# Work IQ MCP group (`--workiq`)

The `workiq` group gives the model Microsoft 365 research: mail, files, chats, meetings and
sites, answered by the hosted Work IQ service. The proxy hosts an MCP server of its own and
acts as an MCP **client** to `https://workiq.svc.cloud.microsoft/mcp`, so the same login
serves Claude Code, Pi, `serve`, and any BYO client pointed at `/mcp` or `/mcp/workiq`.

It is opt-in: nothing is enabled implicitly and nothing is authenticated behind the
operator's back. The group appears only with `--workiq` (or `GH_ROUTER_ENABLE_WORKIQ=1`),
and only after a sign-in created by `github-router workiq auth`.

## Why the hosted service and not the CLI

The official Work IQ Claude plugin does not put the CLI in the request path. Its
`plugins/workiq/.mcp.json` points the client at the hosted Streamable HTTP endpoint; the
`workiq` CLI exists for its own auth bootstrap and a legacy stdio bridge. Because the
endpoint is directly reachable, the proxy speaks to it and the ~22 MB native CLI is not a
dependency.

The CLI's MSAL cache (`~/.work-iq-cli/msal_token_cache.dat`) is DPAPI-encrypted and opaque
outside .NET, so it is not a token source either. The proxy performs its own loopback
sign-in instead.

## Billing

Work IQ calls are served by the Work IQ service under a Copilot Credits usage-based plan.
They are **not** GitHub Copilot premium requests. That is the reason this group exists as a
separate surface: a research turn that fans out across mail, files and chats bills against
the Work IQ plan, and the `github-router` AIC ledger does not see it at all.

Entitlement is per tenant. A tenant without the plan (or without consent for the
`WorkIQAgent.Ask` scope) sees the sign-in fail or the service reject the call; the upstream
text is surfaced verbatim so an admin can act on it.

## One-time tenant setup

The public client id `ba081686-5d24-4bc6-a0d6-d034ecffed87` is the native client the
official plugin ships and the CLI prints. It carries no secret; it is not a credential.

A tenant that has never used Work IQ typically needs:

1. A Copilot Credits usage-based billing plan covering the Work IQ service.
2. The Work IQ service principal (`fdcc1f02-fc51-4226-8753-f668596af7f7`) present in the
   tenant, which is what the access token's audience names.
3. Admin consent for `api://workiq.svc.cloud.microsoft/.default`, which yields the
   delegated `WorkIQ.Act WorkIQ.Read WorkIQAgent.Ask` scopes.

`github-router workiq auth` is the check for all three: it reports Entra's own error text,
including `AADSTS65001` for missing consent, and exits non-zero so a scripted setup notices.

## Authentication

`github-router workiq auth` runs an authorization-code flow with PKCE (S256) against
`https://login.microsoftonline.com/organizations`:

- an ephemeral loopback listener (`server.listen(0)`, dual-stack so a browser resolving
  `localhost` to `::1` still lands) serves the redirect;
- the authorize URL carries the public client id, the scope string, a `state`, and the
  `code_challenge`; the browser is opened through the platform handler and the URL is also
  printed, so a headless operator can paste it;
- the code exchange posts the `code_verifier`; the response's `id_token`
  `preferred_username` becomes the display-only account name;
- the refresh token is written to `<APP_DIR>/workiq-token.json` (override
  `GH_ROUTER_WORKIQ_TOKEN_PATH`) through the same atomic temp-file-plus-rename write the
  GitHub credential uses, and the file mode is owner-only where the platform has one.

The sign-in itself usually needs no interaction because the browser already holds an Entra
session. Nothing prints a token: success logs the account, the expiry, and a SHA-256
fingerprint prefix, matching `src/lib/token.ts`.

`github-router workiq status [--json]` reports account, expiry, tenant, scope and path.
`github-router workiq logout` deletes the file. Both refuse to print the token.

### Refresh

`ensureWorkiqToken()` runs before the first Work IQ call and refreshes five minutes before
expiry, single-flight so concurrent first calls cannot each start a grant (Entra **rotates**
the refresh token, so a second grant would present an already-used value). The rotated
refresh token is persisted.

If a grant fails with `invalid_grant`, the token file is re-read and the grant retried once:
two proxy processes can share one login, and the one that did not refresh holds a value the
other has already rotated. A second failure surfaces Entra's text with the
`github-router workiq auth` remedy.

A rejected access token triggers exactly one forced refresh inside the MCP client, then the
session is reset (the server is stateless, so re-initializing is free) and the call retried.
A second rejection is reported, not retried.

## The tool surface

`--workiq` exposes the eight read tools the live server advertises:

| Tool | Purpose |
|------|---------|
| `ask` | Natural-language question answered across M365 |
| `retrieve` | Retrieval with a rendered answer and citation hits |
| `fetch` | Fetch one or more entities by URL (`entityUrls` batches server-side) |
| `fetch_blob` | Fetch a blob (attachment content) |
| `agents` | List the tenant's Work IQ agents (upstream name `list_agents`) |
| `get_schema` | Describe the entity/function schema |
| `search_paths` | Find entity paths by name |
| `call_function` | Read-only Work IQ function call (Graph functions use GET) |

`--workiq-write` additionally exposes `create_entity`, `update_entity`, `delete_entity`
and `do_action`, and prints a banner line because the session can now change M365 state.

The surface is **dynamic**, like `ado`: `tools/list` is forwarded from the upstream server
rather than frozen. Two deliberate filters sit in between:

- read-only mode keeps only `WORKIQ_READ_TOOLS`; a name outside both the read and write sets
  means the service shipped something new, and it is dropped **with a warning** naming
  `--workiq-write`, so the read surface is never silently narrower than the live one;
- a name the proxy already serves is dropped, as `ado` does.

`list_agents` is the one upstream name that collides today: the `cloudagent` group serves a
tool by that name, and `proxyOwnedMcpToolNames()` reserves it whether or not that group is
enabled. It is exposed to the model as `agents` (`mcp__workiq__agents`); only the MCP-facing
name moves, and the handler still calls the wire name.

The rename rule is the same one the browser tools use, and it is safe because dispatch keys
on `group`, not on the upstream name.

### Result shaping

`retrieve` puts its payload in `structuredContent["application/vnd.ms-workiq.retrieval"]`.
The documented shape there is a `markdown` answer beside `retrievalHits`, the citations the
markdown refers to with inline `[^id]` markers. That shape is preferred when the server
sends it: `workiqResultText` appends a compact sources block (title, entity type, URL),
capped at 25 entries, so the markers stay resolvable.

The live server (measured 2026-11) sends neither. Its retrieval object carries
`results`, and each hit carries its own `markdown` snippet with the display fields one
level down under `resourceMetadata` (an email hit's subject is
`resourceMetadata.email.subject`), plus `id` (`h1`, `h2`, ...), `webUrl`, `entityUrl`,
and `entityType`. There is no top-level markdown and no `content` block. Falling through
to the generic JSON path handed the model 44 KB of raw JSON that then hit the relay cap,
so the hits are rendered as numbered sections instead:

```
[h1] Q3 review (email)
https://outlook.office.com/mail/...
<the hit's markdown>
```

A hit with no body still contributes its source line. An empty retrieval returns
"Work IQ found no results." rather than the empty structured JSON.

Failure arrives two ways and both throw rather than reach the model looking like an answer:
`isError: true`, or a successful envelope whose `stoppedReason` is `error`/`cancelled`. The
service's own `recoveryAction` is kept in the message.

Every result then passes through `relaySafeText`, so a result over the relay cap spills in
full to a file with a bounded preview and that path, exactly as on `ado`. A
`strategy: "copilot"` retrieval can return 20-plus hits and well over the cap, and `fetch`
is the common case rather than an edge one: it returns whole entity bodies, and three email
`entityUrls` in one call measured about 198 KB. The spill is the contract working as
designed: nothing is dropped, and the model reads the file with `offset`/`limit`. `fetch`
accepts several `entityUrls` per call, so one batched call costs one round trip.

### Request deadline

The shared transport defaults to a 30-second per-request deadline, which is right for a
control-plane server. Work IQ's `ask` and `retrieve` are not lookups: they run a model over
the tenant's indexed content. The first live retrieval was killed at 30.004 s, so
`WorkiqMcpClient` passes `requestTimeoutMs: 180_000`. Measured live: `retrieve` 12-38 s,
`ask` 38-51 s, `search_paths` under a second.

## Parallel research

Parallel research needs no special tool. A model issues concurrent `workiq` calls in one
turn and the existing shared `MAX_INFLIGHT_TOOLS_CALL` budget bounds them like any other MCP
traffic; `fetch` additionally batches several `entityUrls` per call. The MCP server is
stateless, so concurrent calls do not contend for a session.

## Launch behavior

`setupAndServe` awaits `provisionWorkiqTools()` after the ADO block, before the child spawns.
It runs `initialize` plus the paginated `tools/list` under a 20-second abort and snapshots
the filtered surface, because the handler's tool accessor is synchronous.

A failed provision **turns the group off** with an actionable warning: no login, consent
failure, unreachable network, or an empty surface. A `workiq` server that advertises no
tools is worse than an absent one. The launch itself never fails over a network or consent
dependency.

`WORKIQ_MCP_TOKEN` supplies a raw bearer for tests and manual runs and is stripped from every
spawned child, alongside the other credential keys.

`serve` refuses the group over a tunnel unless `--workiq-over-tunnel` is passed, matching
`--ado-over-tunnel`: the tunnel would otherwise widen who can drive a service that reads the
whole tenant.

Profiles that admit `ado` admit `workiq`; Standard stays unrestricted.

## Known limits

- **Continuous-access-evaluation challenges are not threaded into the refresh.** The shared
  transport discards 401 response headers, so the behavior is: refresh once, and if the
  server still rejects, report the `workiq auth` remedy. Revisit only if a real claims
  challenge appears.
- **The read allow-list is keyed to documented names.** An upstream rename drops that tool
  with a warning; `--workiq-write` exposes whatever the live server actually advertises.
- **`github-router codex` writes no MCP config**, so Codex cannot use the group yet. BYO
  clients that point at `/mcp` or `/mcp/workiq` can.
- **The token file is a bearer in the clear on disk**, like the GitHub credential. It is
  written atomically with owner-only permissions where the platform supports them; there is
  no OS keychain integration.

## Related

- [`azure-mcp.md`](azure-mcp.md) and [`cloudagent-mcp.md`](cloudagent-mcp.md) — the other
  remote-MCP groups, and the source of the provisioning and scoping patterns this group
  reuses.
- [`../CLAUDE.md`](../CLAUDE.md) — group enumeration and the `workiq` subcommand.
