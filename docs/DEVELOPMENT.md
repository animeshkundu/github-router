# Development Guide

## Prerequisites

- [Bun](https://bun.sh/) runtime
- A GitHub account with an active Copilot subscription (Individual, Business, or Enterprise)

## Setup

```bash
# Install dependencies
bun install

# Authenticate with GitHub (first time only)
bun run dev -- auth

# Start development server
bun run dev
```

## Commands

| Command | Description |
|---|---|
| `bun run dev` | Start dev server with hot reload (port 8787) |
| `bun run start` | Start production server |
| `bun run build` | Build for distribution (tsdown) |
| `bun run typecheck` | Run the root `tsc` check and the separately configured `tsconfig.browser.json` check for shipped `src/browser-bridge/**` TypeScript |
| `bun run lint` | Run ESLint |
| `bun run lint:all` | Lint all files (not just staged) |
| `bun test` | Run lane 1 only; it excludes `tests/isolated/**` |
| `bun run test` | Build, then run the full two-lane suite used by CI |

## CLI Flags

```bash
bun run dev -- start [flags]

--port, -p       Port to listen on (default: 8787)
--verbose, -v    Enable debug logging
--account-type   individual|business|enterprise (default: individual)
--manual         Require approval for each request
--rate-limit     Seconds between requests
--wait           Wait instead of error on rate limit
--github-token   Provide token directly (skip auth flow)
--claude-code    Generate Claude Code launch command
--codex          Generate Codex CLI launch command
--show-token     Display tokens in logs
--proxy-env      Use HTTP_PROXY/HTTPS_PROXY env vars
--extended-betas Forward extended beta headers for Claude CLI compatibility
```

## Project Conventions

### Import Aliases
Use `~/` for imports from the `src/` directory:
```typescript
import { state } from "~/lib/state"
import { createChatCompletions } from "~/services/copilot/create-chat-completions"
```

### File Organization
- **Services** (`src/services/`): External API clients. One file per API call.
- **Routes** (`src/routes/`): One directory per endpoint group. Each has `route.ts` (Hono router) and `handler.ts` (business logic).
- **Lib** (`src/lib/`): Shared utilities. Stateless functions where possible.

### Error Handling
- Use `HTTPError` for API errors (preserves status code from upstream)
- Wrap route handlers in `forwardError()` to properly forward errors to clients
- Error format follows Anthropic SDK convention: `{type:"error",error:{type:"<category>",message:"..."}}`
- Upstream Anthropic-format errors from Copilot are forwarded as-is (not re-wrapped)
- Never swallow errors silently — log with `consola.error()`

### Logging
Use `consola` for all logging:
- `consola.info()` -normal operation messages
- `consola.debug()` -verbose output (requires `--verbose`)
- `consola.error()` -error conditions
- `consola.warn()` -non-fatal issues

## Testing

Tests use Bun's native test framework (`bun:test`) and live in the `tests/` directory.

### Patterns

**Service tests** (mock fetch, validate headers/URL):
```typescript
import { test, expect, mock } from "bun:test"
const fetchMock = mock(() => ({ ok: true, json: () => ({...}) }))
globalThis.fetch = fetchMock
// Call service, check fetchMock.mock.calls
```

**Translation tests** (validate schema with Zod):
```typescript
import { z } from "zod"
const schema = z.object({ model: z.string(), messages: z.array(...) })
const result = translateToOpenAI(payload)
expect(schema.safeParse(result).success).toBe(true)
```

### Running Tests
```bash
bun test                          # Lane 1: excludes tests/isolated/**
bun run test                      # Build + both lanes, matching CI
bun test tests/create-responses   # Specific non-isolated test file
```

`tests/isolated/**` runs one file per process through `scripts/run-tests.ts` because
its `mock.module()` state is process-global. Run `bun run test` for the full suite;
a direct `bun test tests/isolated/foo.test.ts` is excluded by `bunfig.toml` unless
you override its ignore pattern.

CI provisions `ast-grep` from the pinned toolbelt manifest with
`bun scripts/ensure-ast-grep.ts` immediately before `scripts/run-tests.ts`. This is a
hard gate because the `mode:"ast"` code-search tests skip when the executable is
missing, which is not coverage.

The second typecheck configuration covers the shipped Node native-messaging bridge
in `src/browser-bridge/**`. `src/browser-ext/**` remains untypechecked: it is MV3
extension JavaScript with `chrome.*` service-worker globals, and needs a third
configuration plus `@types/chrome`. That follow-up is intentionally not hidden by
the bridge check.

## Token Storage

GitHub tokens are stored at `~/.local/share/github-router/github_token` with `0o600` permissions.
Copilot tokens are short-lived and auto-refreshed in memory (not persisted to disk).

## HTTP Proxy

When `--proxy-env` is set, the server reads `HTTP_PROXY`, `HTTPS_PROXY`, and `NO_PROXY` environment variables and routes outgoing requests through the specified proxy.
