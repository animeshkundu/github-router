export const FLOOR_KEEPER_SKILL = {
  name: "gh-floor-keeper",
  md: `---
name: gh-floor-keeper
description: Done-checkpoint verification for non-trivial changes: run the executable gate, send the diff to OpenAI and Google reviewers, consult the advisor, reconcile findings by severity, author missing tests through a different lab when bounded and appropriate, and return an honest go/no-go before declaring work complete.
user-invocable: true
---

# gh-floor-keeper: done-checkpoint verification

Invoke this before declaring a non-trivial change done.
It is the final floor check: executable gate first, cross-lab review second, advisor third, severity reconciliation last.
It does not prove the change is correct; it reports what was checked and what remains residual.

## Operating contract

- Input: the user ask, user-blessed acceptance criteria, current diff, and any research or plan pointers.
- Output: go/no-go with binding executable results, advisory review findings, and residual risks.
- Scope: changed behavior and changed files, not a full repo audit unless requested.
- Reuse /gh-research for claim verification instead of re-deriving complex facts.
- Keep attempts bounded and ask before expanding into a large new test harness.

## Honest limits

- The executable gate is binding only for what it covers.
- A green gate does not rule out wrong-spec or missing coverage.
- Cross-lab review reduces correlated blind spots but is advisory.
- Advisor output is judgment-only unless converted into tests, source changes, or a gate.
- Different-lab test authorship is an advisory practice, not enforceable provenance.

## Step 1: gather the done context

Collect:

- Original ask and acceptance criteria.
- Current working-tree diff.
- Commands already run and their outputs.
- Research brief pointer, if one exists.
- Plan or orchestration summary, if one exists.
- Known residual risks from earlier phases.

If acceptance criteria are absent, stop and ask for them or state that wrong-spec risk remains high.

## Step 2: run the executable gate

Run the repo-appropriate executable checks for the changed slice:

- typecheck, tests, lint, build, or focused command named by the repo/user.
- Prefer the existing gate command when available.
- Capture exact command, exit code, duration, and relevant output.
- If the command times out or cannot run, report unknown, not pass.

Binding rule:

- Red gate for covered behavior means no-go until fixed or explicitly waived by the user.
- Green gate means only that the checks that ran passed.
- Missing checks or unavailable commands remain residual risk.

## Step 3: identify missing test coverage

Ask whether changed behavior has executable coverage.

- If behavior changed and no relevant test exists, use mcp__workers__test to author a focused test through a DIFFERENT lab than the implementer when possible.
- Cap missing-test attempts; default to a small number of focused tries.
- Run the new test and then the relevant existing gate.
- If creating a large new harness, broad fixture system, or slow integration environment is required, ask the user before proceeding.
- If a model-authored test is the only oracle, label it honestly as helpful but not a complete correctness guarantee.

## Step 4: fan out cross-lab review

Send the same diff, acceptance criteria, and gate results in parallel to:

- mcp__peers__codex_reviewer (OpenAI)
- mcp__peers__gemini_reviewer (Google)

Ask both reviewers for:

- correctness bugs
- acceptance-criteria misses
- regressions
- security or data-loss risks
- test gaps
- maintainability issues that matter for this change
- severity for each finding: blocker, high, medium, low, nit

Do not treat reviewer agreement as proof. Treat it as advisory signal to investigate or fix.

## Step 5: consult advisor

Consult the advisor with a focused concern:

- whether the diff satisfies the acceptance criteria
- whether the gate covers the risky behavior
- whether reviewer findings indicate no-go
- what residual risk should be surfaced to the user

Advisor output is advisory unless you convert it into a source-verified claim, executable test, or code change.

## Step 6: verify disputed or load-bearing claims

For any important claim from a reviewer, advisor, or your own reading:

- If it needs research, invoke /gh-research and use its persisted brief pointer.
- Prefer reproducing the issue or running a focused test: verified-executable.
- Otherwise read the actual source and cite it: verified-source.
- If neither is possible within budget, mark unverified and include it in residual risk.

Do not re-derive complex repo facts from memory when /gh-research is the right tool.

## Step 7: reconcile by severity

Build a reconciliation table:

- Finding.
- Source: gate, codex reviewer, gemini reviewer, advisor, research, or self.
- Severity: blocker, high, medium, low, nit.
- Evidence tag: verified-executable, verified-source, cross-lab-agreed, or unverified.
- Decision: fix now, accept residual, ask user, or no action.

Decision rules:

- Any covered executable failure is no-go.
- Any credible blocker or high correctness/security/data-loss issue is no-go unless disproven or explicitly waived.
- Medium issues usually require fixing when cheap; otherwise surface as residual.
- Low and nit findings do not block unless they violate acceptance criteria.
- Wrong-spec residual is always listed unless the user explicitly blessed the acceptance criteria for this exact done state.

## Step 8: return go/no-go

Return a compact final checkpoint:

- Verdict: go or no-go.
- Executable gate: commands, pass/fail/unknown, and why it is binding or not.
- Missing-test handling: tests authored, skipped, capped, or user approval needed.
- Cross-lab review summary: OpenAI findings, Google findings, agreements, disagreements.
- Advisor summary.
- Reconciliation table with severity and evidence tags.
- Residual risks, explicitly including wrong-spec if applicable.
- Required next actions before declaring done.

## Non-goals

- Do not claim the change is correct merely because tests passed.
- Do not let advisory reviewers override a covered red executable gate.
- Do not spend unbounded attempts creating tests.
- Do not bury cap-hit or unknown states in a green-sounding summary.
`,
} as const
