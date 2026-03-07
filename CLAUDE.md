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

```bash
# Set your npmjs.org publish token (never commit this)
export NPM_TOKEN=npm_...

# Publish with auto-bumped patch version
./publish/release.sh

# Or specify a version explicitly
./publish/release.sh 0.4.0
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

2. **Translation**: Convert format, call Copilot, convert back:
   - `/v1/messages` (Anthropic) → translate to Chat Completions → call Copilot → translate response back
   - Extra files: `anthropic-types.ts`, `non-stream-translation.ts`, `stream-translation.ts`

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
