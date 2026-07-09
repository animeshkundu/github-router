# Injected skills — research and description review

Research docs for every skill `github-router claude` injects into the spawned Claude Code
session. Each skill is a `SKILL.md` materialized into the per-launch `CLAUDE_CONFIG_DIR`
mirror so the child discovers it as a user-scope skill.

Governing lens for this review: **raise the floor, never nerf** and **the right thing, at
the right time, in the right amount**. A skill's `description` frontmatter is the
pre-expansion routing line — the name and description are preloaded into every session; the
body loads only on invoke. That single line decides whether the right skill fires at the
right moment, so it is the highest-leverage text in the whole skill.

## What was verified

- Registry: `src/lib/injected-skills/index.ts:29-36` (the six `INJECTED_SKILLS`, in
  dependency order), plus `gh-artifact-review` exported separately at
  `src/lib/injected-skills/index.ts:16`.
- Writer: `src/lib/injected-skills/write.ts` (mirror-only guard, atomic temp+rename,
  warn-and-continue, `VALID_SKILL_NAME` kebab allowlist).
- Gates: `src/claude.ts:670-747` (worker-gated skills + first-mate filter),
  `src/claude.ts:753-772` (operator guard), `src/claude.ts:807-827`
  (`gh-artifact-review`, gated on `AIORDIE_SESSION_ID` only); capability predicates in
  `src/lib/mcp-capabilities.ts:99-218`.
- Tests: `tests/injected-skills.test.ts` (structural + body-substring), and
  `tests/injected-skills-drift.test.ts` (MCP-tool-name drift). Neither pins description
  quality (char budget, voice, or presence of a WHEN clause).

## Inventory

| Skill | Gate | Desc chars | Third person? | Key issues |
|---|---|---|---|---|
| `gh-research` | `workerToolsEnabled()` | 356 | Yes | Clean. Verb-noun opener ("Bounded saturation research") reads as a label, not a sentence. |
| `gh-orchestrate` | `workerToolsEnabled()` | 352 | Yes | Clean. Same label-style opener. |
| `gh-floor-keeper` | `workerToolsEnabled()` | 314 | Yes | Clean. Strongest WHEN signal of the set ("before declaring work complete"). |
| `gh-worker` | `workerToolsEnabled()` | 279 | **No** (2nd person) | Second-person voice ("without blocking your turn"); a live render anomaly was reported by the team lead (see below). |
| `gh-first-mate` | `workerToolsEnabled()` AND `agentToolsEnabled()` | 253 | Yes | **No explicit WHEN clause** in the description; omits the body's load-bearing foundation-first and scoped-work mandates. |
| `gh-first-mate-scaffold` | `workerToolsEnabled()` AND `agentToolsEnabled()` | 73 | Imperative | **Vague + imperative** ("Seed a..."); no concrete trigger term. Closest to the "Helps with X" anti-pattern. |
| `gh-artifact-review` | `AIORDIE_SESSION_ID` set (write) vs `artifactToolsEnabled()` trio (runtime) | 390 | Imperative | Imperative mood, but carries an explicit concrete "Use when..." trigger. Gate/capability mismatch (see below). |

All seven descriptions are comfortably under the 1024-char Anthropic ceiling and the
1536-char Claude Code truncation point for description+when_to_use.

## Systemic findings

### 1. Voice is inconsistent across the registry (Important)

The registry mixes three voices in the routing line:

- Third-person declarative: `gh-research`, `gh-orchestrate`, `gh-floor-keeper`,
  `gh-first-mate` (matches the Anthropic rubric).
- Second-person: `gh-worker` ("run github-router workers without blocking **your** turn").
- Imperative: `gh-first-mate-scaffold` ("**Seed** a..."), `gh-artifact-review`
  ("**Review** plans and artifacts... **Default to**...").

The Anthropic skill-description rubric calls for third person ("Processes X", not "I/you").
The second-person and imperative openers are the two that also carry the weakest WHEN
signal, so the voice drift and the trigger weakness co-occur. A shared voice standard would
fix both.

### 2. Missing or weak WHEN clauses (Important)

The description is the only routing signal before the body loads, so a missing WHEN clause
forces the router to guess from the body — which it has not loaded yet. Two skills are
under-triggered by their descriptions:

- `gh-first-mate` — the description states WHAT (thin operating protocol, start missions,
  wake the loop) but never states WHEN. The trigger ("when the user wants first-mate to
  drive GitHub cloud coding agents") lives only in the body at
  `first-mate-skill.ts:11`. It also omits the body's two load-bearing mandates,
  "Foundation-first" and "Scoped-work discipline."
- `gh-first-mate-scaffold` — a single imperative clause with no trigger at all. "Seed a
  world-class repo-geared agentic-dev foundation through first-mate" tells the router what
  the skill produces but not when to reach for it (the body's real trigger is "before the
  first build wave on an owned repository").

By contrast, `gh-research`, `gh-orchestrate`, and `gh-floor-keeper` all end their
descriptions with a "when you need..." / "before declaring..." clause — the pattern the
other two should adopt.

### 3. The `gh-worker` live render anomaly (Important — could not reproduce here)

The team lead reported that `gh-worker`'s description is correct on disk
(`worker-skill.ts:11-13`, 279 chars) but was NOT rendered into their session's skill list
at all — a Claude Code metadata-render/cache break that nulls its routing signal. In THIS
researcher session, gh-worker DOES appear in the injected skill list with its full
description. So the anomaly is either session-specific, transient, or already resolved; it
could not be reproduced from this context. If it recurs it needs a clean repro (fresh
launch, capture the rendered skill list) and an upstream note to Claude Code, because a
nulled description silently disables auto-invocation while leaving the on-disk file looking
healthy — the tests would pass throughout. The second-person voice is a separate,
confirmed on-disk issue independent of the render anomaly.

### 4. The `gh-artifact-review` gate/capability mismatch (Important)

The skill file is written whenever `AIORDIE_SESSION_ID` is set (`src/claude.ts:807`), but
the runtime `mcp__peers__artifact_*` tools it steers toward are gated by
`artifactToolsEnabled()` (`src/lib/mcp-capabilities.ts:212-217`), which requires the full
trio: `AIORDIE_BASE_URL` **and** `AIORDIE_TOKEN` **and** `AIORDIE_SESSION_ID`. So a session
with `AIORDIE_SESSION_ID` set but either of the other two missing will discover a skill
whose entire loop calls tools that fail with an isError envelope. The skill's own "Honest
limits" section does tell the model to report tool errors verbatim, which softens the blow,
but the cleaner fix is to align the write gate with `artifactToolsEnabled()` so the skill is
only materialized when its tools will actually work.

### 5. No test pins description quality (Suggestion)

`tests/injected-skills.test.ts` asserts frontmatter structure (name matches, a description
line exists) and specific body substrings; `tests/injected-skills-drift.test.ts` asserts
that every referenced MCP tool name is real. Neither test pins the character budget, the
voice (third person), or the presence of a WHEN clause. So a future edit could regress a
description to first person, drop its trigger, or blow the 1024-char budget with a green
suite. A lightweight description-quality test would lock in the routing-line contract.

## Recommendations

1. **Adopt a shared voice standard**: third-person declarative, WHAT + WHEN, a concrete
   trigger term, no MUST/ALWAYS/CRITICAL overtrigger. Apply it to `gh-worker`,
   `gh-first-mate`, and `gh-first-mate-scaffold`.
2. **Add a WHEN clause to `gh-first-mate` and `gh-first-mate-scaffold`**, and surface the
   foundation-first / scoped-work mandates (first-mate) and the "before the first build
   wave" trigger (scaffold) into the routing line.
3. **Align the `gh-artifact-review` write gate** with `artifactToolsEnabled()` (the full
   env trio) so the skill is not materialized in a session where its tools cannot run.
4. **Add a description-quality test**: assert each injected skill's description is
   ≤1024 chars, third person (no leading "I"/"you"/"your"), and contains a WHEN signal
   ("use when", "before", "when you need", or equivalent).
5. **Track the `gh-worker` render anomaly** with a clean repro and an upstream note if it
   recurs; the tests cannot catch it because the on-disk file stays valid.

Per-skill detail is in the sibling files in this directory.
