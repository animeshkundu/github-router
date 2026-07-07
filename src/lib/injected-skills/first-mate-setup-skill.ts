export const FIRST_MATE_SETUP_SKILL = {
  name: "gh-first-mate-scaffold",
  md: `---
name: gh-first-mate-scaffold
description: Seed a world-class repo-geared agentic-dev foundation through first-mate.
user-invocable: true
---

# gh-first-mate-scaffold

Invoke the ` + "`scaffold_repo`" + ` MCP tool (` + "`mcp__first-mate__scaffold_repo`" + `) before the first build wave on an owned repository. The goal is not generic TODO stubs; it is a repo-geared foundation that GitHub agents, local agents, reviewers, and CI can read.

## What it seeds

- ` + "`AGENTS.md`" + ` / ` + "`CLAUDE.md`" + ` / ` + "`GEMINI.md`" + ` / ` + "`.github/copilot-instructions.md`" + ` — identical guidance with overview, detected stack, commands, hard DoD gate, primary OS, conventions, structure, decisions/memory, handoff, testing, and gotchas.
- ` + "`.github/agents/{planner,implementer,reviewer,researcher,tester}.md`" + ` mirrored into ` + "`.claude/agents/`" + ` — role agents with frontmatter, cold-start contract, method, quality bar, output contract, and self-reminder.
- ` + "`docs/adrs/0000-template.md`" + ` plus ` + "`docs/adr/0001-record-architecture-decisions.md`" + ` — Nygard-style decision record foundation.
- ` + "`LEARNINGS.md`" + `, ` + "`CHANGELOG.md`" + `, ` + "`docs/history/0000-template.md`" + `, ` + "`docs/plans/README.md`" + `, and ` + "`docs/research/README.md`" + ` — durable memory, history, plans, and research conventions.
- ` + "`.github/pull_request_template.md`" + ` — summary, type, failure-modes-considered-and-tested, and DoD checklist.
- ` + "`.github/instructions/tests.instructions.md`" + ` — path-scoped test guidance filled from detected framework/dir/glob where possible.
- ` + "`.github/workflows/copilot-setup-steps.yml`" + ` and starter ` + "`.github/workflows/ci.yml`" + ` — detected toolchain setup with stable quality-gate job names.

It does not seed factory-protocol or ` + "`docs/factory/`" + ` files. Orchestration remains outside the product repo in first-mate.

## Usage

` + "```" + `
mcp__first-mate__scaffold_repo({ repo: "owner/repo" })
mcp__first-mate__scaffold_repo({ repo: "owner/repo", mode: "enhance" })
mcp__first-mate__scaffold_repo({
  repo: "owner/repo",
  mode: "add-missing-only",
  detection_overrides: { primary_os: "windows-latest", test_command: "npm test" }
})
` + "```" + `

Modes:

- ` + "`add-missing-only`" + ` (default): seed absent files and skip present files.
- ` + "`enhance`" + `: for guidance files, ADR index, changelog, and learnings, append only missing ` + "`##`" + ` sections; never rewrite existing prose. Other present files are skipped.
- ` + "`overwrite-approved`" + `: replace existing files only when explicitly approved.

Always inspect the returned per-file report and PR. A no-op result means the repo already has the foundation or has no missing enhanceable sections.
`,
} as const
