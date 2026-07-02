export const FIRST_MATE_SKILL = {
  name: "gh-first-mate",
  md: `---
name: gh-first-mate
description: Thin operating protocol for the first-mate GitHub cloud-agent controller: start missions, wake the durable controller loop, answer model and human requests, keep context compact, and report from the board/ledger rather than rereading full diffs or logs.
user-invocable: true
---

# gh-first-mate: durable cloud-agent controller loop

Use this skill when the user wants first-mate to drive GitHub cloud coding agents across one or more repositories.
The first-mate controller is the durable system of record: missions, units, decisions, handles, and controller state live in its registry and ledger.
Your job is to run the thin protocol, not to hold the mission in context.

## Start a mission

For a new goal, call mcp__first-mate__start_mission with:

- goal: the user's goal in one sentence.
- repos: repository strings as owner/name.
- acceptance_criteria: explicit user-blessed acceptance criteria.
- priority and house_rules only when the user supplied them or they are necessary constraints.

If acceptance criteria are missing or ambiguous, ask the user before starting.
Do not decompose the mission yourself at start time; v1 mission registration is intentionally simple and later controller wakes/model requests drive decomposition and steering.

Invariant (closes the stranding hole): work only ever becomes active inside a turn — start_mission is a tool call, nothing activates a mission server-side. So immediately after start_mission, run one loop turn (advance, then arm the heartbeat) in the SAME turn, before you yield. Never register a mission and stop without arming; otherwise nothing will wake to drive it.

## Controller loop (push-based, self-driving)

The loop is push-based: each turn you DRAIN all ready work, then ARM the next wake and YIELD the turn. You never sit polling advance in a tight loop — that does not scale and wastes context. A durable heartbeat re-invokes this skill while the session is idle, and one advance call sweeps the WHOLE portfolio (every mission, every repo) at once, so a single heartbeat drives everything.

Each turn:

1. Call mcp__first-mate__advance, batching any answers you already have.
2. Read the compact response: board, needsModel, needsHuman, applied_count, nextWakeAt, and nextWakeSeconds.
3. Answer every needsModel item with the typed verdict for its kind, and courier every needsHuman packet. If you produced any model_answers this turn, call advance again to apply them and pick up the resulting state. Stop this inner drain once advance returns no new needsModel you can answer without the user; keep it bounded (at most a few iterations), never a busy loop.
4. Manage the heartbeat from nextWakeSeconds (see "Self-driving heartbeat").
5. Report compactly from the board, then YIELD. Do not call advance again until the next scheduled wake or a new user message.

When submitting answers, batch what you have:

- model_answers: [{ requestId, verdict }]
- human_decisions: [{ requestId, choice }]

Keep verdicts small and typed to the request kind.

## Model request verdicts

Use the request's kind and payload as the contract:

- review_plan: review the plan against the mission goal, acceptance criteria, and house rules. Return { decision: "approve" } when the plan is good enough to implement, or { decision: "refine", instruction: "..." } with a short actionable refinement.
- answer_agent_question: answer only from the acceptance criteria and supplied context. Return { answer: "..." }. If the answer is not derivable, do not invent policy; escalate by leaving a short answer that says what the human must decide.
- author_fix: author a concise fix instruction for the cloud agent. Return { instruction: "..." } with the failure, expected behavior, and any bounded check to run.
- judge_review: judge whether review/CI/floor evidence is sufficient. Return { pass: true } only when the acceptance criteria and floor are satisfied; otherwise return { pass: false } with a compact reason when useful.

Delegate heavy reading to workers:

- Use mcp__workers__explore for focused source or history gathering.
- Use mcp__workers__review for compact review of a specific plan, PR summary, or suspicious change.
- Use mcp__workers__test when a missing executable check is the blocker.

Do not read a full diff, full CI log, or full transcript in the lead context. Ask workers for narrow facts and compact excerpts. The ledger is durable memory; context is not.

## Human requests

For each needsHuman item:

1. If packetHtmlPath is present, open that HTML file in the ai-or-die artifact panel for the user.
2. Tell the user the reason, repo, issue/PR handles, and the available decision choices.
3. Wait for the user's decision.
4. Submit the choice back with mcp__first-mate__advance({ human_decisions: [...] }).

If an artifact-panel tool is unavailable, give the user the local packetHtmlPath and the compact summary from needsHuman.
Never decide a merge approval or abandonment choice on the user's behalf.

## Self-driving heartbeat (arm / disarm)

The loop keeps itself alive with ONE durable cron job — a dead-man's-switch that survives idle, compaction, restart, and /clear because it lives on disk, not in your context. The controller hands you nextWakeSeconds so you never do arithmetic: it is a ready-to-use delay in seconds, or null when the whole portfolio is idle. Every heartbeat carries the exact marker token [fm-heartbeat] in its prompt so you can identify it unambiguously (never a fuzzy match against unrelated crons). Manage exactly one heartbeat:

Arm — "create fresh, then reap the rest" (nextWakeSeconds is a number, i.e. there is active work):

1. Pick the cadence bucket from nextWakeSeconds (fixed cron expressions, no time math), so the heartbeat tracks the controller's own cadence:
   - nextWakeSeconds <= 120  → "1-59/2 * * * *"    (about every 2 min)
   - nextWakeSeconds <= 600  → "2,7,12,17,22,27,32,37,42,47,52,57 * * * *"  (about every 5 min)
   - otherwise               → "3,13,23,33,43,53 * * * *"  (about every 10 min)
2. CronCreate the new heartbeat and capture its id: durable: true, recurring: true, the chosen cron, prompt "/gh-first-mate [fm-heartbeat] wake the controller loop, answer ready requests, reschedule." Creating first (before deleting) guarantees at least one heartbeat always exists.
3. CronList, then CronDelete every job whose prompt contains [fm-heartbeat] EXCEPT the id you just created. This converges to exactly one, reaps duplicates and old-version orphans, and — because you recreate each wake — resets the 7-day recurring-cron expiry so a long mission never silently stops.

Disarm (nextWakeSeconds is null AND there are no pending needsHuman): nothing is active. CronList and CronDelete every [fm-heartbeat] job. Report that first-mate is idle and resumes when the user next starts or advances a mission (safe because, per the Start-a-mission invariant, only a turn can reactivate work, and that turn re-arms).

Responsiveness (optional): the buckets above already tighten cadence to ~2 min for imminent work. If this session is a /loop you MAY additionally ScheduleWakeup(delaySeconds: nextWakeSeconds, ...) for an exact one-shot; keep at most one outstanding.

Guardrails: never leave more than one [fm-heartbeat] job; never busy-loop advance; if no scheduler tool is available, tell the user the next wake is in nextWakeSeconds seconds and stop.

## Board reports

Use mcp__first-mate__board or mcp__first-mate__mission_status for read-only status checks.
Report compactly:

- mission id and title
- repositories
- phase counts
- blocked count and why, when available
- next wake time or the next requested action

Never reconstruct status by rereading raw logs when the controller board already has the handles.

## Context discipline

- The ledger is the durable memory; do not paste large artifacts into the chat.
- Never read a full diff/log/transcript unless the user explicitly asks and it is essential.
- Prefer handles: mission id, repo, issue, PR, request id, packet path.
- Keep every answer to first-mate compact and action-oriented.
- If controller state and chat memory disagree, trust the controller state and ask for clarification only when it affects acceptance criteria or human approval.

## Return format

When reporting progress, return:

- Mission: id and one-line goal.
- Board: compact phase counts and blocked count.
- Applied: count or short list of important controller actions.
- Needs model: request ids and kinds answered or pending.
- Needs human: decision ids/packet paths and the user's required choice.
- Next wake: the heartbeat state — armed and next check in nextWakeSeconds seconds, or idle (disarmed).
`,
} as const
