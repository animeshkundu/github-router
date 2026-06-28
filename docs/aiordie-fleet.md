# Fleet session control + remote artifact review (ai-or-die integration)

github-router hosts two MCP surfaces that let a single client LLM drive remote [ai-or-die](https://github.com/)
instances and the artifact-review loop inside its own tab. Both are off by default.

## `/mcp/fleet` — control sessions across many ai-or-die instances

One client Claude Code (running through github-router) controls the live AI-CLI sessions inside MANY ai-or-die
instances on different machines. Each instance is an authed HTTPS server (single Bearer token) reachable over
its Dev Tunnel; github-router holds a registry, routes by a globally-unique session id, and fans `await_turn`
long-polls out across instances.

- **Opt-in:** `--fleet` or `GH_ROUTER_ENABLE_FLEET=1` (gated like `--browse`). Off by default.
- **Registry:** `~/.local/share/github-router/fleet.json` (override `GH_ROUTER_FLEET_CONFIG`):
  `{ "instances": [ { "id", "label", "url", "token", "tunnelId?", "tunnelToken?", "insecureTLS?", "default?", "allowExec?" } ] }`.
  `url` must be **https** (or `http://localhost` for local testing) and carry no embedded userinfo. `token` is
  the instance's ai-or-die Bearer; it lives ONLY here, is sent as `Authorization: Bearer`, is NEVER returned by
  `list_instances`, and never enters the model's context. Keep the file `0600` (a warning is logged if it is
  group/other-readable).
- **Private Dev Tunnel auth (`tunnelId` / `tunnelToken`):** ai-or-die hosts its tunnel with
  `devtunnel ... --allow-anonymous` by default (ADR-0002/0032 there), so the **simplest setup is an anonymous
  tunnel** — the required ai-or-die Bearer is the real access control, and github-router needs no tunnel auth
  (it always sends `X-Tunnel-Skip-Anti-Phishing-Page: true`). For a **private** tunnel (one that 302-redirects to
  GitHub auth), set per instance one of:
  - **`tunnelId`** (recommended for private): the devtunnel tunnel NAME from `devtunnel list` on the host
    (e.g. `aiordie-myhost-gh` or `aiordie-myhost-gh.usw2`) — NOT the public URL subdomain. github-router
    auto-mints a `connect`-scope token via `devtunnel token <id> --scopes connect --json`, caches it per tunnel,
    and re-mints ~5 min before its 24h expiry. **Prerequisite:** the `devtunnel` CLI installed AND a one-time
    `devtunnel user login` **on the control-plane machine**, whose identity must have mint rights on **every**
    fleet tunnel. The connect token never enters logs or model context.
  - **`tunnelToken`** (manual fallback): a static `connect` token. Dev Tunnel tokens are 24h, fixed, and NOT
    refreshable, so this goes stale daily and must be re-pasted — prefer `tunnelId` or anonymous. A `tunnel `
    scheme prefix is normalized off; whitespace/empty is rejected.

  The token is sent as `X-Tunnel-Authorization: tunnel <token>` ONLY on a request whose host is the pinned
  `.devtunnels.ms` origin. Failures surface as an actionable `AUTH_FAILED` in the tool result (e.g. *"run
  `devtunnel user login`"* / *"verify tunnelId with `devtunnel list`"*), never an opaque `UNREACHABLE`; the
  provider backs off on repeated failures and force-re-mints once on a mid-session auth failure.
- **Direct-HTTPS self-signed instance (`insecureTLS`):** an ai-or-die instance reached directly over HTTPS
  WITHOUT a tunnel (e.g. `ai-or-die --https` on loopback or a trusted LAN host) serves a SELF-SIGNED cert
  (`CN=ai-or-die`, SAN = `localhost` / loopback / the primary LAN IP — note: NOT the `.local` mDNS name). The
  FleetClient uses the runtime's default `fetch`, which rejects that cert with `self signed certificate`, so set
  `"insecureTLS": true` on that instance to send `tls: { rejectUnauthorized: false }` for its requests only.
  Tunnel instances never need it (`*.devtunnels.ms` presents a valid public cert). **SECURITY:** this disables
  chain AND hostname verification for the one instance (so the IP/`.local`/`localhost` URL forms all work, but a
  MITM on the path could impersonate the host and capture the Bearer) — safe on loopback, a deliberate
  trade-off on a trusted LAN. It is scoped to that instance: the global TLS posture and the Copilot upstream are
  untouched, and the origin-pinning + `redirect:"error"` credential boundaries still hold. A non-boolean value
  is rejected at load (no silent coercion); so is `insecureTLS` on an `http` url (no TLS to relax) or on a Dev
  Tunnel instance (host under `*.devtunnels.ms`, or one carrying `tunnelId`/`tunnelToken`) — those already get a
  valid public cert, so the flag there would only weaken security. `insecureTLS` is never returned by
  `list_instances`. (Runtime note: the relax uses Bun's per-request `tls` option; under a Node/undici `fetch` it
  would silently no-op — the proxy runs on Bun.)
- **Addressing:** existing-session ops take a global `sessionId` of the form `instanceId:localId` and route by
  it; instance-scoped ops (`list_sessions`, `create_session`, reads) take an `instance` (id or label, resolved
  and echoed as `resolvedInstance`); ambiguous labels error; **no default** for create/exec/write.
- **Tools (`mcp__fleet__*`):** `list_instances` (probes reachability, ~5s cached), `list_sessions`,
  `read_session`, `session_status`, `send_message` (LOUD `isError` on unconfirmed delivery), `send_keys`,
  `respond`, `create_session`, `stop_session`, `await_turn` (server-managed per-client cursor; epoch/gap-safe;
  merges events across instances), `read_file`/`list_dir`/`search`/`git_show`. To spin up a remote
  `npx github-router@latest claude --browse`, call `create_session` with `agent: "claude"` + `start: true`
  (ai-or-die's claude bridge resolves that command); confirm headless start works on your ai-or-die build.
- **Safety:** the client (`FleetClient`) pins the registry origin and asserts every request stays on it, then
  sends the bearer (and any tunnel token) with `redirect:"error"` so a redirect can never re-send a credential
  to another origin and a private tunnel's 302→github-auth surfaces loudly. `create`/`stop` forward an
  `idempotencyKey` (ai-or-die dedupes it).
- **Implementation:** `src/lib/fleet/{registry,client,tools,tunnel-auth}.ts`; group registered in
  `src/lib/peer-mcp-personas.ts`; gate `fleetToolsEnabled()` in `src/lib/mcp-capabilities.ts` + `handler.ts`;
  opt-in in `src/lib/server-setup.ts` / `src/claude.ts`.

## `artifact_*` — remote HTML-artifact review feedback

When github-router launches a claude session inside an ai-or-die tab, ai-or-die sets `AIORDIE_BASE_URL`,
`AIORDIE_TOKEN`, `AIORDIE_SESSION_ID` on the process. The agent then uses three tools to run the lavish-style
review loop against ai-or-die's `/api/artifact/*` endpoints:

- `artifact_open({file})` — open/refresh the review for the tab's session; returns the panel `viewUrl`.
- `artifact_poll()` — long-poll for the human's queued annotations / layout warnings (structured tool result
  with a `next_step`).
- `artifact_reply({text})` — reply into the browser chat.

Gated by `artifactToolsEnabled()` (the env trio present). `AIORDIE_TOKEN` is in `STRIPPED_PARENT_ENV_KEYS` so a
nested launch cannot inherit the parent tab's token. Implementation: `src/lib/artifact/{client,tools}.ts`.

The ai-or-die consumer side lives in `docs/adrs/0032-*` and `0033-*` there.
