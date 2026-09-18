export const GATHER_CONTEXT_SKILL = {
  name: "gh-gather-context",
  md: `---
name: gh-gather-context
description: Bounded context gathering for non-trivial asks: decomposes the ask, runs lexical code searches to identify relevant files, dispatches bounded parallel Explore subagents to gather evidence, stitches results into a freshness-stamped context brief plus a compact version. Use when grounded context is needed before planning or changing code.
user-invocable: true
---

# gh-gather-context: bounded context gathering

Use this skill when a non-trivial ask needs grounded context before planning.
All reasoning runs at the 200K default window: the lead and every Explore
subagent use the Luna model at high effort with bare slugs (no 1M accounting).
Output is a durable full brief plus a compact downstream version. This skill
dispatches ONLY native subagents present on the profile roster (Explore) via
the Agent tool, never worker-* MCP dispatchers. No reviewer dispatch in this
stage: Explore evidence plus targeted follow-up reads is the verification path.

## Hard bounds

- Maximum rounds: 3.
- Maximum parallel Explore subagents per round: 6.
- Maximum lexical searches per round: 10.
- Maximum follow-up reads per round: 5.
- Advisory budget: keep each Explore dispatch under ~3 minutes of wall-clock;
  the Task tool has no maxWallClockMs parameter, so count your own dispatches
  and stop at saturation rather than running to a clock.
- Terminate at the first of saturation or a cap.
- On cap-hit, return with open unknowns flagged as residual. Do not loop forever.

## Evidence tags

Use these exact tags on every finding and claim:

- verified-executable: reproduced the symptom, ran the failing test, or ran a check that directly proves the claim. This is the only deterministic confidence tag.
- verified-source: read the actual source, config, logs, docs, or primary artifact and cited the relevant locations. This is model-mediated and can still be wrong.
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

4. Decompose into bounded Explore subagents.
   - Cluster search results into at most 6 coherent investigation areas.
   - For each area, write a narrow brief: the specific question, the expected artifact, and the files to focus on.
   - Dispatch ALL Explore subagents in a single turn via the Agent tool (subagent_type Explore). Each runs read-only at the 200K default window and returns a summary with an evidence table and file:line citations. Advisory: keep each dispatch under ~3 minutes; the Task tool enforces no wall-clock, so terminate at saturation.
   - Keep Explore results summarized; do not paste every detail into the main context.

5. Stitch and verify.
   - Collect all Explore results and deduplicate file references.
   - Run at most 5 targeted follow-up reads for gaps, in parallel, using Read, Grep, and Glob directly; dispatch one more narrow Explore round only for gaps direct reads cannot close.
   - Do NOT dispatch a reviewer in this stage. Verification here is Explore evidence plus your own follow-up reads: re-open the primary source for every load-bearing claim and confirm the citation is real before tagging it verified-source.
   - Form a root-cause hypothesis or integration map, and state what would falsify it.

6. Run a completeness pass.
   - Ask: what do we still not know?
   - Ask: what claim, if false, would break the conclusion?
   - Ask: have we checked primary sources for every load-bearing claim?
   - If no material unknowns remain and the root cause is at least verified-source, stop for saturation.

7. Persist outputs under .github-router/context/<slug>/ and close the stage.
   - context.md: full brief with the ask decomposition, searches run, Explore reports, evidence table, hypothesis, freshness metadata (HEAD commit, working-tree diff hash, timestamp, repo path), residuals, and full citations.
   - context.compact.md: downstream consumable with a one-paragraph ask summary, key files with one-line purposes, critical constraints (APIs, types, patterns, forbidden changes), integration seams, and residual risks.
   - .complete: stage-completion marker written ONLY after every dispatched Explore subagent has returned or been recorded as superseded, and both briefs are on disk. No downstream stage (/gh-plan, /gh-implement, /gh-swe-pipeline stage 2+) may start until this marker exists.
   - Downstream phases read by pointer and check freshness instead of re-injecting the whole brief.

## Waterfall rule

This stage owns all Explore dispatches until it completes. Do NOT return while
any Explore subagent is still running unless you explicitly record it as
superseded (saturation reached or its area covered) with the reason. Native
subagents cannot be killed mid-run: record superseded areas and let them
finish, but do not wait on or use their output. If the brief already saturates
the ask, record remaining dispatches as superseded first (no further
follow-ups), then write the marker. A plan built on shifting evidence wastes
more than an idle subagent costs.

## Return format

Return a compact brief, not the whole dump:

- Context files: paths to context.md and context.compact.md.
- Freshness: HEAD commit, diff hash, timestamp.
- Termination: saturated or cap-hit; if cap-hit, name the cap.
- Summary: 3-8 bullets with confidence tags.
- Evidence table: claim, tag, primary source or command, verification status.
- Residual unknowns: explicit list, or none.
- Downstream guidance: recommended next action and what must be rechecked if the tree changes.

## Non-goals

- Do not present verified-source as deterministic.
- Do not hide open unknowns because the answer looks useful.
- Do not keep searching after the cap.
- Do not paste the entire persisted brief into later turns unless the user asks.
- Do not dispatch a reviewer from this stage; Explore evidence plus targeted follow-up reads is the verification path.
- Do not finish without the .complete marker: a marker-less brief is not a completed stage.
`,
} as const
