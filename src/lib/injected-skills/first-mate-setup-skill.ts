export const FIRST_MATE_SETUP_SKILL = {
  name: "gh-first-mate-scaffold",
  md: `---
name: gh-first-mate-scaffold
description: Seed deterministic agentic-dev repository convention files through first-mate.
user-invocable: true
---

# gh-first-mate-scaffold

Invoke the \`scaffold_repo\` MCP tool (\`mcp__first-mate__scaffold_repo\`) to seed agentic-dev conventions files into a GitHub repository.

## What it seeds

- \`AGENTS.md\` / \`CLAUDE.md\` / \`GEMINI.md\` / \`.github/copilot-instructions.md\` — identical agentic guidance (overview, tech stack, DoD gate, conventions, PR rules, gotchas)
- \`.github/instructions/tests.instructions.md\` — path-scoped test conventions stub
- \`.github/workflows/copilot-setup-steps.yml\` — Copilot setup workflow
- \`docs/adr/0001-record-architecture-decisions.md\` — first ADR (Nygard format)
- \`docs/plans/README.md\` + \`docs/research/README.md\` — dated-entry convention docs
- \`LEARNINGS.md\` + \`CHANGELOG.md\` — living documents

## Usage

\`\`\`
mcp__first-mate__scaffold_repo({ repo: "owner/repo" })
\`\`\`

By default uses \`add-missing-only\` mode: existing files are never overwritten. Pass \`mode: "overwrite-approved"\` to replace existing files.
`,
} as const
