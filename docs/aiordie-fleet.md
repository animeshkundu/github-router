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
  `{ "instances": [ { "id", "label", "url", "token", "default?", "allowExec?" } ] }`. `url` must be **https**
  (or `http://localhost` for local testing). `token` is the instance's ai-or-die Bearer; it lives ONLY here,
  is sent as `Authorization: Bearer`, is NEVER returned by `list_instances`, and never enters the model's
  context. Keep the file `0600` (a warning is logged if it is group/other-readable).
- **Addressing:** existing-session ops take a global `sessionId` of the form `instanceId:localId` and route by
  it; instance-scoped ops (`list_sessions`, `create_session`, reads) take an `instance` (id or label, resolved
  and echoed as `resolvedInstance`); ambiguous labels error; **no default** for create/exec/write.
- **Tools (`mcp__fleet__*`):** `list_instances` (probes reachability, ~5s cached), `list_sessions`,
  `read_session`, `session_status`, `send_message` (LOUD `isError` on unconfirmed delivery), `send_keys`,
  `respond`, `create_session`, `stop_session`, `await_turn` (server-managed per-client cursor; epoch/gap-safe;
  merges events across instances), `read_file`/`list_dir`/`search`/`git_show`.
- **Safety:** the client (`FleetClient`) sends the bearer with `redirect:"error"` so a redirect can never
  re-send the token to another origin and an http→https hop surfaces loudly. `create`/`stop` forward an
  `idempotencyKey` (ai-or-die dedupes it).
- **Implementation:** `src/lib/fleet/{registry,client,tools}.ts`; group registered in
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
