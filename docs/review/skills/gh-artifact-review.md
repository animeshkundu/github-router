# gh-artifact-review

## 1. Identity

- **Name**: `gh-artifact-review`
- **Gate (write)**: `AIORDIE_SESSION_ID` set (`src/claude.ts:807`). It is written OUTSIDE
  `INJECTED_SKILLS` (exported separately at `src/lib/injected-skills/index.ts:16`) so it only
  appears inside an ai-or-die tab, not on every worker-enabled launch.
- **Gate (runtime tools)**: `artifactToolsEnabled()` (`src/lib/mcp-capabilities.ts:212-217`),
  which requires the full trio `AIORDIE_BASE_URL` AND `AIORDIE_TOKEN` AND `AIORDIE_SESSION_ID`.
  **This is a mismatch** — see Findings.
- **Source**: `src/lib/injected-skills/artifact-review-skill.ts:1-72` (the `md` string is
  lines 3-70).
- **Registration**: not in `INJECTED_SKILLS`; written directly at `src/claude.ts:807-809`,
  alongside a CLAUDE.md directive prepend (`src/claude.ts:810-814`) and a
  PostToolUse(ExitPlanMode) auto-open hook (`src/claude.ts:819-826`).
- **Write mechanism**: `writeInjectedSkill(ARTIFACT_REVIEW_SKILL.name, ARTIFACT_REVIEW_SKILL.md)`
  → `<CLAUDE_CONFIG_DIR>/skills/gh-artifact-review/SKILL.md`.
- **Body size / structure**: ~5.3 KB. Headings: `# gh-artifact-review: human review in the
  ai-or-die panel`, `## Default: present HTML, not raw markdown`, `## When to reach for an
  artifact`, `## Playbooks (what a good artifact of each type contains)`, `## Design system`,
  `## Loop` (5 steps + push-arrival + frozen-legacy notes), `## Interactive controls
  (data-aod-* authoring)`, `## Honest limits`.

## 2. Description (verbatim)

> Review plans and artifacts in the ai-or-die panel. Default to authoring a self-contained
> HTML artifact (rich, annotatable, optionally interactive) and opening THAT for the human,
> then drain feedback with artifact_await, revise, and end the loop. Use when running inside
> an ai-or-die tab and you have a plan, comparison, diagram, table, diff, or report the user
> should see before proceeding.

390 characters (the longest description in the registry).

## 3. Anthropic rubric assessment

| Criterion | Verdict | Note |
|---|---|---|
| Char budget (≤1024) | Pass | 390 chars. |
| Third person | **Fail** (imperative) | Imperative mood ("**Review** plans...", "**Default to**...", "**Use** when..."). Not first/second person, so it reads acceptably, but the rubric prefers third-person ("Reviews plans..."). |
| States WHAT | Pass | Clear: author a self-contained HTML artifact, open it, drain feedback with `artifact_await`, revise, end the loop. |
| States WHEN | Pass | Strong, explicit, and enumerated: "Use when running inside an ai-or-die tab and you have a plan, comparison, diagram, table, diff, or report the user should see before proceeding." The best trigger enumeration in the registry. |
| Specific, not vague | Pass | Names the artifact type (self-contained HTML), the tool (`artifact_await`), and six concrete content types. |
| "use when / proactively" | Pass | Explicit "Use when..." clause; auto-invocation intended (also reinforced by the CLAUDE.md directive and the ExitPlanMode auto-open hook). |
| Previews the body | Pass | Maps to `## Default: present HTML`, `## When to reach for an artifact`, and the `## Loop` (open → await → reply → end). |
| No overtrigger | Pass | No MUST/ALWAYS/CRITICAL. The "and you have a plan, comparison..." qualifier scopes it to reviewable content. |

## 4. Right thing / right time / right amount

- **Right thing**: yes. Steering the model to author a rich, annotatable HTML artifact and
  drive the human-review loop is the right behavior inside an ai-or-die tab, and the body's
  per-type playbooks + the `data-aod-*` interactive-control authoring are genuinely useful,
  floor-raising guidance.
- **Right time**: yes by the description's WHEN clause — it fires when inside a tab and there
  is reviewable content. The ExitPlanMode auto-open hook and CLAUDE.md directive make the
  tab-scoped auto-invocation robust beyond the description alone.
- **Right amount**: yes. The description's "Skip it only for trivial one-line answers"
  (echoed in the body) and the enumerated content types keep it from firing on every reply.
  The "Honest limits" section correctly notes the panel is a review surface, not an approver.
- **Overtrigger / undertrigger risk from the description**: low overtrigger — the tab
  precondition and the content-type enumeration scope it well. The real risk is the gate
  mismatch below producing a session where the skill fires but its tools do not work.

## 5. Findings

- **Important (gate/capability mismatch)**: the skill file is written when `AIORDIE_SESSION_ID`
  alone is set (`src/claude.ts:807`), but every tool it drives is gated by
  `artifactToolsEnabled()` (`src/lib/mcp-capabilities.ts:212-217`), which additionally
  requires `AIORDIE_BASE_URL` and `AIORDIE_TOKEN`. In a session with `AIORDIE_SESSION_ID` set
  but either of the other two missing, the model discovers a fully-documented review skill
  whose entire loop (`artifact_open` → `artifact_await` → `artifact_reply` → `artifact_end`)
  hits the isError envelope at `src/lib/artifact/tools.ts:416` ("artifact tools only work
  inside an ai-or-die tab-backed Claude session. Missing AIORDIE_BASE_URL, AIORDIE_TOKEN, or
  AIORDIE_SESSION_ID"). The skill's "Honest limits" section does instruct the model to report
  the error code verbatim, which prevents a false "panel opened" claim — but the cleaner fix
  is to align the write gate with `artifactToolsEnabled()` so the skill is only materialized
  when its tools will run. (In normal ai-or-die launches all three are set together, so this
  is a latent mismatch, not a routine failure — but it is the kind of drift a capability
  predicate exists to prevent.)
- **Suggestion (voice)**: the opener is imperative ("Review plans and artifacts..."). A
  third-person predicate ("Reviews plans and artifacts in the ai-or-die panel...") would
  match a shared voice standard. Non-blocking; the description is otherwise the strongest in
  the registry.

**Verdict**: The strongest routing line in the registry (enumerated WHEN, specific, previews
the body) — but the write gate is narrower than `artifactToolsEnabled()`, so the skill can
be materialized in a session where its own tools are gated off. Align the gate.
