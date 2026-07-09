# gh-worker

## 1. Identity

- **Name**: `gh-worker`
- **Gate**: `workerToolsEnabled()` (`src/claude.ts:670-673`). The skill documents the
  non-blocking worker surface; the load-bearing enforcement is the PreToolUse guard
  (`src/claude.ts:724-739`) plus the `worker-*` dispatcher subagents.
- **Source**: `src/lib/injected-skills/worker-skill.ts:8-58` (the `md` string is lines
  10-57; the description is lines 11-13). A leading module doc-comment
  (`worker-skill.ts:1-7`) explains the discoverability/playbook role.
- **Registration**: fourth entry in `INJECTED_SKILLS` (`src/lib/injected-skills/index.ts:33`).
- **Write mechanism**: `writeInjectedSkill` →
  `<CLAUDE_CONFIG_DIR>/skills/gh-worker/SKILL.md`.
- **Body size / structure**: ~2.4 KB (the smallest floor-raising skill body). Headings:
  `# gh-worker: non-blocking workers`, `## How to run a worker`, `## What to expect`,
  `## Notes`.

## 2. Description (verbatim)

> How to run github-router workers without blocking your turn. Workers
> (explore/implement/review/plan/test) can run up to 6 hours; dispatch the matching worker-*
> background subagent so you get a completion notification instead of waiting. Use whenever
> you would reach for a worker.

279 characters.

## 3. Anthropic rubric assessment

| Criterion | Verdict | Note |
|---|---|---|
| Char budget (≤1024) | Pass | 279 chars. |
| Third person | **Fail** | Second person throughout: "without blocking **your** turn", "so **you** get", "whenever **you** would reach for a worker". The rubric calls for third person ("Processes X"). |
| States WHAT | Pass | Explains the non-blocking dispatch model and names the five modes (explore/implement/review/plan/test). |
| States WHEN | Pass | "Use whenever you would reach for a worker" — a clear (if self-referential) trigger. |
| Specific, not vague | Pass | Names the modes, the 6-hour ceiling, and the completion-notification mechanism. Not "Helps with workers." |
| "use when / proactively" | Pass | "Use whenever you would reach for a worker" is an explicit proactive trigger. |
| Previews the body | Pass | Maps to `## How to run a worker` (the mode list) and `## What to expect` (completion notification, concurrency cap). |
| No overtrigger | Pass | No MUST/ALWAYS/CRITICAL. |

## 4. Right thing / right time / right amount

- **Right thing**: yes. The skill's job is discoverability of the non-blocking worker
  pattern — teaching the model to dispatch a background `worker-*` subagent instead of
  calling the raw `mcp__workers__*` tool and blocking its turn. That is a real,
  floor-raising operating-model correction.
- **Right time**: yes. "whenever you would reach for a worker" fires at exactly the decision
  point where the model would otherwise block. The PreToolUse guard is the hard backstop, so
  the skill's role is to make the model do the right thing before hitting the guard.
- **Right amount**: yes. Short body, no ceremony; the "Notes" section flags the real
  gotchas (no dedup on double-dispatch, headless behaves differently). Appropriately light.
- **Overtrigger / undertrigger risk from the description**: low from the wording. The larger
  risk is the render anomaly below, which would cause silent UNDERtrigger (the routing line
  never reaches the router).

## 5. Findings

- **Important (voice)**: the description is second person, the only such skill in the
  registry. Fix: rewrite third person, e.g. "Runs github-router workers without blocking the
  turn: dispatch the matching worker-* background subagent (explore/implement/review/plan/test,
  up to 6 hours each) for a completion notification instead of a blocking wait. Use when a
  worker is the right tool." Preserves every fact and the WHEN clause while matching the rubric.
- **Important (live render anomaly — could not reproduce in this session)**: the team lead
  reported that this skill's description is correct on disk (verified: `worker-skill.ts:11-13`,
  279 chars) but was NOT rendered into their session's skill list at all — a Claude Code
  metadata-render/cache break that would null the routing signal and silently disable
  auto-invocation. In THIS researcher session, `gh-worker` DOES appear in the injected skill
  list with its full description, so the anomaly could not be reproduced here; it is
  session-specific, transient, or already resolved. The on-disk file is healthy and the
  tests (`tests/injected-skills.test.ts`, `tests/injected-skills-drift.test.ts`) pass, so no
  test would catch a render-side null. If it recurs: capture the rendered skill list from a
  fresh launch and file an upstream Claude Code note; the failure lives in the harness's
  skill-metadata render/cache, not in this file.

**Verdict**: Content is correct and well-scoped, but the second-person voice is a confirmed
on-disk rubric miss, and the reported render anomaly (unreproduced here) would be the more
serious defect if real. Fix the voice; track the anomaly with a clean repro.
