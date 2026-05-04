# github-router

A reverse proxy that exposes GitHub Copilot as OpenAI and Anthropic compatible API endpoints.

## Commands

```bash
bun run build        # Build for distribution (tsdown → dist/)
bun run dev          # Dev server with hot reload
bun run lint:all     # Lint entire project
bun run typecheck    # TypeScript type checking
bun test             # Run all tests
bun run start        # Production server (port 8787)
```

## Publishing

The canonical npm package is the **unscoped** `github-router` (NOT `@animeshkundu/github-router`).
Users install via `npm install -g github-router`. The scoped name in package.json is for
GitHub Packages compatibility only.

**CI publishing** (preferred): Every push to `master` triggers the Release workflow
(`.github/workflows/release.yml`), which auto-bumps the version, publishes to npmjs.org
via OIDC trusted publishing (no token needed), creates a GitHub release, and builds Docker
images. Uses Node 24 (npm 11.11.0) for OIDC support.

**Manual publishing** (fallback):
```bash
export NPM_TOKEN=npm_...
./publish/release.sh          # auto-bump patch
./publish/release.sh 0.4.0    # explicit version
```

The release script builds, tests, temporarily rewrites package.json to the unscoped name,
publishes, and restores. See `publish/release.sh` for details.

## Architecture

- **Stack**: TypeScript / Bun / Hono / SSE streaming
- **Import alias**: `~/` maps to `src/`
- **Token storage**: `~/.local/share/github-router/github_token`

### Two patterns

1. **Passthrough**: Forward directly to Copilot API:
   - `/v1/chat/completions`, `/v1/responses`, `/v1/embeddings`
   - Service: `src/services/copilot/create-*.ts` → handler → route

2. **Passthrough with sanitization**: Forward to Copilot, stripping unsupported fields:
   - `/v1/messages` (Anthropic) → strip `cache_control.scope`, filter beta headers → Copilot `/v1/messages?beta=true`
   - `/v1/messages/count_tokens` → same sanitization → Copilot `/v1/messages/count_tokens?beta=true`

### Beta header filtering

Two modes controlled by `--extended-betas` flag:
- **Default (VS Code stealth)**: Only forward 3 beta prefixes the VS Code extension sends (`interleaved-thinking-`, `context-management-`, `advanced-tool-use-`). Traffic is indistinguishable from VS Code.
- **Extended (`--extended-betas`)**: Forward 14 additional beta prefixes for Claude CLI compatibility. Required when using `github-router claude --extended-betas`.

The router strips `context-1m-`, `skills-`, `files-api-`, and `code-execution-` from every outgoing `anthropic-beta` value — Copilot returns 400 ("unsupported beta header") on each. 1M context for Opus 4.7 is unlocked by selecting the `claude-opus-4.7-1m-internal` model id (enterprise tier only), not via a beta header.

### Default models

The `claude` and `codex` subcommands default to the latest Copilot-supported models when no `--model` is given:
- `claude` → `claude-opus-4.7` (resolver upgrades to `claude-opus-4.7-1m-internal` when present, which requires enterprise tier)
- `codex` → `gpt-5.5` (Copilot's GPT-5.5 dropped the `-codex` suffix; the `/responses` endpoint is the discriminator)

Override with `-m`/`--model`. Constants live in `src/lib/port.ts`.

### Thinking-mode translation

Copilot rejects Anthropic's `thinking:{type:"enabled", budget_tokens:N}` shape on adaptive-thinking models with HTTP 400. The router translates to Copilot's `thinking:{type:"adaptive"}` + `output_config:{effort}` automatically when the resolved model declares `adaptive_thinking: true`. Bucket: `<2k → low`, `<8k → medium`, `<24k → high`, else `xhigh`. Clamps to `model.capabilities.supports.reasoning_effort` allowlist when present (lower-tier preference for ties). Client-supplied `output_config.effort` always wins. No-op when the model lacks `adaptive_thinking` (passthrough). Implemented in `src/routes/messages/handler.ts` (`translateThinking`).

### Web search

The legacy `/search` route wraps Copilot's `/github/chat/threads` endpoint and depends on the **`github_chat` token entitlement** — gated by the enterprise admin policy "Copilot in GitHub.com" being Enabled. Per the [Nov 4 2025 GitHub changelog](https://github.blog/changelog/2025-11-04-github-copilot-policy-update-for-unconfigured-policies/), Unconfigured policies silently flipped from Enabled-default to Disabled-default — so accounts that "used to work" may now see 401/403. When the entitlement is missing, the indirect `web_search` tool path on `/v1/responses` and `/v1/chat/completions` silently degrades (no search context, but the main request still succeeds via the existing try/catch around `searchWeb`).

For OpenAI-shaped clients on GPT-5.x today: `tools:[{type:"web_search_preview"}]` on `/v1/responses` works natively (the tool-type filter was removed in commit 4c62926). For Anthropic-shape `web_search_*` tools on `/v1/messages`, Copilot returns 400 "use of the web search tool is not supported" — these are not currently translatable.

A migration to MCP (`/mcp` with `X-MCP-Toolsets: web_search` and the GitHub PAT bearer) — model-agnostic, regardless of `github_chat` — is tracked in `followups-mcp-web-search.md`. Verified working live during the bundle's investigation.

### Error format

Errors use Anthropic SDK format: `{type:"error",error:{type:"<category>",message:"..."}}`.
Upstream Anthropic-format errors from Copilot are forwarded as-is.

### Key directories

```
src/routes/<name>/     # route.ts (Hono router) + handler.ts (business logic)
src/services/copilot/  # API clients for Copilot endpoints
src/services/github/   # GitHub OAuth + token management
src/lib/               # Shared utilities (state, config, rate-limit, etc.)
```

### Model → endpoint mapping

- gpt-5-codex models ONLY work via `/responses` (NOT `/chat/completions`)
- Models report `supported_endpoints` in their metadata

## Testing

- Framework: `bun:test` with `mock()` for fetch, Zod for schema validation
- Tests live in `tests/` directory
- Pattern: mock `globalThis.fetch`, call service, validate calls and response shapes
