# Pi launch (`github-router pi`)

Launches the [Pi coding agent](https://pi.dev) against the proxy with a
fixed, cost-controlled profile. Six `-m` aliases are supported; the two
`-2` variants are derived from their base profile and move only the model
identities named below:

| Profile | Lead | Roster | Consultants |
|---|---|---|---|
| `cheapest` | `gpt-6-luna` / max, 272K tier window | Explore (Luna/high), General-Purpose (Luna/max), reviewer (Luna/max, protege of the Advisor); no Plan | Sol 5.6/medium Advisor (plan review + capped reviewer rounds), Sol 5.6/high Oracle |
| `cheapest2` | `gpt-6-luna` / max, 272K tier window | Explore (Luna/high), General-Purpose (Luna/max), reviewer (Luna/max, protege of the Advisor); no Plan | Sol 6.1/high Advisor (plan review + capped reviewer rounds), Sol 6.1/high Oracle |
| `balanced` | `gpt-5.6-sol` / medium, 272K tier window | Explore (Luna/high), General-Purpose (Luna/max), reviewer (Sol 5.6/high, may delegate Explore); no Plan | Grok 4.6/medium Oracle only — **advisor-free by design** |
| `balanced2` | `gpt-6.1-sol` / medium, 272K tier window | Explore (Luna/high), General-Purpose (Luna/max), reviewer (Sol 6.1/high, may delegate Explore); no Plan | Grok 4.7/medium Oracle only — **advisor-free by design** |
| `local` | `opus` on the local server, 200K | Explore (`haiku`/high), General-Purpose (`sonnet`/max), reviewer (`opus`/max); no Plan | none: `local` runs **every** agent turn on the local server, so it carries no Oracle and no Advisor (the builtin `oracle` is disabled in settings). The browser page compressor is the one model-backed Copilot exception, shared with `local2`; web search rides Copilot's MCP endpoint without a model |
| `local2` | `opus` on the local server, 200K | Explore (`haiku`/high), General-Purpose (`sonnet`/max), reviewer (`opus`/max); no Plan | Sol 6.1/high Advisor (plan review + capped reviewer rounds), Sol 6.1/high Oracle |

Both `-2` profiles inherit everything else from their base: the delegation
graph, the peer set, the prompt-rewrite brief (`cheapest` family only), the
compaction reserves, and the bare-200K accounting. `balanced2` keeps the
declarative `astra` slot (`gpt-6-astra`, not callable on this family).

`-m cheaplocal` exists on `github-router claude` but is deliberately not a Pi
profile. Pi binds one provider per profile in its models file, while cheaplocal
needs the lead and the natives on the Copilot provider and the Advisor and
Oracle on the local `anthropic-messages` one. The launcher rejects the alias
with a message pointing at `-m cheapest` / `-m cheapest2` for Pi and
`github-router claude -m cheaplocal` for the two-provider layout.

No Copilot-served role runs above its **Default-tier** window (Luna/Sol
272K, Grok 200K, anything else 200K) — that is the whole cost lever here,
the Pi counterpart of the bare-200K default window the Claude `cheap` family
(`cheap`, `cheap1m`), the `cheapest`/`balanced` families (each including
its `-2` sibling), and the `local` family rely on. There is no `[1m]`
accounting anywhere; see [Tier-priced context windows](#tier-priced-context-windows).

### Local profiles (`-m local`, `-m local2`)

The two local aliases are the Pi counterpart of the Claude `-m local` /
`-m local2` launch profiles: the main loop runs against a locally running
server that already speaks Anthropic Messages. `local` sends every role
there, subagents included; `local2` keeps two Copilot consumers, the Oracle
and the Advisor, both on `gpt-6.1-sol`. The endpoint is configured exactly
as the Claude launcher configures it — `--localurl <url>` > `--localport
<port>` > `GH_ROUTER_LOCAL_BASE_URL` > `GH_ROUTER_LOCAL_PORT` > the default
`https://localhost:11111/v1`; the two flags are a launch error together and
are inert on every other profile. Nothing is assumed about the server beyond
that base URL: no stack detection, no model discovery, no launch-time
request, and no fallback to Copilot.

On the Pi side that means these concrete differences from a Copilot profile:

- The provider's `api` is `anthropic-messages` (every Copilot-served row —
  `local2`'s Oracle and Advisor — is pinned back to `openai-responses`, so
  the two never mix). `local` has no Copilot-served row at all: it runs the
  lead, every native role, and nothing else.
- The provider's `baseUrl` is the proxy ORIGIN, not `<proxy>/v1`: Pi's
  bundled Anthropic client POSTs `{baseUrl}/v1/messages`, so the `/v1` root
  produced `/v1/v1/messages` and a proxy 404 (measured against the installed
  Pi bundle). Each Copilot-served row overrides `baseUrl` back to
  `<proxy>/v1`, which is what the OpenAI client's `{baseUrl}/responses`
  expects. Non-local providers keep the `/v1` root.
- Each tier row carries a per-model `x-claude-code-session-id` header
  (`state.sessionId`), so every Pi request names the same session the
  Claude path forwards verbatim from the client. The profile assumes nothing
  about what the local endpoint does with it.
- Each tier row also carries `X-GH-Router-Launch-Secret`, the same value
  `/mcp` registration holds. The proxy keys its local routing off the launch
  bound to that header; a request without it is treated as unbound BYO
  traffic and goes to Copilot, where the bare `opus` id does not exist (the
  observed symptom was Copilot's "The requested model is not supported" 400).
  Claude Code gets the header through `ANTHROPIC_CUSTOM_HEADERS`; Pi has no
  such channel, so `models.json` is it. Copilot-served rows deliberately
  never carry it, or their own ids would be routed to the local server.
- Tier rows are the bare ids `opus` / `sonnet` / `haiku` at a 200K
  `contextWindow`, with no `cost` and no `thinkingLevelMap`: a local id has
  no catalog entry to derive either from, and the server's effort ladder is
  unknown, so both are omitted rather than guessed.
- `local` emits no `oracle` agent file. Every agent turn on this profile is
  a local turn, and a consultant is the one role that cannot be — so the
  role is absent rather than re-pointed: no file, no `gh-oracle` skill, no
  `/plan-review`, no consult prose in the digest, no `allowedAgents: …,
  oracle` edge on `General-Purpose`. Because our file is what shadows the
  builtin, dropping it requires the matching settings entry:
  `subagents.agentOverrides.oracle = {disabled: true}`. Without that, the
  builtin `oracle` (and the `advisor` alias it owns) would take the empty
  slot on a model of its own choosing — on the one profile that may bill no
  Copilot model.
- `workers` is not published on either local profile, because a worker
  subagent resolves and runs a Copilot model. `peers` is published only while
  it holds a tool: on `local` that means the artifact review panel, on
  `local2` the Oracle and the artifact panel.

Lead turns are recorded in the AIC ledger at zero (`recordZeroCostRequest`,
keyed on the raw id), so the footer reads `[AIC 0.00]` / `~$0.00` on `local`.
On `local2` the same zero-cost lead sits beside the Oracle's and Advisor's
Copilot-billed credits. See
[`default-models.md`](default-models.md#local-launch-profiles--m-local--m-local2)
for the full contract.

Roster notes: our `reviewer`/`oracle` agent files intentionally shadow the
same-named pi-subagents builtins (pinned models); builtin
`scout`/`worker`/`researcher`/`evidence-auditor` are disabled via settings
(their habitual invocations resolve through our `scout`/`worker` aliases),
as are the external-CLI families `claude-code`/`codex-exec`/`cursor-agent`
(+ `-writer` variants — they shell out to other CLIs with ambient auth,
off-proxy and off-ledger), while builtin `delegate` stays enabled as the
cheap append-mode path. `local` additionally disables builtin `oracle`,
since it emits no replacement file.
Every emitted agent runs foreground (`async: false`): the detached
background runner demonstrably drops `read`/`bash` from its tool registry
(observed live as `requested unavailable child tools: [read, bash]`),
failing every strict-allowlist child it touches. `contact_supervisor`
appears only on `General-Purpose` (blocked-writer escalation); leaves
never page the supervisor.
`General-Purpose` may nest `reviewer`/`oracle` (`local` grants `oracle`
only — it has no Advisor), balanced `reviewer` may nest
`Explore` (ceiling raised to 3 via `PI_SUBAGENT_MAX_DEPTH`). Handoff is
inline prose in the delegating brief — no `context.md`/`progress.md` file
bindings, so runs write nothing into the repo. `--swe` without `--peers`
emits no skills or prompts (no agents behind them). `/parallel-review`
intentionally shadows the packaged prompt of the same name.

## Usage

```bash
github-router pi -m cheapest --search --browse
github-router pi -m balanced -- --print "review this diff"
github-router pi -m balanced2 --continue
```

Everything after `--` is forwarded verbatim to `pi`; other Pi flags
(`--print`, `--mode`, `--continue`, `--resume`, `--session`, …) flow
through automatically. Sessions live in a router-owned root that outlives
the launch, so `--continue` picks up the last session in the current
working directory and `--resume` lets you pick from the list.

## Flag policy (mirrors the Claude launcher's house rules)

A bare launch advertises no skills or prompts — only what Pi ships
plus the mode identity. Each surface rides a flag:

| Flag | Default | Surface |
|---|---|---|
| `--peers` / `--no-peers` | **on** | Native agent files, the `peers` MCP group (`mcp__gh-router-peers__oracle`, plus the `advisor` subagent wherever the profile carries one), `gh-oracle` skill, `pi-subagents` package (**extensions only** — its skills/prompts are filtered out so they never reach Ctrl+O). `--no-peers` drops all of it (plus the server-side allow-list) and validates the lead model only. |
| `--helpers` / `--no-helpers` | **on** (peers-gated) | Helpful bundle, extensions-only filtered: allowlisted `pi-agent-extensions` (`sessions`, `ask-user`, `todos`, `handoff`, `context`, `answer`, `cwd-history`, `session-breakdown`, `notify` — no `review`/`loop`/`workflow`/`control`/footer and no `files` picker, whose `ctrl+shift+o` would collide with the UI's extra-detail toggle), plus `pi-web-access` only when neither `--search` nor `--browse` is on (else it double-pays our ColBERT/browser surfaces). `--no-helpers` keeps `pi-subagents` + `gh-router-pi` only. Peerless launches skip the bundle (no delegation floor). |
| `--ui` / `--no-ui` | **on** | Claude-Code look: Pi follows the terminal's own palette (`theme: system`, `terminalTheme: true`) — the same colours the terminal uses for every other tool, and light/dark switches are tracked automatically. The six genuine Claude Code palettes still ship themes-only from `better-claude-code-ui` (`claude-code-dark` `#D77757` coral, `claude-code-light`, …), one `/settings` pick away. cc-ui chrome derives from the active theme (`themeAdaptive: true`), tool rows collapse to one line (`summary`/`count` modes) on transparent backgrounds, and finished thinking collapses to `Thought for Xs` (`thinkingMode: live`). Bash row labels stay **off**: upstream's `model` default adds a tool field plus an instruction line to every turn, a standing token cost for a cosmetic. Thinking blocks hidden via native `hideThinkingBlock` regardless of this flag (the cc-ui `Thought for Xs` one-liner has no off switch upstream — it is the minimum). Presentational only, zero model cost. `--no-ui` restores stock Pi rendering. `pi-code` behaviors stay a manual recipe — its `/memory` + `/context` commands would collide with the router-owned pair (Pi offers no per-command filtering inside one extension). |
| `--swe` | off | Pipeline surface: `gh-delegate` (+`gh-advisor` wherever the profile carries an Advisor) skills, `review` / `parallel-review` (+`plan-review` on the same profiles) prompts |
| `--search` | off | ColBERT provision + the `gh-search-first` skill prose. The `code` tool itself is published on every launch (see the MCP section), so this flag now owns only the ColBERT-specific advice, which would be wrong on a Bluebird or lexical backend |
| `--browse` | off | Browser MCP group when a supported browser is installed |
| `--bluebird` | auto on an Azure DevOps remote | Routes the `code` tool's `semantic` and `lexical` modes to Bluebird server-side. The tool is already on the `search` group, so nothing extra is emitted; the description and the runtime `source` label say which engine answered. `gh-search-first` prose and `pi-web-access` deliberately stay on `--search`: neither is Bluebird's job |
| `--ado` | auto on an Azure DevOps remote | `ado` MCP group (key `gh-router-ado` -> `<serverUrl>/mcp/ado`, read-only unless `--ado-write`). Gated on its own predicate only, exactly as on the Claude side, so neither `--no-peers` nor `--no-helpers` removes it |
| `--kusto` | auto on an Azure DevOps remote | `kusto` MCP group by the same route (key `gh-router-kusto`). A remote enables it and the flag forces it anywhere; `--kusto-cluster` only sets a default, and without one every call names the cluster it queries. There is no launch-side reachability probe: the group is served read-only by the service |
| `--cloudagent` | auto on an Azure DevOps remote | `cloudagent` MCP group (Microsoft Cloud Agent Job API v2) by the same route (key `gh-router-cloudagent`). The git remote enables all ten tools, `create_job`, `create_pr_job` and `cancel_job` included; `--no-cloudagent` is the veto, and the create tools tell the model to confirm with the user first because a job runs a cloud agent for hours and spends compute. `--cloudagent-env prod\|ppe` selects the service. The proxy mints the Entra token itself from an existing `az login`, and the base URL is not configurable |
| `--memory-bridge` / `--no-memory-bridge` | **on** | Copilot (`.github/copilot-instructions.md`, `.github/instructions/*.instructions.md` `applyTo`) + Claude (`.claude/rules/`, `.claude/CLAUDE.md`, `~/.claude/CLAUDE.md`, `~/.copilot/copilot-instructions.md`) bridge. Static repo-wide slice synthesizes into the mirror `AGENTS.md` (Pi-native candidate, 24KB budget, secrets-redacted, fenced idempotent); path-scoped rules lazy-attach on matching `read/edit/write` (once/session). Auto-memory (`~/.claude/projects/<slug>/memory/MEMORY.md`, 200-line/25KB) is on-demand via `/memory` only, never auto-injected. Honors `GH_ROUTER_PI_BRIDGE=0` / `GH_ROUTER_DISABLE_PI_BRIDGE=1` and Pi's own `--no-context-files`/`-nc` passthrough. `--no-memory-bridge` = Pi-native `AGENTS.md`/`CLAUDE.md` discovery only. |

Always injected regardless of flags (like Claude's operating
defaults): `models.json` (routing is load-bearing), `mcp.json` (the
`search` group at minimum), minimal `settings.json`, `keybindings.json`
(frees `shift+tab` for plan mode — see [Plan mode](#plan-mode)),
`APPEND_SYSTEM.md` digest, statusline footer (built into
the `gh-router-pi` extension — no third-party package; opt out with
`GH_ROUTER_DISABLE_AIC_STATUSLINE=1`), plan mode (built into the same
extension — see [Plan mode](#plan-mode); no flag, no package), toolbelt PATH
(opt out with `GH_ROUTER_DISABLE_TOOLBELT=1`), launch binding. The user's own
`~/.pi/agent` snapshot is their Pi default, never gated.

## MCP: Pi's built-in client, every profile-appropriate group

Every group reaches Pi through **Pi's own MCP client**, configured in
`<mirror>/mcp.json` (`PI_CODING_AGENT_DIR` already points there). Nothing is
hand-wrapped in the generated extension any more: the extension is a seam for
the prompt-submit relay and the statusline footer, and it registers no
model-facing tools.

**The adapter had to go, not merely be optional.** An installed extension that
registers `/mcp` replaces built-in MCP for the session, and Pi then never reads
`mcp.json` at all. `pi-mcp-adapter` is therefore a blocker for native MCP, not
an alternative to it, and it is out of the `--helpers` bundle. What native
brings that the adapter could not: `tool_search`, MCP resources, per-server
`exposure` / `toolExposure` / `timeout`, and the `mcp_servers` system-prompt
roster.

**All servers are `deferred`.** Pi lists a deferred server in the
`mcp_servers` section of the system prompt with one line from its `description`
and activates `tool_search` automatically, so the model can find a tool without
any server being connected up front. The alternative, `direct`, makes the first
prompt wait up to 10 s per server while every tool definition is fetched. On a
launch that can carry seven groups that is an unacceptable first-turn cost for
a surface most turns never touch, so `deferred` is the only exposure we emit.
The consequence to know: the `description` string is the model's entire
pre-search signal, which is why each one says what the group is for rather than
just naming it.

**Group set, per profile.** Every Pi profile carries the same
`allowedGroups` (`peers`, `search`, `workers`, `browser`, `ado`, `kusto`,
`cloudagent`) except the local family, which has no `workers` because a
worker subagent is a Copilot-model consumer. Everywhere else the published
set matches what Claude publishes for the same flags:

| Group | Emitted when | Key |
|---|---|---|
| `peers` | `--peers` (default on) | `gh-router-peers` |
| `search` | always | `gh-router-search` |
| `workers` | the browse agent's model resolves, on a non-local profile | `gh-router-workers` |
| `browser` | `--browse` and a supported browser is installed | `gh-router-browser` |
| `ado` | `--ado` / an Azure DevOps remote | `gh-router-ado` |
| `kusto` | `--kusto` / an Azure DevOps remote | `gh-router-kusto` |
| `cloudagent` | `--cloudagent` / an Azure DevOps remote | `gh-router-cloudagent` |

`orchestrate`, `decide`, `fleet` and `first-mate` are outside the pinned
profiles' `allowedGroups`, so no flag combination surfaces them. That is the
same hard deny the Claude launcher applies, not a Pi-specific choice.

`search` is the one unconditional group: `code` always answers (semantic when
the index is ready, labelled lexical otherwise) and `web` is Copilot-backed, so
there is no configuration where withholding it buys anything.

**Entry shape.** Each entry is `type: "http"` with the scoped URL
`<serverUrl>/mcp/<group>`, `exposure: "deferred"`, a `description`, and three
headers:

- `Authorization: Bearer ${GH_ROUTER_HOOK_NONCE}` — a placeholder Pi expands
  from the child env at connect time, never a token on disk.
- `X-GH-Workspace: ${GH_ROUTER_WORKSPACE}` — load-bearing, not cosmetic. The
  worker tools refuse a call that names no workspace, and native MCP sends no
  such header on its own (the old extension set it by hand). It rides every
  group and is ignored where unused.
- `x-claude-code-session-id: <session id>` — a literal, not a placeholder: the
  id is a random UUID rather than a secret, and the mirror file it lands in is
  per-launch and swept with it. Native MCP sends no session header on its own,
  and a consult keyed on the process id would lose prompt-cache routing. Every
  other launch ignores the header.

**Keys are always `gh-router-<group>`, never the bare name.** A project
`.pi/mcp.json` outranks the user-level file and replaces a same-named server
wholesale, so a bare `ado` key would be hijacked by the workspace's own. A
project file that declares one of our prefixed keys is reported in a launch
warning, never edited. `.mcp.json` and `.pi/mcp-adapter.json` are no longer
scanned: native Pi never opens them, so warning about them would be a false
positive.

The file is read-merged, so a user's own `mcpServers` survive untouched. A file
we cannot parse is left exactly as it is, and the groups are simply not exposed
that launch.

Deliberate divergence: pinned Claude profiles refuse `--no-codex-mcp`;
Pi allows `--no-peers`. Do not "fix" this back into parity.

## How it cooperates with Pi

- **Right wire endpoint, not a provider hack.** The launcher writes a
  `gh-router` provider into the mirror's `models.json` with
  `api: openai-responses` (per-model `api` override derives from catalog
  endpoints for a future chat-served model), `baseUrl: <proxy>/v1`, and `authHeader`
  for the dummy bearer — Pi POSTs `/v1/responses`, the Codex-proven
  path. Every roster model is Responses-only on Copilot; sending them
  to `/v1/chat/completions` is an upstream 400 (observed live). Each
  row also carries `maxTokens` (catalog output cap, ≥16 floor the
  proxy enforces), `cost` (USD/1M from live billing), `input`
  (`["text","image"]` when the catalog says vision — fail-open so
  `@path`/`--file`/paste/`read` images work, with the proxy vision
  preflight as backstop), `inputLimits.images.resize` (1568px/512KiB/q75
  so Pi resizes before sending), `thinkingLevelMap` (catalog
  `reasoning_effort` allowlist, unsupported tiers hidden), and its
  cheap-tier `contextWindow`. No `registerProvider` override, no
  proxy-side translation. Two Pi quirks discovered live and pinned by
  tests: tool schemas must be TypeBox `parameters` (plain-JSON
  `inputSchema` fails the load), `execute` is
  `(toolCallId, params, signal)` returning `{content, details}` — and
  a **partial** `cost` object silently rejects the entire provider as
  `Unknown provider`, so `cost` is all-four-figures-or-absent
  (`piUsdCostFor`), never a guessed zero.
- **Isolated mirror.** The user's `~/.pi/agent` is snapshot-copied to a
  per-launch dir (`PI_CODING_AGENT_DIR` → mirror); `auth.json` and
  `sessions/` are never copied. The mirror is swept on shutdown (plus a
  boot sweep of dead-PID mirrors).
- **Sessions outlive the launch.** Pi's default session root is
  `<agent dir>/sessions`, which sits inside the mirror that shutdown
  deletes, so quitting used to erase the transcript history and leave
  `--continue` / `--resume` with nothing to resume. The child now gets
  `PI_CODING_AGENT_SESSION_DIR` → `~/.local/share/github-router/pi-sessions`,
  one stable root shared by every launch. Pi groups sessions under it by
  working directory, so per-workspace history stays separate and
  `--continue` still picks the right one. The root is a sibling of the
  `pi-mirrors` directory, never inside it: the boot sweep reaps mirrors by
  PID because they are scratch, and this directory is history, so nothing
  ages it out. Pi documents no retention policy; the session picker's
  delete (and `/session`) is the pruning surface. `--session-dir` remains
  the per-launch override (Pi gives it precedence over the env var), and
  the user's own `PI_CODING_AGENT_SESSION_DIR` export is stripped from the
  parent env for the same isolation reason `PI_CODING_AGENT_DIR` is.
- **Persistent npm-package cache.** A fresh mirror would force Pi to
  reinstall every `packages[]` entry from the registry on each boot
  (seconds + `added N packages` noise that bypasses npm's loglevel, since
  Pi spawns npm with inherited stdio). Instead the launcher pre-seeds
  `<mirror>/npm` from `~/.local/share/github-router/pi-packages/<hash>/`
  (keyed by the exact flag-dependent package set) and saves the installed
  tree back on shutdown. Repeat launches with the same flags install
  nothing. Entries older than 24 hours are treated as a miss so unpinned
  packages refresh daily rather than weekly — that window is the worst-case
  staleness of every extension in the launch, and the install it saves costs
  ~5 s, so one refresh a day is paid back by every other launch that day.
  Override with `GH_ROUTER_PI_PACKAGE_CACHE_HOURS` (e.g. `168` restores the
  old week); opt out with `GH_ROUTER_PI_NO_PACKAGE_CACHE=1`.
- **Subagents via `pi-subagents` + our agents.** The `gh-router-pi`
  extension registers no model-facing tools; every consult and search tool
  arrives through native MCP as `mcp__gh-router-peers__oracle`,
  `mcp__gh-router-search__code`, and the rest. The extension keeps two
  non-tool seams: the prompt-submit relay and the statusline footer.
  Guidance lives in skills (`gh-oracle`, `gh-search-first`,
  `gh-delegate`, plus `gh-advisor` on every profile that carries an
  Advisor) and `/review`, `/parallel-review` (+ `/plan-review` on the same
  profiles) prompts, all pointing at those MCP tool names.
- **Per-prompt brief, full `UserPromptSubmit` parity.** The extension
  registers a `before_agent_start` handler that relays the user's prompt to a
  hook-only MCP tool, `prompt_brief` (group `search`, hook-nonce
  authenticated, never listed to the model), and re-emits the reply as a
  custom message ABOVE the user turn — additive, `systemPrompt` untouched.
  `runPiPromptBrief` (`src/lib/hook-prompt-brief.ts`) calls the SAME
  `decidePromptSubmitV2` the Claude Code hook calls, so the two clients cannot
  drift on when to search, when to spend a model call, or when to stay silent:
  pending prior-turn findings are surfaced once and cleared, a non-trivial
  prompt gets the search tip plus a grounded scope/goal note from one
  `gpt-6-luna` call (lexical search when semantic is off, lexical + semantic
  in parallel when it is on), and the cheapest family additionally spends its
  one-shot Sol rewrite (`GH_ROUTER_DISABLE_CHEAPEST_REWRITE=1` opts both
  front-ends out, `GH_ROUTER_DISABLE_PROMPT_STEER=1` disables the steer).
  The handler stands down inside a `pi-subagents` child process so a fanout
  cannot spend one brief per child.

  Only the PROSE differs, through `PromptProseOverrides`: Pi has no
  `/gh-research` or `/gh-orchestrate` skills and its native MCP servers carry
  the `gh-router-` prefix, so the tip names `mcp__gh-router-search__code` and
  the fallback goal names the `subagent` roster (Explore for recon,
  General-Purpose for scoped implementation, reviewer for verification).
  Naming Claude's nouns there would point the model at tools and skills that
  do not exist in the session. `decision.resetSession` is dropped: it clears
  the Claude Stop-gate's per-prompt block budget, and Pi has no Stop gate.
  An empty string is the ordinary "nothing to inject" answer for a trivial
  prompt with no pending findings, never an error.

  **Latency budget.** The extension aborts the brief at 45 s
  (`BRIEF_TIMEOUT_MS`); the Claude hook has no client-side bound. A cheapest
  prompt whose Sol rewrite misses cleanly then runs the Luna scope path, so the
  theoretical worst case (a 30 s rewrite budget followed by the 22 s scope
  budget) can exceed Pi's abort. A clean miss is normally fast, and the abort is
  fail-open — the extension injects nothing and the turn proceeds — so the
  overlap costs a brief on a rare path, not a hang.
- **Native compaction stays authoritative.** Each model row carries its
  Default-tier `contextWindow` (272K for Luna/Sol, 200K for Grok — never the
  advertised 1.05M), and `compaction.reserveTokens` is derived per model from
  that window plus live catalog `max_prompt_tokens` ceilings
  (`derivePiCompactionSettings` in `src/lib/pi-models-settings.ts`:
  `reserve = window − floor(min(prompt, window) × 0.85)`, clamped to
  [16384, 100000], global reserve = the max, per-model overrides for the
  rest) so Pi's own trigger lands below both the price cliff and Copilot's
  ceiling — the Pi-native analogue of `CLAUDE_CODE_AUTO_COMPACT_WINDOW`. The
  extension's `session_before_compact` handler observes only and always
  falls back to native.

  **Local launches compact at 80% (160K), on purpose.** The local endpoint has
  no price cliff, and the live catalog carries no `max_prompt_tokens` for the
  `opus`/`sonnet`/`haiku` rows, so the derivation above would fall through to
  Pi's 16384 default and trigger at 183.6K. That is too late: with `thinking`
  enabled the endpoint caps generation at `thinking.budget_tokens`, **not**
  `max_tokens` (measured: `max_tokens=25904, budget=16384` returns exactly
  16384 output tokens with `stop_reason: max_tokens`; `budget=30000` returns
  30000), and Pi turns that stop into
  `Compaction failed: Summarization failed: generation hit the token cap and
  the summary is incomplete`. At 183.6K Pi's `clampMaxTokensToContext` leaves
  only 12288, so the provider trims the budget to 11264 — smaller than the
  16384 it would have used, and far too small for a real summary (5 of the 19
  compactions in the reference session reported output above 16384, up to
  21643). So `local`/`local2` take a flat `PI_LOCAL_COMPACTION_RESERVE_TOKENS`
  (40000 → trigger at 160K, 80% of the window) **and** emit
  `thinkingBudgets: { high: 32768 }` (`PI_LOCAL_THINKING_BUDGETS`), which puts
  the wire budget at 31744 — double the old ceiling, with room for both the
  reasoning and the summary text. `thinkingBudgets` is emitted for local
  profiles only; on Copilot the same numbers would be billed reasoning tokens
  on every turn.
- **Tool choice steered in the digest, not narrowed.** Pi's own per-tool
  guidelines ship for `read`/`write`/`edit` but not for `grep`/`find`/`ls`,
  and its "use bash for ls, rg, find" rule fires only when those dedicated
  tools are absent — so a full-roster launch is told nothing. The digest
  carries one line (`PI_TOOL_PREFERENCE_LINE`) saying both halves of the
  policy: prefer `read`/`write`/`edit`/`grep`/`find`/`ls` over shelling out to
  `cat`/`sed`/`python`, and still reach for `rg`, `jq`, `ast-grep`, `git` and
  the build/test commands when those are the better instrument. No tool is
  removed from the roster to enforce it.

  **Search order, only when the launch serves it.** When this launch publishes
  the `code` group (`--search` or Bluebird), the digest adds one more line
  (`PI_SEARCH_ORDER_LINE`): narrow with semantic `code` search first, then
  reach for `rg`/`grep` for what meaning cannot answer — every occurrence, an
  exact token, a regex, a filename. The tool's own description already says
  semantic-first with a labelled lexical fallback, but a description is read
  once at roster time while the digest is read every turn, and without the
  ordering the model reaches for `grep` first on exact strings. Both halves
  matter: semantic-only would leave concepts un-grepped, and the fallback
  alone would not fix the order. The line is gated on
  `surfaces.codeSearch` — the same predicate that publishes the MCP group — so
  a launch without search is never pointed at a tool it does not have.
- **Pi lifecycle respected.** Version floor Pi ≥ 1.3.0 (`PI_MIN_VERSION`,
  `src/lib/pi-version-check.ts`) / Node ≥ 22.19. Startup never waits on npm:
  a fast local `pi --version` probe gates
  the floor foreground; a missing Pi installs in parallel with server
  boot (joined fail-closed before launch, aborted if setup fails); a
  healthy install refreshes in the background (throttled hourly probe,
  detached post-exit install when newer, cross-process locked, silent
  on failure). Below-floor installs upgrade foreground and re-verify,
  fail closed. `--no-update-check` skips the probe + refresh entirely
  (offline/CI); `--no-auto-update` disables the background refresh
  (the floor is still enforced).   Throttle state lives in
  `~/.local/share/github-router/last-pi-update-check`.
  Boot is quiet by design: with stored auth, setup chatter is held
  back and one three-line card (version · account · lead/models/surface)
  replaces it; `--verbose`/`--show-token` restore full logs, and
  first-time device flow is never gated.
  Parent env is stripped of Pi routing keys (`PI_CODING_AGENT_DIR`,
  …) so a stale shell export can't re-route the session off the proxy.
  Parent env is stripped of Pi routing keys (`PI_CODING_AGENT_DIR`,
  …) so a stale shell export can't re-route the session off the proxy.

## Tier-priced context windows

Copilot bills OpenAI/xAI models in two tiers keyed on per-request input
tokens. Each Pi model row carries its cheap-tier window, so Long-tier
(2x) pricing is structurally unreachable:

| Model | Default (cheap) tier | `contextWindow` |
|---|---|---|
| `gpt-6-luna` | ≤ 272K ($0.10/1M in) | 272000 |
| `gpt-5.6-sol` | ≤ 272K ($4.00/1M in) | 272000 |
| `gpt-6-sol` | ≤ 272K ($2.00/1M in) | 272000 |
| `gpt-6.1-sol` | ≤ 272K ($2.00/1M in) | 272000 |
| `grok-4.6` | ≤ 200K ($2.00/1M in) | 200000 |
| `grok-4.7` | ≤ 200K ($2.00/1M in) | 200000 |
| anything else | — | 200000 (fallback) |

The `local` family's `opus` / `sonnet` / `haiku` rows have no catalog entry
to key on and take that 200K fallback like any other unknown id, which is
the window the profile asks for anyway.

Pinned in `src/lib/pi-tier-windows.ts` (sourced to the billing doc;
the live catalog carries no tier data). Compaction reserves derive per
model (`reserve = window − floor(min(prompt, window) × 0.85)`), so the
trigger sits below both the price cliff and Copilot's ceiling.
`warnOnTierPriceDriftForModels` warns loudly when live catalog prices
disagree with the table. Refresh the table when the billing doc changes.

## Statusline

Pi's footer shows `[AIC x.xx]` (this session's AI-credit total) plus
the discounted actual (`~$`), rendered by the **same
`internal-aic-status` runner** `github-router claude` drives — one
renderer, identical segments (`src/lib/default-statusline.ts`). The ctx
segment carries the window next to the percentage (`[####------] 42%·272K`,
`--` when a client reports none), so the bar is always readable against a
real denominator — Pi's 272K Default-tier windows versus the Claude profiles'
200K, and a `/model` switch into Claude Code's 1M accounting.

How it works: the mode's own `gh-router-pi` extension owns Pi's footer
(`ctx.ui.setFooter`, refreshed on `session_start`/`turn_end`/
`model_select`/`session_compact`/`session_tree`, 300 ms debounce) and
spawns the runner with a natively-built Claude-shaped payload
(`src/lib/pi-statusline.ts`): context % from Pi's authoritative
`getContextUsage()`, cumulative in/out tokens summed over the session
branch, wall-clock duration from session start (transcript-span
fallback), line counts from edit tool-result details, model + cwd
directly. The command travels via `GH_ROUTER_AIC_STATUS_COMMAND` env
(alongside `GH_ROUTER_AIC_LEDGER`); the last footer width is fed back as
`COLUMNS` so narrow terminals drop segments right-to-left with AIC
pinned, plus an ANSI-aware truncation backstop. Statuses published by
other extensions via `setStatus` render as extra footer rows so replacing
the footer never silently drops them.

Deliberate divergences from the Claude path:

- No third-party statusline package and no `statusLine` settings block.
  The community `pi-statusline` bridge only reads the user's real
  global/project settings and never sees the launch mirror behind
  `PI_CODING_AGENT_DIR`, so a mirror-injected block would be dead
  config — verified live against v0.0.2 (its payload also hardcodes
  line counts to null and derives context % from the latest turn only).
- Router-wins by architecture: the footer is extension-owned, so a
  user's own statusline command is never executed (pinned Claude
  profiles behave the same via `routerWins`).
- Ledger taps are proxy-side, so Pi traffic accumulates automatically.

Opt out with `GH_ROUTER_DISABLE_AIC_STATUSLINE=1`. Fail-open: a broken
runner degrades to Pi's native footer, never a broken launch.

## Plan mode

Claude Code's plan mode is a mode; Pi ships none (upstream README: "skips
features like sub-agents and plan mode") and offers it only as an example
extension a user has to install. `github-router pi` therefore generates the
equivalent into its own `local:gh-router-pi` extension, always on, for every
profile — no flag, no package, no model-facing tool.

**Toggle** with `Shift+Tab` — the Claude Code key — or `/plan`;
`/plan-status` prints the current step list. Pi binds `shift+tab` to
`app.thinking.cycle` and treats it as reserved, so an extension cannot claim
it. The launcher therefore writes `<mirror>/keybindings.json` moving that one
action to `Ctrl+Shift+T` (free in pi's table and in every bundled package),
which frees the key without costing thinking-level cycling. Your own
`keybindings.json` merges underneath: other bindings survive, and a
`app.thinking.cycle` you already moved off `shift+tab` is left alone. The
invariant enforced is "`shift+tab` is unbound", never "our value wins".
`Ctrl+Alt+P` stays registered as the fallback for a host where the keybindings
file is absent. Plan mode closes exactly one door:

- `edit`, `write` and `apply_patch` are refused by a `tool_call` handler. They
  stay in the active tool set — deliberately. An earlier revision also removed
  them from it and called the pair "two independent barriers"; they were not
  independent, they were *stacked*. Pi resolves a call against the declared
  tool list and answers `Tool write not found` **before** the `tool_call` hook
  runs, so the narrower barrier sat in front of the wider one, the plan-file
  exception could never admit anything, and the documented refusal was never
  shown. One barrier the model can reach and read beats two that shadow each
  other; a `write` attempt now costs one turn and comes back with the sentence
  that says where the plan goes.
- **One file is writable: this session's plan.**
  `.github-router/plans/pi-plan-<session-id>/plan.md` — derived by the extension
  from `ctx.sessionManager.getSessionId()`, never chosen by the model, and a
  `write`/`edit` is admitted only when the *resolved* path equals it. Claude
  Code's plan mode is a one-write mode (the plan is an editable Doc); without
  the exception our model would have no artifact to hand back.

  The session id is what makes parallel use safe. A single pinned
  `.github-router/plans/pi-plan/plan.md` was the original design and it does not
  survive two sessions in one repo: both resolved the same path, so both cleared
  the gate — there is no ownership in a path comparison — and the second plan
  silently replaced the first. An `edit` written against the old text then
  failed with a message about fuzzy matching, which describes the symptom and
  not the collision. Everything else in plan mode was already per-session (the
  mode, the steps and the execution flag live in the session's own transcript);
  the file was the last piece of shared mutable state. Claude Code solves the
  same problem the same way — its artifact hook reads `tool_input.planFilePath`
  "per-session; never the globally-newest file in the shared plans dir".

  Derived rather than generated: a resumed session has to land back on the file
  it started, and the session id is the only thing stable across resume (it is
  in the session-file header and restored on `--resume`), so resume safety is
  free and no plan registry is needed. The full id is used rather than a hash or
  a prefix so a plan directory traces to the session that wrote it; UUIDv7 is
  time-ordered, so a prefix would collide for launches in the same millisecond.
  The id is sanitized to `[A-Za-z0-9._-]`, which makes traversal structurally
  impossible (no separator survives, and every segment is prefixed with
  `pi-plan-`, so a dots-only segment is unreachable). Sanitizing is lossy, and
  lossy is a collision: Pi's own id validator admits `.`, so `a.b` and `a-b`
  are both legal ids — which is why dots are kept rather than replaced, and why
  an id the sanitizer had to CHANGE (a dropped character, a trim, or the
  96-character cap) carries an eight-hex digest of its original bytes instead of
  silently merging with the id it resembles. Generated UUIDv7 ids never take
  that path, so the readable form that traces to the transcript filename is the
  common case. It is still one `<slug>` segment under
  `.github-router/plans/`, so the `/gh-plan` → `<slug>/plan.md` convention
  still describes the shape.

  A host that cannot report a session id (an older Pi, a `getSessionId` that
  throws) falls back to the single `.github-router/plans/pi-plan/plan.md`,
  which is exactly the previous behaviour — fail-open, never fail-closed.

  A fork (`session_start` with `reason: "fork"`) is where the two designs meet.
  Pi copies the parent's entries into the forked session, so a fork inherits the
  plan *mode* and the checkbox state — while resolving a **new** id, so its plan
  file has never been written and the parent's is refused. That is the intended
  trade: a fork cannot rewrite the plan it branched from, and it starts from an
  empty file rather than a stale copy. The brief is worded for that — "this one
  plan file", not "the SAME file" — because the model is told to keep ONE plan,
  not told to keep the parent's.

  The path gate is platform-agnostic: separators are unified before comparison,
  so on a Windows cwd (`C:\work\repo`) the backslash, forward-slash, mixed,
  drive-absolute and `.\`-relative spellings of the plan file are all admitted,
  while a sibling, a look-alike, another drive, a UNC share and another
  session's plan directory are all refused.

  The comparison runs on a normalized absolute path, so `./…`, `//`, and
  traversal that lands on this session's plan file are admitted while a sibling
  (`notes.md`), a look-alike (`plan.md.bak`), another plan directory — including
  **another session's** plan directory — or `../plan.md` are not. `apply_patch`
  has no single target to check, so it has no exception.

Everything else stays available, deliberately. `bash` and `powershell` are
both allowed; so are MCP tools, `subagent`/`workflow`, `todo` writes, and
every other tool in the roster. An earlier revision maintained a read-only
allowlist for `bash`, a destructive-flag table, a de-quoting pass to defeat
`find${IFS}.-delete`, a PowerShell ban, a delegation block and an MCP namespace
deny. All of it is gone, for three reasons: a command string cannot be
classified (each of `sed -n '1e sh'`, `awk 'BEGIN{system("sh")}'`,
`sort --compress-program=sh` needed its own row, and the next trick always
had none); every rule was a bet that a frontier model cannot be trusted with a
shell it was just told to only read with; and each one cost capability the
planning turn actually needed — `git log`, `rg`, running the test suite to see
what it does, or delegating a parallel survey of the repo.

Be clear about what this is: a **norm enforced with one mechanical edge**, not a
sandbox. `bash` is allowed in plan mode, so a model that wanted to write
`src/x.ts` could `echo > src/x.ts` and no handler would see it. That is the same
trade Claude Code makes, and the right one for a mode whose purpose is to keep a
cooperative model from getting ahead of the user — not to contain a hostile one.

What replaces them is prose — under 2,000 characters of it, roughly the length
of Claude Code's own plan-mode reminder. The brief says the user does not want
execution yet, that this supersedes any instruction to do the work now, and
that the plan file is the single exception. It then gives the workflow: reuse
what already exists, ask only what exploration cannot answer, design until an
implementer has no open decisions left, write Context / recommended approach /
critical files / verification to the plan file, summarise in the reply. It
ends with the two norms a frontier model actually needs — leaving plan mode is
the user's action, so never ask for plan approval through `ask_user` or prose;
and if an action would be described as *doing* the work rather than *planning*
it, it waits — plus the rule that this session keeps ONE plan file: a user who
asks for changes gets a revision in place, not a second plan. That is how a
capable model is kept in planning mode; a 600-line command table was how a weak
one was fenced in.

- The injected context is `display: false` and only appears on a real user
  turn — a background notification cannot re-add it. Pi appends and persists
  each injected block, so the transcript keeps only the newest block of each
  kind, and a block lives only while its own mode does: the read-only
  instructions disappear the moment execution starts (they would contradict
  the "full access" notice), and everything is gone once plan mode ends.

Plan mode **never touches the tool set** — not on entry, not on exit, not on
resume. It owns the gate, not the roster. Two bugs came from owning both: the
stacked barrier above, and a resume path that re-applied a saved snapshot
verbatim, so a session started under `--tools read,bash,edit` handed `edit`
back to a later launch that had deliberately dropped it. Resuming now restores
plan state (the mode, the step list, the widget) and nothing else, and a test
asserts that a saved `toolsBeforePlan` cannot widen a narrower live roster.
Plan state persists through a custom session entry — one per real change, not
per turn — and starting a fresh session (`/new`, a fork into an empty branch)
releases it. The plan FILE is per-session too (see above), so a fork into a new
session gets its own file and cannot edit the one it forked from.

**Checklist.** A numbered list under a plan heading — `Plan:`, `## Plan`,
`## Recommended approach`, `## Steps`, `## Implementation plan` — is parsed into
steps and rendered as a resident widget above the editor, plus a footer badge —
`⏸ plan` while planning, `📋 2/5` while executing. Accepting "Execute the
plan" kicks off the first step and tracks
progress from `[DONE:n]` tags (text *and* thinking blocks, since
reasoning-max models often tag in thinking); "All steps complete" is honoured
as a fallback. Completion is posted as a `nextTurn` message rather than
`triggerTurn`, so a checkmark never buys an extra model turn. The checklist is
display state only: plan mode never touches the file-backed `todo` tool, so a
plan and a todo list stay separate stores.

**Versus `--swe`'s `gh-plan`:** plan mode gates tools inside one session;
the `gh-plan` skill (only with `--swe`) writes a durable `plan.md` plus a
`.complete` marker for a multi-agent pipeline. Both exist on purpose — the
first is interactive exploration, the second is an artifact other agents read.
They differ in one property worth knowing: plan mode's file name is derived from
the session, so two parallel Pi sessions cannot collide. `gh-plan`'s slug is
chosen by the model, so two parallel `--swe` runs in one repo still can.

Fail-open throughout: every Pi API the section touches is feature-probed, so a
Pi build that grew or dropped one degrades to "no plan mode" rather than a
broken session. `Shift+Tab` follows the converted binding, so a terminal that
swallows the sequence loses it too; `/plan` is the fallback that always works.

## Files

- `src/pi.ts` — launcher (TTY or `--print`/`--mode` headless).
- `src/lib/pi-models-settings.ts` — pure builders (models/settings,
  agents, APPEND_SYSTEM digest, compaction derivation). Unit-tested in
  `tests/pi-models-settings.test.ts`.
- `src/lib/pi-tier-windows.ts` — pinned tier thresholds, window
  derivation, price-drift guard. Unit-tested in
  `tests/pi-tier-windows.test.ts`.
- `src/lib/pi-extension.ts` — extension source + skills + prompts + bridge lazy-attach (`tool_result`) + `/memory` + `/context`.
- `src/lib/pi-memory-bridge.ts` — pure bridge builders (frontmatter scope, glob match, `@` imports, caps, redaction, mirror synthesis). Unit-tested in `tests/pi-memory-bridge.test.ts`.
- `src/lib/pi-paths.ts` — mirror lifecycle plus the durable session
  root (`piSessionsDir()`).
- `src/lib/pi-version-check.ts` — install/update gate.

## Claude-Code look (bundled by default)
`pi-claude-code-ui` ships by default (`--no-ui` opts out): grouped rows,
Shiki diffs, Ctrl+O previews. The TUI follows the terminal's own palette
(`theme: system`), which is what cc-ui does on its own at `session_start`
anyway — pinning `claude-code-dark` only produced a startup flash and a
settings file that lied about the active theme. The six genuine CC
palettes still load themes-only from `better-claude-code-ui` (none of its
status line, footer, or tool rendering loads, so the router-owned AIC
footer is untouched), so `claude-code-dark` / `claude-code-light` / any
installed theme stays one `/settings` pick, and a user's own `theme` value
still wins. For the full Claude behavior set, install
yourself — the `~/.pi/agent` snapshot carries it into the mirror automatically
(`pi-code` itself stays out of the bundle: its `/memory` + `/context`
commands would collide with the router-owned pair):

```bash
pi install npm:pi-code            # Claude behavior: todos, /rewind, /memory, subagents, /context, /init
pi install npm:pi-claude-code-ui  # Claude transcript: grouped rows, Shiki diffs, Ctrl+O previews
```

Alternatives: `@owlburtoe/pi-claudify` (closest `⏺`/`⎿` grammar), `cc-my-pi` (header + spinner + dark theme), `better-claude-code-ui` (6 themes + footer). Themes: `pi.dev/packages?type=theme`, `pi --theme <file>`, `/settings`.

### Customizing the look

Yes — every display default is overridable, at three levels:
1. **Your settings win for display keys.** Anything you set in
   `~/.pi/agent/settings.json` for these keys survives the launch
   (snapshot-carried into the mirror, applied over our defaults):
   `hideThinkingBlock`, `theme` (default `system`; `claude-code-dark`,
   `claude-code-light`, or any installed theme also work),
   `terminalTheme`, `thinkingMode` (`live`/`full`/`latest`),
   `bashIntent` (`off`/`model`/`local`),
   `themeAdaptive`,
   `groupToolCalls`, `readOutputMode` (`summary`/`preview`/`hidden`),
   `searchOutputMode` (`count`/`preview`/`hidden`),
   `mcpOutputMode`, `bashOutputMode` (`summary`/`preview`/`opencode`),
   `toolBackground`, `terminal`, `images`, `markdown` (`mermaid: streaming` pinned),
   `tuiMode`, `quietStartup`, and the four `fullscreen*` keys.
   Example:
   `"hideThinkingBlock": false` shows thinking again;
   `"readOutputMode": "preview"` restores expanded reads. Load-bearing keys (models, tools, thinking levels,
   compaction, retry, packages) always stay router-owned — those are
   the cost contract, not a preference.
2. **Kill-switch:** `--no-ui` drops the whole transcript package.
3. **Runtime toggles (this session):** `/settings` (thinking, theme),
   `/cc-theme terminal on|off` (follow the terminal vs. a fixed palette),
   `/cc-tools thinking|group|outlines` (thinking expansion, grouping,
   chrome), `/cc-spinner` (spinner colors).

Rich rendering never costs tokens: mermaid diagrams stream in the TUI
(`markdown.mermaid: streaming`, pinned), pasted/dragged images display
inline (`terminal.showImages`, kitty/iTerm2 auto-detect), and diffs
render via Shiki in `pi-claude-code-ui`. All three are display-side —
they change zero bytes on the wire to the model.

## Terminal mode (regular by default)

Pi defaults to `tuiMode: "fullscreen"`; the generated settings pin
`"regular"`. Regular mode hands the screen back to the terminal: scrollback,
select, copy and wheel scrolling are the terminal's own bindings, over the
whole session, instead of an app-owned viewport that reimplements them. That
is what most people mean by "mouse support" and it is the mode that keeps
terminal-native search (`Ctrl+Shift+F`, `tmux copy-mode`) working.

Mouse is a fullscreen-only feature by Pi's design — regular mode deliberately
leaves mouse input to the terminal, because the terminal owns the scrollback
(`docs/tui.md` in the Pi package). Anyone who wants app-level mouse (drag
selection inside the transcript, the app's own scrollbar) opts in per launch:

```bash
github-router pi --tui-mode fullscreen
```

`--tui-mode` is not a router flag, so it passes straight through to Pi. The
four fullscreen knobs are pinned to Pi's current defaults
(`fullscreenExitOutput: "transcript"`, `fullscreenScrollbar: "auto"`,
`fullscreenCopyOnSelect: true`, `fullscreenWheelScrollLines: "auto"`) rather
than left absent, so the opt-in path cannot silently regress when a Pi release
changes one of those defaults. They are inert in regular mode.

`quietStartup: true` is also emitted: the router prints its own launch card
before spawning Pi, so Pi's startup header plus its loaded-resource listing is
duplicate noise. `"header"` (version and key hints only) and `false` remain
available as user overrides. `defaultProjectTrust` is deliberately NOT set:
auto-trust would let a cloned repository load its own extensions at startup,
which is a security downgrade rather than a convenience.

## Verification

```bash
bun test tests/pi-memory-bridge.test.ts tests/pi-models-settings.test.ts
bun run typecheck && bun run lint:all && bun run build
```

Spike note, recorded when Pi 0.87.1 was the latest release and the vendored
worker runtime pinned v0.82.0: the launcher uses the installed Pi and is
independent of the vendor tree. Both have since moved in step to the 1.3.0
line (`PI_MIN_VERSION` and `docs/pi-vendor-sync.md`), so an install below
1.3.0 now fails the launch floor instead of running the older shape this
note was measured against.

## Helpful bundle (exclusion guardrails)

`--helpers` (default on, peers-gated) wires allowlisted
`pi-agent-extensions` and conditional `pi-web-access` (all
extensions-only filtered: `skills: []`, `prompts: []`, so third-party
prose never reaches Ctrl+O). Deliberately excluded:
`pi-mcp-adapter` (an installed `/mcp` extension replaces built-in MCP,
so it would silently take the whole native surface away),
`review`/`loop`/`workflow`/`control` (overlap our delegate/review
pipeline), any footer/statusline package (router owns the AIC footer
via `gh-router-pi`), compaction replacers (`session_before_compact`
stays observe-only), and provider/model overriders (would break the
fixed-roster cost contract). `--ui` opts into `pi-code` +
`pi-claude-code-ui`; `pi-lean-ctx` stays a docs recipe until its
manifest paths are pinned. `pi-claude-code` is likewise a manual
recipe: it duplicates the two UI packages already bundled and ships a
statusline that would fight the router-owned AIC footer.

## npm `allow-scripts` is neutralized for the Pi child

Pi installs the mirror's `packages[]` on every boot with a project-scoped
install (`npm install <pkg> --prefix <mirror>/npm`). npm 11.19 refuses a
CLI- or env-sourced `allow-scripts` for that shape
(`resolveAllowScripts`: `cliPolicy && !npm.global && !skipProjectConfig`
throws `EALLOWSCRIPTS`), so a shell export of `npm_config_allow_scripts` -
routine on managed corporate machines - kills the launch before a single
package lands, naming a flag the caller never passed. Measured on npm
11.19.1 with the real command against a scratch prefix: with the export
present the install fails; with it unset or emptied it succeeds.

`getPiLaunchEnvVars` therefore emits `npm_config_allow_scripts=""` for the
Pi child only. Empty is not a policy change: npm reads it as no
configuration and falls through to the `.npmrc` cascade, which is exactly
where npm's own error message says the setting belongs - so an operator
who allowlists a package for install scripts in `.npmrc` keeps that
allowlist, and their shell export still applies to their own npm use. The
router's other npm invocations are `npm install -g` (Pi's own install and
update), which the rule exempts because global installs have no project
context to protect.

## npm registry and publish-age, for the Pi child only

The router installs Pi itself through `resolvePiRegistry()`
(`src/lib/pi-version-check.ts`), which defaults to
`https://registry.npmjs.org/` because a corporate feed lags behind npmjs and
the version floor becomes unreachable. That covered the router's own install
and nothing else: the moment the model ran `npm install` from Pi's bash tool
the same feed came back through the front door, which for a coding agent is
the common case rather than the exception.

`getPiLaunchEnvVars` now emits both settings into the child env:

| Variable | Value | Why |
| --- | --- | --- |
| `npm_config_registry` | `resolvePiRegistry()` | Same registry the router's own Pi install uses, so `GH_ROUTER_NPM_REGISTRY` (http(s)-validated, trailing slash normalized) stays the single override |
| `npm_config_min_release_age` | `"0"` | npm's `min-release-age` holds fresh versions back for a cooldown window. Fine for an application, fatal for a package whose floor is newer than the window. `0` is the env form of deleting the setting |

Both are read from the environment and override the `.npmrc` cascade. Verified
on npm 11.19: `npm config list` reports the user and global entries as
"overridden by env", and `npm config get min-release-age --json` returns `0`
for a numeric value.

**Blast radius, stated plainly.** `npm_config_registry` reaches every process
the Pi child spawns, including anything the model runs through bash. That is
the intent: it reproduces the operator's own
`npm config set registry https://registry.npmjs.org/ && npm config delete
min-release-age --location=global` prefix for the whole session. It is
narrower than that prefix in one respect and wider in another. Narrower:
nothing is written to the user's `.npmrc`, so their own npm keeps the
corporate feed. Wider: an `npm publish` inside a Pi session also targets
npmjs, which is why the setting lives only in this child and not in the
parent env.

Neither variable is gated on `GH_ROUTER_PI_VERBOSE_NPM`. That flag is about
log noise; folding reachability into it would point an operator who asked for
stock npm output back at the feed that cannot serve the install.
