# `github-router serve` — browser control plane

`github-router serve` stands up a single-command web control plane: a browser UI where you
create/end Claude sessions, browse files, use a terminal, and see session history — with every
Claude request routed through the github-router proxy (the same routing `github-router claude`
gives on the terminal).

It does this by launching **CloudCLI** (`@cloudcli-ai/cloudcli`, a mature web IDE) as a **separate
process** and **reverse-proxying it under github-router's own origin** with zero-login auto-auth.

## Why reuse CloudCLI (and why arm's-length)

CloudCLI already has the file explorer, node-pty terminal, and SQLite session history, and it spawns
Claude via `@anthropic-ai/claude-agent-sdk`, forwarding its environment. Rebuilding that is not
worth it. CloudCLI is **AGPL-3.0-or-later**; github-router is **MIT, published to npm**. To keep
github-router MIT we never bundle, vendor, or distribute CloudCLI: `serve` installs it from npm onto
the user's machine at the user's direction and runs it as an independent process communicating over
env-at-spawn + localhost HTTP/WebSocket. That is "mere aggregation" (see `NOTICE`,
`scripts/check-pack-no-agpl.mjs`, and the FSF GPL FAQ). The npm tarball ships `dist/` only, so no
CloudCLI bytes can leak into it; the release CI license guard enforces this.

## Architecture

```
 browser ──http/ws──▶ reverse proxy (127.0.0.1:servePort, github-router-owned origin)
                          │  injects localStorage['auth-token']=<jwt> into index.html
                          │  enforces Origin == own origin on requests + WS upgrades
                          ▼
                      CloudCLI server (127.0.0.1:ccPort, HOST=127.0.0.1)
                          │  spawns claude via Agent SDK, env-forwarded
                          ▼
                      github-router proxy (serverUrl) ──▶ GitHub Copilot
```

Startup sequence (`src/serve.ts`):
1. `setupAndServe()` → github-router proxy + `serverUrl`.
2. Provision the Claude config exactly like `github-router claude`: `ensureClaudeConfigMirror()`
   (synthetic `.credentials.json` + onboarding-skip), peer-MCP / agent-`.md` injection
   (`src/lib/codex-mcp-config.ts`), `getClaudeCodeEnvVars(serverUrl, model)`. A spike confirmed an
   Agent-SDK-spawned claude with this env authenticates through the proxy and loads the injected
   peer-MCP.
3. Resolve CloudCLI (pinned, router-owned; see below) and spawn it on a loopback child port with a
   **filtered env** and `--database-path` set to a router-owned dir (data isolation). JWT auth stays
   ON; `VITE_IS_PLATFORM` is **not** set.
4. Mint a JWT (`/api/auth/register` on a fresh DB, else `/api/auth/login`), user = your GitHub login.
5. Start the reverse proxy (`src/lib/serve/reverse-proxy.ts`); inject the token; enforce Origin.
6. Fail-closed conformance probe (a request must demonstrably reach the github-router proxy).
7. Open the browser at the reverse-proxy origin.

## Security model

CloudCLI's OSS server binds `0.0.0.0` by default and performs **no WebSocket `Origin` check** on
`/ws` (chat) or `/shell` (node-pty terminal) — a browser-exposed terminal with those defaults is a
remote-code-execution risk (any website could drive it via cross-origin WS / DNS-rebinding). `serve`
closes this:

- **Loopback only.** CloudCLI is spawned with `HOST=127.0.0.1`; the reverse proxy binds `127.0.0.1`.
  Loopback is asserted before the browser opens.
- **Origin enforcement at the proxy.** Requests / WS upgrades whose `Origin` is present and not the
  proxy's own origin are rejected. The auth token lives in `localStorage`, which is same-origin
  locked, so a cross-origin page cannot read it or reach the terminal.
- **JWT auth stays ON.** `VITE_IS_PLATFORM=true` is deliberately NOT used: it disarms the server's
  auth entirely AND (being build-time in the OSS bundle) still shows a login wall — the worst of both.
- **Filtered child env.** The env handed to CloudCLI has the same secrets github-router's worker
  shell strips removed — `GITHUB_TOKEN`, `GH_ROUTER_*`, `ANTHROPIC_AUTH_TOKEN`, `OPENAI_API_KEY`,
  `COPILOT_TOKEN`, `JWT_SECRET`. Auth to the proxy still works because it rides the synthetic
  `.credentials.json` **file** in `CLAUDE_CONFIG_DIR`, not an env token. This keeps the browser
  terminal (which can read its own env) from exposing the GitHub PAT.
- **Host + Origin enforcement.** The reverse proxy rejects any request or WS upgrade whose `Host`
  isn't the bound loopback host (DNS-rebinding defense — an Origin-only check still lets a rebound
  `attacker.com → 127.0.0.1` navigation fetch the token-injected HTML) or whose `Origin` is foreign.

### Residual (by design)
The browser terminal runs as the same OS user, so it can read the synthetic `.credentials.json` in
the router-owned `CLAUDE_CONFIG_DIR`. That synthetic OAuth token grants proxy / Copilot-quota access
(the same access the control plane already gives) but **not** the raw GitHub PAT, which is stripped
from the env and never placed in the mirror. This is inherent to a zero-login local control plane.

## CloudCLI resolution & install

Resolved in order: `--cloudcli-path <dir>` → an existing pinned install in the router-owned dir →
(unless `--no-install`) install the **pinned** `@cloudcli-ai/cloudcli` version into the router-owned
dir (local `npm i`, never `-g`, never `@latest`). Windows-safe exec throughout. The pinned version is
a tested known-good (1.36.1 at introduction); its native deps (`better-sqlite3`, `node-pty`) build on
Windows. On install failure (offline / proxy / missing build tools) `serve` prints the manual install
command rather than half-starting.

## Flags
`--cloudcli-path <p>`, `--no-install`, `--cloudcli-version <v>`, `-m/--model <slug>`, plus the shared
server args.

## Known limitations
- CloudCLI's model picker is a hardcoded list (not the live Copilot catalog); common Anthropic slugs
  map through the proxy's `resolveModel`. Refreshed occasionally with the pinned version.
- `serve` depends on CloudCLI's HTTP shapes (`/api/auth/*`, `SERVER_PORT`/`HOST` env, env-forward);
  the version is pinned so upstream changes can't silently break it.

## Verification
See `scripts/verify-serve.mjs` (or the manual steps in the plan): browser opens already-logged-in;
cross-origin WS to the terminal is rejected; the CloudCLI terminal env has no `GITHUB_TOKEN`/
`ANTHROPIC_*`; a session's traffic appears in the proxy's `/usage`; teardown kills the child + proxy
and removes the per-launch mirror. `windows-latest` CI must be green.
