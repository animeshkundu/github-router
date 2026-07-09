# gh-first-mate

## 1. Identity

- **Name**: `gh-first-mate`
- **Gate**: `workerToolsEnabled()` AND `agentToolsEnabled()`. The registry filter at
  `src/claude.ts:671-673` keeps first-mate skills out unless `agentToolsEnabled()` is also
  true (`isFirstMateSkillName` at `src/claude.ts:97-99` matches `gh-first-mate` and
  `gh-first-mate-scaffold`). `agentToolsEnabled()` (`src/lib/mcp-capabilities.ts:196-202`)
  requires the `--agents` opt-in AND a non-empty write-capable GitHub agent token, so the
  skill is only materialized when the `mcp__first-mate__*` tools it drives actually exist.
- **Source**: `src/lib/injected-skills/first-mate-skill.ts:1-148` (the `md` string is lines
  3-147).
- **Registration**: fifth entry in `INJECTED_SKILLS` (`src/lib/injected-skills/index.ts:34`).
- **Write mechanism**: `writeInjectedSkill` →
  `<CLAUDE_CONFIG_DIR>/skills/gh-first-mate/SKILL.md`.
- **Body size / structure**: ~7.6 KB (the largest injected skill body). Headings:
  `# gh-first-mate: durable cloud-agent controller loop`, `## Foundation-first mandate`,
  `## Scoped-work discipline`, `## Start a mission`, `## Controller loop (push-based,
  self-driving)`, `## Model request verdicts`, `## Human requests`, `## Self-driving
  heartbeat (arm / disarm)`, `## Board reports`, `## Context discipline`, `## Return format`.

## 2. Description (verbatim)

> Thin operating protocol for the first-mate GitHub cloud-agent controller: start missions,
> wake the durable controller loop, answer model and human requests, keep context compact,
> and report from the board/ledger rather than rereading full diffs or logs.

253 characters.

## 3. Anthropic rubric assessment

| Criterion | Verdict | Note |
|---|---|---|
| Char budget (≤1024) | Pass | 253 chars. |
| Third person | Pass | "start / wake / answer / keep / report" describe the protocol's actions; no "I/you". |
| States WHAT | Pass | The thin protocol: start missions, wake the loop, answer requests, keep context compact, report from the board. |
| States WHEN | **Fail** | The description states no trigger. The WHEN ("when the user wants first-mate to drive GitHub cloud coding agents across one or more repositories") lives only in the body at `first-mate-skill.ts:11`, which does not load until the skill is already invoked. |
| Specific, not vague | Pass | Names the concrete surface (first-mate controller, board/ledger, model and human requests). Not vague. |
| "use when / proactively" | **Fail** | No "use when" clause. The skill is heartbeat-driven (a cron re-invokes it), so auto-invocation matters, yet the routing line gives the router no trigger term to match a user's cloud-agent request against. |
| Previews the body | Partial | It previews the loop mechanics (start / wake / answer / report) but omits the body's two load-bearing mandates — `## Foundation-first mandate` (scaffold before the first build wave) and `## Scoped-work discipline` (concrete testable units, human-gated merge). A reader of the description alone would not know first-mate insists on foundation-first. |
| No overtrigger | Pass | No MUST/ALWAYS/CRITICAL. |

## 4. Right thing / right time / right amount

- **Right thing**: yes. The body is a genuinely thin, durable-controller operating protocol
  — the controller is the system of record, the model runs the protocol and keeps context
  compact. The dual gate (`workerToolsEnabled()` AND `agentToolsEnabled()`) means it is only
  present when the cloud-agent surface is real, so it never advertises a dead tool.
- **Right time**: weakened by the missing WHEN clause. When a user says "have first-mate
  drive the cloud agents on repo X," the router must match that intent to this skill using
  only the description — and the description names no trigger. It relies on the skill name
  (`gh-first-mate`) and the phrase "first-mate GitHub cloud-agent controller" carrying the
  match, which works for an explicit `/gh-first-mate` invocation but is thin for
  auto-invocation from a natural-language request.
- **Right amount**: yes for the body — it is explicitly a "thin protocol," delegates heavy
  reading to workers, and enforces context discipline. The description is arguably too thin:
  it drops the two mandates that most distinguish first-mate's behavior.
- **Overtrigger / undertrigger risk from the description**: undertrigger. Without a WHEN
  clause or the foundation-first signal, a natural-language cloud-agent request may not route
  here on description alone.

## 5. Findings

- **Important (missing WHEN clause)**: add the body's trigger to the description. e.g.
  "...report from the board/ledger. Use when the user wants first-mate to drive GitHub cloud
  coding agents across one or more repositories." This closes the auto-invocation gap.
- **Suggestion (surface the mandates)**: the description omits the load-bearing
  Foundation-first mandate (scaffold before the first build wave) and Scoped-work discipline
  (concrete testable units, human-gated merge). Even a short nod — "foundation-first,
  scoped, human-gated merge" — would make the routing line preview the body's actual
  behavior. Budget allows it (253/1024 chars).

**Verdict**: Third-person and specific, but the routing line has no WHEN clause and omits the
two mandates that define first-mate's behavior — an undertrigger risk for auto-invocation.
Add a trigger clause.
