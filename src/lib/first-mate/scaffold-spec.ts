export const COPILOT_SETUP_JOB_NAME = "copilot-setup-steps" as const
export const COPILOT_SETUP_TIMEOUT_MAX = 59 as const
export const COPILOT_SETUP_ALLOWED_KEYS = ["steps", "permissions", "runs-on", "services", "snapshot", "timeout-minutes"] as const

export interface ScaffoldFile {
  path: string
  content: string
}

export interface ScaffoldOpts {
  repoName: string
  repoDescription?: string
  techStack?: string
}

const COPILOT_SETUP_TIMEOUT_MINUTES = 5 as const

const SHORT_DEFINITION_OF_DONE = `- Build, typecheck, lint, and test commands pass, or unavailable commands are explicitly documented.
- Acceptance criteria are verified against the changed behavior.
- Security-sensitive changes receive focused review.
- Documentation and learnings are updated when behavior or process changes.`

export function buildScaffoldFiles(opts: ScaffoldOpts): ScaffoldFile[] {
  const guidance = buildGuidance(opts)
  return [
    { path: "AGENTS.md", content: guidance },
    { path: "CLAUDE.md", content: guidance },
    { path: "GEMINI.md", content: guidance },
    { path: ".github/copilot-instructions.md", content: guidance },
    { path: ".github/instructions/tests.instructions.md", content: buildTestInstructions() },
    { path: ".github/workflows/copilot-setup-steps.yml", content: buildCopilotSetupWorkflow() },
    { path: "docs/adr/0001-record-architecture-decisions.md", content: buildAdr() },
    { path: "docs/plans/README.md", content: buildDatedEntryReadme("Plans") },
    { path: "docs/research/README.md", content: buildDatedEntryReadme("Research") },
    { path: "LEARNINGS.md", content: buildLearnings() },
    { path: "CHANGELOG.md", content: buildChangelog() },
  ]
}

function buildGuidance(opts: ScaffoldOpts): string {
  const repoName = opts.repoName.trim() || "this repository"
  const overview = opts.repoDescription?.trim() || "<!-- TODO: fill in project overview, goals, users, and boundaries. -->"
  const techStack = opts.techStack?.trim() || "<!-- TODO: fill in languages, frameworks, package managers, services, and runtime versions. -->"

  return `# Repository guidance for ${repoName}

## Project overview

${overview}

## Tech stack

${techStack}

## Build/run

<!-- TODO: fill in setup, build, run, and local development commands. -->

## Test & validate

<!-- TODO: fill in repository-specific validation commands and required checks. -->

Use this Definition of Done gate before opening or merging changes:

${SHORT_DEFINITION_OF_DONE}

## Conventions

<!-- TODO: fill in coding style, naming, formatting, dependency, and review conventions. -->

## Project structure

<!-- TODO: fill in the important directories, ownership boundaries, and generated-file locations. -->

## Security

<!-- TODO: fill in secret-handling, dependency, data-retention, and permission rules. -->

## PR/commit rules

<!-- TODO: fill in branch naming, commit message, PR description, review, and merge rules. -->

## Gotchas/learnings

<!-- TODO: fill in surprising constraints, past incidents, and durable project learnings. -->
`
}

function buildTestInstructions(): string {
  return `---
applyTo: "**/*.test.*"
---
# Test conventions

<!-- TODO: fill in test naming, fixture, mocking, isolation, and coverage conventions. -->

- Keep tests deterministic and independent.
- Prefer focused assertions over broad snapshots.
- Record new testing gotchas in LEARNINGS.md.
`
}

function buildCopilotSetupWorkflow(): string {
  return `on:
  workflow_dispatch: {}
jobs:
  ${COPILOT_SETUP_JOB_NAME}:
    runs-on: ubuntu-latest
    timeout-minutes: ${Math.min(COPILOT_SETUP_TIMEOUT_MINUTES, COPILOT_SETUP_TIMEOUT_MAX)}
    steps:
      - uses: actions/checkout@v4
      - name: Set up environment
        run: echo "Environment ready"
`
}

function buildAdr(): string {
  return `# 0001. Record architecture decisions

## Status

Proposed

## Context

<!-- TODO: describe the forces, constraints, and options that motivated this decision. -->

## Decision

<!-- TODO: describe the decision and the scope where it applies. -->

## Consequences

<!-- TODO: describe positive, negative, and neutral consequences. -->
`
}

function buildDatedEntryReadme(title: "Plans" | "Research"): string {
  const lower = title.toLowerCase()
  return `# ${title}

Use one Markdown file per entry with the naming convention:

\`YYYY-MM-DD-slug.md\`

Examples:

- \`2026-01-31-add-search-index.md\`
- \`2026-01-31-evaluate-cache-options.md\`

Each ${lower} entry should include:

- date and owner
- short context
- decision, plan, or findings
- links to related issues, PRs, ADRs, and follow-ups
`
}

function buildLearnings(): string {
  return `# Learnings

Record durable project learnings here so future work can avoid rediscovering them.

## Template

### YYYY-MM-DD — Short title

- Context:
- What happened:
- What to do next time:
- Related links:
`
}

function buildChangelog(): string {
  return `# Changelog

All notable changes to this project will be documented in this file.

The format is based on Keep a Changelog, and this project follows Semantic Versioning when versioned releases are published.

## [Unreleased]

### Added

- Initial changelog scaffold.

### Changed

### Deprecated

### Removed

### Fixed

### Security
`
}
