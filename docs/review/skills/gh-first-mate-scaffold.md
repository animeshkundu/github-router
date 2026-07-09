# gh-first-mate-scaffold

## 1. Identity

- **Name**: `gh-first-mate-scaffold`
- **Gate**: `workerToolsEnabled()` AND `agentToolsEnabled()` — same dual gate as
  `gh-first-mate` (`isFirstMateSkillName` at `src/claude.ts:97-99` matches this name;
  filter at `src/claude.ts:671-673`). Only materialized when the `mcp__first-mate__*`
  surface is real.
- **Source**: `src/lib/injected-skills/first-mate-setup-skill.ts:1-46` (the `md` is a
  template-string concatenation; the description is line 5).
- **Registration**: sixth (last) entry in `INJECTED_SKILLS`
  (`src/lib/injected-skills/index.ts:35`).
- **Write mechanism**: `writeInjectedSkill` →
  `<CLAUDE_CONFIG_DIR>/skills/gh-first-mate-scaffold/SKILL.md`.
- **Body size / structure**: ~2.7 KB. Headings: `# gh-first-mate-scaffold`,
  `## What it seeds`, `## Usage`, then a `Modes:` list. The body is a detailed catalog of
  what `mcp__first-mate__scaffold_repo` seeds (guidance files, role agents, ADRs, changelog,
  PR template, CI) and the three modes (`add-missing-only`, `enhance`, `overwrite-approved`).

## 2. Description (verbatim)

> Seed a world-class repo-geared agentic-dev foundation through first-mate.

73 characters.

## 3. Anthropic rubric assessment

| Criterion | Verdict | Note |
|---|---|---|
| Char budget (≤1024) | Pass | 73 chars — but it uses only 7% of the budget; there is ample room for a WHEN clause and concrete trigger terms. |
| Third person | **Fail** | Imperative mood ("**Seed** a..."), not third person. The rubric wants "Seeds a..." / "Scaffolds a...". |
| States WHAT | Partial | "Seed a repo-geared agentic-dev foundation" is broadly what it does, but it does not name a single concrete artifact (guidance files, role agents, ADRs, CI) — all of which are in the body. "world-class" is marketing, not information. |
| States WHEN | **Fail** | No trigger at all. The body's real trigger ("before the first build wave on an owned repository") is absent from the routing line. |
| Specific, not vague | **Fail** | Closest skill in the registry to the "Helps with X" anti-pattern. "world-class ... agentic-dev foundation" is vague; the router cannot tell from it that this seeds `AGENTS.md`/`CLAUDE.md`, role agents, ADRs, PR templates, and CI. |
| "use when / proactively" | **Fail** | No "use when" clause. |
| Previews the body | **Fail** | The body is a precise catalog of seeded files and three modes; the description previews none of it. |
| No overtrigger | Pass | No MUST/ALWAYS/CRITICAL — but "world-class" is a promotional adjective the rubric discourages. |

## 4. Right thing / right time / right amount

- **Right thing**: yes at the body level — a foundation-scaffolding skill that seeds the
  guidance/agents/ADR/CI substrate a repo needs before cloud agents work it is exactly right,
  and it correctly refuses to seed factory-protocol files (first-mate stays the external
  orchestrator).
- **Right time**: undermined by the description. The correct moment is "before the first
  build wave on an owned repository," and the routing line does not say so. A model deciding
  whether to scaffold has to guess from the name plus a vague foundation phrase.
- **Right amount**: the body is appropriately detailed (it must be — the seeded-file catalog
  is the value). The description is under-built: 73 of 1024 chars, no trigger, no artifacts.
- **Overtrigger / undertrigger risk from the description**: undertrigger. Without a concrete
  trigger or artifact list, a scaffolding request may not route here; and "world-class
  agentic-dev foundation" is generic enough that it could weakly match unrelated setup asks
  (mild overtrigger in the other direction).

## 5. Findings

- **Important (vague + imperative + no WHEN — the registry's weakest routing line)**: rewrite
  third person, name the artifacts, and add the trigger. e.g.
  "Scaffolds a repo-geared agentic-dev foundation through first-mate: seeds AGENTS.md /
  CLAUDE.md guidance, role agents, ADRs, changelog, PR template, and CI via
  `scaffold_repo`. Use before the first build wave on an owned repository." This lifts every
  failed criterion (third person, WHAT with concrete artifacts, WHEN, specific,
  previews-body) and still sits well under budget.

**Verdict**: The weakest description in the registry — vague, imperative, no WHEN clause, and
previews none of a body that is itself precise. The routing line should be rewritten to name
the seeded artifacts and the "before the first build wave" trigger.
