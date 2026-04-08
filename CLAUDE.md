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
- **Extended (`--extended-betas`)**: Forward 20 beta prefixes for Claude CLI compatibility. Required when using `github-router claude --extended-betas`.

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

- gpt-5-codex models and gpt-5.4 ONLY work via `/responses` (NOT `/chat/completions`)
- Models report `supported_endpoints` in their metadata

## Testing

- Framework: `bun:test` with `mock()` for fetch, Zod for schema validation
- Tests live in `tests/` directory
- Pattern: mock `globalThis.fetch`, call service, validate calls and response shapes
