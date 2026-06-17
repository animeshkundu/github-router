export const RESEARCH_SKILL = {
  name: "gh-research",
  md: `---
name: gh-research
description: Bounded saturation research for non-trivial GitHub Router asks: enumerate unknowns, gather in parallel through code search, web search, and explore workers, adversarially verify load-bearing claims, persist a freshness-stamped brief, and return a compact confidence-tagged root-cause summary when you need grounded context before planning or changing code.
user-invocable: true
---

# gh-research: bounded saturation engine

Use this skill when an ask needs grounded investigation before planning or editing.
Your output is a compact confidence-tagged root-cause brief plus a pointer to the durable full brief.
Do not try to be exhaustive forever; saturation is bounded by explicit caps.

## Operating contract

- Objective: find the most likely root cause, integration constraints, or decision facts for this ask.
- Prefer primary sources over summaries.
- Prefer executable proof over all other evidence.
- Be honest about uncertainty: only verified-executable is deterministic.
- Delegate heavy gather to workers so the top-level context stays compact.
- Never silently claim completeness after hitting a cap.

## Evidence tags

Use these exact tags on every finding and claim:

- verified-executable: reproduced the symptom, ran the failing test, or ran a check that directly proves the claim. This is the only deterministic confidence tag.
- verified-source: read the actual source, config, logs, docs, or primary artifact and cited the relevant locations. This is model-mediated and can still be wrong.
- cross-lab-agreed: a different-lab reviewer or critic independently agreed with the claim. This reduces correlated blind spots but is advisory.
- unverified: plausible but not confirmed; treat as residual risk.

## Bounded loop

Default caps unless the user explicitly gives a smaller or larger budget:

- Maximum rounds: about 3.
- Maximum parallel explore workers per round: finite and right-sized to the ask.
- Maximum search and peer-review calls: finite; do not spend unbounded context.
- Terminate at the first of saturation or a cap.
- On cap-hit, return with open unknowns flagged as residual. Do not loop forever.

## Procedure

1. Restate the ask and define the research target.
   - Identify whether this is a bug, feature, refactor, incident, or design question.
   - Name the expected downstream consumer: implementer, orchestrator, floor-keeper, or user.

2. Enumerate unknowns as an explicit worklist.
   - Include facts needed to decide the root cause or safe implementation path.
   - Mark each unknown as code, behavior, dependency, history, external, or acceptance-criteria related.
   - Add newly discovered unknowns as they appear.

3. Fan out in parallel.
   - Run independent code, web, history, and explore calls concurrently where possible; only the semantic-to-lexical code-search refinement is ordered. Issue the independent calls in a SINGLE turn (one message, multiple tool calls) so the harness actually runs them in parallel rather than serializing.
   - Use mcp__search__code semantically first to find concepts and likely files.
   - Then use mcp__search__code lexically for exact symbols, filenames, errors, routes, flags, and config keys.
   - Use git blame or history when authorship, regression timing, or intent matters.
   - Use mcp__search__web for upstream APIs, package behavior, protocol docs, or public issues.
   - Launch parallel mcp__workers__explore workers for heavy gathering, each with a narrow question and expected artifact.
   - Keep worker results summarized; do not paste every detail into the main context.

4. Form a root-cause hypothesis.
   - For bugs: describe the causal chain from trigger to observed symptom.
   - For features: identify integration points, constraints, and likely implementation seams.
   - For design questions: identify the decision, alternatives, and primary constraints.
   - State what would falsify the hypothesis.

5. Verify load-bearing claims adversarially.
   - First preference: reproduce the bug, run the failing test, or run the direct check. Tag verified-executable.
   - If executable proof is not available, read the actual source or primary artifact and cite the lines. Tag verified-source.
   - Ask mcp__workers__review to confirm the source-reading for important claims.
   - Ask a different-lab refuter through mcp__peers__codex_critic or mcp__peers__gemini_critic to try to refute the hypothesis.
   - Give the refuter the symptom, observed facts, and acceptance criteria, but not your proposed root cause. Avoid anchoring them.
   - If the refuter finds a plausible alternative, add it to the worklist and spend at most one bounded round resolving it.

6. Run a completeness pass.
   - Ask: what do we still not know?
   - Ask: what claim, if false, would break the conclusion?
   - Ask: have we checked primary sources for every load-bearing claim?
   - Ask: did a further bounded round surface anything material?
   - If no material unknowns remain and the root cause is at least verified-source, stop for saturation.

7. Persist the full brief.
   - Write a durable markdown file such as .docs/research/<slug>.md.
   - Include freshness metadata: HEAD commit, working-tree diff hash, timestamp, repo path, and command/search date.
   - Include the unknown worklist, searches run, workers consulted, evidence table, refuter result, residuals, and full citations.
   - Downstream phases should read by pointer and check freshness instead of re-injecting the whole brief.

## Return format

Return a compact brief, not the whole research dump:

- Research file: path to the durable brief.
- Freshness: HEAD commit, diff hash, timestamp.
- Termination: saturated or cap-hit; if cap-hit, name the cap.
- Root-cause hypothesis: 3-8 bullets with confidence tags.
- Evidence table: claim, tag, primary source or command, reviewer/refuter status.
- Residual unknowns: explicit list, or none.
- Downstream guidance: recommended next action and what must be rechecked if the tree changes.

## Non-goals

- Do not present verified-source or cross-lab-agreed as deterministic.
- Do not hide open unknowns because the answer looks useful.
- Do not keep searching after the cap.
- Do not paste the entire persisted brief into later turns unless the user asks.
`,
} as const
