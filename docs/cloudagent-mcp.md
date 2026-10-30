# Cloud Agent MCP group: `cloudagent`

The `cloudagent` group exposes Microsoft's **Cloud Agent Job API v2** as eight MCP tools
(`mcp__cloudagent__*`). Cloud Agent runs an autonomous coding agent in the cloud against
an Azure DevOps repository: you hand it a prompt, it clones the repository,
works for hours, and finishes with a written summary and (usually) a pull
request. The group is what lets a model hand work to that service, watch it, and
collect the result.

> Not to be confused with [Cloud Agent Hub](cloudagent-hook-isolation.md), the internal
> Claude Code distribution whose hooks this repo filters out of mirrored
> settings. Different service, different problem.

## Why a sibling group, not an orchestration step

`src/lib/orchestration/` already composes work, so it is fair to ask why Cloud Agent
is not a producer kind there. The kernel is a strictly sequential in-process
DAG: a fresh local worktree per write producer, in-memory-only state, and a
`selectChampion` gate that needs a locally executable `GateOutcome`. A remote
multi-hour job satisfies none of that, and every Cloud Agent run would fail closed to
the baseline.

So the group is modelled on `kusto`: **the calling model drives the chain and
the Cloud Agent API is the ledger.** `list_jobs` returns every job with its prompt,
`metadata` labels and outcome, so a research → plan → iterate → implement
sequence survives a restart, a compaction, or a different session. Nothing is
tracked locally; there is no state to lose.

## Enabling

| Surface | Effect |
|---|---|
| `--cloudagent` / `GH_ROUTER_ENABLE_CLOUDAGENT=1` | All eight tools, including `create_job` and `cancel_job` |
| Azure DevOps git remote discovered | The **six read tools only** |
| `--no-cloudagent` / `GH_ROUTER_DISABLE_CLOUDAGENT=1` | Never |
| `GH_ROUTER_AZURE_MCPS=off` | The shared wholesale kill switch; suppresses the discovery enable too |
| `--cloudagent-env prod\|ppe` / `GH_ROUTER_CLOUDAGENT_ENV` | Selects the service; does **not** enable the group |

Precedence per half: explicit negative → explicit positive → discovery → off.
The flag is tri-state (`undefined` = absent, `true` = asked for, `false` =
refused) because "off unless discovered" is only safe while an operator can
always say no.

### The read/write split is the load-bearing part

`create_job` and `cancel_job` carry the `cloudagent_write` capability and require
the explicit flag. Discovery never enables them.

`src/lib/azure-mcp-flags.ts` states the invariant for the Azure groups: a
git remote that turned a group on can never produce a write surface. A clone's
`origin` is attacker-controllable, and the read tools are the whole reason the
auto-enable exists; a job, by contrast, spends hours of real compute. So the
discovered half is the six read tools, and the launcher banner says so
explicitly (`Cloud Agent MCP (prod): read-only, enabled by the git remote.`) — a
model that can see `list_jobs` and not `create_job` will otherwise look for the
missing tool and call it a bug.

The discovery probe is shared and memoized with the Azure groups
(`discoverAzureRepo()` runs once), so the split costs no extra `git remote -v`.

### Profiles

`"cloudagent"` is in every group allow-list in `src/lib/launch-profile.ts`. A
profile that hid a group the operator explicitly asked for would be worse than
one that honours it, and discovery can only ever surface the read tools anyway.

`github-router serve` adds one more gate: with a tunnel exposed, the group is
off unless `--cloudagent-over-tunnel` is passed, because the tools act with the
operator's `az` identity and `create_job` spends compute on a surface reachable
from outside the machine.

## The job lifecycle (measured, 2026-10-29)

These numbers decide the tool contracts, so they live here rather than only in
the commit that probed them:

- **One-shot.** No continuation, no follow-up message, no resume. Iteration is a
  sequence of jobs.
- **Hours, not minutes.** Over the last 25 jobs: median 221 min, min 13 min, max
  416 min. The minimum is why `wait_for_job` cannot be a wait for completion.
- **The deliverable is a tool call.** A successful job's final `task_complete`
  call carries `arguments.summary`, the agent's full markdown answer. It is
  reachable only through `GET /jobs/{id}/logs`, which is 233 KB to 7.5 MB of
  `chatHistory`. A failed job has no `task_complete`.
- **`toolDiffs` is empty on every sampled job**, successful or failed. "What
  changed" is derived from the trace (`edit`/`create`/`write` call arguments),
  never from that field.

## Tool surface

| Tool | Capability | Contract |
|---|---|---|
| `create_job` | `cloudagent_write` | Returns immediately with the job id and the normalized request |
| `cancel_job` | `cloudagent_write` | `POST /jobs/{id}/cancel` (not under `/v2/`); irreversible |
| `get_job` | `cloudagent` | The poll. The summary leads on a terminal job |
| `list_jobs` | `cloudagent` | The durable ledger; defaults to the workspace's repository |
| `wait_for_job` | `cloudagent` | Short bounded wait: "did it start?" |
| `get_job_logs` | `cloudagent` | `digest` (default) or `full` |
| `list_plugins` | `cloudagent` | The real capability selector; `name_contains` searches the whole catalog |
| `list_agents` | `cloudagent` | Today it returns one agent; still the only source of `customAgent.inputs` |

`create_job` arguments: `prompt` (or `agent`), the repository triple
(`organization`/`project`/`repository`) or a `workspace` checkout, `branch`,
`agent` + `agentType` + `agentInputs`, `plugins[]` + `includeDefaultPlugins`,
`model`, `reasoningEffort`, `context` (`default` | `long_context`), and
`metadata` (short string labels such as `{"chain": "research", "step": "1"}`).

### Optional arguments are defaults, not questions

No tool marks an optional argument as required, and every one of them works
when omitted. That is deliberate: a schema full of optional properties reads to
a model as a form to fill in, and a live session showed exactly that failure —
`list_jobs` called with an empty `organization`/`project`/`repository` triple
and a `pageSize` of `0`, all of which the service rejected.

So each optional argument has a default the tool applies or states, and its
description names that default and what overrides it:

| Argument | Default |
|---|---|
| repository triple / `workspace` | read from the session workspace's git remote; `list_jobs` drops the filter when neither is available |
| `branch` | the repository's default branch |
| `agent` | the service's standard agent |
| `plugins` | none beyond what the service enables by default |
| `model`, `reasoningEffort` | the service's and the model's own defaults |
| `context` | `default` |
| `pageSize` (jobs) | 25 |
| `top` (catalog) | 50 |
| `skip` | 0 |
| `max_wait_s` | 25 |
| `mode` / `tail` (logs) | `digest` / 12 |

Fixed sets are enumerated in the description rather than left to the model to
guess: `context` is `default` or `long_context`, `agentType` and the catalog
`type` filters are `Repo`/`Organization`/`Company`/`Spec`, and `mode` is
`digest` or `full`. The two values that genuinely belong to the service —
`model` and `reasoningEffort` — stay free strings, because enumerating a
vocabulary the service owns would rot the moment it adds a model, and the
service's rejection is already actionable.

Empty expressions of absence are treated as absent: `optionalString` maps `""`
to unset and `optionalInt` maps `0` to unset wherever `0` is not a legal value.
Where `0` IS legal (`skip`), it passes through untouched.

### `list_plugins`: a name search has to read the catalog

`GET /plugins` has no name filter and refuses `top > 100`, so a filter applied to
one page would answer "no plugin for X" while 183 of the 233 entries had never
been looked at. Measured live: `name_contains: "repo"` over the default page
returned 0 matches; over the whole catalog it returns 5.

So the proxy pages the catalog itself. The first page carries `totalCount`, and
the remaining pages are fetched **concurrently** because one `GET /plugins`
costs 2-11 s regardless of page size (three sequential pages made the search
take 40 s; parallel paging takes ~20 s). The result states its search space, so
a miss is trustworthy:

```
[name_contains "repo": 5 match(es) in all 233 plugin(s)]
```

With `name_contains`, `top` and `skip` window the **matches**, not the catalog.
Paging stops at 1000 entries, and the header says so if it ever does, so a
truncated search is never read as an empty one.

### Selectors that are deliberately absent

- **`state` / `status` / `top` on `GET /jobs`** are silently ignored by the
  service. Exposing them would hand the model a filter that looks like it works
  and does not, so `list_jobs` does not accept them.
- **`validate_job`** (`POST /v2/jobs/validate`) is cut: it returns the same 400
  a create returns, and a rejected create stores nothing, so it tells the model
  nothing new. It fails the "what would the model do with this?" test.
- **`inheritFrom`** is cut. `GET /jobs/{id}` does not return
  `modelConfiguration`, so an inherited follow-up would silently drop the effort
  and context tier — an inheritance that looks like it worked. Instead
  `create_job` echoes the normalized request it sent under `effective request:`,
  so a follow-up passes those lines forward explicitly and verifiably.

### Why `create_job` returns instead of waiting

The tool description carries the contract: a job is **ONE-SHOT**, runs
unattended for hours (median 221 minutes), cannot be messaged or resumed, and
the model should confirm with the user before creating a job the user did not
ask for. After it returns, the caller polls with `get_job` or makes one
`wait_for_job` call.

### The repository, and provenance

The repository is the explicit triple when given, otherwise read from a
checkout's git remote. The workspace is resolved by the MCP boundary
(`X-GH-Workspace` session header, or the caller's own `workspace` argument), and
the result records which. Only the inferred case carries a provenance line:

```
[repository: contoso/platform/web (inferred from this session's workspace)]
```

There is no `process.cwd()` fallback for `create_job`. The proxy is started once
from wherever the operator was, and a stale cwd spending real compute against
the wrong repository is not a recoverable mistake. A partial triple is an error
for the same reason: it would either be guessed or silently ignored.

### `wait_for_job`

`wait_for_job(jobId, max_wait_s = 25, hard max 50)` polls every ~3 s and returns
the moment the job leaves `Queued` (compute was invoked) or reaches a terminal
state; otherwise it reports "still `Queued` after N s".

50 s is not an arbitrary convenience. A raw-JSON MCP client is capped near 60 s
per call ([#50289](https://github.com/anthropics/claude-code/issues/50289)), and
no wait that fits in one call can observe a terminal state anyway — the fastest
observed job took 13 minutes. So the contract is deliberately the one question a
short wait can answer: **did the handoff take, or is this stuck in the queue?**
Long-horizon checking is `get_job`.

### `get_job`: the summary leads

For a terminal job, `get_job` fetches the trace once, extracts the
`task_complete` summary, and renders it **first**, above state and metadata. The
model quotes the top of the result, so burying the answer under five metadata
lines is how a correct call produces a useless turn.

A running job ends with a cadence line so a model does not burn turns re-polling
a state that cannot have changed:

```
next: check again in ~10 min; job created 45 min ago.
```

Summary results are cached per environment and job id, **including negative
answers**. `null` is meaningful: it records "the trace was read and has no
summary", which is the normal case for a failed job, and without it every poll
would re-download a multi-megabyte trace to learn the same nothing. A transient
read failure is never cached, so it cannot poison the answer.

### `get_job_logs`

`mode: "digest"` (default) renders, in value order: terminal state and outcome,
the `task_complete` summary (or a line saying none was produced), the final
failing tool call with a bounded slice of its result, a tool histogram
(`view=66 powershell=57 grep=49 edit=12`), the changed files, and the last
`tail` calls (default 12).

The changed-files list excludes the agent's own runtime directories
(`%LOCALAPPDATA%\agency\`, `%TEMP%`, `.engram/`, the checkout's `tmp/` and
`home/`). Measured on one live job: 15 of the 16 "changed files" were plugin
bundles the review skill had staged for itself, and only one was the source file
the job actually edited.

`mode: "full"` hands the raw body to `relaySafeText`, which spills anything
over the relay cap to a file under `PATHS.WORKER_DIFFS_DIR` and returns a
bounded preview plus the path. That is not an edge case: every live trace is
larger than the cap.

### A failed job is not a failed call

`isError` is reserved for input-shape failures. A job that ended `Failed` is a
normal result: it renders `outcome.code`, `outcome.description`,
`jobOutcomeType` (who is responsible) and the tail of the trace, so the model
diagnoses instead of retrying the same call.

## Token: acquired and managed by the proxy

The operator never supplies an Cloud Agent credential. Nothing beyond an existing
`az login` is required — the same login the `ado` and `kusto` groups use.

- **Mint.** `az account get-access-token --resource <App ID URI>` through the
  shared `AzCliAccessTokenCache` (`src/lib/azure-cli-token.ts`). The resource is
  per environment, because prod and PPE are different audiences. Both the
  audience and the destination come from one table in
  `src/lib/cloudagent-client.ts`, so they cannot drift apart.
- **Hold.** In memory only, keyed by Entra resource, refreshed on the token's own
  expiry, single-flighted so concurrent tool calls share one `az` process. There
  is no token file. Unlike the GitHub PAT, this cache never reaches disk.
- **Recover.** A 401 drops the cached entry and retries exactly once. A 403 does
  **not** invalidate: the token was accepted and the service returned an
  authorization verdict, so the message says that rather than sending the user
  to `az login`.
- **Never prompt.** `allowInteractiveLogin` is `false`, a deliberate divergence
  from Kusto. A device-code prompt raised inside a spawned `claude` session is
  invisible to the user and looks like a hang; Kusto is read-only, this group
  can spend compute. A missing session fails fast with `az login` guidance.
- **Never redirect.** There is no configurable base URL and no per-call
  environment argument. The destination is a two-value enum and the token's
  audience is the same mapping, so no argument or env var can point the bearer
  at another host — the `COPILOT_HOST_ALLOWLIST` argument applied by removing
  the knob rather than validating it.
- **Never leak.** The bearer enters no log line, error message, tool result or
  spill file. `GH_ROUTER_CLOUDAGENT_TOKEN` (a test/operator override of the token,
  never the destination) is in `STRIPPED_AUTH_ROUTING_ENV_KEYS`, so the spawned
  CLI and everything under it cannot see it.

## Clients that receive the group

`claude` (`src/claude.ts`), `serve` (`src/lib/serve/enhancements.ts`, with the
`--cloudagent-over-tunnel` gate described above), and the Pi launcher
(`src/lib/pi-mcp-config.ts` + `src/pi.ts`). `codex` is registry-driven and picks
the group up with no change. As with every scoped group, a collision with a
user-owned `mcpServers` entry named `cloudagent` is resolved to
`gh-router-cloudagent`, not dropped.

## Testing policy

- `tests/cloudagent-client.test.ts` and `tests/cloudagent-tools.test.ts` are hermetic:
  an injected client (a literal token provider, a scripted `fetchImpl`, an empty
  retry ladder), no network, no `az`. The only real subprocess is `git`, against
  a throwaway repository in the OS temp dir — the actual lookup path rather than
  a mock of it.
- The live origins are not transcribed in fixtures. `cloudAgentBaseUrl()` is the
  single source, and `tests/bluebird-test-isolation.test.ts` reads the
  environment table out of the client source and fails if any Azure suite names
  a live endpoint. That guard is also the one place the two origins are pinned
  by value, because a swapped prod/ppe mapping would half-work.
- `tests/isolated/cloudagent-tools-spill.test.ts` covers the relay spill in its own
  process, because `mock.module("node:os")` is process-global.
- The token-leak assertion is symmetric with the wire assertion: the suite
  first proves the bearer is on the request, then that it appears in no rendered
  result.

## Related

- [`azure-mcp.md`](azure-mcp.md) — the `ado` and `kusto` groups, the shared
  discovery probe, and the auto-enable rule this group follows.
- [`peer-mcp-design.md`](peer-mcp-design.md) — the MCP tool-surface minimality
  principle every field here was checked against.
- [`cloudagent-hook-isolation.md`](cloudagent-hook-isolation.md) — Cloud Agent Hub, a
  different Microsoft product with an unrelated hook problem.
