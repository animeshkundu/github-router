# gh-research

## 1. Identity

- **Name**: `gh-research`
- **Gate**: `workerToolsEnabled()` (`src/claude.ts:670-673`). Written to the mirror when the
  worker/orchestrate backend is available; the skill calls `mcp__search__code`,
  `mcp__search__web`, and dispatches `worker-explore` / `worker-review` subagents.
- **Source**: `src/lib/injected-skills/research-skill.ts:1-109` (the whole `RESEARCH_SKILL`
  constant; the `md` string is lines 3-108).
- **Registration**: first entry in `INJECTED_SKILLS` (`src/lib/injected-skills/index.ts:30`),
  deliberately first because "research underpins the others" (index.ts:28 comment).
- **Write mechanism**: `writeInjectedSkill(name, md)` →
  `<CLAUDE_CONFIG_DIR>/skills/gh-research/SKILL.md`, atomic temp+rename, mirror-only guard
  (`write.ts:51-101`).
- **Body size / structure**: ~4.0 KB. Headings: `# gh-research: bounded saturation engine`,
  then `## Operating contract`, `## Evidence tags`, `## Bounded loop`, `## Procedure`
  (7 numbered steps), `## Return format`, `## Non-goals`.

## 2. Description (verbatim)

> Bounded saturation research for non-trivial GitHub Router asks: enumerate unknowns, gather
> in parallel through code search, web search, and explore workers, adversarially verify
> load-bearing claims, persist a freshness-stamped brief, and return a compact
> confidence-tagged root-cause summary when you need grounded context before planning or
> changing code.

356 characters.

## 3. Anthropic rubric assessment

| Criterion | Verdict | Note |
|---|---|---|
| Char budget (≤1024) | Pass | 356 chars. |
| Third person | Pass | "enumerate / gather / verify / persist / return" are imperative-infinitive verbs describing the skill's actions, not "I/you". No first- or second-person pronouns. |
| States WHAT | Pass | The pipeline is spelled out: enumerate unknowns → parallel gather → adversarial verify → persist brief → compact summary. |
| States WHEN | Pass | "when you need grounded context before planning or changing code" is a concrete trigger. |
| Specific, not vague | Pass | Names the tools (code search, web search, explore workers) and the artifact (freshness-stamped brief, confidence-tagged summary). Not "Helps with research." |
| "use when / proactively" | Pass | Carries a "when you need..." clause. Auto-invocation is intended (this is the grounding step for the other skills). |
| Previews the body | Pass | Every phrase maps to a body section: unknowns → Procedure step 2; parallel gather → step 3; adversarial verify → step 5; persist brief → step 7; return summary → Return format. |
| No overtrigger (MUST/ALWAYS/CRITICAL) | Pass | None present. "non-trivial" and "when you need" appropriately scope it down. |

## 4. Right thing / right time / right amount

- **Right thing**: yes. Grounding investigation before planning or editing is exactly what a
  research skill should do, and the body's evidence-tag discipline (only `verified-executable`
  is deterministic; `verified-source` / `cross-lab-agreed` / `unverified` are honestly weaker)
  raises the floor rather than gilding.
- **Right time**: yes. The "before planning or changing code" trigger fires the skill at the
  front of the workflow, and `gh-orchestrate` Phase 1 explicitly invokes it, so it is the
  designed entry point.
- **Right amount**: yes. "Bounded saturation" plus the explicit caps in the body (about 3
  rounds, right-sized parallel workers, "Never silently claim completeness after hitting a
  cap") guard against the over-trigger failure mode of a research skill — burning unbounded
  context. The word "non-trivial" in the description keeps it off trivial asks.
- **Overtrigger / undertrigger risk from the description**: low. The "non-trivial" qualifier
  and the specific WHEN clause keep it from firing on one-line lookups.

## 5. Findings

- **Suggestion**: the opener "Bounded saturation research for non-trivial GitHub Router asks:"
  reads as a noun-phrase label rather than a third-person sentence. A form like "Runs bounded
  saturation research on non-trivial GitHub Router asks..." would read as a cleaner
  third-person predicate and match a shared voice standard. Non-blocking; the current form is
  clear and already rubric-passing.

**Verdict**: Clean, rubric-passing, well-scoped — the model description in the registry.
