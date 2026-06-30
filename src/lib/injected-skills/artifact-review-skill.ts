export const ARTIFACT_REVIEW_SKILL = {
  name: "gh-artifact-review",
  md: `---
name: gh-artifact-review
description: Review plans and artifacts in the ai-or-die panel. Default to authoring a self-contained HTML artifact (rich, annotatable) and opening THAT for the human, then poll for feedback, revise, and end the loop. Use when running inside an ai-or-die tab and you have a plan, comparison, diagram, table, diff, or report the user should see before proceeding.
user-invocable: true
---

# gh-artifact-review: human review in the ai-or-die panel

Use this when you finish a plan or produce something a user should review and you are inside an ai-or-die tab (the \`mcp__peers__artifact_*\` tools drive a live panel). The human can click any block or select text to attach a comment that comes back to you.

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

1. Open: \`mcp__peers__artifact_open\` with the absolute path of the \`.html\` (or the file). Relay the returned \`viewUrl\` and tell the user to review in the panel — they can click a block or select text to comment.
2. Poll: \`mcp__peers__artifact_poll\`. If status is waiting, poll again. Each returned prompt may carry a \`selector\`, quoted \`text\`, and \`sourceLine\` pinpointing what the comment is about — act on that exact spot.
3. Apply: make the requested edits, then \`mcp__peers__artifact_reply\` with a concise summary of what changed.
4. Repeat 2-3 until the user is satisfied; then \`mcp__peers__artifact_end\`.

## Honest limits

- If a tool errors (e.g. \`NOT_IN_AIORDIE_TAB\`, \`UNREACHABLE\`), report the code/message verbatim; do not claim the panel opened.
- The panel is a review surface, not an approver: outward/irreversible actions still need explicit user confirmation.
`,
} as const
