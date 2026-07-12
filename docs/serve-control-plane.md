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

## github-router tools inside Claude sessions

`serve` gives the CloudCLI-spawned Claude the same enhancement layer `github-router claude` provides,
by writing into the router-owned `CLAUDE_CONFIG_DIR` mirror (which the SDK-spawned claude reads via
`settingSources: ['user']`) plus best-effort background provisions. Implemented in
`src/lib/serve/enhancements.ts` + the provision block in `src/serve.ts`, reusing the exact functions
`claude.ts`/`start.ts` use:

- **MCP servers** — `peers` / `search` / `orchestrate`, plus `workers` / `decide` / `browser` /
  `fleet` / `first-mate` when their gate passes (`injectPeerMcpIntoMirror`; the per-launch nonce is set
  on `state.peerMcpNonce`). `--codex-cli` routes Codex personas through a local `codex mcp-server`
  (requires codex 0.129+; HTTP fallback otherwise). **Tunnel gating:** when the control plane is
  tunnel-exposed (`--tunnel` / `--public-url`), the server-side **browser** MCP, **first-mate** (which
  mints a `repo+workflow` GitHub write token), and **fleet** (which drives remote coding sessions) are
  withheld unless the operator opts in with `--browse-over-tunnel` / `--agents-over-tunnel` /
  `--fleet-over-tunnel` — see Security model.
- **Subagents** — the peer critics, worker dispatchers, and `implementer` (`.md` files in the
  mirror's `agents/`), PLUS Claude Code's **built-in subagents** (`Explore`, `Plan`, `general-purpose`)
  which the Agent SDK does NOT register on its own. Without these a serve session shows
  `Agent type 'Explore' not found` when the model habitually calls them; we re-register them
  (`BUILTIN_SUBAGENT_DEFINITIONS` in `src/lib/codex-mcp-config.ts`) **serve-only** — never for
  `github-router claude`, where the CLI provides the native, tuned built-ins and a same-name custom
  agent would shadow them.
- **Skills** — `gh-research` / `gh-orchestrate` / `gh-floor-keeper` / `gh-worker` (operator +
  ai-or-die-tab-specific skills are intentionally excluded).
- **System-prompt-level guidance** — operating-defaults, style (no-attribution/voice), peer-tool and
  toolbelt awareness are injected into the mirrored `CLAUDE.md` (the right substitute for
  `--append-system-prompt`, which CloudCLI doesn't expose).
- **Hooks** — the `UserPromptSubmit` orchestration hook and the `PreToolUse` worker-guard (steers
  `mcp__workers__*` to the non-blocking `worker-*` subagents; opt out with
  `GH_ROUTER_DISABLE_WORKER_GUARD=1`). They reach the proxy via `GH_ROUTER_HOOK_MCP_URL` +
  `GH_ROUTER_HOOK_NONCE` forwarded into the child env.
- **Background provisions** — semantic search (colbert), the LLM toolbelt (`rg`/`fd`/`jq`/…),
  keep-awake, and self-update, all fire-and-forget.
- **Permissions** — matches `github-router claude`'s default `--dangerously-skip-permissions`: serve
  sets `permissions.defaultMode: "bypassPermissions"` in the mirror `settings.json` (and allow-lists its
  own `mcp__*` servers as a fallback). Without this, CloudCLI's Agent-SDK `canUseTool` stalls the chat on
  a browser approval prompt for every injected tool, and an operator's mirrored `defaultMode: "plan"`
  refuses native writes. Opt out with `GH_ROUTER_SERVE_NO_AUTO_APPROVE=1` (prompts + the mirrored mode
  are then left untouched). Existing `allow`/`deny`/`ask` entries are preserved; a user `deny` still wins.
- **Injected MCP servers auto-approved in PLAN mode (the real serve mechanism)** — CloudCLI drives
  Claude via the Agent SDK, whose `canUseTool` callback is what gates tools once a session is switched
  off bypass into **plan mode**. That callback reads `sdkOptions.allowedTools` (seeded from the browser
  `localStorage['claude-settings'].allowedTools`), NOT the mirror `settings.json permissions.allow`, and
  it does EXACT tool-name matching (no `mcp__<server>` wildcard). So the reverse proxy seeds
  `claude-settings.allowedTools` with the **exact** `mcp__<key>__<tool>` names of every injected server
  (`enumerateInjectedMcpToolNames`), which makes those tools auto-approve in plan mode — no
  `permission_request`, fixing the `Tool permission request failed: Error: Stream closed` a plan-mode
  MCP call otherwise hits. **Verified end-to-end** (`bun run verify:plan-mode` /
  `scripts/verify-plan-mode-cloudcli.mjs`): a live CloudCLI plan-mode session calls `mcp__search__code`
  and it executes (isError:false, no prompt). The seed is auto-approve-only under the SDK's `claude_code`
  preset — empirically ADDITIVE, so an MCP-only list does NOT restrict the native toolset (unlike a bare
  `claude --allowedTools`, which does). Bypass mode skips `canUseTool` entirely, so this only bites in
  plan mode. NOTE: the mirror `settings.json permissions.allow` `mcp__<server>` rules (also injected) are
  a belt for the interactive-CLI path but are NOT consulted by CloudCLI's `canUseTool` — the localStorage
  seed is the load-bearing lever for serve. (Plain `github-router claude` in plan mode hard-blocks MCP
  tools at the binary level — a Claude Code limitation with no `canUseTool` override, not serve-fixable.)
- **Coordinator-mode strip (single-agent toolset)** — serve removes `CLAUDE_CODE_COORDINATOR_MODE` from
  the mirror `settings.json` `env` block (unconditional, NOT gated by `GH_ROUTER_SERVE_NO_AUTO_APPROVE`).
  A user who runs FleetView/coordinator sessions sets that var in their real `~/.claude/settings.json`; it
  mirrors in, and because CloudCLI applies the mirror `env` via the Agent SDK's `settingSources`, it puts
  the SINGLE serve chat agent into orchestrator-only mode — stripping every direct tool
  (Glob/Read/Bash/Grep/Edit/Write) down to delegation-only (Task/SendMessage/Workflow), so a direct
  `Glob` call fails "Glob exists but is not enabled in this context". Serve is a single-agent surface, so
  coordinator mode is never appropriate there. (`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` is left intact —
  purely additive.) `verify:serve` now asserts `init.tools ⊇ {Read, Glob, Grep, Bash, Edit, Write}` (and
  scrubs an ambient `CLAUDE_CODE_COORDINATOR_MODE` from its probe env so it tests the mirror, not the
  runner's shell) — the assertion that would have caught this.

**Connected badge + UI display parity.** CloudCLI's client renders its MCP manager, skills panel /
slash menu, model picker, and "connected" badge verbatim from its server's `/api/providers/*` (and
`/api/commands/list`) REST responses. The reverse proxy **rewrites those responses on the way through**
(`src/lib/serve/provider-facade.ts`) so the UI reflects the github-router layer with **no CloudCLI file
change and no client rebuild**:

- `GET /api/providers/claude/mcp/servers?scope=user` — the injected github-router MCP servers are
  appended to `data.servers` (display-only: **name / scope / transport / url only — the `/mcp` bearer
  nonce and all `headers`/`env`/`headersHelper` are stripped**, never reaching the browser).
- `GET /api/providers/claude/skills` + `POST /api/commands/list` — the gh-* skills / custom commands
  are appended.
- `GET /api/providers/claude/models` — `data.models.OPTIONS` is replaced with the **live Copilot
  catalog** (picker-enabled models; each `value` is a real slug that round-trips through the proxy's
  `resolveModel`); `data.cache` is preserved (the client drops a provider whose `cache` is missing).
- `GET /api/providers/claude/auth/status` — `data.authenticated` is forced true, so the badge reads
  connected off the proxy's synthetic credential rather than a real key.

Each rewrite is defensive: a non-200, non-JSON, unexpected-shape, or error response passes through
**unchanged** (byte-for-byte), so a CloudCLI version bump can only lose the display enhancement, never
corrupt the UI. The child env still carries a **placeholder** `ANTHROPIC_API_KEY` as a belt-and-suspenders
fallback for the badge when the façade degrades to passthrough; it is not a real key (the proxy ignores
inbound auth and authenticates to Copilot itself; auth rides the synthetic `.credentials.json`).

**Single instance (once per machine).** `serve` is a single, long-lived, machine-wide control plane:
you start ONE and use its file explorer / sessions to work on any repo. On launch it probes the
intended port for an already-running github-router serve (a loopback `/__github-router-serve__` identity
endpoint served directly by the reverse proxy, carrying no secret); if one is found it **attaches**
(opens that URL and exits) instead of spawning a second CloudCLI that would contend on the shared auth
DB. A foreign process on the port still falls through to the random-port fallback.

**Per-session workspace routing.** Because one machine-wide proxy serves many sessions (each a different
repo), the injected worker / `code` / `run_workflow` MCP tools must target the ACTIVE session's project,
not the proxy's launch cwd. Each injected HTTP MCP server entry carries a `headersHelper` that Claude
re-runs per connection in the session's working directory (`github-router internal-workspace-header`),
emitting an `X-GH-Workspace: <session cwd>` header. The `/mcp` handler uses it as the default
`workspace`; an explicit `workspace` arg still overrides it. Under serve, an omitted-and-un-headered
workspace **fails loud** (never silently defaults to the launch dir) so a worker can't mutate the wrong
repo.

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
from the env and never placed in the mirror. The browser terminal can likewise read
`GH_ROUTER_HOOK_NONCE` from its own env — so the orchestration hooks' reach-back nonce is a **routing
tag, not an authorization secret**; the worker-guard / plan-review hooks are UX steering, never a
security boundary. This is inherent to a zero-login local control plane.

### Per-capability gating for remote (tunnel) access
Remote exposure (`--tunnel` / `--public-url`) is authenticated but **not necessarily single-user**, and
the control plane's capabilities span a wide privilege range (a shell, the filesystem, the operator's
browser identity, GitHub writes). So the two highest-blast-radius capabilities are **withheld by default
whenever the control plane is tunnel-exposed** (`tunnelExposed = --tunnel || --public-url`), gated in
`provisionServeEnhancements`:

- **browser MCP** — a server-side browser is a session-hijack / SSRF / cloud-metadata primitive when
  driven remotely. Enable over a tunnel only with `--browse-over-tunnel`.
- **first-mate** — mints a `repo+workflow` GitHub write token reachable from the web UI. Enable over a
  tunnel only with `--agents-over-tunnel`.
- **fleet** — drives remote coding sessions with the operator's stored fleet credentials
  (code-execution-by-proxy on remote instances). Enable over a tunnel only with `--fleet-over-tunnel`.

Local (loopback-only) serve is unaffected — both are gated purely on the tunnel-exposed condition, and
`serve` prints a one-line hint when it withholds a capability.

## CloudCLI resolution & install

Resolved in order: `--cloudcli-path <dir>` → an existing pinned install in the router-owned dir →
(unless `--no-install`) install the **pinned** `@cloudcli-ai/cloudcli` version into the router-owned
dir (local `npm i`, never `-g`, never `@latest`). Windows-safe exec throughout. The pinned version is
a tested known-good (1.36.1 at introduction); its native deps (`better-sqlite3`, `node-pty`) build on
Windows. On install failure (offline / proxy / missing build tools) `serve` prints the manual install
command rather than half-starting.

## Flags
`--port <n>` (default **5454** when free, else a random free port), `--cloudcli-path <p>`,
`--no-install`, `--cloudcli-version <v>`, `-m/--model <slug>` (accepts the `4.7`/`4.8` Opus-family
shorthand + default fallback-cache walk, like `github-router claude`), `--no-open`, `--tunnel`,
`--public-url <url>`, `--codex-cli`, `--browse-over-tunnel`, `--agents-over-tunnel`,
`--fleet-over-tunnel`, plus the shared
server args (including `--browse` / `--fleet` / `--agents`). `--browse` enables the **server-side**
browser MCP (it drives the machine running `serve`).

## Remote access via an authenticated dev tunnel

`serve` binds loopback and enforces a `Host` + `Origin` allowlist (DNS-rebinding + cross-origin
defense), so remote traffic is rejected by default. `--tunnel` makes it reachable from anywhere by
**automatically creating, hosting, and displaying an authenticated Microsoft dev tunnel** for the
serve port:

```bash
# one-time
winget install Microsoft.devtunnel      # or: brew install --cask devtunnel
devtunnel user login                    # or: devtunnel user login -g   (GitHub)

# each session — auto-creates + hosts the tunnel and prints its URL
github-router serve --port 5454 --tunnel
```

`serve` runs `devtunnel host -p <port>` for you (the tunnel client connects to the loopback port, so
the bind stays loopback), captures the public URL, allowlists it, and prints it as
`remote (tunnel): https://<id>-<port>.<region>.devtunnels.ms`. If the `devtunnel` CLI is missing or
you're not logged in, `serve` says so and keeps serving locally (you can then host manually with
`devtunnel host -p <port>`).

- **One STABLE tunnel per machine (bookmarkable URL, no leak).** A dev tunnel implicitly created by
  `host` is a PERSISTENT server-side object — killing the host process stops hosting but does not delete
  it, and Microsoft caps you at `TunnelsPerUserPerCluster` (10). So `serve` REUSES a single stable
  per-machine tunnel across launches, giving a **stable public URL you can bookmark** (same URL every
  launch). Mechanism: a deterministic tunnel id `serveTunnelId()` = `ghr-serve-<hash-of-hostname>` +
  the `github-router-serve` / `ghr-machine-<hash>` labels. Each launch it (1) ensures the stable tunnel
  exists (creates it labeled if absent), (2) **reconciles its ports** to exactly the current `--port`
  via per-port `devtunnel port delete`/`port create` — NOT `host <id> -p <newport>`, which 400s "Batch
  update of ports is not supported" (this per-port reconcile is what makes reuse correct across `--port`
  changes, the reason the old design couldn't reuse), (3) sweeps its OTHER idle labeled tunnels
  (pre-migration random-named ones / crash orphans) while keeping the stable one, then (4) `host <id>`.
  A live tunnel (>0 host connections, e.g. a concurrent serve instance) is never swept. NOTE: the URL's
  subdomain is a devtunnels-assigned token (e.g. `dh4vhtc2-<port>`), not the tunnel id — so the URL is
  stable/bookmarkable but not human-readable/named (devtunnel controls the subdomain). If any
  stable-path step fails (id taken by another owner sharing the account, CLI hiccup), it **falls back**
  to hosting a fresh anonymous-labeled tunnel, so `--tunnel` always works — just without a stable URL
  that launch. To prune pre-existing unlabeled leaks from before this change, `devtunnel list` then
  `devtunnel delete <id>` the random-named entries with 0 connections and no labels.

- **Authenticated, never anonymous.** `serve` never passes `--allow-anonymous`, so Microsoft's
  default applies: the tunnel is reachable only by the signed-in owner (an unauthenticated visitor is
  redirected to a Microsoft/GitHub login). To grant specific other identities, use
  `devtunnel access create ... --tenant`/`--org` out of band.
- **`--public-url <url>`** is the alternative for a manually-run or persistent tunnel: it allowlists
  an exact `host`+`origin` without auto-hosting (e.g. `--public-url https://id-5454.region.devtunnels.ms`).
- **Security:** the tunnel's authentication is the OUTER gate; the injected token is the inner gate.
  **Anyone you grant tunnel access to gets FULL control-plane access, including a shell on this
  machine** — only grant yourself or fully-trusted parties. `serve` prints this warning when remote
  access is enabled. A different dev tunnel can never forward to your loopback port, so accepting
  `*.devtunnels.ms` does not widen the same-user trust boundary.

## Known limitations
- The model picker is populated from the **live Copilot catalog** via the provider façade (picker-enabled
  models; each selection round-trips through the proxy's `resolveModel`). If the façade degrades to
  passthrough (a CloudCLI shape change), CloudCLI's own hardcoded list is shown instead.
- `serve` depends on CloudCLI's HTTP shapes (`/api/auth/*`, `/api/providers/*`, `/api/commands/list`,
  `SERVER_PORT`/`HOST` env, env-forward); the version is pinned so upstream changes can't silently break
  it, and every provider-façade rewrite fails closed to passthrough on an unexpected shape.
- `serve --agents` performs a **one-time** GitHub device-code login (a second, write-capable token —
  `repo workflow read:org`) on first launch, printing the code + verification URL to the terminal; the
  token is cached at `PATHS.GITHUB_AGENT_TOKEN_PATH` so subsequent launches read it and return immediately.
  Plain `serve` (no `--agents`) never triggers this. Complete the prompt in the launching terminal; if
  `serve` is started fully detached the poll will wait for authorization.

## SDK-vs-CLI surface audit — status of every override/intercept/patch point

CloudCLI drives Claude **headlessly via the Agent SDK** (`query()` → the resolved `claude` binary), but its UI was built for full Claude Code, so surfaces that assume interactive-CLI behavior need interception. The complete audit (four parallel surface sweeps) and the status of each surface:

**Addressed + intercepted/patched** (the core loop — frictionless): model picker (incl. the per-model **reasoning-effort selector** — the façade emits `effort.values` from each model's catalog `reasoning_effort`, so the UI effort picker drives `resolveClaudeEffort` end-to-end), MCP manager list, skills/slash menu, connected badge (all via the provider façade); the **`POST /api/system/update` block** (answered directly with a "managed by github-router" message so CloudCLI's update button can't run a global `npm i -g @cloudcli-ai/cloudcli@latest`); permission bypass + injected-MCP/native-research allow rules; built-in subagents (`Explore`/`Plan`/`general-purpose`); per-session workspace routing; the mirror settings/agents/skills/CLAUDE.md injection; the reverse-proxy HTML seed (`auth-token` + `claude-settings`) + Host/Origin enforcement; the filtered child env; and the mirror `settings.json` `env` **auth/routing/remote strip** (`sanitizeServeSettingsEnv` + `stripped-env-keys.ts` — coordinator-mode, `ANTHROPIC_BASE_URL`, `USE_BEDROCK/VERTEX/FOUNDRY`, real-auth tokens, Bridge/remote, model pins).

**Accept-and-document** (CloudCLI-inherent or external-dep, can't be made to work through the SDK-headless path):
- **`ExitPlanMode` / `AskUserQuestion` auto-resolve under bypass.** Both are `TOOLS_REQUIRING_INTERACTION` in the SDK; under serve's bypass default the SDK skips `canUseTool`, so ExitPlanMode auto-approves (inline plan buttons inert) and AskUserQuestion never reaches the operator (the model fabricates an answer and proceeds). To get interactive plan/questions, cycle the composer's permission mode off bypass (Tab → plan/default).
- **Voice** (`/api/voice`) needs `VOICE_API_KEY`/`VOICE_API_BASE_URL`, which the filtered env drops — the mic button reports `configured:false` and is unavailable.
- **Taskmaster** (`/api/taskmaster`) spawns `npx task-master` needing its own per-provider model keys (absent) — broken under serve.
- **CloudCLI's own browser-use** (`/api/browser-use`, distinct from github-router's `--browse`) is a separate Playwright feature; it is **inert until the user enables it**, but if enabled it self-registers a loopback browser MCP into the provider config the SDK reads (`nServerToAllProviders`), giving the model a **second, ungated** browser surface that bypasses our tunnel gating. Do not enable it under a tunnel.
- **Non-`claude` provider rows** (codex / cursor / opencode) appear in the provider switcher but are not faced by github-router (façade is claude-only), so they read "not connected" and never route through the proxy.
- **MCP manager is display-only under serve**: adding/removing a server in the panel writes CloudCLI's own store, not the mirror the SDK reads, so it won't reach Claude; our injected servers are re-appended each GET.
- **A user's own mirrored `hooks` / `mcpServers` / top-level `model` / `outputStyle` / plugins** run headless in the single-agent serve session; a TTY-assuming hook or a stdio MCP that needs a terminal may stall or no-op. Not currently filtered.



CloudCLI's stdout/stderr are `ignore`d by default (it is noisy and its logs aren't user-facing). To
inspect its internal errors (Agent-SDK, DB, session/project create), set `GH_ROUTER_CLOUDCLI_LOG=<path>`
before launching `serve`; the child's stdout+stderr are appended there. This is how the session-create
path was validated: CloudCLI's Express `body-parser` **correctly** rejects a malformed request body
(e.g. a Windows `projectPath` sent with un-escaped single backslashes — `"Q:\hobby"` is an illegal JSON
escape) with `entity.parse.failed`, surfaced as HTTP 500. A real browser always sends `JSON.stringify`-ed
bodies (backslashes escaped to `\\`), so session-create returns **HTTP 201** end-to-end; the reverse proxy
streams request bodies through **raw** (`clientReq.pipe(proxyReq)`, no parse/re-serialize), so it never
mangles escaping. When reproducing over `curl`, build the JSON body with a tool that escapes correctly
(e.g. `--data-binary @file` where the file was written by `JSON.stringify`) — a shell-quoted single-backslash
path is invalid JSON and will 500, which is CloudCLI behaving correctly, not a serve bug.

## Verification

**`bun run verify:serve`** (`scripts/verify-serve-session.mjs`) is the ground-truth check of what a serve
session's Claude actually sees. It boots serve to generate the mirror, then runs the real `claude` binary
in the SAME headless stream-json mode CloudCLI uses (`--print --output-format stream-json`) against that
mirror and inspects the `init` control message — asserting the registered **agents** (built-in
`Explore`/`Plan`/`general-purpose` + the injected peer/worker set), **MCP servers**
(`peers`/`search`/`workers`/`orchestrate`/`decide`), and `permissionMode: bypassPermissions`. This
verifies the mirror-injection layer directly, without depending on CloudCLI's Agent-SDK spawn (which is
sensitive to the launching shell's environment on Windows). Requires the `claude` binary
(`CLAUDE_CLI_PATH` or `~/.local/bin/claude`); skips cleanly otherwise.

Other checks (manual / `scripts/serve-ws-smoke.mjs`): browser opens already-logged-in; cross-origin WS to
the terminal is rejected; the CloudCLI terminal env has no `GITHUB_TOKEN`/`ANTHROPIC_*`; a session's
traffic appears in the proxy's `/usage`; teardown kills the child + proxy and removes the per-launch
mirror. `windows-latest` CI must be green.

### Known CloudCLI-inherent behaviors (not reachable by our injection)
`serve` runs Claude through CloudCLI's **Agent SDK** (headless), not the interactive `claude` CLI, and
github-router only writes the mirror + injects HTML — it does not modify CloudCLI. So a few interaction
behaviors are CloudCLI's own and unchanged by us:
- **Escape / Stop abort** is wired end-to-end (Escape → `chat.abort` → SDK signal; our proxy passes it
  through untouched) but armed only for the **currently-viewed** session while its run is `running` with
  a captured provider session id — an abort sent too early returns `NO_ACTIVE_RUN`, and viewing a
  different session disarms it.
- **Plan mode under the permission bypass**: `ExitPlanMode` auto-approves, so the inline plan
  Approve/Reject buttons have no pending request; interactive plan approval requires cycling the
  composer's permission mode off bypass (Tab), which re-enables prompts for that session.
