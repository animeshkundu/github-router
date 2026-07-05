# Cross-repo, multi-machine orchestration — what exists, what's missing

**The vision under research:** a SINGLE Claude instance ("the conductor") that thinks and drives
improvements ACROSS both repos (github-router + ai-or-die) using MULTIPLE machines in parallel —
work no single human could manage. This report maps the building blocks that already exist, traces
each observed friction to a root cause in code/config, and specifies what is REQUIRED beyond what
exists to make conducting reliable, consistent, and friction-free.

**Method:** read-only audit of both repos, fanned across three sub-investigations (fleet MCP
surface; ai-or-die control plane / bridge / tunnel; orchestration / aggregation / observability),
then reconciled. Every load-bearing claim carries a `file:line` anchor; doc-only claims are tagged
lower-confidence. Live `await_turn` against the real fleet (`alpaca-1`, `ani-devbox`, `mini-local`,
plus a stale `deleted-teams-machine` returning `TIMEOUT`) corroborates the event vocabulary.
Confidence: **[H]** = verified in source both sides · **[M]** = verified one side / doc-corroborated ·
**[L]** = inferred / not executed.

---

## 1. The one-line verdict

The conductor today straddles **two capability planes that do not compose**:

1. **Fleet MCP** (`src/lib/fleet/`) — cross-machine *session control*: create / send / respond / read
   one remote terminal per call, plus ONE real fan-out (`await_turn` merges events across instances).
   It has reach but only verb-level reach: no machine inventory, no task model, no result
   aggregation, no cost, coarse all-or-nothing permissions.
2. **Orchestrate MCP + workers + skills + floor-keeper** (`src/lib/orchestration/`,
   `src/lib/worker-agent/`, `src/lib/injected-skills/`) — a real **do-no-harm floor** (champion
   retention, cross-lab review, sealed gates) — but pinned to a SINGLE LOCAL absolute workspace
   path. It cannot see a remote machine. The orchestration package never imports fleet. **[H]**

The conductor sits in the seam and hand-rolls everything cross-machine because no primitive bridges
the two. The rich floor/review machinery can't target the fleet; the fleet can't dispatch /
aggregate / reconcile a task matrix or account for cost. The closest existing fan-out, `await_turn`,
*watches* but does not *act*. **The highest-leverage work is to build the bridge, not to rewrite
either plane** — the kernel is already abstract over an injected runner
(`src/lib/orchestration/kernel.ts:44-52`), so cross-machine needs a NEW remote runner, not a
rewrite. **[H]**

---

## 2. Success criteria for "frictionless cross-repo multi-machine conducting"

A conductor session should be able to, with first-class primitives and without hand-rolling
per-machine monitors:

1. **Discover** the fleet: for each machine, which repos exist, their paths, current branch,
   clean/dirty state, the github-router + ai-or-die + claude versions in play, and whether the
   service is up — in one structured call.
2. **Converge** every target machine to a known state (branch/commit, pinned tool versions,
   provisioned env/secrets) before driving — reproducibly, not by scripting git through a shell.
3. **Reach** machines reliably: tunnel auth self-heals or at minimum surfaces a precise, proactive
   diagnosis; transient `TIMEOUT`/`AUTH_FAILED` recover without a human babysitting `devtunnel`.
4. **Dispatch a task across N targets, watch, aggregate, and reconcile** through one primitive —
   not N creates + N sends + a hand-rolled watch loop + N pulls + a manual merge.
5. **Get an unambiguous completion-with-result signal** per remote session — "this task (including
   its subagents) is done, here is the artifact/result" — not turn-boundary heuristics + tail-reading.
6. **Observe** all parallel remote Claudes: aggregated progress, failures, blockers (with the
   blocking prompt inline), and cost/token spend, in a consolidated view.
7. **Run autonomously but safely**: a permission/policy envelope finer than all-or-nothing bypass —
   per-tool / per-command / per-machine guardrails before destructive or outward-facing ops.
8. **Route remote work through the human/automated review gate** (gh-floor-keeper + the
   artifact-review loop) without the conductor acting as the manual transport layer.

---

## 3. Current capabilities map (the building blocks that exist)

### 3.1 Fleet control plane (github-router → ai-or-die `/api/control/*`)
- **Registry** `~/.local/share/github-router/fleet.json`: `{id,label,url,token,tunnelId?,tunnelToken?,insecureTLS?,default?,allowExec?}` — a pure *connection* registry (`src/lib/fleet/registry.ts:5-43`). **[H]**
- **Tools** (`src/lib/fleet/tools.ts`): `list_instances` (reachability probe, 5 s cached, `:280-292,216-241`), `list_sessions`, `read_session`, `session_status`, `send_message` (`:337-391`), `send_keys`, `respond`, `create_session` (`:441-487`), `stop_session`, `await_turn` (`:510-585`), plus `read_file`/`list_dir`/`search`/`git_show` (file reads forwarded to ai-or-die, `client.ts:409-421`). **[H]**
- **`await_turn` is the one cross-instance fan-out:** long-polls all/selected instances (`AWAIT_TURN_FANOUT_CONCURRENCY=256`, `tools.ts:36,529-531`), merges events, time-sorts them into one stream (`stampEvent`/`compareStampedEvents`, `tools.ts:568-570,821-828`), carries per-instance opaque cursors. **[H]**
- **Tunnel auth** (`src/lib/fleet/tunnel-auth.ts`): lazily mints a `connect`-scope devtunnel token via `devtunnel token <id> --scopes connect --json` (`:247`), caches per tunnel, re-mints ~5 min before the 24 h expiry (`:58,295-323`), single-flights, 30 s negative backoff on mint failure (`:61,283`). Classifies "run `devtunnel user login`" from devtunnel stderr (`:219-223`). **[H]**
- **Wire contract** frozen in `docs/fleet-control-plane-contract.md`; capability negotiation via `/api/control/capabilities` (fail-closed on a known-absent capability, fail-open when undeterminable). **[H]**

### 3.2 ai-or-die per-machine server
- **Two spawn paths.** Control/fleet path `_controlStartAgent` (`ai-or-die/src/server.js:4466`) injects the full artifact env trio + hardening + the PTY edge detector; manual-tab path `startToolSession` (`:5075-5291`) injects only `AIORDIE_CLAUDE_BIND` (terminal). **[H]** (verified first-hand: `server.js:4503-4507` vs `5155-5160`).
- **Claude bridge:** `claude` always resolves to `npx -y github-router@latest claude --browse` (`ai-or-die/src/claude-bridge.js:35,15-26`); github-router's `claude` subcommand registers the bind hook + Copilot proxy + MCP wiring. **[H]**
- **Tunnel** (`ai-or-die/src/tunnel-manager.js`): hosts a devtunnel; `--allow-anonymous` is **opt-in, default OFF** (`:15,251`), i.e. the default is a PRIVATE tunnel. **[H]**
- **Health/diagnostics:** `GET /api/health` → `{status,claudeSessions,activeConnections}` (`server.js:1215-1221`) and `/api/diagnostics` (`:1235`) — both registered AFTER the Bearer middleware (`:1180`), so token-gated despite the "safe to expose" comment. **[H]**
- **Crash-restart supervisor:** `bin/supervisor.js` respawns the server with tiered backoff + a Windows Job-Object guard (`:122-226,278-304`). **[H]**
- **Artifact-review loop** (ADR-0033): `artifact_open`/`artifact_poll`/`artifact_reply` against `/api/artifact/*`, gated on the env trio. **[H]**

### 3.3 Orchestration / workers / review (LOCAL)
- **Orchestrate MCP** (`decompose`/`verify_workflow`/`run_workflow`/`attest_step`): a verified typed IR run through a frozen kernel delivering `max(orchestrated, baseline)` over sealed executable gates (`docs/agent-orchestration-design.md`; `src/lib/orchestration/kernel.ts:163-184`). **[H]**
- **Workers** (`mcp__workers__*`): explore / plan / review / implement / test, a Pi `Agent` over a canonicalized LOCAL workspace with local worktree provisioning + local `bash` (`src/lib/worker-agent/engine.ts:30-65`). **[H]**
- **Peers** cross-lab critics; **skills** `gh-research` / `gh-orchestrate` / `gh-floor-keeper` (`src/lib/injected-skills/`). **[H]**
- **Concurrency limiters:** shared MCP `MAX_INFLIGHT_TOOLS_CALL` (default 128, `src/lib/mcp-inflight.ts:30-33`); the LOCAL worker semaphore (default 8, fast-fail, `src/lib/worker-agent/semaphore.ts:27-33`); `await_turn` fan-out cap (256). The worker semaphore does NOT bound remote fleet sessions. **[H]**

---

## 4. Gap & friction analysis (per checklist, evidence-tied)

### A. Machine / repo discovery & inventory — **MISSING** **[H]**
- The registry carries only connection/auth fields; no repos, paths, branches, versions, services, or health (`registry.ts:5-43`). `list_instances` returns reachability only — `{id,label,reachable,sessionCount,lastSeen}` or `{reachable:false,error,hint}` (`tools.ts:44-47,216-241`), DROPPING even non-secret `url`/`default`/`allowExec`.
- ai-or-die exposes `git_show` (`git show <ref>:<relpath>` — file content at a ref, `server.js:2110`) and a per-session repo-root endpoint, but **no** `git status --porcelain` / current-branch / dirty-clean / version / inventory endpoint exists, and github-router exposes neither repo-root nor any status as a fleet tool.
- **Friction observed (brief #7):** had to SEARCH where repos lived, manually check branch/clean state, and discovered github-router was on a feature branch on ani-devbox but master on alpaca, with the service up on one machine and not the other. There is no inventory to consult. The stale `deleted-teams-machine` in the live registry (returns `TIMEOUT`) shows there isn't even instance-lifecycle hygiene.

### B. Auth / tunnel reliability — **PARTIAL; no self-heal, no proactive surfacing** **[H]**
- Mint/refresh automation exists but only github-router-side, and reconnection is minimal: exactly ONE re-mint+retry per request (`client.ts:465,507-522`), a flat 30 s negative backoff (not exponential), and `AUTH_FAILED` is non-retryable at the probe/await level (only `TIMEOUT` retries, `client.ts:544-552`). Static `tunnelToken` instances get NO retry (`tools.ts:967-970`).
- **`devtunnel user login` has no automation** — documented one-time human prerequisite whose identity needs mint rights on every fleet tunnel (`docs/aiordie-fleet.md:28-30`). The code only *detects* not-logged-in and emits an actionable message; a human must log in.
- **No proactive login/health monitoring:** login state is discovered reactively, only on the next mint attempt. **Friction (brief #1):** reaching machines failed with `AUTH_FAILED` until a human ran `devtunnel user login`; instances intermittently `TIMEOUT` on probe — both observed live in this session.
- **Drift finding:** ai-or-die's tunnel default is PRIVATE (`tunnel-manager.js:15,251`), but ADR-0002/0032 describe/assume an anonymous tunnel — a likely setup-friction source. **[M]**
- **Correction to the brief:** the exact string "GitHub token refresh failed" does NOT exist as a literal in either repo. The real surfaces are the `AUTH_FAILED` family (devtunnel connect-token at `client.ts:531-535`, or the ai-or-die Bearer 401/403 at `:576-584`) and a SEPARATE, unrelated subsystem — github-router's Copilot/GitHub OAuth refresh for the LLM proxy (`src/lib/token.ts:59,117`). Conflating the tunnel auth with the LLM-proxy refresh would mis-diagnose; the live log line is needed to disambiguate which fired. **[M]**

### C. Session lifecycle & driving — **PARTIAL; weak completion semantics, event-parity hole, no reliable in-flight steer** **[H]**
- **`send_message` is delivery-only `isError`** (`tools.ts:358-389`): a delivered-but-unconfirmed message returns `confirmationPending`/`confirmationTimedOut` and is explicitly NOT an error. This is by design (F9), but it is an **ambiguous conductor-facing signal**: "delivered, turn not confirmed in the window" looks like failure but isn't (**friction brief #5**). Producer confirmation: `confirmed = bound && submitted && turnCompleted` — terminal sessions return `confirmed:true, confidence:'low'` because a shell has no turn (`server.js:4666-4683,4700-4710`).
- **The terminal/manual event-parity hole (friction brief #4, root-caused):** `turn_ended` is **bound-claude-only**, emitted exclusively by the JSONL turn detector (`server.js:5673-5686`; "never faked from the coarse unbound signal", `:4218-4220`). Coarse `became_busy`/`became_idle` for unbound sessions come only from `_controlRecordPtyOutput` (`:4253-4279`), which is wired into the CONTROL path's `onOutput` (`:4531`) but NOT the manual-tab `onOutput` (`:5188-5212`). So a plain `terminal` session started from the manual UI emits NO turn_ended (ever) AND no coarse busy/idle — `await_turn` filtered to it returns nothing and the cursor never advances past head ("stuck at 0", because `_seq` only increments when an event is appended, `event-bus.js:75,88`). **Refinement of the brief:** the boundary is *control-spawned vs manual-start* (and *bound-claude vs unbound*), not *terminal vs claude* per se — a control-spawned terminal DOES get coarse edges, and a bound claude in a manual tab DOES get real turn events. **[H]**
- **No first-class "whole task (incl. subagents) complete, here is the result" signal** (**friction brief #6**): completion is a single-turn transcript-tail heuristic (`endsOnAssistant`, `server.js:4780-4791`); the session-bind path explicitly SKIPS subagent payloads (`docs/aiordie-session-bind.md:30-31`). The result text must be separately tail-read via `read_session`. `EVENT_KINDS` is frozen with no "task done" kind (`event-bus.js:49-58`). **[H]**
- **Driving via `send_keys` is PTY-byte injection, and it is unreliable on Windows (observed this session on `ani-devbox`)** — root-caused. `_controlSendKeys` maps a named key to control bytes (`_controlKeyBytes`: `enter`→`\r`, `up`→`\x1b[A`, `escape`→`\x1b`, etc., `server.js:4958-4992`) then `bridge.sendInput()` writes those bytes to the PTY (`:4856-4857`). Two failure modes compound: **(1)** the name table is lowercased-exact-match and falls THROUGH to the literal string on any miss (`:4990-4991`) — so a non-canonical name like `BSpace` (vs the table's `backspace`) is typed as text, not a key; and **(2)** even canonical names and `raw` byte sequences (`\r`, `\x1b`, `\x15`) landed LITERALLY in the Claude TUI composer on the Windows instance — consistent with the in-code note that "ConPTY setup on Windows flaked the binary smoke test's terminal echo" (`server.js:180-182`). Net: on that instance you cannot Enter-to-submit, Up-to-edit, or Esc-to-interrupt via `send_keys` — **TUI control via PTY-key emulation is not a reliable control-plane primitive**, especially cross-OS. **[H, observed + source-corroborated]**
- **A `send_message` sent while the session is BUSY does not auto-submit on return to idle (observed).** The submit path writes the text as a bracketed paste then a `\r` (`server.js:4631-4635`); when the session is mid-turn the paste lands in Claude's "Press up to edit queued messages" overlay and the trailing `\r` does not flush it on idle, so the queued steer is STRANDED — and (per the previous bullet) there is no working `send_keys` to flush it manually. There is no queued-message auto-submit-on-idle semantic on the control plane. **[H, observed]**
- **Combined consequence — once a remote turn is busy/blocked there is NO reliable external interrupt-or-steer primitive.** `respond`/`send_keys` only reach a session that is *awaiting input* (or depend on the flaky PTY path); a busy turn never yields to an input boundary. This is the same wall that stranded the `alpaca-1` "finish with what you have" nudge (§G2). It turns "drive a remote Claude" into fire-and-pray the moment a turn is in flight. **[H, observed]** → see R11.
- *(Note: DRIFT A from the contract — `FleetEvent.at` typed `string` — is already FIXED in the committed code (`client.ts:142`, `tools.ts:821-828`); the contract doc is stale on that point. Live `await_turn` confirms `at` is epoch-ms number.)* **[H]**

### D. Fan-out / aggregation primitive — **MISSING** **[H]**
- Dispatch is singleton: `create_session`/`send_message` are strictly one instance per call (create even refuses the registry default, `tools.ts:442`). `await_turn` watches but yields turn/idle EVENTS, not artifacts. There is no task-matrix dispatch, no result aggregation, no reconcile/merge.
- **Friction (brief #8):** to run a task across machines and collect results, the conductor hand-rolled monitor subagents per machine — N creates + N sends + a manual watch loop + N `read_file`/`git_show` pulls + a hand merge. Root cause: fleet = session control plane, orchestrate = local executor, and **they don't compose** (orchestration never imports fleet). **[H]**

### E. Repo / env consistency — **MISSING** **[H]**
- **No version pinning:** the launcher is always `npx -y github-router@latest claude` (`claude-bridge.js:35`), resolving `@latest` at EACH spawn — so machines auto-update mid-flight and drift (**friction brief #3:** a remote claude auto-updated 2.1.191 → 2.1.195 during the session). No way to pin a version through the fleet API.
- **No repo-sync:** grep for `git checkout/fetch/pull/reset`/`syncRepo` across both repos' `src/` returns nothing. `create_session` takes only a `workingDir` (`tools.ts:447,472`) and spawns in whatever state that directory is in (**friction brief #2:** repos on inconsistent branches across machines, no "bring all to known state"). Convergence must be scripted through a terminal session.
- **Env/secret provisioning** works on the control path (the trio + hardening) but the manual tab is the unfilled ADR-0033 follow-up (artifact tools dark there). No reproducible per-machine setup. **[H]**

### F. Cross-repo coordination — **MISSING** **[H]**
- ai-or-die is purely per-machine: ADR-0032 explicitly scopes it to one instance's HTTP control plane, with federation living in github-router's fleet group (`docs/adrs/0032:18-20`). Nothing helps coordinate a change spanning both repos, freeze a contract across them, or run integration validation across the pair. The `docs/fleet-control-plane-contract.md` IS a hand-maintained cross-repo contract, but enforcement is manual (each repo's tests are self-referential — its own opening note). **[M]**

### G. Observability — **PARTIAL; no cost, no consolidated view, pull-based blockers** **[H]**
- Structured per-session status exists: `interactionState`/`canAcceptInput`/`blockReason`/`awaiting{kind}` (`client.ts:124-133`; `session-status.js:49-61`), and permission prompts surface as `waiting_input` + a typed `awaiting.kind` answerable via `respond`. The 8-kind merged event stream is the progress feed.
- **No cost/token accounting on the fleet path at all** (verified absent in `src/lib/fleet/` and `ai-or-die/src/control/`; the design doc confirms cost accounting is Phase 2/3 and unbuilt, `docs/agent-orchestration-design.md:114,215`). **No consolidated dashboard:** progress is a raw merged event stream the conductor interprets per-session. **Blocker surfacing is two-step / pull-based:** `/events` emits `waiting_input` as a wake signal but carries no `awaiting` payload — the prompt detail needs a separate `session_status` call. Deeper progress (% done, which sub-task) is only tail-readable. **[H]**
- **Observed in the wild (this session) — a live reproduction of the C+G gaps inside ONE remote lead session.** A separate remote `alpaca-1` Claude verification run jammed at final assembly: three meta-subagents (explore/implement/review) each ran live worker invocations and finished, but the lead got stuck in the finished-subagent → lead-mailbox handshake — 2 of 3 verdicts arrived only after an explicit re-request, and the 3rd (explore) never delivered its body, leaving the lead looping ~7 min with a frozen token counter and no input-boundary yield. This concretely reproduces (a) the **missing "task fully complete, here is the result" signal** (§C / R2): completion is only per-turn-inferable and the bind path skips subagent payloads, so the lead cannot tell "subagent done, result in hand" from "subagent still running"; and (b) **flaky, at-least-once subagent→lead result delivery with no dedupe/ack** — a result that must be manually re-requested, and one that never arrived at all. Note the affected handshake here is the LOCAL Claude-Code subagent→lead mailbox, distinct from the fleet wire, but it has the same shape as the fleet gap and the same root cause (no first-class completion-with-result + no delivery ack), which is why it belongs to the same requirement. **[H, observed]**

### G2. Loop control of a blocked turn — **MISSING** **[H, observed]**
- In the same jam, a queued "finish with what you have" steer **could not be consumed**: the stuck turn never yielded to a user-input boundary, so the nudge sat unread until the turn unwedged itself. There is **no external interrupt/steer primitive that lands while a turn is mid-flight** — neither for a local lead nor across the fleet (`respond`/`send_keys` target a session that is *awaiting input*, not one busy inside a blocked turn). A conductor watching N parallel Claudes cannot abort, redirect, or "ship what you have" a wedged remote session without killing it (`stop_session`) and losing its partial work. This is the loop-control complement to §I's review gate: the human/conductor can review a *finished* artifact but cannot *steer a stuck one*. The §C driving findings root-cause why even the existing inputs don't fill this hole: `send_keys` is unreliable PTY-byte injection (literal on Windows ConPTY) and queued `send_message` text doesn't auto-submit on idle. **[H, observed]** → R11.

### H. Safety / permissions at fleet scale — **MISSING (coarse only)** **[H]**
- `permissionMode` allowlist on `create_session` (`plan|acceptEdits|default|bypassPermissions`, validated server-side `claude-bridge.js:101-107`, with `agentArgs` guarded against flag smuggling `:94-98`) — so a per-session posture is settable. But the **default is full bypass** (the launcher emits `--dangerously-skip-permissions` unless an explicit non-bypass mode is passed, `launch.ts:233-244`), and the modes are **all-or-nothing**. There is **no per-tool allowlist, no per-command policy, no per-machine guardrail, no hook-based gating** in the control plane.
- **Friction (brief #9):** everything ran in `bypassPermissions` to avoid prompt friction. At fleet scale you choose unconstrained autonomy OR prompt friction the conductor answers one-at-a-time. Root cause: permission is delegated wholesale to Claude Code's `--permission-mode`; the fleet layer adds no finer policy envelope. **[H]**

### I. Human-in-the-loop checkpointing — **EXISTS but local-only** **[H]**
- `gh-floor-keeper` is a real done-gate: executable gate (binding) → cross-lab `codex_reviewer`+`gemini_reviewer` (advisory) → advisor → severity reconcile → honest go/no-go (`src/lib/injected-skills/floor-keeper-skill.ts:44-137`). The artifact-review loop (`artifact_*`) is the human visual checkpoint.
- **But both are local / single-machine.** gh-floor-keeper reads the LOCAL working-tree diff and runs LOCAL gate commands (`:33-57`); it is not fleet-aware. The artifact loop only activates on a control-spawned session (the trio asymmetry). To review a REMOTE machine's work the conductor must manually pull the artifact local (`read_file`/`git_show`) then run the local gate — the conductor IS the transport layer. The kernel's hard floor guarantee does not extend across machines. **[H]**
- **The review gate covers *finished* work, not *stuck* work.** It assumes an artifact exists to check. The §G2 jam shows the complementary hole: when a session wedges mid-turn, there is no way to steer it ("ship what you have"), so the human/conductor checkpoint cannot engage at all — the only recourse is `stop_session` (lose partial work) or wait it out. A complete human/loop-control story needs both the review gate (R9) AND an in-flight steer primitive (R11). **[H, observed]**

---

## 5. Requirements beyond what exists (prioritized)

Matrix legend — **Repos:** GHR = github-router, AOD = ai-or-die. **Kind:** code / config / process.
**Effort:** S (<1 day) / M (days) / L (week+).

| # | Requirement | Removes friction | Checklist | Repos | Kind | Effort | Prio |
|---|---|---|---|---|---|---|---|
| R1 | **Machine/repo inventory tool** — an AOD `GET /api/control/inventory` (per-repo path, branch via `rev-parse --abbrev-ref`, dirty via `status --porcelain`, github-router/ai-or-die/claude versions, service health) + a GHR `fleet_inventory` tool that fans it across instances. | #7, #2 | A,E | GHR+AOD | code | M | **P0** |
| R2 | **First-class "task complete + result" signal, with delivery ack** — a `task_completed` event (or a `send_message` completion mode) that fires when the top-level turn settles AND no subagents are pending, carrying a result digest, so the conductor stops tail-reading and disambiguating delivered-but-unconfirmed. Include an **acked / deduped result-delivery** path (a finished agent's result is delivered exactly once and confirmed, not at-least-once-and-maybe-never as the §G live jam showed). Make `await_turn` reliable for the targets a conductor actually drives. | #4, #5, #6 | C,G | GHR+AOD | code | M | **P0** |
| R3 | **Cross-machine fan-out / aggregate / reconcile primitive** — a GHR `fleet_dispatch({instances, task})` that creates+sends across N targets, watches via the existing `await_turn` merge, collects each result/diff, and returns an aggregated, reconcilable view. The natural home is a **remote `NodeRunner`** for the orchestration kernel (already abstract over the runner, `kernel.ts:44-52`) so the floor/champion-retention machinery can target the fleet. | #8 | D,F,I | GHR | code | L | **P0** |
| R4 | **Repo/env convergence + version pinning** — a `fleet_sync({instance, repo, ref})` (fetch/checkout/clean-check on AOD) and a way to pin the github-router version (replace bare `@latest` in `claude-bridge.js:35` with a fleet-specifiable version) so machines stop drifting mid-flight. | #2, #3 | E,F | GHR+AOD | code | M | **P1** |
| R5 | **Per-machine service install (launchd/systemd) + ANONYMOUS health probe** — an OS service recipe so the AOD host auto-starts and survives reboot/SSH-close (the "alpaca up, ani-devbox down" cause), plus an UNAUTHENTICATED `/api/control/ping` so a fleet probe can detect "host up but unauthorized" vs "host down". | #7 | A,B | AOD | code+process | M | **P1** |
| R6 | **Proactive tunnel-auth health + self-heal** — surface devtunnel login state in `list_instances`/inventory before a request fails; widen reconnection beyond one re-mint+retry (exponential backoff on `AUTH_FAILED`, not just `TIMEOUT`); document the private-vs-anonymous default to match ADR-0002/0032. | #1 | B | GHR(+AOD docs) | code+config | M | **P1** |
| R7 | **Fleet-scale permission/policy envelope** — a per-tool / per-command / per-machine guardrail layer (deny destructive/outward ops by default, escalate to the human checkpoint) so the conductor needn't choose between full bypass and one-at-a-time prompts. | #9 | H | GHR+AOD | code | L | **P1** |
| R8 | **Consolidated observability + cost telemetry on the fleet path** — surface per-session token/cost (AOD already has an internal `sessionUsage`, just unserialized) into control responses; carry the `awaiting` payload ON the `waiting_input` event (kill the two-step pull); a conductor-facing progress/failure/blocker roll-up. | #5, #8 | G | GHR+AOD | code | M | **P2** |
| R9 | **Fleet-aware review gate** — let gh-floor-keeper / the artifact loop accept a REMOTE diff (route a machine's diff + gate-results into the checkpoint) so the human gate works across machines without the conductor as transport. Depends on R3. | — | I | GHR | code | M | **P2** |
| R10 | **Spawn-path parity for the artifact trio** — inject the env trio in the manual-tab `startToolSession` path (ADR-0033's unfilled follow-up, `server.js:5155-5160`) so artifact review works in manually-started tabs too. | — | E | AOD | code | S | **P2** |
| R11 | **Transport-level steer / interrupt / submit primitive (NOT PTY-key emulation)** — a control-plane verb that lands a steer ("finish with what you have" / redirect / abort-to-clean) and a *submit* on a session that is BUSY inside a turn, delivered through the agent's own input channel rather than by injecting control bytes into a PTY. Today `send_keys` is PTY-byte injection that lands literally on Windows ConPTY (`server.js:4856-4857,4958-4992,180-182`) and `respond`/`send_keys` only reach an *awaiting* session, so a wedged turn is unrecoverable without `stop_session` (lost work). Must also give queued messages an **auto-submit-on-idle** semantic so a steer sent mid-turn flushes when the session returns to idle instead of stranding in the "press up to edit" overlay (`server.js:4631-4635`). | #4, #6 | C,G,I | GHR+AOD | code | M | **P1** |

---

## 6. Recommended sequencing (max leverage first)

1. **R1 (inventory) + R2 (completion-with-result) first — together they end the two worst daily
   pains.** R1 replaces the "search for repos, manually check branch/clean/service" ritual with one
   call; R2 replaces tail-reading + delivered-but-unconfirmed guesswork with a real signal. Both are
   self-contained M-effort additions that every later primitive builds on, and both are needed before
   any reliable fan-out. **Build these before R3.**
2. **R3 (the bridge) is the keystone — but it depends on R1/R2.** A `fleet_dispatch` that aggregates
   junk signals is worse than none; give it inventory to target and a clean completion signal to
   collect on. Implement it as a **remote `NodeRunner`** so the existing floor/champion-retention
   machinery (not a new, unproven orchestrator) does the reconciling. This is the single biggest
   unlock for "one conductor, many machines" and the reason to resist hand-rolling: the floor
   guarantee is the whole point.
3. **R4/R5/R6 (consistency + reliability) in parallel** once the dispatch path exists — convergence
   (R4) and a real service + anonymous probe (R5) make a dispatched task reproducible; proactive
   tunnel health (R6) keeps the fan-out from silently losing machines.
4. **R7 (safety) before scaling autonomy wide.** Full-bypass-by-default is acceptable on a couple of
   trusted boxes but does not scale to many autonomous remote Claudes; the policy envelope is the
   precondition for trusting the fleet to run unattended.
5. **R11 (in-flight steer) alongside R7** — once you run many autonomous sessions you WILL hit wedged
   ones (observed §G2: a lead looped ~7 min, unsteerable, on a stuck subagent handshake). Without a
   steer/abort-to-clean primitive the only recovery is `stop_session` and lost work, so this is an
   operational-safety peer of R7, not polish — promote it if jams recur.
6. **R8/R9/R10 last** — observability polish, the fleet-aware review gate (needs R3), and the small
   parity fix. Valuable, but each is a refinement on a working pipeline rather than a precondition.

**Why this order:** R1+R2 are cheap and unblock everything; R3 is where the leverage is but is
worthless on noisy inputs; consistency/reliability protect the dispatch; safety gates scale;
polish last. Resist building R3 first — without R1/R2 it aggregates garbage, and without the kernel
runner it forfeits the do-no-harm floor that justifies the whole system.

---

## 7. Open questions for the user

1. **Scale & topology:** how many machines, and is the conductor always one designated control box,
   or any machine? (R5's service recipe and R6's mint-rights model depend on this.)
2. **Tunnel posture:** standardize on anonymous tunnels (URL-as-secret + Bearer, simplest, matches
   ADR-0032) or private tunnels (needs the `devtunnel user login` + mint-rights chain)? This decides
   whether R6 is "automate login" or "drop login entirely".
3. **Acceptable autonomy:** for R7, what's the default policy — deny destructive/outward ops and
   escalate to the human gate, or a per-machine allowlist? What counts as "outward-facing" on these
   internal boxes (push, deploy, external API calls)?
4. **Version-pinning mechanism (R4):** pin github-router by npm version, by a fleet-wide manifest, or
   by a pre-provisioned local install? Auto-update during a run is the current default and is the
   observed drift source.
5. **The `AUTH_FAILED` you hit (brief #1):** capture the live log line so we know which of the three
   surfaces fired (devtunnel connect-token / ai-or-die Bearer / unrelated Copilot LLM-proxy refresh)
   — this report could not disambiguate from source alone.

---

## 8. Confidence & what could not be verified
- **[H]** spawn-path parity, the turn/event divergence and its root cause, run_workflow locality, the
  permission default, the absence of inventory/cost/repo-sync/version-pin — all verified in source on
  both sides (several first-hand by the synthesizer, e.g. `server.js:4503-4507` vs `5155-5160`).
- **[M]** the private-vs-anonymous tunnel-default drift; cross-repo coordination scope; a few ai-or-die
  route-shape details that came via a delegated sub-investigation rather than line-by-line re-reads.
- **[L]** none of the runtime behavior was EXECUTED against a live instance beyond the corroborating
  `await_turn` poll; the precise origin of the brief's "GitHub token refresh failed" string is not a
  literal in either repo and needs a live log.
- Docs-vs-code drift flagged: contract DRIFT A is already fixed in code; `docs/aiordie-fleet.md:62`'s
  "LOUD isError on unconfirmed delivery" is outdated (F9 made `isError` delivery-only).
