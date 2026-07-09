export const ARTIFACT_REVIEW_SKILL = {
  name: "gh-artifact-review",
  md: `---
name: gh-artifact-review
description: Reviews plans and artifacts in the ai-or-die panel. Defaults to authoring a self-contained HTML artifact (rich, annotatable, optionally interactive) and opening THAT for the human, then drains feedback with artifact_await, revises, and ends the loop. Use when running inside an ai-or-die tab and there is a plan, comparison, diagram, table, diff, or report the user should see before proceeding.
user-invocable: true
---

# gh-artifact-review: human review in the ai-or-die panel

Use this when you finish a plan or produce something a user should review and you are inside an ai-or-die tab (the \`mcp__peers__artifact_*\` tools drive a live panel). The human can click any block or select text to attach a comment, and can click declarative action controls you emit — both come back to you as typed events.

## Default: present HTML, not raw markdown

HTML is the canonical review artifact — it renders richly and is annotatable element-by-element. When the content is anything visual or structured (a comparison, table, diagram, diff, dashboard, or a plan you want to look polished), **author a self-contained \`.html\` file** (inline CSS, no external deps, readable typography) and open THAT.

- Plan-mode plans: the panel auto-opens them already rendered to HTML — you do not need to convert them by hand.
- Do not paste raw markdown into an \`.html\`; write real HTML (headings, lists, tables, \`<pre>\` for code). Opening a raw \`.md\` still renders, but a purpose-built HTML artifact reads better and annotates cleanly.

## When to reach for an artifact

Default to one for anything easier to grasp visually than as terminal prose: plans, design proposals, comparisons / trade-offs, decisions that need the user's input, diagrams / architecture, tables, code diffs, reports. Skip it only for trivial one-line answers.

## Playbooks (what a good artifact of each type contains)

- **plan**: goal, current state, the proposed approach (high-level decisions, not every line), then risks and open questions at the end.
- **comparison**: options as columns, trade-offs as rows, current-vs-target where relevant, and an explicit recommendation. Do not make the reader infer the winner.
- **table**: scannable rows, a sticky header, aligned numeric columns; group/section dense records rather than one flat wall.
- **diagram**: boxes + arrows. Mermaid when automatic layout matters; positioned SVG/CSS when each node needs prose, code, or controls.
- **code / diff**: \`<pre>\` with before/after or unified-diff styling; keep line context tight; call out the changed lines.
- **report / dashboard**: lead with the headline number / verdict, then supporting detail; keep one idea per section.

## Design system

Artifacts stay portable (they must render identically opened standalone), so do not depend on a server-injected theme. Pick the look in priority order: (1) a look the user named; (2) the **subject project's** own design system, its Tailwind / theme config, CSS variables / tokens, component library, or existing styled pages, especially when the artifact previews that app's UI; (3) only when both come up empty, clean readable defaults (system font stack, generous spacing, a single accent).

## Loop

1. Open: \`mcp__peers__artifact_open\` with the absolute path of the \`.html\` (or the file). Pass \`mode:"interactive"\` when the HTML carries \`data-aod-*\` action controls (below). Relay the returned \`viewUrl\` and tell the user to review in the panel.
2. Drain: \`mcp__peers__artifact_await\`. It long-holds for the human's next events and returns \`{events, status, cursor}\`. **Pass the returned \`cursor\` on your next call** so you only receive newer events; if \`events\` is empty, call again with that cursor.
3. Act on each event by \`kind\`:
   - \`comment\` — a free-text note anchored to the artifact (\`selector\`, quoted \`text\`, \`sourceLine\`); apply the requested change at that exact spot.
   - \`action\` — the human clicked a control you emitted (\`action\` verb, \`elementId\`, optional \`value\`; a multi-select submit arrives as one action carrying the selected set). Do what the verb means (approve a step, choose an option, apply a toggle set).
4. Reply: \`mcp__peers__artifact_reply\` with a concise summary of what you changed. Optionally \`mcp__peers__artifact_update({file})\` or \`({html})\` to replace the artifact content in place, or \`mcp__peers__artifact_refresh\` to reload it from disk.
5. Repeat 2-4 until the user is satisfied; then \`mcp__peers__artifact_end\`. Use \`mcp__peers__artifact_dismiss\` to hide the panel while keeping the review alive (queued feedback preserved) if the user wants it out of the way without ending.

### Push arrival (you do not have to be polling)

When you are idle at the prompt, panel feedback can arrive on its own as a new turn (the tab injects it). Structured actions that answer a pending decision are routed to you directly. Either way, the durable record is the \`artifact_await\` drain, so when in doubt call \`artifact_await\` (with your last cursor) to reconcile — it replays anything you missed.

### \`artifact_poll\` (frozen legacy)

\`mcp__peers__artifact_poll\` still resolves for back-compat but returns the OLD payload (human comments only, no structured actions). Prefer \`artifact_await\`.

## Interactive controls (data-aod-* authoring)

To let the human act on the artifact (not just comment), emit declarative controls; the panel wires them and delivers a typed \`action\` event. No JS in the artifact.

- **choose-one (fires immediately):** each option is a button that posts the moment it is clicked.
  \`<button data-aod-action="choose" data-aod-group="decision-1" data-aod-id="opt-jwt" data-aod-value="jwt">JWT</button>\`
- **multi-select (toggle then submit):** checkboxes sharing a \`data-aod-group\`, plus one submit button with the same group. The submit delivers ONE action carrying \`{group, selected:[{elementId, value?}]}\`.
  \`<input type="checkbox" data-aod-action="check" data-aod-group="opts" data-aod-id="a" data-aod-value="a">\` … \`<button data-aod-action="submit" data-aod-group="opts" data-aod-id="opts-submit">Apply</button>\`
- **plan steps:** \`<li class="aod-step" data-aod-id="plan-step-3" data-source-line="14">\` with per-step \`data-aod-action="approve"/"skip"\` buttons.
- **Required attrs:** \`data-aod-action\` (verb), \`data-aod-id\` (stable, echoed back as \`elementId\`; a control missing it is ignored), optional \`data-aod-value\`. Keep \`data-source-line\` for comment mapping.

## Honest limits

- If a tool errors (e.g. \`NOT_IN_AIORDIE_TAB\`, \`UNREACHABLE\`, \`INVALID_REQUEST\`), report the code/message verbatim; do not claim the panel opened.
- The panel is a review surface, not an approver: outward/irreversible actions still need explicit user confirmation.
`,
} as const
