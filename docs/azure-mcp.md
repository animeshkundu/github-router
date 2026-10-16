# Azure MCP groups: `ado` and `kusto`

Two scoped MCP groups expose Microsoft's Azure surfaces to the model, in the same
shape as the Bluebird integration ([`docs/bluebird-search.md`](bluebird-search.md)):

| Group | Server name | Endpoint | Tools |
| --- | --- | --- | --- |
| `ado` | `github-router-ado` | `https://mcp.dev.azure.com/{organization}` | whatever the remote advertises under the selected toolsets |
| `kusto` | `github-router-kusto` | `{cluster}/v1/rest/{query,mgmt}` | five static tools over an in-repo client |

Both are **off unless enabled**, and both mint their own Azure access token
through the already-authenticated `az` CLI. Neither token ever reaches a child
process: `ADO_MCP_TOKEN` and `KUSTO_TOKEN` are in the stripped-env key list
beside `BLUEBIRD_TOKEN`, so a value the operator exports for a manual run is
consumed by the router and removed from the environment Claude, Codex, and every
tool under them inherits.

## Enabling

```sh
github-router claude --ado --ado-org contoso
github-router claude --kusto-cluster https://example.kusto.windows.net --kusto-database Telemetry
```

| Flag | Effect |
| --- | --- |
| `--ado` / `--no-ado` | Expose / refuse the Azure DevOps group |
| `--ado-org <org>` | Organization. Overrides the git remote; naming one is itself an opt-in |
| `--ado-toolsets <csv>` | Toolsets to request. Default `repos,wit,pipelines,wiki` |
| `--ado-all-toolsets` | Request every toolset (sends no `X-MCP-Toolsets` header) |
| `--ado-write` | Omit `X-MCP-Readonly`, making mutating tools reachable |
| `--kusto` / `--no-kusto` | Expose / refuse the Kusto group |
| `--kusto-cluster <uri>` | Cluster origin. **Naming one is itself an opt-in** |
| `--kusto-database <name>` | Default database for calls that do not name one |

Environment equivalents: `GH_ROUTER_ENABLE_ADO`, `GH_ROUTER_ADO_ORG`,
`GH_ROUTER_ADO_TOOLSETS`, `GH_ROUTER_ADO_ALL_TOOLSETS`, `GH_ROUTER_ENABLE_KUSTO`,
`GH_ROUTER_KUSTO_CLUSTER`, `GH_ROUTER_KUSTO_DATABASE`. `GH_ROUTER_AZURE_MCPS=off`
(or `0` / `no` / `false`) suppresses every Azure surface including explicit
positives.

## Auto-enable on Azure DevOps repository discovery

Launching inside a checkout whose git remotes resolve to an Azure DevOps
repository turns **Bluebird and `ado`** on without a flag. `kusto` does not
auto-enable: a git remote carries no cluster identity, and guessing one would run
queries against the wrong data with the operator's credentials.

Resolution order per capability:

1. explicit negative (`--no-*`, or the kill switch),
2. explicit positive (`--*`, `GH_ROUTER_ENABLE_*`),
3. Azure DevOps remote discovery,
4. off.

**The trust question, answered rather than ignored.** A cloned repository's
`origin` is attacker-controllable, so this rule does derive authority from a URL
the user did not type. Four properties bound it:

- It can never enable writes. `--ado-write` is an explicit flag that discovery
  does not touch.
- It is suppressible per capability (`--no-bluebird`, `--no-ado`, `--no-kusto`)
  and wholesale (`GH_ROUTER_AZURE_MCPS=off`).
- The banner names both what turned on and the remote that caused it, so a
  session that suddenly has two more servers is explainable rather than
  mysterious.
- Kusto, the one surface that can read arbitrary data from an arbitrary cluster,
  requires an operator-named cluster that discovery never supplies.

The probe is one memoized, bounded (`5 s`) `git` read per process, and any
failure resolves to "not an Azure DevOps workspace" rather than failing the
launch. Tests inject a synthetic probe; see "Testing" below.

## Azure DevOps (`ado`)

### Authentication

`az account get-access-token --resource 2a72489c-aab2-4b65-b93a-a91edccf33b8`
(app-id / audience for the remote server, scope `Ado.Mcp.Tools`). `az` is a
`.cmd` shim on Windows, so every invocation goes through `resolveExecutable` /
`buildExecInvocation` in `src/lib/exec.ts` like the rest of the tree.

Microsoft documents the remote server as Entra-OAuth for clients that support the
interactive flow with a custom app registration. This proxy is not such a client:
it mints a bearer with the already-authenticated `az` session, which was verified
to work. A tenant without the `Ado.Mcp.Tools` enterprise application, without
admin consent, or without a matching `az login` fails at the launch probe with an
actionable warning, and the group is switched off rather than advertised empty.

### Read-only by default

`X-MCP-Readonly: true` is sent on every request. The header is the control: the
server removes the mutating tools from `tools/list` and refuses a mutation at
call time. Measured live (2026-10-15, read-only, `tools/list` only): with
`X-MCP-Toolsets: repos,wit,pipelines,wiki` the server advertises **20 tools**
under `X-MCP-Readonly: true` and **31** without it; across every toolset the
counts are **26** and **43**. The read-only set is a strict subset whose
difference is exactly the 11 tools named
`*_write` / `*_upload` / `*_create_*` / `upsert`.

`--ado-write` omits the header for an operator who explicitly wants mutations,
and prints a banner line so an elevated session is never silent. The two knobs
are **independent**: the toolset filter applies identically in both modes, so
`--ado-all-toolsets` alone can never produce a write tool (pinned by a test).

### Toolset selection

`X-MCP-Toolsets` accepts `all`, `repos`, `advsec`, `wit`, `pipelines`, `wiki`,
`work`, `testplan`, `elm`. **`core` and `repositories` are not valid values**
(they were a wrong guess in an earlier draft of this work and are rejected
client-side so the mistake cannot reach the wire). The curated default is
`repos,wit,pipelines,wiki`: pull requests and files, work items, builds, and
wiki, excluding the toolsets whose tools are off the main repository loop. The
four `core_*` tools are always present regardless of toolset.

### Why the tool list is dynamic

Every other group in `NON_PERSONA_MCP_TOOLS` is a frozen array of hand-written
entries, pinned at boot by `assertMcpToolSurfaceConsistent()`. This group cannot
be: the remote server owns the tool set, it is large, and its names and
descriptions change on Microsoft's schedule. Freezing twenty entries would mean a
transcription that drifts silently and a proxy release for every upstream rename.

So `tools/list` is forwarded from the upstream `tools/list`, and the two headers
above ARE the filter. What the static contract still guarantees:

- **Name uniqueness.** The dynamic entries are checked against the static
  registry at snapshot time, and a collision drops the upstream tool with a
  warning rather than shadowing a proxy tool. A duplicate would be worse than a
  missing tool: the model would call one name and reach the other's code.
- **Scope and capability symmetry.** Each entry carries `group: "ado"` and
  `capability: "ado"`, so the same list-time filter and the same call-time gate
  apply as to any static tool.
- **Read-only default.** The subset is whatever the server returned after being
  told `X-MCP-Readonly: true`, not a classification computed here.

The snapshot is taken **once at launch**, awaited (20 s bound) before the child
process starts, because `toolEntries()` is synchronous and cannot fetch. A
failure disables the group: an `ado` server that advertises no tools is worse
than an absent one, because the model would see the group, find nothing usable,
and have no way to tell whether the group or its own query was wrong.

The `action` argument on the dispatcher tools is advertised as a plain `string`
with no `enum`; the accepted values live only inside the description text. No
client-side classification is therefore possible, which is the second reason the
headers are the filter.

## Kusto (`kusto`)

### Why an in-repo client

There is no public Microsoft-hosted remote MCP endpoint for Azure Data Explorer.
The official route is the `kusto` namespace inside `@azure/mcp` 3.0.0: seven
tools, stdio transport, shipped as a **122 MB** platform binary needing a managed
.NET child process, for tools whose entire value is one authenticated POST to
`/v1/rest/query`. A wrong-shaped request here is a JSON body; a wrong-shaped
request there is a failed native spawn on the canonical Windows environment. The
router therefore owns a thin client.

### Read-only is enforced by the service

Every request carries **both**:

- the `x-ms-readonly: true` header, and
- `properties.Options.request_readonly_hardline: true` in the body.

Kusto documents both as unavailable to a `set` statement, so a hostile query
string cannot lift them. That is the property a leading-dot or text allowlist in
the client could not provide: Kusto composes multiple `;`-separated statements
per request, so "does this text contain a mutating command" is not a question a
prefix check answers. **The client performs no KQL inspection** and relies on the
service to refuse a mutation.

### Wire shape

| | |
| --- | --- |
| Query | `POST {cluster}/v1/rest/query` |
| Management (leading `.`) | `POST {cluster}/v1/rest/mgmt` |
| Body | `{db, csl, properties: {Options: {...}}}` |
| Audience | the cluster URI |

The query field is **`csl`**, not `query` — a `query` field is silently ignored
by the service. `truncationmaxrecords` (200) and `truncationmaxsize` (64 MiB)
bound the response; an 8 MiB client-side cap and a rendered-size cap bound it
again; a response over either is a stated truncation, never a silent short read.
The 8 MiB cap is counted in **bytes**, not UTF-16 code units, and a
`content-length` that already declares an oversize body is refused before the
body is buffered at all: a character count lets a multi-byte body past a budget
named in bytes.

Cluster references are normalized to a bare https origin. Anything else is
refused, because the value becomes both a request URL and an `az --resource`
argument: `http` would send a bearer in cleartext, a path would silently address
a different endpoint than the audience, and embedded credentials would be echoed
into a command line. Table and column identifiers interpolated into generated
commands (`| getschema`, `| take N`) are restricted to
`[A-Za-z_][A-Za-z0-9_]*` rather than escaped, because a smaller reviewable
surface beats an escaper.

### Tools

Five, all read-only, all in the `kusto` group:

| Tool | Arguments | Purpose |
| --- | --- | --- |
| `databases` | none | The databases this identity can see |
| `tables` | optional `database` | Tables and stored functions |
| `schema` | required `table`, optional `database` | Column names and types |
| `sample` | required `table`, optional `rows` (1-100), `database` | First N rows, as a grid |
| `query` | required `csl`, optional `database` | Arbitrary KQL |

`clusters_list` is deliberately absent: enumerating clusters is an ARM
(`management.azure.com`) operation on a different audience and token, so it had
no implementation path under the cluster-scoped token this client mints.

Results are rendered as a compact aligned grid, never raw wire JSON —
`{"Tables":[{"Columns":[{"ColumnName":…` is both unreadable to the model and
several times the tokens of the same content as columns and rows.

### Results at the relay boundary

Both groups' tool results pass through `relaySafeText` as the last transform
before they leave `/mcp`. A result over the relay cap spills **in full** to a
file and the model receives a bounded preview plus that path, instead of a
string truncated where the model cannot see it (the ADO client had its own 60k
character clip for exactly that, and it is deleted: clipping there made the
relay's "full result saved to" trailer untrue). Kusto's rendered-size cap
stays, because it bounds RENDERING work rather than relay size, and the spill
file carries that client's own truncation trailer so "full" is never read as
"everything the service had".

### Token refresh

One process-lifetime cache keyed by cluster URI (which is also the audience),
with a 5-minute refresh margin ahead of the reported expiry and **single-flighted**
refresh: concurrent callers that see the same expired entry await ONE `az`
invocation. A token whose expiry `az` does not report is used but **not cached**,
because a cache entry with no deadline can only be either immortal (serving a
dead token) or arbitrary (minting in a loop). A **401 alone** invalidates the
cached entry, so the retry (and every later call) mints a fresh token rather
than replaying the dead value. A **403 does not**, and is not reported as a
credential problem: ADX answers 403 for a valid identity that has no access to
the cluster or database, so invalidating would send the operator to
re-authenticate against a token that is fine while spawning an `az` call per
attempt that still 403s. The service's own text names the missing grant, so it
is read (under the same byte cap) and surfaced rather than replaced by a guess.
This is the same distinction `src/lib/token.ts` makes for GitHub: only a 401 is
a rejected credential, a bare 403 is not.

### Retries

429 and 5xx, plus transport failures, retry three times at 1/2/4 seconds, with
`Retry-After` winning when the service sends one (both the delta-seconds and
the HTTP-date forms, clamped to 300 s). Every request here is read-only, which
is what makes resending it safe:
no tool in this client mutates anything, by construction rather than by
convention, since read-only is enforced by the service. A 401 retries at most
once, and only after the cache invalidation above, so a second 401 from a
freshly minted token is a real auth verdict instead of something another `az`
call would fix. The ladder is injectable through the client's `retryDelaysMs`
seam; an empty array makes every retriable verdict final, which is how the
suites assert a verdict without paying the production backoff.

## Testing policy

The `docs/bluebird-search.md` policy extends verbatim to both clients: **unit and
end-to-end tests must not call the real Azure DevOps endpoint, a real Kusto
cluster, or a real repository.** Tests inject a fictional base URL, mock `fetch`,
and use synthetic paths, queries, organization names, and tokens. Live checks are
manual, read-only, and must never print or inspect an access token.

`tests/bluebird-test-isolation.test.ts` enforces this for the whole family. It
reads the live endpoint constants **out of the client sources** rather than
transcribing them, so a guard that would stop guarding when a constant moves
follows it instead, and it asserts that the protocol suites address only
IANA-reserved hosts (`example.*`, `.test`, `.invalid`) — a host that could
resolve to a real service is unrepresentable rather than merely discouraged.

`AdoMcpClient` takes an optional `baseUrl` for exactly this reason, so no test
ever names the production host.

## Related

- [`docs/peer-mcp-design.md`](peer-mcp-design.md) — the group system, the scoped
  `/mcp/<group>` endpoints, and the tool-surface minimality rule.
- [`docs/bluebird-search.md`](bluebird-search.md) — the sibling integration this
  one follows, including the shared Azure CLI token plumbing.
- [`docs/unsupported-features.md`](unsupported-features.md) — Anthropic surfaces
  with no Copilot equivalent.
