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
