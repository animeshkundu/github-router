# gh-floor-keeper

## 1. Identity

- **Name**: `gh-floor-keeper`
- **Gate**: `workerToolsEnabled()` (`src/claude.ts:670-673`). Runs the executable gate,
  fans out to `mcp__peers__codex_reviewer` / `mcp__peers__gemini_reviewer`, dispatches
  `worker-test`, consults the advisor, and invokes `/gh-research`.
- **Source**: `src/lib/injected-skills/floor-keeper-skill.ts:1-148` (the `md` string is
  lines 3-147).
- **Registration**: third entry in `INJECTED_SKILLS` (`src/lib/injected-skills/index.ts:32`).
- **Write mechanism**: `writeInjectedSkill` →
  `<CLAUDE_CONFIG_DIR>/skills/gh-floor-keeper/SKILL.md`.
- **Body size / structure**: ~5.4 KB. Headings: `# gh-floor-keeper: done-checkpoint
  verification`, `## Operating contract`, `## Honest limits`, then `## Step 1` through
  `## Step 8` (gather context → run gate → identify missing coverage → fan out cross-lab
  review → consult advisor → verify claims → reconcile by severity → return go/no-go),
  and `## Non-goals`.

## 2. Description (verbatim)

> Done-checkpoint verification for non-trivial changes: run the executable gate, send the
> diff to OpenAI and Google reviewers, consult the advisor, reconcile findings by severity,
> author missing tests through a different lab when bounded and appropriate, and return an
> honest go/no-go before declaring work complete.

314 characters.

## 3. Anthropic rubric assessment

| Criterion | Verdict | Note |
|---|---|---|
| Char budget (≤1024) | Pass | 314 chars. |
| Third person | Pass | Imperative-infinitive verbs (run / send / consult / reconcile / author / return), no "I/you". |
| States WHAT | Pass | The full checkpoint: gate → cross-lab review → advisor → severity reconciliation → missing-test authorship → go/no-go. |
| States WHEN | Pass | "before declaring work complete" is the single clearest WHEN clause in the whole registry — it names the exact moment. |
| Specific, not vague | Pass | Names the reviewers by lab (OpenAI, Google), the advisor, and the deliverable (honest go/no-go). |
| "use when / proactively" | Pass | "before declaring work complete" is a proactive trigger; the body opens "Invoke this before declaring a non-trivial change done." |
| Previews the body | Pass | Each phrase maps to a Step: gate → Step 2; missing tests → Step 3; cross-lab review → Step 4; advisor → Step 5; reconcile → Step 7; go/no-go → Step 8. |
| No overtrigger | Pass | No MUST/ALWAYS/CRITICAL. "non-trivial changes" and "when bounded and appropriate" scope it down. |

## 4. Right thing / right time / right amount

- **Right thing**: yes. A done-checkpoint that runs the executable gate first (binding),
  then treats cross-lab review and advisor as advisory, then reconciles by severity is
  exactly the floor-keeping discipline. The "Honest limits" section is explicit that a green
  gate does not rule out wrong-spec, and that different-lab test authorship is "an advisory
  practice, not enforceable provenance" — no false guarantees.
- **Right time**: yes. "before declaring work complete" fires it at the terminal checkpoint,
  which is where a floor check belongs. It composes naturally after `gh-orchestrate` or a
  direct implementation.
- **Right amount**: yes. Bounds are built in — "Keep attempts bounded and ask before
  expanding into a large new test harness," "Cap missing-test attempts," "Do not spend
  unbounded attempts creating tests." The severity decision rules (Step 7) prevent the
  advisory reviewers from overriding a covered red gate, and prevent nit findings from
  blocking. This is the right amount of skepticism, not a ritual.
- **Overtrigger / undertrigger risk from the description**: low. "non-trivial changes" keeps
  it off typo fixes; the sharp WHEN clause keeps it firing at the right moment. If anything
  the risk is a model skipping it on a change it under-estimates as trivial, but that is a
  judgment call the description cannot fully close.

## 5. Findings

- **Suggestion**: same label-style opener as its siblings ("Done-checkpoint verification
  for..."). A third-person predicate would align a shared voice standard. Non-blocking.

**Verdict**: Clean, rubric-passing, and carries the sharpest WHEN clause in the registry —
the reference for how the others should signal their trigger.
