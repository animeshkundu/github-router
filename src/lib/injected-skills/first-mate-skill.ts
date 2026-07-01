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

## Controller loop

Repeat this bounded loop until there is no immediate work, the user asks to stop, or a human decision is required:

1. Call mcp__first-mate__advance.
2. Read the compact response: board, needsModel, needsHuman, applied_count, and nextWakeAt.
3. For each needsModel item, produce exactly the typed judgment requested by its kind and resubmit through the next advance call as model_answers.
4. For each needsHuman item, open or surface the packet for the user, then resubmit the user's choice through a later advance call as human_decisions.
5. Report from the board and request lists, not from full logs or diffs.

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

## Waiting and wakeups

If needsModel and needsHuman are empty but nextWakeAt is set, schedule a wake for that time with ScheduleWakeup if available.
If no scheduler is available, tell the user when to wake first-mate again.
Do not busy-loop advance calls.

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
- Next wake: timestamp or none.
`,
} as const
