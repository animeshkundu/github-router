# ARTIFACT_PANEL_DIRECTIVE

## Identity

- **What**: A directive steering the agent to review plans, designs, comparisons, tables, diagrams, diffs, and reports in the ai-or-die human-review panel by default, authoring a self-contained HTML artifact and driving it through the `mcp__peers__artifact_*` tool loop (open → await feedback → revise → reply → end).
- **Constant**: `ARTIFACT_PANEL_DIRECTIVE`, `src/lib/claude-md-injection.ts:48-58`. Lever-split design comment at `:40-47`.
- **Injected via**: mirrored CLAUDE.md only, prepended at the TOP by `prependArtifactPanelDirectiveToMirroredClaudeMd` (`claude-md-injection.ts:731-741`), called from `src/claude.ts:811`.
- **Surfaces**: CLAUDE.md `<claudeMd>` wrapper only. Reaches the main agent and descendants. It does NOT ride `--append-system-prompt`.
- **Gate**: only injected when running inside an ai-or-die tab, the caller guards on `AIORDIE_SESSION_ID` being non-empty (`src/claude.ts:807`). Best-effort (warn-and-continue).
- **Position in final CLAUDE.md order**: prepended before STYLE and OPERATING_DEFAULTS run, so it ends up below them but above the user's content (top-of-file region). Size: 2148 bytes.
- **Related deterministic lever**: the design comment (`:44-47`) notes this directive is the SOFT steer for model-judgment cases (show a mid-conversation comparison/table that no hook can detect); the one DETERMINISTIC artifact-open is the `PostToolUse(ExitPlanMode)` hook that auto-opens a finalized plan. A Stop/UserPromptSubmit hook is deliberately NOT added (would mis-fire or duplicate this steer).

## Text (verbatim)

`src/lib/claude-md-injection.ts:48-58`:

```
## Review in the artifact panel (HTML by default)

You are running inside an ai-or-die tab, so the `mcp__peers__artifact_*` tools drive a live human-review panel. Default to an HTML artifact for anything the user should review before you proceed, not just plans but also design proposals, comparisons / trade-offs, decisions that need their input, diagrams, tables, code diffs, and reports. Author a self-contained `.html` (inline CSS, no external deps, readable typography) and open it with `mcp__peers__artifact_open` (pass `mode:"interactive"` if it carries `data-aod-*` action controls); tell the user to review, then drain their feedback with `mcp__peers__artifact_await` (pass back the returned `cursor` each call), revise, `mcp__peers__artifact_reply`, and `mcp__peers__artifact_end` when done. `artifact_await` returns typed events: `comment` (free-text anchored by selector/text/sourceLine) and `action` (the human clicked a control you emitted). Use `mcp__peers__artifact_update`/`artifact_refresh` to change the shown content and `mcp__peers__artifact_dismiss` to hide the panel while keeping the review alive. `mcp__peers__artifact_poll` is a frozen legacy alias (comments only). Plan-mode plans are auto-rendered to HTML and auto-opened for you; raw markdown is only a fallback. Skip the panel only for trivial one-line answers.

Make the HTML good: match the subject project's design system (its Tailwind / theme / tokens) when the artifact represents a specific app, otherwise clean readable defaults. Per-type cheatsheet. plan: goal, current state, proposed approach, risks / open questions. comparison: options as columns with trade-off rows and a recommendation. table: scannable rows with a sticky header. diagram: boxes + arrows (SVG/CSS or Mermaid). code / diff: `<pre>` with before/after. To let the user act (not just comment), emit declarative controls (no JS): `data-aod-action` (verb) + `data-aod-id` (stable) [+ `data-aod-value`] — a choose-one option fires on click, a multi-select is checkboxes sharing `data-aod-group` plus a submit button with that group. The `gh-artifact-review` skill carries the fuller playbook.
```

## Anthropic-guideline assessment

- **Role framing**: n/a, a workflow directive, not a role.
- **Positive / prohibitive**: Positive. It tells the model what to do ("Default to an HTML artifact...", "Author a self-contained `.html`...", "Make the HTML good"). The only near-prohibition is "Skip the panel only for trivial one-line answers", which is a scoped exception phrased positively (it grants a carve-out rather than forbidding a behavior). Clean.
- **Overtrigger risk**: Low. No MUST/ALWAYS/CRITICAL/all-caps, consistent with Anthropic's "dial back any aggressive language" guidance for newer models ([Prompting best practices, "Tool usage"](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-4-best-practices)). "Default to" is a soft steer, and the design intent (comment `:42-43`) is explicitly the soft-lever half of a lever split, the deterministic auto-open is a hook, this is the judgment-case nudge. The "Skip the panel only for trivial one-line answers" scope line is the main overtrigger guard: without it, a precise-following model might wrap even a one-word answer in an HTML panel. With it, the model has an explicit floor.
- **Literalness / scope**: Good. The scope is stated at both ends: the trigger set is enumerated ("plans but also design proposals, comparisons / trade-offs, decisions ... diagrams, tables, code diffs, and reports") and the exclusion is explicit ("Skip the panel only for trivial one-line answers"). Opus 4.8 following instructions precisely, the enumerated trigger + explicit exclusion is exactly the technique that keeps it from either under- or over-firing, and being specific about the desired output is Anthropic's core lever ("Being specific about your desired output can help enhance results", [Prompting best practices, "Be clear and direct"](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-4-best-practices)). The per-type cheatsheet gives the model concrete shapes to produce rather than leaving "make a good comparison" underspecified.
- **Enforcement claims**: None problematic. It says plan-mode plans "are auto-rendered to HTML and auto-opened for you", that is a true statement about the PostToolUse(ExitPlanMode) hook, not an unbacked promise. The directive itself does not claim it is enforced; it correctly reads as a default the model applies by judgment (which matches the lever-split design: the hook enforces the plan case, this steers the rest).
- **Structure**: Markdown `##` header + two paragraphs + an inline per-type cheatsheet. Dense but well-organized; the cheatsheet is a compact reference table in prose form. Appropriate for a workflow with several artifact types.

## Don't-nerf / right-balance

- **Does it help at the right time?** Yes, and only at the right time, it is gated on `AIORDIE_SESSION_ID`, so it is injected ONLY when the artifact panel actually exists. Outside an ai-or-die tab the block is absent, so it never steers the model toward tools that are not there. This is the correct conditional-injection discipline: surface the capability exactly when it is reachable.
- **Soft-lever role is right.** The mid-conversation "show a comparison" case genuinely cannot be detected by a hook, so a soft steer is the only lever available. Pairing it with the deterministic plan auto-open hook (so the highest-value case is enforced, the judgment cases are nudged) is a well-reasoned split. This raises the floor (reviews happen by default) without nerfing (the "trivial one-line" carve-out and the model's judgment keep it from over-firing).
- **CLAUDE.md-only is defensible.** It is environment-conditional context (only meaningful inside a tab), which is what CLAUDE.md is for. Descendant reach matters (a subagent producing a report should also use the panel), so the mirrored file is the right surface. No system-prompt push is needed since it is not a directive that must win over user instructions.

## Findings + verdict

**Finding 1 (correctness, the `mcp__peers__artifact_*` hardcode, flag + cross-reference):** This directive hardcodes the `mcp__peers__artifact_*` tool prefix in its text (one wildcard mention at `claude-md-injection.ts:50` plus seven named tools at `:52-53`, `artifact_open`/`_await`/`_reply`/`_end`/`_update`/`_dismiss`/`_poll`). The `peers` group config key is normally `peers`, but on a collision with a user-side `mcpServers` entry named `peers`, `resolveGroupKeysFromMirror` walks the numbered fallback (`gh-router-peers`, `gh-router-peers-2`, ...) and the artifact tools would then be served under `mcp__gh-router-peers__artifact_*`. The peer-awareness snippet renders its prefixes from the resolved `groupKeys` and so tracks the fallback; this directive does NOT, `prependArtifactPanelDirectiveToMirroredClaudeMd` (`:731-741`) takes no `groupKeys` and injects the static `ARTIFACT_PANEL_DIRECTIVE` string with the bare `peers` prefix baked in. Under a `peers` collision, the directive would instruct the model to call `mcp__peers__artifact_open`, which would not resolve to the proxy's server. **Severity**: Important (a real but narrow drift, only triggers when a user has their own MCP server literally named `peers`, which is uncommon). **Fix**: parameterize the directive on the resolved peers group key the same way `buildPeerAwarenessSnippet` does, or (simpler) have the caller string-replace the prefix with the resolved key before prepending. This finding should be cross-referenced from the mcp/artifact review; it is the same class of bug the group-key resolution was built to prevent, but this one static string was missed.

**Finding 2 (positive, keep):** The `AIORDIE_SESSION_ID` gate is exemplary conditional injection, the block appears only where its tools exist. Keep.

**Finding 3 (positive, keep):** The enumerated trigger set plus the explicit "trivial one-line" exclusion is the right literalness technique for a soft default. Keep.

**Verdict**: Well-written as a soft steer, positive, explicitly scoped at both ends, correctly gated to the tab, honest about the plan-hook enforcement without overclaiming enforcement for itself. The one real defect is the hardcoded `mcp__peers__artifact_*` prefix that does not track the resolved group key on a `peers` collision (Finding 1, Important); everything else is sound.

## Sources

- [Prompting best practices](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-4-best-practices), sections cited: "Tool usage" (dial back aggressive language), "Be clear and direct" (be specific about desired output).
