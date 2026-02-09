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
  ├─ PASSTHROUGH routes: forward directly to Copilot
  │   ├─ /v1/chat/completions → Copilot /chat/completions
  │   └─ /v1/responses → Copilot /responses
  │
  └─ TRANSLATION routes: convert format, then call Copilot
      └─ /v1/messages (Anthropic) → translate → Copilot /chat/completions → translate back
  │
  ▼
GitHub Copilot API (api.githubcopilot.com)
```

## Directory Structure

```
src/
├── main.ts              # CLI entry point (citty subcommand router)
├── start.ts             # "start" subcommand: server init + CLI flags
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
│   ├── messages/          # TRANSLATION: Anthropic Messages API
│   │   ├── route.ts       # POST /, POST /count_tokens
│   │   ├── handler.ts     # Rate limit → translate → createChatCompletions() → translate back
│   │   ├── anthropic-types.ts        # Anthropic API type definitions
│   │   ├── non-stream-translation.ts # Anthropic ↔ OpenAI format conversion
│   │   ├── stream-translation.ts     # Streaming chunk conversion
│   │   ├── count-tokens-handler.ts   # Token counting endpoint
│   │   └── utils.ts                  # Stop reason mapping
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
│   │   ├── create-embeddings.ts        # POST to Copilot /embeddings
│   │   └── get-models.ts              # GET Copilot /models
│   ├── github/                         # GitHub OAuth + token management
│   └── get-vscode-version.ts          # Fetches latest VSCode version
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
    └── utils.ts           # sleep(), isNullish(), cacheModels(), cacheVSCodeVersion()
```

## Two Patterns: Passthrough vs Translation

### Passthrough (chat-completions, responses, embeddings)
When Copilot natively supports the API format, we just proxy the request through.
Files: `service.ts` + `handler.ts` + `route.ts` (3 files)

### Translation (messages/Anthropic)
When Copilot doesn't support the format, we translate to/from Chat Completions.
Files: `types.ts` + `non-stream-translation.ts` + `stream-translation.ts` + `handler.ts` + `route.ts` (5 files)

## Model Endpoint Routing

Not all models support all endpoints:

| Model Family | `/chat/completions` | `/responses` |
|---|---|---|
| gpt-4.1, gpt-4o | YES | YES |
| gpt5.2-codex, gpt-5.1-codex-mini | NO | YES |
| claude-sonnet-4, claude-opus-4 | YES (via /messages translation) | NO |
| o3, o4-mini | YES | YES |

Models report `supported_endpoints` in their metadata from the `/models` endpoint.

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
- `vsCodeVersion` — dynamically fetched, used in request headers
- `manualApprove` / `rateLimitSeconds` / `rateLimitWait` / `showToken` — CLI flag state

## Streaming

Both passthrough and translation routes support SSE streaming:
- **Passthrough**: SSE events from Copilot forwarded directly to client
- **Translation**: Chat Completions chunks → translated to Anthropic SSE events

The `fetch-event-stream` library handles parsing incoming SSE from Copilot.
Hono's `streamSSE()` helper handles writing outgoing SSE to the client.
