# Architecture Overview

## What Is This?

github-router is a reverse-proxy that exposes the GitHub Copilot API as OpenAI and Anthropic-compatible endpoints. It enables tools like Claude Code, Codex CLI, and any OpenAI-compatible client to use GitHub Copilot as a backend.

## Request Flow

```
Client (Claude Code, Codex CLI, curl, etc.)
  │
  ▼
Hono Web Server (src/server.ts)
  │
  ├─ Rate Limiting (src/lib/rate-limit.ts)
  ├─ Manual Approval (src/lib/approval.ts) [optional]
  │
  ▼
Route Handler (src/routes/<endpoint>/handler.ts)
  │
  └─ PASSTHROUGH routes: forward directly to Copilot
      ├─ /v1/chat/completions → Copilot /chat/completions
      ├─ /v1/responses        → Copilot /responses
      └─ /v1/messages         → Copilot /v1/messages?beta=true
  │
  ▼
GitHub Copilot API (api.githubcopilot.com)
```

## Directory Structure

```
src/
├── main.ts              # CLI entry point (citty subcommand router)
├── start.ts             # "start" subcommand: server init + CLI flags
├── codex.ts             # "codex" subcommand: proxy + launch Codex CLI
├── claude.ts            # "claude" subcommand: proxy + launch Claude Code
├── auth.ts              # "auth" subcommand: GitHub device flow
├── check-usage.ts       # "check-usage" subcommand
├── debug.ts             # "debug" subcommand
├── server.ts            # Hono router: all route registration
│
├── routes/              # API endpoint handlers
│   ├── chat-completions/  # PASSTHROUGH: OpenAI Chat Completions
│   │   ├── route.ts       # POST /
│   │   └── handler.ts     # Rate limit → createChatCompletions() → response
│   │
│   ├── responses/         # PASSTHROUGH: OpenAI Responses API (for Codex)
│   │   ├── route.ts       # POST /
│   │   └── handler.ts     # Rate limit → createResponses() → response
│   │
│   ├── messages/          # PASSTHROUGH: Anthropic Messages API
│   │   ├── route.ts       # POST /, POST /count_tokens
│   │   ├── handler.ts     # Rate limit → resolveModel → createMessages() → response
│   │   └── count-tokens-handler.ts   # Token counting endpoint
│   │
│   ├── models/            # GET /models (list available Copilot models)
│   ├── embeddings/        # POST /embeddings (passthrough)
│   ├── usage/             # GET /usage (Copilot quota info)
│   └── token/             # GET /token (current Copilot token)
│
├── services/            # External API clients
│   ├── copilot/
│   │   ├── create-chat-completions.ts  # POST to Copilot /chat/completions
│   │   ├── create-responses.ts         # POST to Copilot /responses
│   │   ├── create-messages.ts          # POST to Copilot /v1/messages?beta=true
│   │   ├── create-embeddings.ts        # POST to Copilot /embeddings
│   │   ├── get-models.ts              # GET Copilot /models
│   │   └── web-search.ts             # Copilot web search integration
│   ├── github/                         # GitHub OAuth + token management
│   ├── get-copilot-version.ts          # Fetches latest Copilot Chat version (marketplace API)
│   └── get-vscode-version.ts           # Fetches latest VSCode version (AUR)
│
└── lib/                 # Shared utilities
    ├── state.ts           # Global singleton state
    ├── api-config.ts      # Copilot API headers, URLs, version constants
    ├── token.ts           # GitHub + Copilot token setup/refresh
    ├── rate-limit.ts      # Request rate limiting
    ├── approval.ts        # Manual request approval prompt
    ├── error.ts           # HTTPError class + forwardError()
    ├── tokenizer.ts       # Token counting (Chat Completions format)
    ├── proxy.ts           # HTTP proxy support
    ├── shell.ts           # Cross-platform env var script generation
    ├── paths.ts           # File system paths for token storage
    ├── port.ts            # Default port, random port generation, default codex model
    ├── launch.ts          # Child process spawning for codex/claude subcommands
    ├── model-validation.ts  # Endpoint support checks, mismatch logging
    ├── server-setup.ts    # Shared server bootstrap (setupAndServe, env var builders)
    ├── request-log.ts     # Structured request logging
    └── utils.ts           # resolveModel(), filterBetaHeader(), normalizeModelId(),
                           # resolveCodexModel(), sleep(), cacheModels(), cacheVSCodeVersion()
```

## Passthrough Architecture

All three main API routes are now passthrough: they forward the request body directly to the corresponding Copilot endpoint and return the response as-is.

### Passthrough routes (chat-completions, responses, messages, embeddings)
When Copilot natively supports the API format, we just proxy the request through.
Files: `service.ts` + `handler.ts` + `route.ts` (3 files)

The messages route previously used a translation layer (Anthropic format to/from Chat Completions format) with dedicated `anthropic-types.ts`, `non-stream-translation.ts`, and `stream-translation.ts` files. This was removed when Copilot added native `/v1/messages` support, making the translation unnecessary.

## Model Endpoint Routing

Not all models support all endpoints:

| Model Family | `/chat/completions` | `/responses` | `/v1/messages` |
|---|---|---|---|
| gpt-4.1, gpt-4o | YES | YES | No |
| gpt-5-codex variants, gpt-5.4 | NO | YES (ONLY) | No |
| claude-sonnet-4, claude-opus-4 | YES | NO | YES |
| o3, o4-mini | YES | YES | No |

Models report `supported_endpoints` in their metadata from the `/models` endpoint.

## Model Resolution

When a client requests a model by name, the proxy resolves it against the cached Copilot model list using a five-step cascade:

1. **Exact match** -- model ID matches a known model verbatim
2. **Case-insensitive match** -- e.g. `Claude-Sonnet-4` resolves to `claude-sonnet-4`
3. **Normalized match** -- dots replaced with dashes, repeated dashes collapsed (e.g. `gpt5.3-codex` matches `gpt-5.3-codex`)
4. **Family preference** -- shorthand names resolve to preferred variants:
   - `opus` resolves to the `-1m` context variant (e.g. `claude-opus-4-1m`)
   - `codex` resolves to the highest-versioned gpt-5 model supporting `/responses`
5. **Passthrough with warning** -- if no match is found, the original model ID is forwarded as-is and a warning is logged

The `resolveCodexModel()` variant extends this for the codex subcommand: if the resolved model still does not exist in the model list, it falls back to the best available codex model that supports `/responses`.

Resolution is implemented in `src/lib/utils.ts` and invoked by both the subcommand startup logic and the messages route handler.

## Subcommand Lifecycle

The `codex` and `claude` subcommands start the proxy server and launch their respective CLI tools as child processes, wired to use the proxy.

### Startup sequence

Both subcommands follow the same pattern (implemented via `setupAndServe` in `src/lib/server-setup.ts`):

1. **setupAndServe** -- parse CLI flags, initialize proxy/auth/tokens, start Hono server on a random port
2. **cacheModels** -- fetch and cache the Copilot model list (called within `setupAndServe`)
3. **Validate model** -- resolve the requested model against the cached list, warn if not found
4. **Launch child process** -- spawn the CLI tool via `launchChild` (`src/lib/launch.ts`), which handles signal forwarding and server cleanup on exit

### Environment variables

Each subcommand sets environment variables so the child process uses the proxy:

**codex** (`src/codex.ts`):
- `OPENAI_BASE_URL` = `<serverUrl>/v1`
- `OPENAI_API_KEY` = `dummy`
- Codex CLI uses the `/v1/responses` endpoint

**claude** (`src/claude.ts`):
- `ANTHROPIC_BASE_URL` = `<serverUrl>`
- `ANTHROPIC_AUTH_TOKEN` = `dummy`
- `ANTHROPIC_MODEL` = resolved model (when `-m` is specified)
- `DISABLE_NON_ESSENTIAL_MODEL_CALLS` = `1`
- `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` = `1`
- Claude Code uses the `/v1/messages` endpoint

### Endpoint usage

| Subcommand | Primary endpoint | Default model |
|---|---|---|
| `codex` | `/v1/responses` | `gpt-5.4` |
| `claude` | `/v1/messages` | (Claude Code's own default) |

## Authentication Flow

```
1. GitHub OAuth Device Flow:
   User runs `github-router auth` →
   Gets device code + verification URL →
   User visits URL and enters code →
   Poll for access token → saved to ~/.local/share/github-router/github_token

2. Copilot Token:
   GitHub token → POST /copilot_internal/v2/token →
   Gets short-lived Copilot token (auto-refreshed every ~25 minutes)

3. API Requests:
   Copilot token used as Bearer token in Authorization header
```

## Global State (`src/lib/state.ts`)

Singleton object tracking:
- `githubToken` / `copilotToken` — authentication credentials
- `accountType` — "individual" | "business" | "enterprise" (affects API base URL)
- `models` — cached model list from Copilot API
- `vsCodeVersion` — dynamically fetched from AUR at startup, used in `editor-version` header
- `copilotVersion` — dynamically fetched from VS Code marketplace at startup, used in `editor-plugin-version` and `user-agent` headers
- `extendedBetas` — when true, forward extended beta prefixes for Claude CLI compatibility (default: false, VS Code stealth mode)
- `manualApprove` / `rateLimitSeconds` / `rateLimitWait` / `showToken` — CLI flag state

## Streaming

Both passthrough routes support SSE streaming:
- **Passthrough**: SSE events from Copilot forwarded directly to client

The `fetch-event-stream` library handles parsing incoming SSE from Copilot.
Hono's `streamSSE()` helper handles writing outgoing SSE to the client.

## Beta Header Filtering (`src/lib/utils.ts`)

The proxy filters the `anthropic-beta` header to control which beta features are forwarded to Copilot. Two whitelists are available, selected by the `--extended-betas` CLI flag:

**Default (VS Code stealth)**: Only 3 prefixes matching what VS Code Copilot Chat v0.43 sends:
- `interleaved-thinking-`, `context-management-`, `advanced-tool-use-`

**Extended (`--extended-betas`)**: 20 prefixes including all betas Claude CLI sends:
- Adds `claude-code-`, `context-1m-`, `effort-`, `prompt-caching-`, `computer-use-`, `pdfs-`, `max-tokens-`, `token-counting-`, `compact-`, `structured-outputs-`, `fast-mode-`, `skills-`, `mcp-client-`, `mcp-servers-`, `files-api-`, `redact-thinking-`, `web-search-`

Notably absent from both lists: `output-128k-` (Copilot returns 400).

## Request Body Sanitization

The `/v1/messages` and `/v1/messages/count_tokens` handlers sanitize the request body before forwarding:

1. **Model resolution**: Client model names resolved to Copilot model IDs (e.g., `claude-opus-4-6` → `claude-opus-4.6-1m`)
2. **cache_control.scope stripping**: Claude CLI 2.1.88+ sends `cache_control: {"type":"ephemeral","scope":"global"}` which Copilot rejects. The `scope` field is stripped from all `cache_control` objects in system blocks, message content blocks (including nested tool_result content), and tool definitions. Empty `cache_control` objects are removed entirely.
3. **Web search tool handling**: `web_search` tools are intercepted, search is performed via Copilot's Chat Threads API, results are injected into the system prompt, and the tool is stripped from the request.

Fast path: sanitization is skipped when `"scope"` does not appear in the raw body string. Model resolution and sanitization share a single JSON parse/serialize pass.

## Error Format

All errors returned by the proxy use the Anthropic SDK format:
```json
{"type": "error", "error": {"type": "invalid_request_error", "message": "..."}}
```

When Copilot returns an error already in Anthropic format, it is forwarded as-is. Other errors (gateway errors, proxy-internal errors) are wrapped in this format with appropriate `error.type` based on HTTP status (400 → `invalid_request_error`, 401 → `authentication_error`, 429 → `rate_limit_error`, etc.).

## VS Code Fingerprint

The proxy mimics VS Code Copilot Chat extension headers to match expected API client identity.

**Dynamic version fetching** (`src/services/get-copilot-version.ts`):
- Copilot Chat extension version is fetched from the VS Code marketplace API at startup
- VS Code editor version is fetched from AUR PKGBUILD at startup (`src/services/get-vscode-version.ts`)
- Both use 5-second timeouts with hardcoded fallbacks on failure
- Versions are cached in `state.copilotVersion` and `state.vsCodeVersion`

**Header construction** (`src/lib/api-config.ts`):
- `editor-plugin-version`: `copilot-chat/<copilotVersion>` (dynamic)
- `user-agent`: `GitHubCopilotChat/<copilotVersion>` (dynamic)
- `editor-version`: `vscode/<vsCodeVersion>` (dynamic)
- `x-github-api-version`: `2025-10-01` (static)
- `anthropic-version`: `2023-06-01` (static, matches both VS Code and Claude CLI)
- `anthropic-version`: `2023-06-01` (matches both VS Code and Claude CLI)

For `/v1/messages`, the proxy uses `openai-intent: messages-proxy` and suppresses `copilot-integration-id`, matching VS Code extension v0.43 behavior.
