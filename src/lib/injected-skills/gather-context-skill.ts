export const GATHER_CONTEXT_SKILL = {
  name: "gh-gather-context",
  md: `---
name: gh-gather-context
description: Bounded context gathering for non-trivial asks: decomposes the ask, runs lexical code searches to identify relevant files, dispatches bounded parallel explore workers to gather evidence, stitches results into a freshness-stamped context brief plus a compact version. Use when grounded context is needed before planning or changing code.
user-invocable: true
---

# gh-gather-context: bounded context gathering

Use this skill when a non-trivial ask needs grounded context before planning.
All reasoning runs at the 200K default window: the lead and every explore
worker use the Luna model at high effort with bare slugs (no 1M accounting).
Output is a durable full brief plus a compact downstream version.

## Hard bounds

- Maximum rounds: 3.
- Maximum parallel explore workers per round: 6.
- Maximum lexical searches per round: 10.
- Maximum follow-up reads per round: 5.
- Terminate at the first of saturation or a cap.
- On cap-hit, return with open unknowns flagged as residual. Do not loop forever.

## Evidence tags

Use these exact tags on every finding and claim:

- verified-executable: reproduced the symptom, ran the failing test, or ran a check that directly proves the claim. This is the only deterministic confidence tag.
- verified-source: read the actual source, config, logs, docs, or primary artifact and cited the relevant locations. This is model-mediated and can still be wrong.
- cross-lab-agreed: a different-lab reviewer independently agreed with the claim. This reduces correlated blind spots but is advisory.
- unverified: plausible but not confirmed; treat as residual risk.

## Procedure

1. Restate the ask and define the research target.
   - Identify whether this is a bug, feature, refactor, incident, or design question.
   - Name the expected downstream consumer: planner, implementer, or user.

2. Decompose the ask into searchable entities.
   - Extract symbols, filenames, error strings, routes, flags, config keys, and types.
   - Define what must be true for a correct implementation.

3. Run lexical search first, in parallel, in a single turn.
   - Use mcp__search__code lexically for exact symbols, filenames, errors, routes, flags, and config keys.
   - Use mcp__search__code semantically only to find concepts, then refine to lexical.
   - Use git log and git blame when authorship, regression timing, or intent matters.
   - Use mcp__search__web for upstream APIs, package behavior, protocol docs, or public issues.

4. Decompose into bounded explore workers.
   - Cluster search results into at most 6 coherent investigation areas.
   - For each area, write a narrow brief: the specific question, the expected artifact, and the files to focus on.
   - Dispatch ALL explore workers in a single turn via the Agent tool (subagent_type worker-explore). Each runs read-only at the 200K default window and returns a summary with an evidence table and file:line citations. Pass maxWallClockMs 180000 on every worker call so a hung worker is reaped after 3 minutes instead of blocking its slot.
   - Keep worker results summarized; do not paste every detail into the main context.

5. Stitch and verify.
   - Collect all explore results and deduplicate file references.
   - Run at most 5 targeted follow-up reads for gaps, in parallel.
   - Dispatch the worker-review subagent (via the Agent tool, maxWallClockMs 300000) to confirm source-reading for load-bearing claims.
   - Form a root-cause hypothesis or integration map, and state what would falsify it.

6. Run a completeness pass.
   - Ask: what do we still not know?
   - Ask: what claim, if false, would break the conclusion?
   - Ask: have we checked primary sources for every load-bearing claim?
   - If no material unknowns remain and the root cause is at least verified-source, stop for saturation.

7. Persist outputs under .github-router/context/<slug>/ and close the stage.
   - context.md: full brief with the ask decomposition, searches run, worker reports, evidence table, hypothesis, freshness metadata (HEAD commit, working-tree diff hash, timestamp, repo path), residuals, and full citations.
   - context.compact.md: downstream consumable with a one-paragraph ask summary, key files with one-line purposes, critical constraints (APIs, types, patterns, forbidden changes), integration seams, and residual risks.
   - .complete: stage-completion marker written ONLY after every dispatched explore worker has returned or been recorded as stopped, and both briefs are on disk. No downstream stage (/gh-plan, /gh-implement, /gh-swe-pipeline stage 2+) may start until this marker exists.
   - Downstream phases read by pointer and check freshness instead of re-injecting the whole brief.

## Waterfall rule

This stage owns all explore workers until it completes. Do NOT return while
any explore worker is still running unless you explicitly record it as
stopped (saturation reached or its area superseded) with the reason. If the
brief already saturates the ask, stop remaining workers first (no further
follow-ups; treat partial output as superseded), then write the marker. A
plan built on shifting evidence wastes more than a stopped worker costs.

## Return format

Return a compact brief, not the whole dump:

- Context files: paths to context.md and context.compact.md.
- Freshness: HEAD commit, diff hash, timestamp.
- Termination: saturated or cap-hit; if cap-hit, name the cap.
- Summary: 3-8 bullets with confidence tags.
- Evidence table: claim, tag, primary source or command, reviewer status.
- Residual unknowns: explicit list, or none.
- Downstream guidance: recommended next action and what must be rechecked if the tree changes.

## Non-goals

- Do not present verified-source or cross-lab-agreed as deterministic.
- Do not hide open unknowns because the answer looks useful.
- Do not keep searching after the cap.
- Do not paste the entire persisted brief into later turns unless the user asks.
- Do not finish without the .complete marker: a marker-less brief is not a completed stage.
`,
} as const
