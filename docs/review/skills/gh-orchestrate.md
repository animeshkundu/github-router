# gh-orchestrate

## 1. Identity

- **Name**: `gh-orchestrate`
- **Gate**: `workerToolsEnabled()` (`src/claude.ts:670-673`). Calls `mcp__orchestrate__*`,
  dispatches `worker-plan` / `worker-implement` / `worker-test` subagents, and invokes
  `/gh-research`.
- **Source**: `src/lib/injected-skills/orchestrate-skill.ts:1-137` (the `md` string is
  lines 3-135).
- **Registration**: second entry in `INJECTED_SKILLS` (`src/lib/injected-skills/index.ts:31`).
- **Write mechanism**: `writeInjectedSkill` →
  `<CLAUDE_CONFIG_DIR>/skills/gh-orchestrate/SKILL.md`.
- **Body size / structure**: ~6.0 KB. Headings: `# gh-orchestrate: right-sized blind-spot
  elimination`, `## Right-size first`, `## Honest limits`, `## Phase 0: scope and acceptance
  criteria`, `## Phase 1: delegate research`, `## Phase 2: blind-spot analysis`, `## Phase 3
  and 4: decompose and plan (run in parallel)`, `## Phase 5: compose a native Workflow`,
  `## Phase 6: verify the workflow`, `## Phase 7: checkpoint, then run`, `## Return format`.

## 2. Description (verbatim)

> Right-sized blind-spot-elimination for non-trivial implementation asks: capture
> user-blessed acceptance criteria, delegate bounded research, decompose and plan, compose a
> native Workflow with explicit deterministic/advisory annotations, verify the workflow,
> checkpoint residual risks and cost, then run only when the pipeline actually raises the
> floor.

352 characters.

## 3. Anthropic rubric assessment

| Criterion | Verdict | Note |
|---|---|---|
| Char budget (≤1024) | Pass | 352 chars. |
| Third person | Pass | Imperative-infinitive verbs (capture / delegate / decompose / compose / verify / checkpoint / run), no "I/you". |
| States WHAT | Pass | The full pipeline: acceptance criteria → research → decompose+plan → compose Workflow → verify → checkpoint → run. |
| States WHEN | Pass | "for non-trivial implementation asks" plus the closing "run only when the pipeline actually raises the floor" — a WHEN and a right-sizing guard in one line. |
| Specific, not vague | Pass | Names the artifacts (user-blessed acceptance criteria, native Workflow, deterministic/advisory annotations) and the floor-raising objective. |
| "use when / proactively" | Pass | "for non-trivial implementation asks" scopes auto-invocation; the "run only when... raises the floor" clause is an explicit anti-overtrigger. |
| Previews the body | Pass | Each phrase maps to a Phase: acceptance criteria → Phase 0; research → Phase 1; decompose+plan → Phases 3-4; compose Workflow → Phase 5; verify → Phase 6; checkpoint → Phase 7. |
| No overtrigger | Pass | No MUST/ALWAYS/CRITICAL; the "Right-size first" body section and the "raises the floor" clause actively push against over-firing. |

## 4. Right thing / right time / right amount

- **Right thing**: yes. The skill's stated sole objective ("how does the composed workflow
  deterministically raise the floor for THIS ask, and what blind spots does it eliminate")
  is precisely the floor-raising mandate. The "Honest limits" section names the wrong-spec
  hole and states that native Workflow "approximates but does not carry the kernel's hard
  max(orchestrated, baseline) guarantee" — honest about where the floor is soft.
- **Right time**: yes for a multi-file / risky-migration / uncertain-tests change; the
  description's "non-trivial implementation asks" and the body's "Right-size first" section
  ("For trivial asks, skip this pipeline and say why") gate it correctly.
- **Right amount**: strong. The most over-trigger-prone skill in the set (orchestration is
  expensive), and it has the most explicit anti-overtrigger language — both in the
  description ("run only when the pipeline actually raises the floor") and the body ("The
  pipeline is a tool, not a ritual"). The parallel decompose+plan batching (Phase 3-4) and
  the OPT-IN baseline/selector ("doubles cost") show cost-awareness.
- **Overtrigger / undertrigger risk from the description**: low overtrigger — the
  right-sizing clause is doing real work. Slight undertrigger risk only if the model reads
  "non-trivial implementation" narrowly and skips it on a genuinely risky small change, but
  the body's criteria (multiple files, unclear behavior, risky migration, uncertain tests,
  high user impact) correct that once loaded.

## 5. Findings

- **Suggestion**: like `gh-research`, the opener is a noun-phrase label
  ("Right-sized blind-spot-elimination for..."). A third-person predicate ("Runs a
  right-sized blind-spot-elimination pipeline on non-trivial implementation asks...") would
  align with a shared voice standard. Non-blocking.

**Verdict**: Clean, rubric-passing, and the best-scoped anti-overtrigger description in the
registry.
