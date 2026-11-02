# Cloud Agent MCP group: `cloudagent`

The `cloudagent` group exposes Microsoft's **Cloud Agent Job API v2** as ten MCP tools
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
| `--cloudagent` / `GH_ROUTER_ENABLE_CLOUDAGENT=1` | All ten tools, including `create_job`, `create_pr_job` and `cancel_job` |
| Azure DevOps git remote discovered | All ten tools, by the same route the `ado`, `kusto` and Bluebird groups take |
| `--no-cloudagent` / `GH_ROUTER_DISABLE_CLOUDAGENT=1` | Never |
| `GH_ROUTER_AZURE_MCPS=off` | The shared wholesale kill switch; suppresses the discovery enable too |
| `--cloudagent-env prod\|ppe` / `GH_ROUTER_CLOUDAGENT_ENV` | Selects the service; does **not** enable the group |

Precedence: explicit negative → explicit positive → discovery → off.
The flag is tri-state (`undefined` = absent, `true` = asked for, `false` =
refused) because "off unless discovered" is only safe while an operator can
always say no.

### One switch, write tools included

`create_job`, `create_pr_job` and `cancel_job` keep the distinct
`cloudagent_write` capability, but it is a label for the tools that spend cloud
compute, not a second gate: it resolves through the same
`cloudAgentToolsEnabled()` predicate the seven read tools use.

That is a deliberate reversal of an earlier read-only design. The original
argument was the Azure invariant in `src/lib/azure-mcp-flags.ts`: a git remote
that turned a group on can never produce a write surface, because a clone's
`origin` is attacker-controllable. Two things carry the risk now:

- The operator's veto, `--no-cloudagent` / `GH_ROUTER_DISABLE_CLOUDAGENT=1`,
  which beats discovery.
- The create tools' own descriptions, which tell the model to confirm with the
  user before creating a job the user did not ask for.

Against that, a half-enabled group was the worse failure mode: a model that can
see `list_jobs` and not `create_job` reads the gap as a bug and spends turns
looking for the tool that is missing. Enabling a group wholesale from the
discovered remote is what the `ado`, `kusto` and Bluebird groups do too; the
difference is that Cloud Agent's create tools need no second opt-in, which is
why the veto and the confirmation guidance carry that weight instead. An Azure
DevOps checkout is the same evidence the operator works in the ecosystem in all
four cases.

The discovery probe is shared and memoized with the Azure groups
(`discoverAzureRepo()` runs once), so the group costs no extra `git remote -v`.

### Profiles

`"cloudagent"` is in every group allow-list in `src/lib/launch-profile.ts`. A
profile that hid a group the operator explicitly asked for would be worse than
one that honours it.

`github-router serve` adds one more gate: with a tunnel exposed, the group is
off unless `--cloudagent-over-tunnel` is passed, because the tools act with the
operator's `az` identity and `create_job` spends compute on a surface reachable
from outside the machine.

## The job lifecycle (measured, 2026-10-29)

These numbers decide the tool contracts, so they live here rather than only in
the commit that probed them:

- **One-shot.** No continuation, no follow-up message, no resume. Iteration is a
  sequence of jobs.
- **Tens of minutes to hours, never seconds.** The 2026-10-29 probe sampled the
  organization's 25 most recent jobs: median 221 min, max 416 min. Both
  reproduce exactly from the ledger on 2026-11-01, so the sample is identifiable;
  the 13-minute minimum stated here originally does not, because that window's
  minimum is 32 min. That window is rolling, so the figures move: over the 161
  jobs in the organization's ledger on 2026-11-01 the distribution was min 3 min,
  p25 30 min, median 66 min, p75 148 min, p90 336 min, max 447 min, and **no job
  finished in under 60 seconds**. The minimum is why `wait_for_job` cannot be a
  wait for completion, and it is a claim about the floor rather than about the
  median.
- **The deliverable is a tool call.** A successful job's final `task_complete`
  call carries `arguments.summary`, the agent's full markdown answer. It is
  reachable only through `GET /jobs/{id}/logs`, which is 233 KB to 7.5 MB of
  `chatHistory`. A failed job has no `task_complete`.
- **`toolDiffs` never carries diff content.** Re-sampled on 2026-11-01 against
  five logs, four returned `[]` and one returned a 65-element array whose every
  entry was `{"id": …, "fileDiffs": []}`. So "always `[]`" is imprecise and the
  decision is unaffected: the field can be populated per tool call while every
  `fileDiffs` is empty, and "what changed" is derived from the trace
  (`edit`/`create`/`write` call arguments) rather than from that field.
- **Two agent runtimes share the service.** `agentPlatform` was `Agency` on 33 of
  62 live jobs and `SweAgent` on the other 29, so it is a real discriminator
  rather than the constant the first samples suggested. No tool selects it; the
  client parses it and does not render it, because knowing which runtime ran a
  finished job explains a difference after the fact and changes nothing a caller
  can do next.

### The write path, measured (2026-10-30)

One approved probe job: created, then cancelled as soon as it was seen running.

- `POST /v2/jobs/validate` succeeds but returns a **projected bare UUID**, not the
  id `create_job` returns (`<org>-<uuid>`), and that projected id 404s on
  `GET /jobs/{id}`. A second, independent reason `validate_job` is not exposed:
  its answer is not a handle to anything.
- **Dispatch happens about a second after create.** The probe left `Queued` for
  `InProgress` in ~0.9 s, so a "cancel while it is still queued" plan has no
  window to aim at. `wait_for_job` reporting "still `Queued` after N s" is the
  stuck case, not the normal one.
- **Cancel to terminal took about 2 minutes 14 seconds**, with zero agent
  messages in the trace. `cancel_job` stops the run, not the compute already
  allocated: it is not a refund and not an instant stop, so a caller should not
  poll in a tight loop after it.

## Tool surface

| Tool | Capability | Contract |
|---|---|---|
| `create_job` | `cloudagent_write` | Returns immediately with the job id and the normalized request |
| `create_pr_job` | `cloudagent_write` | `create_job` with the `agency-coding` and `agency-review` plugins, the `complex` tier, a required `title`, and a fixed request-to-pull-request workflow prepended to the prompt |
| `cancel_job` | `cloudagent_write` | `POST /jobs/{id}/cancel` (not under `/v2/`); irreversible |
| `get_job` | `cloudagent` | The poll. The summary leads on a terminal job |
| `list_jobs` | `cloudagent` | The durable ledger; defaults to the workspace's repository |
| `wait_for_job` | `cloudagent` | Short bounded wait: "did it start?" |
| `get_job_logs` | `cloudagent` | `digest` (default) or `full` |
| `list_plugins` | `cloudagent` | The real capability selector; `name_contains` searches the whole catalog |
| `list_agents` | `cloudagent` | The only source of `customAgent.inputs`; `Repo` scope lists a repository's own agents |
| `list_models` | `cloudagent` | The live model catalog behind `create_job`'s `tier` presets |

`create_job` arguments: `prompt` (or `agent`), `tier` (`easy` | `normal` |
`complex`), the repository triple (`organization`/`project`/`repository`) or a
`workspace` checkout, `branch`, `agent` + `agentType` + `agentInputs`,
`plugins[]` + `includeDefaultPlugins`, `model`, `reasoningEffort`, `context`
(`default` | `long_context`), and `metadata` (short string labels such as
`{"chain": "research", "step": "1"}`).

### Tiers: one word instead of a model id and an effort

Left to itself, `create_job` would either send no `modelConfiguration` and let
the service pick, or make every caller guess ids from a catalog the service does
not document. So `create_job` takes `tier`, and each tier is a preset of model
**and** effort, all three measured present in the live catalog and accepting
`max` (2026-10-31):

| `tier` | Model | Effort |
|---|---|---|
| `easy` | `claude-opus-4.8-fast` (preview model) | `max` |
| `normal` (default) | `gpt-6-astra` | `max` |
| `complex` | `claude-opus-5.5` | `max` |

The presets are constants, not catalog queries: a tier that silently changed
model because the catalog shifted would make two identical calls bill
differently. `claude-opus-4.8-fast` is flagged `preview: true` upstream, so
`list_models` is the check to run in an unfamiliar environment, and its row
says so.

Overrides, in precedence order:

- **`model`** replaces the tier's model **and discards its effort**, because
  8 of the 25 catalog models do not accept `max`; inheriting the preset effort
  would turn a valid model choice into a 400. The model's own default effort
  applies unless `reasoningEffort` is also given.
- **`reasoningEffort`** always wins, and given without `model` it keeps the
  tier's model.
- **`context`** (`default` | `long_context`) is independent of the tier.

`create_job`'s result echoes the resolved choice in the `effective request:`
block as a `tier:` line, since `GET /jobs/{id}` never returns
`modelConfiguration` and the echo is the only record of what was sent.

### `create_pr_job`: one request in, one review-ready pull request out

`create_job` requires the caller to know four things beyond the task: which
plugins provide the Azure DevOps write tools and the review orchestrator, which
model suits long-horizon work, which engineering process the job should follow,
and what the job should be called. `create_pr_job` takes the task and a title
and fixes the rest:

- **Plugins.** `agency-coding`, measured live on 2026-10-31 (`Company` scope,
  not enabled by default; the whole 235-entry catalog has no default-enabled
  plugin), provides branch, commit, push, pull request, pipeline and work item
  tools. `agency-review`, measured live on 2026-11-01 at the same scope,
  bundles the review orchestrator and specialist reviewer agents plus the
  skills that prepare diffs, plan and dispatch reviewers, deduplicate, and
  reconcile findings onto the pull request through the `ado` MCP. Naming that
  plugin is what makes the review scoped, parallel and bounded, rather than a
  process the model has to improvise.
- **Model.** The `complex` tier: `claude-opus-5.5` at `max` effort. `tier`,
  `model`, `reasoningEffort` and `context` are still accepted and behave
  exactly as they do on `create_job`.
- **Workflow.** A fixed directive is prepended to `prompt`, in eight phases:
  search and understand, research, a plan, an adversarial review of that plan,
  implementation with verification and tests, the pull request and its work
  item, an adversarial review of the change, and a green build. The job leaves
  the pull request open; it never merges.
- **Title.** `title` is required. It is the job's name in `list_jobs` and
  `get_job`, it opens the prompt, and it becomes the pull request title unless
  the repository's convention requires another form. It is written into
  `metadata.title` as well so the job is named in the metadata line, and a
  caller-supplied `metadata.title` is rejected rather than left to drift from
  it.

The directive answers a measured failure. Job
`domoreexp-4657bde2-1c19-4107-ae93-a317d1827fc1` ran 9.19 hours on
`teams-userprofilesvc` and was **not** killed: it ended `Completed` with
`jobOutcomeType: Succeeded`, and the service classified the work a failure
because nothing was pushed and no pull request was opened. The old order put
branch, commit and push after implementation and two review phases, so a run
that ended early left no durable trace. The branch is now created and pushed
before any edit exists, and pushes are required at each milestone and before
anything long-running. The review phase is bounded for the same reason.

The Job API has no system-prompt field. A validate probe sent one on
2026-10-31, got a 200, and the field was ignored and not echoed, so the
directive is folded into the single `prompt` string the API does accept. The
caller's task is wrapped in `<user_task>` tags at the end of that string, which
keeps "how to work" and "what to build" distinguishable. No validate preflight
is used, for the reason recorded under [Selectors that are deliberately
absent](#selectors-that-are-deliberately-absent): its answer is a projected id,
not a job handle.

The directive was written against Anthropic's current prompting guidance for
Claude Opus 5.5:
[prompt engineering best practices](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices)
and
[prompting Claude Opus 5.5](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-opus-5-5).
Every token has to earn its place: the target is "the smallest possible set of
high-signal tokens that maximize the likelihood of some desired outcome", and
minimal "does not necessarily mean short". So outcomes, constraints,
load-bearing ordering and environment facts the model cannot infer are stated
explicitly, while method stays implicit: general instructions beat prescriptive
steps, parallel tool calls need no instruction, and a standalone verification
phase causes over-verification on Opus 5. The one product the directive names
is Bluebird, and only conditionally: of the 235 catalog plugins, only
`cloudbuild` bundles the Bluebird MCP and only for CloudBuild failure
diagnosis, so `agency-coding` cannot be assumed to provide it and the text says
"use Bluebird semantic / vector search if available".

Traceability does not need a version marker. The full directive is stored
verbatim on every job and returned by `get_job` under `prompt:`, so a job's
behavior is traceable to the exact text that produced it, and the structural
assertions in `tests/cloudagent-tools.test.ts` keep a rewrite from silently
dropping a section. Treat a directive edit as a product change.

### `list_models`: the catalog behind the tiers

`GET /models` is live but undocumented, so the parser was written from a
measured response (2026-10-31, prod): an envelope `{ "models": [...] }` of 25
rows, global across every repository and organization, which is why the tool
takes no arguments.

**These are the Cloud Agent service's models, not the proxy's.** The two
catalogs are independent: they may share an id by name, but nothing in the
Cloud Agent request path resolves, translates or validates against
`github-router`'s own model catalog, and no model configuration is sent to the
proxy. A `model` argument is forwarded to the Job API verbatim, so an id that
exists only in the proxy's catalog fails at the service. That is why the tier
presets are checked against `list_models` and not against `/v1/models`.

A row can omit almost every member; the ones the renderer uses are

```
{ id, vendor?, preview?,
  capabilities: { supports: { reasoningEffort?: string[] },
                  limits: { maxContextWindowTokens?, maxOutputTokens? } },
  billing: { multiplier? },
  infoMessages?: [{ message }] }
```

`list_models` flattens those into `id`, vendor, preview, context window, output
limit, the effort ladder, the billing multiplier when above 1, and any
`infoMessages` as `note:` lines (for example the scheduled deprecation notice
on `claude-opus-4.6`). The result opens with the tier presets, so the model sees
the ids `create_job` will use and what else exists in one place. Measured:
every row is `isPremium: true` with `multiplier: 1` today, but the field is
carried rather than assumed, and the effort ladder is per model — a preset is
the only place where `max` is guaranteed.

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
| repository triple / `workspace` | read from the session workspace's git remote; `list_jobs` drops the filter when neither is available, and the catalog tools only use it for their `Repo`/`Organization` scopes |
| `branch` | the repository's default branch |
| `agent` | the service's standard agent |
| `plugins` | none beyond what the service enables by default |
| `tier` | `normal` on `create_job` (`gpt-6-astra` at `max` effort), `complex` on `create_pr_job`; `easy` and `complex` are `claude-opus-4.8-fast` and `claude-opus-5.5`, both at `max` |
| `model` | the `tier`'s model; naming one replaces the preset model and drops its effort |
| `reasoningEffort` | the `tier`'s effort; always wins when given |
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
service's rejection is already actionable. `list_models` reports that vocabulary
live instead of freezing it in a schema.

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

### Catalog scopes need a repository, and the tool supplies one

`list_plugins` and `list_agents` take the same `Repo`/`Organization`/`Company`/`Spec`
vocabulary `create_job` does, and `Repo`/`Organization` need an Azure DevOps
context. The two scopes do **not** need the same one. Measured live
(2026-10-30, prod):

- `type=Repo` needs the full `organization`/`project`/`repository` triple. Without
  one the service answers **HTTP 400** ("Azure DevOps context is required for
  'Repo' agents/plugins"), and a partial set earns a component-specific 400:
  organization alone says "ProjectName in Azure DevOps context is required",
  organization+project says "RepositoryName in Azure DevOps context is required",
  and organization+repository says "Project is required when Repository is
  specified."
- `type=Organization` needs **only `organization`**. Org-only, org+project,
  org+repository and the full triple all answer identically, so requiring three
  names here was asking for two the service never reads.
- `type=Company`, `type=Spec` and an untyped call read no context. Measured:
  `Company` plus the triple answers exactly as `Company` alone does, so the
  context is harmless there and is neither inferred nor forwarded.

So each scope is held only to what it reads: `Repo` resolves the triple the way
`create_job` does (the caller's three names, else the session workspace's git
remote), `Organization` resolves the organization the same way, and an explicit
`organization` is enough there. `Company`, `Spec` and untyped calls never probe a
checkout, so a `list_plugins` on a machine that is not in an Azure DevOps
checkout keeps working. This is the `list_jobs` lesson: inferring eagerly turned
unrelated calls into errors for a filter they did not need. A `Repo` or
`Organization` scope with no checkout and no explicit names fails locally, with
both ways forward, before any request is sent. The inferred case carries the same
provenance line `create_job` uses.

**What those scopes read** (measured): `Repo` reads the repository's marketplace
manifest, `.github/plugin/marketplace.json` or `.claude-plugin/marketplace.json`,
and `Organization` looks for the `ado-private` marketplace in the organization's
`AzureDevOps` project. A repository without a manifest answers **200 with an empty
page and the search path in `errors`**, which the renderer now prints as
`reason:`. Before, the empty page rendered as "No plugins matched." and the
explanation was dropped, so "nothing exists" and "it looked somewhere else" were
indistinguishable. `Repo` is also where a repository's own custom agents appear:
measured 74 on one repository, against the single `echo` agent of the company
catalog, which makes `list_agents` with a `Repo` scope the place to look for the
agent that needs `agentInputs`.

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
unattended for a median of about an hour (66 min over the whole ledger, 221 min
over the 2026-10-29 window) and can run for many hours, cannot be messaged or
resumed, and the model should confirm with the user before creating a job the
user did not ask for. After it returns, the caller polls with `get_job` or makes
one `wait_for_job` call.

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

### `list_jobs`: the filter is a prefix, and the service wants ids

`list_jobs` takes the same three names `create_job` takes, but they behave as an
**additive prefix**, not the all-or-none repository a job needs:

| Arguments | What it lists |
|---|---|
| none | every job this account can see, first page |
| `organization` | every job in that organization |
| `organization` + `project` | one project |
| `organization` + `project` + `repository` | one repository |

Anything else is a typo the tool refuses rather than a filter it silently
ignores: `project` without `organization` and `repository` without `project`
both throw with the two ways out. `pullRequestId` narrows on its own.

Names given by the caller override names read from the checkout, so a session
working in repository A can still ask about repository B. When nothing is given
and none can be read from a checkout, the call is not an error — it lists the
whole account and says so.

**Measured live (2026-10-30), and the reason the tool does a second lookup:**
`GET /jobs` matches `organization` by **name** but `project` and `repository` by
**GUID**. Passed a name, those two filters match nothing and the service returns
an empty ledger rather than an error, so a model that trusted the result would
report "no jobs" about a repository with dozens. The tool therefore resolves
names to ids itself, through the same Azure DevOps REST API the `ado` group
already talks to (`/_apis/projects/{project}` and
`/_apis/git/repositories/{repo}`, `api-version=7.1`, ADO resource
`499b84ac-1321-427f-aa17-267ca6975798`), and caches the answer per process keyed
by the lowercased triple, dropping rejected entries. A caller who has already
run `list_jobs` against the same repository pays nothing for the lookup.

Two failure modes, deliberately different:

- **A caller-named filter that cannot be resolved is an error.** A ledger that
  looks filtered and is not is the exact failure the argument exists to prevent,
  so the call fails with the upstream detail and the two ways out, rather than
  quietly widening.
- **A filter read off a checkout that cannot be resolved degrades to the
  organization**, which needs no lookup (it matches by name), plus a line saying
  the project and repository were dropped and why. A workspace whose remote
  points at a repository the caller's ADO identity cannot see should not break a
  question about what else is running.

The resolved ids are not echoed back; they are an implementation detail of
matching names the caller actually typed. What the caller sees is the
provenance line when the filter was inferred, and the jobs.

### `wait_for_job`

`wait_for_job(jobId, max_wait_s = 25, hard max 50)` polls every ~3 s and returns
the moment the job leaves `Queued` (compute was invoked) or reaches a terminal
state; otherwise it reports "still `Queued` after N s".

50 s is not an arbitrary convenience. A raw-JSON MCP client is capped near 60 s
per call ([#50289](https://github.com/anthropics/claude-code/issues/50289)), and
no wait that fits in one call can observe a terminal state anyway. The 2026-11-01
sweep of the organization's 161 jobs found a 3-minute minimum and **no job that
finished in under 60 seconds**, so a 50 s wait cannot see a terminal state even in
the best case. So the contract is deliberately the one question a short wait can
answer: **did the handoff take, or is this stuck in the queue?** Long-horizon
checking is `get_job`.

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

`outcome.code` alone is not a success verdict and must not be read as one. It is
the **pipeline run's** outcome, so a job the agent finished and reported on
still reads `Succeeded` when the work itself failed. Over 62 live jobs the four
observed values were `Pending` 46, `Succeeded` 13, `UserCancelled` 2 and
`PipelineTaskSkipped` 1, and `Pending` does not mean the job is still alive: it
covered 46 of the 62 rows, including jobs that had long since stopped. The
renderer therefore prints
`jobOutcomeType` and `result` on their own labelled lines, and the Kusto probe
job is the worked example: `outcome: Succeeded` and `result: Failure` in the
same block, because the agent completed and the task did not.

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

### The job does not inherit that token (measured, 2026-10-31)

A read-only probe of 11 job traces, with no job created for it, established what
the runtime identity is and what it is not:

- The request body has no identity or credential field at all
  (`GenericJobRequest`: prompt, repository context, optional agent, plugins,
  model configuration, metadata). The proxy's Entra token authorizes the Job API
  call and never enters the job.
- Job records attribute the job to the initiating user
  (`initiatingUser`/`requester` of type `UserRequester`) for `WebApi` jobs, or to
  an app (`AppRequester`) for `EventTrigger` jobs. Attribution is not execution.
- The sampled sandbox ran as a 1ES/Agency pipeline identity
  (`BUILD_REQUESTEDFOR=Agency`, `USER=cloudtest`); `az account show` failed with
  "Please run 'az login'". Its `SYSTEM_ACCESSTOKEN` is ADO-audience: it could
  read pull requests but not create one ("requires user authentication").
- None of the sampled traces called a Kusto tool. Six of 235 plugins advertise
  Kusto execution (`agency-kusto-canvas`, `cdss-insight-copilot`, `pirbot`,
  `trusted-platform-support`, `odl-assistant`, `service360-breeze-common`). The
  most explicit of them was then tested with a real job (below), so that path is
  no longer an open question; the other five and any ambient managed identity
  remain **unverified**.

### A configured Kusto plugin does not make the job able to query Kusto

One real job was created to settle the plugin path:
`domoreexp-2a63aaa0-a944-4403-a4b0-2dd747ed13b1` on
`domoreexp/Teamspace/teams-modular-packages`, `claude-haiku-5.5` at effort `low`,
plugin `agency-kusto-canvas`, and a prompt that asked only for `print 1` against
`msteamsusea2.eastus2.kusto.windows.net/TeamsGraniteFabric` (no repository work,
no installs, no `az login`). It completed in about three minutes and failed to
reach Kusto by every route:

- The plugin was loaded, but the job's own tool search found no Kusto, KQL, Data
  Explorer or ADX tool. `agency-kusto-canvas` is a Copilot-app co-editing canvas,
  not a tool the coding agent receives.
- `az account show` failed with "Please run 'az login' to setup account."
- A raw `POST /v1/rest/query` bearer-authenticated with the sandbox's `ADO_TOKEN`
  returned HTTP 401, the wrong audience for Kusto.
- `python3 -c "import azure.kusto.data"` raised `ModuleNotFoundError`.

The sandbox did expose `SYSTEM_CONNECTION_ACCESSTOKENSCOPE` and
`SYSTEM_CANISSUEOIDCTOKENFORWORKLOADIDENTITYFEDERATION`, so a pipeline
provisioned with a federated Kusto identity is the remaining plausible path. It
was not exercised, and nothing in the default job shape produces it.

Consequence for callers: a job does not run with the operator's rights. Anything
the job must do with the user's identity has to come from its own repository,
pipeline or plugin configuration, not from the proxy's `az login`.

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
