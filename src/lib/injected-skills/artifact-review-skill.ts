export const ARTIFACT_REVIEW_SKILL = {
  name: "gh-artifact-review",
  md: `---
name: gh-artifact-review
description: Review plans and artifacts in the ai-or-die panel: open the file for the human, poll for feedback, revise, and end the loop. Use when running inside an ai-or-die tab and you have a plan, diff, or file the user should see before proceeding.
user-invocable: true
---

# gh-artifact-review: human review in the ai-or-die panel

Use this when you finish a plan or produce a file/diff the user should review and you are inside an ai-or-die tab (the \`mcp__peers__artifact_*\` tools drive a live panel).

## Loop

1. Open: \`mcp__peers__artifact_open\` with the absolute path of the plan/file. Relay the returned \`viewUrl\` and tell the user to review in the panel.
2. Poll: \`mcp__peers__artifact_poll\`. If status is waiting, poll again. Surface returned prompts and layout warnings.
3. Apply: make the requested edits, then \`mcp__peers__artifact_reply\` with a concise summary of what changed.
4. Repeat 2-3 until the user is satisfied; then \`mcp__peers__artifact_end\`.

## Honest limits

- If a tool errors (e.g. \`NOT_IN_AIORDIE_TAB\`, \`UNREACHABLE\`), report the code/message verbatim; do not claim the panel opened.
- The panel is a review surface, not an approver: outward/irreversible actions still need explicit user confirmation.
`,
} as const
