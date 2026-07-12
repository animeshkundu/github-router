export const COPILOT_SETUP_JOB_NAME = "copilot-setup-steps" as const
export const COPILOT_SETUP_TIMEOUT_MAX = 59 as const
export const COPILOT_SETUP_ALLOWED_KEYS = ["steps", "permissions", "runs-on", "services", "snapshot", "timeout-minutes"] as const

export type ScaffoldMode = "add-missing-only" | "overwrite-approved" | "enhance"

export interface ScaffoldFile {
  path: string
  content: string
}

export interface ScaffoldCommandSet {
  install?: string
  build?: string
  typecheck?: string
  lint?: string
  test?: string
  dev?: string
}

export interface ScaffoldTestContext {
  framework?: string
  directory?: string
  glob?: string
}

export interface ScaffoldCiContext {
  primaryOs?: string
  matrix: string[]
}

export interface ScaffoldOpts {
  repoName: string
  repoDescription?: string
  defaultBranch?: string
  techStack?: string
  packageManager?: string
  commands?: ScaffoldCommandSet
  tests?: ScaffoldTestContext
  ci?: ScaffoldCiContext
  uiEvidenceRequired?: boolean
  projectStructure?: string[]
  detectedNotes?: string[]
}

export interface ScaffoldPlanFile extends ScaffoldFile {
  action: "seed" | "overwrite" | "skip" | "enhance"
  appendedSections?: string[]
}

export interface ScaffoldPlan {
  filesToCommit: ScaffoldFile[]
  reports: ScaffoldFileReport[]
}

export interface ScaffoldFileReport {
  path: string
  status: "seeded" | "skipped" | "overwritten" | "enhanced"
  appendedSections?: string[]
}

export interface ExistingScaffoldFile {
  path: string
  content?: string
}

const GUIDANCE_PATHS = [
  "AGENTS.md",
  "CLAUDE.md",
  "GEMINI.md",
  ".github/copilot-instructions.md",
] as const

const ENHANCEABLE_PATHS = new Set<string>([
  ...GUIDANCE_PATHS,
  "docs/adr/0001-record-architecture-decisions.md",
  "LEARNINGS.md",
  "CHANGELOG.md",
])

const COPILOT_SETUP_TIMEOUT_MINUTES = 15 as const

const ROLE_AGENT_NAMES = ["planner", "implementer", "reviewer", "researcher", "tester"] as const

const DEFAULT_CI_MATRIX = ["ubuntu-latest", "windows-latest"] as const

export function buildScaffoldFiles(opts: ScaffoldOpts): ScaffoldFile[] {
  const normalized = normalizeScaffoldOpts(opts)
  const guidance = buildGuidance(normalized)
  const roleAgents = ROLE_AGENT_NAMES.flatMap((role) => {
    const content = buildRoleAgent(role)
    return [
      { path: `.github/agents/${role}.md`, content },
      { path: `.claude/agents/${role}.md`, content },
    ]
  })

  return [
    ...GUIDANCE_PATHS.map((path) => ({ path, content: guidance })),
    ...roleAgents,
    { path: ".github/instructions/tests.instructions.md", content: buildTestInstructions(normalized) },
    { path: ".github/workflows/copilot-setup-steps.yml", content: buildCopilotSetupWorkflow(normalized) },
    { path: ".github/workflows/ci.yml", content: buildCiWorkflow(normalized) },
    { path: ".github/pull_request_template.md", content: buildPullRequestTemplate(normalized) },
    { path: "docs/adrs/0000-template.md", content: buildAdrTemplate() },
    { path: "docs/adr/0001-record-architecture-decisions.md", content: buildAdrIndex(normalized) },
    { path: "docs/history/0000-template.md", content: buildHistoryTemplate() },
    { path: "docs/plans/README.md", content: buildDatedEntryReadme("Plans") },
    { path: "docs/research/README.md", content: buildDatedEntryReadme("Research") },
    { path: "LEARNINGS.md", content: buildLearnings(normalized) },
    { path: "CHANGELOG.md", content: buildChangelog() },
  ]
}

export function planScaffoldFiles(opts: {
  mode: ScaffoldMode
  desired: ReadonlyArray<ScaffoldFile>
  existing: ReadonlyArray<ExistingScaffoldFile>
}): ScaffoldPlan {
  const existingByPath = new Map(opts.existing.map((file) => [file.path, file.content] as const))
  const filesToCommit: ScaffoldFile[] = []
  const reports: ScaffoldFileReport[] = []

  for (const file of opts.desired) {
    if (!existingByPath.has(file.path)) {
      filesToCommit.push(file)
      reports.push({ path: file.path, status: "seeded" })
      continue
    }

    if (opts.mode === "overwrite-approved") {
      filesToCommit.push(file)
      reports.push({ path: file.path, status: "overwritten" })
      continue
    }

    if (opts.mode === "enhance" && ENHANCEABLE_PATHS.has(file.path)) {
      const current = existingByPath.get(file.path)
      if (current === undefined) {
        reports.push({ path: file.path, status: "skipped" })
        continue
      }
      const enhanced = appendMissingSections(current, file.content)
      if (enhanced.appendedSections.length > 0) {
        filesToCommit.push({ path: file.path, content: enhanced.content })
        reports.push({ path: file.path, status: "enhanced", appendedSections: enhanced.appendedSections })
      } else {
        reports.push({ path: file.path, status: "skipped" })
      }
      continue
    }

    reports.push({ path: file.path, status: "skipped" })
  }

  return { filesToCommit, reports }
}

function appendMissingSections(current: string, desired: string): { content: string; appendedSections: string[] } {
  const currentHeadings = new Set(sectionHeadings(current))
  const desiredSections = splitTopLevelSections(desired)
  const missing = desiredSections.filter((section) => !currentHeadings.has(section.heading))
  if (missing.length === 0) return { content: current, appendedSections: [] }

  const suffix = missing.map((section) => section.text.trim()).join("\n\n")
  const separator = current.endsWith("\n") ? "\n" : "\n\n"
  return {
    content: `${current}${separator}${suffix}\n`,
    appendedSections: missing.map((section) => section.heading),
  }
}

function sectionHeadings(markdown: string): string[] {
  return markdown
    .split(/\r?\n/)
    .filter((line) => /^##\s+\S/.test(line))
    .map((line) => line.trim())
}

function splitTopLevelSections(markdown: string): Array<{ heading: string; text: string }> {
  const lines = markdown.split(/\r?\n/)
  const sections: Array<{ heading: string; text: string }> = []
  let currentHeading: string | undefined
  let currentLines: string[] = []

  for (const line of lines) {
    if (/^##\s+\S/.test(line)) {
      if (currentHeading !== undefined) {
        sections.push({ heading: currentHeading, text: currentLines.join("\n") })
      }
      currentHeading = line.trim()
      currentLines = [line]
    } else if (currentHeading !== undefined) {
      currentLines.push(line)
    }
  }
  if (currentHeading !== undefined) {
    sections.push({ heading: currentHeading, text: currentLines.join("\n") })
  }
  return sections
}

function normalizeScaffoldOpts(opts: ScaffoldOpts): Required<ScaffoldOpts> {
  return {
    repoName: opts.repoName.trim() || "this repository",
    repoDescription: opts.repoDescription?.trim() || "<!-- TODO: describe the product, users, jobs-to-be-done, and explicit non-goals. -->",
    defaultBranch: opts.defaultBranch?.trim() || "<!-- TODO: confirm the default branch. -->",
    techStack: opts.techStack?.trim() || "<!-- TODO: fill in languages, frameworks, package managers, services, and runtime versions. -->",
    packageManager: opts.packageManager?.trim() || "<!-- TODO: confirm the package manager or build tool. -->",
    commands: opts.commands ?? {},
    tests: opts.tests ?? {},
    ci: opts.ci ?? { primaryOs: "<!-- TODO: choose the primary supported OS. -->", matrix: [...DEFAULT_CI_MATRIX] },
    uiEvidenceRequired: opts.uiEvidenceRequired ?? false,
    projectStructure: opts.projectStructure ?? ["<!-- TODO: list the important directories and ownership boundaries. -->"],
    detectedNotes: opts.detectedNotes ?? [],
  }
}

function buildGuidance(opts: Required<ScaffoldOpts>): string {
  const commandBlock = commandLines(opts.commands)
  const primaryOs = opts.ci.primaryOs || "<!-- TODO: choose the primary supported OS. -->"
  const ciMatrix = opts.ci.matrix.length > 0 ? opts.ci.matrix.join(", ") : "<!-- TODO: define CI OS matrix. -->"
  const uiEvidence = opts.uiEvidenceRequired
    ? "- UI-impacting changes include before/after screenshots or recorded browser evidence in the PR."
    : "- If a change affects user-visible UI or CLI output, include before/after evidence in the PR."
  const notes = opts.detectedNotes.length > 0
    ? opts.detectedNotes.map((note) => `- ${note}`).join("\n")
    : "- <!-- TODO: add repo-specific hazards, flaky areas, rate limits, and platform traps as they are discovered. -->"

  return `# Repository guidance for ${opts.repoName}

## Project overview

${opts.repoDescription}

Default branch: ${opts.defaultBranch}

## Tech stack

${opts.techStack}

Package manager / build tool: ${opts.packageManager}

## Commands

Run the closest available command before handing off. If a command is ambiguous, keep the TODO rather than guessing.

${commandBlock}

## Definition of Done gate

A change is not ready for review or merge until all applicable checks below are satisfied with real command output in the PR:

- Build passes: ${commandOrTodo(opts.commands.build, "record the build command")}
- Typecheck passes: ${commandOrTodo(opts.commands.typecheck, "record the typecheck command")}
- Lint passes: ${commandOrTodo(opts.commands.lint, "record the lint command")}
- Tests pass: ${commandOrTodo(opts.commands.test, "record the test command")}
- Tests only go up: features and bug fixes add or strengthen tests; do not delete coverage to make a branch green.
- Acceptance criteria are explicitly verified against the changed behavior.
- No stub, skipped, or TODO-only implementation is counted as done.
- Documentation, ADRs, changelog, and history/learnings are updated in the same PR when behavior, architecture, process, or operational knowledge changes.
- CI is green on the required matrix (${ciMatrix}); branch protection and required checks are the merge gate.
- No attribution to tools or generated authorship appears in commits, PRs, docs, or code comments.
${uiEvidence}

## Primary OS and portability

Primary OS: ${primaryOs}

- Treat the primary OS as authoritative when behavior differs.
- Keep path handling portable; avoid shell-specific assumptions in application code.
- Add regression coverage for platform-specific fixes rather than skipping that platform.

## Conventions

- Follow Conventional Commits: \`feat:\`, \`fix:\`, \`docs:\`, \`test:\`, \`chore:\`, \`refactor:\`.
- Keep one concern per PR; split broad or vague work before implementation.
- Prefer small, reviewable changes with explicit acceptance criteria.
- Do not hide failures with retries, skipped tests, relaxed assertions, or platform carve-outs.
- Preserve existing style unless an accepted ADR says otherwise.

## Project structure

${opts.projectStructure.map((entry) => `- ${entry}`).join("\n")}

## Decision records and durable memory

- ADRs live in \`docs/adr/\` for project-specific decisions; use \`docs/adrs/0000-template.md\` as the Nygard-style template when the repo uses plural ADR paths.
- Plans live in \`docs/plans/YYYY-MM-DD-slug.md\`.
- Research lives in \`docs/research/YYYY-MM-DD-slug.md\` with citations to source files or external URLs.
- Solved problems, incidents, and debugging notes live in \`docs/history/YYYY-MM-DD-slug.md\`.
- Durable project learnings live in \`LEARNINGS.md\`; update it when a future contributor would otherwise rediscover the same fact.

## Handoff

Every handoff should include:

- What changed and why.
- Files touched and the important decisions made.
- Commands run with pass/fail results.
- Risks, follow-ups, and any intentionally deferred work.
- Links to PRs, issues, ADRs, plans, research, and history entries.

## Testing

- Framework: ${opts.tests.framework ?? "<!-- TODO: identify the test framework. -->"}
- Test directory: ${opts.tests.directory ?? "<!-- TODO: identify the test directory. -->"}
- Test file glob: ${opts.tests.glob ?? "<!-- TODO: identify the test file glob. -->"}
- Prefer tests that reproduce real failure modes, not only cooperative mocks.
- Bug fixes include a regression test that fails before the fix.
- Keep tests deterministic and independent; clean up external state.

## Gotchas

${notes}
`
}

function commandLines(commands: ScaffoldCommandSet): string {
  const rows: Array<[string, string | undefined, string]> = [
    ["Install", commands.install, "confirm install command"],
    ["Dev", commands.dev, "confirm dev command"],
    ["Build", commands.build, "confirm build command"],
    ["Typecheck", commands.typecheck, "confirm typecheck command"],
    ["Lint", commands.lint, "confirm lint command"],
    ["Test", commands.test, "confirm test command"],
  ]
  return rows.map(([label, command, todo]) => `- ${label}: ${commandOrTodo(command, todo)}`).join("\n")
}

function commandOrTodo(command: string | undefined, todo: string): string {
  return command === undefined || command.trim() === "" ? `<!-- TODO: ${todo}. -->` : `\`${command}\``
}

function buildRoleAgent(role: (typeof ROLE_AGENT_NAMES)[number]): string {
  const specs: Record<(typeof ROLE_AGENT_NAMES)[number], {
    description: string
    purpose: string
    when: string[]
    method: string[]
    quality: string[]
    output: string[]
    model?: string
  }> = {
    planner: {
      description: "Turn ambiguous goals into scoped, acceptance-criteria'd implementation plans before build work starts.",
      purpose: "Design before building. Translate goals into small, testable work with explicit acceptance criteria, dependencies, risks, and verification commands.",
      when: ["The task is broad, architectural, cross-cutting, or under-specified.", "A mission needs decomposition into concrete build units.", "A decision should be captured as an ADR before implementation."],
      method: ["Read existing guidance, ADRs, plans, and relevant code before proposing a path.", "Split work into one-concern units that can be reviewed and tested independently.", "Call out assumptions, risks, alternatives, and the verification gate for each unit.", "Write or update an ADR when the plan changes architecture or long-lived process."],
      quality: ["No vague meta-work; every unit has a concrete outcome and acceptance criteria.", "Dependencies are explicit and acyclic.", "Plans prefer the simplest design that satisfies the user's outcome."],
      output: ["Status: ready | needs-clarification | blocked", "Plan: ordered units with acceptance criteria and verification", "Risks / decisions / ADRs needed", "Handoff for implementer"],
      model: "claude-opus-4.8",
    },
    implementer: {
      description: "Implement a scoped coding task end-to-end with tests and minimal unrelated churn.",
      purpose: "Turn a clear specification into working, tested code while preserving the surrounding style and scope.",
      when: ["Acceptance criteria and target files or components are clear.", "The task can be completed in one focused implementation pass.", "A bug fix needs a regression test plus minimal code change."],
      method: ["Read the relevant plan, ADRs, guidance, and existing tests before editing.", "Write or update tests first when practical; otherwise add the regression or feature test in the same change.", "Make the smallest correct change; avoid opportunistic rewrites.", "Run the narrow checks first, then the repo-level DoD commands when available."],
      quality: ["No stub or skipped implementation.", "No disabled tests or hidden failures.", "Every changed behavior has executable coverage or a documented reason it cannot."],
      output: ["Status: complete | needs-clarification | blocked", "Files changed with one-line rationale", "Verification commands and outcomes", "Risks and follow-ups"],
      model: "gpt-5.6-sol",
    },
    reviewer: {
      description: "Adversarial code reviewer for concrete diffs; reports real findings with severity and file:line.",
      purpose: "Protect the repository from regressions, security issues, missing tests, platform breaks, and spec drift.",
      when: ["A concrete diff, PR, or changed file set is ready for review.", "The lead needs independent verification before merge or handoff.", "CI/review evidence must be judged against acceptance criteria."],
      method: ["Read the diff and surrounding code, not only summaries.", "Verify the change against acceptance criteria, ADRs, and the DoD gate.", "Look for realistic failure modes: error paths, races, security, data loss, portability, resource leaks.", "Cite every finding with file:line and a minimal suggested fix."],
      quality: ["Do not invent issues to look thorough; silence on clean code is valid.", "Reject missing tests for changed behavior.", "Treat flaky or failing CI as a blocker until root-caused."],
      output: ["Summary: clean | N findings | blocking", "Findings in severity order", "Each finding: severity, file:line, issue, suggested fix", "Verification gaps"],
      model: "gemini-3.1-pro-preview",
    },
    researcher: {
      description: "Investigate code, docs, history, and external sources; return cited, actionable findings without editing implementation.",
      purpose: "Let evidence lead. Build the factual basis for plans, fixes, and decisions.",
      when: ["The team lacks context about a subsystem, dependency, incident, or API.", "A decision needs current external documentation or comparative research.", "A bug needs root-cause exploration before implementation."],
      method: ["Search existing docs, ADRs, history, and tests before new research.", "Trace code paths and cite file paths for repo findings.", "Use external sources when needed and cite URLs.", "Separate confirmed facts from hypotheses and open questions."],
      quality: ["No uncited claims for non-obvious facts.", "No code changes.", "Findings are structured and directly usable by planner, implementer, or reviewer."],
      output: ["Question answered", "Findings with file/URL citations", "Risks and unknowns", "Recommended next steps"],
    },
    tester: {
      description: "Author adversarial tests for a feature or fix without editing implementation to make them pass.",
      purpose: "Try to break the implementation through executable checks that encode acceptance criteria, edge cases, and regressions.",
      when: ["A feature or fix needs stronger coverage.", "Acceptance criteria should become executable checks.", "A review found missing edge-case or failure-path tests."],
      method: ["Read the spec, acceptance criteria, and changed code.", "Write focused tests for happy path, failure path, boundary conditions, and platform-sensitive behavior.", "Run the relevant test command and report pass/fail honestly.", "Do not edit production implementation merely to make tests pass."],
      quality: ["Tests fail for the original bug or missing behavior when possible.", "No broad snapshots where focused assertions are better.", "No skipped tests unless the skip is the behavior under test and clearly justified."],
      output: ["Tests added/changed", "Scenarios covered", "Commands run and outcomes", "Failures that require implementation work"],
      model: "gpt-5.6-sol",
    },
  }
  const spec = specs[role]
  const modelLine = spec.model === undefined ? "" : `model: ${spec.model}\n`
  return `---
name: ${role}
description: ${spec.description}
${modelLine}---

# ${capitalize(role)}

## Purpose

${spec.purpose}

## When to use

${spec.when.map((line) => `- ${line}`).join("\n")}

## Inputs (cold-start contract)

A delegated task starts from a blank context. The caller must include:

- The goal or artifact to work on, pasted or linked precisely.
- Acceptance criteria and constraints.
- Relevant files, PRs, issues, ADRs, plans, or prior decisions.
- The expected output format and verification bar.

If any required input is missing, ask one concise clarifying question before doing irreversible work.

## Method

${spec.method.map((line) => `- ${line}`).join("\n")}

## Quality bar

${spec.quality.map((line) => `- ${line}`).join("\n")}
- Repository DoD applies: build/typecheck/lint/test, docs, ADRs, changelog/history, and CI evidence as relevant.

## Output contract

${spec.output.map((line) => `- ${line}`).join("\n")}

## Self-reminder

Am I still acting as the ${role} for this scoped task, with evidence for every claim and no unrelated churn?
`
}

function buildTestInstructions(opts: Required<ScaffoldOpts>): string {
  return `---
applyTo: "${opts.tests.glob ?? "**/*.{test,spec}.*"}"
---
# Test conventions

Framework: ${opts.tests.framework ?? "<!-- TODO: identify the test framework. -->"}
Directory: ${opts.tests.directory ?? "<!-- TODO: identify test directories. -->"}
Command: ${commandOrTodo(opts.commands.test, "record test command")}

- Keep tests deterministic, isolated, and independent.
- Prefer focused assertions over broad snapshots.
- Add or strengthen tests for every behavior change and bug fix.
- Do not skip, delete, or relax tests to make a branch green.
- Record new testing gotchas in \`LEARNINGS.md\` or \`docs/history/\`.
`
}

function buildCopilotSetupWorkflow(opts: Required<ScaffoldOpts>): string {
  const setupSteps = setupStepsFor(opts)
  return `on:
  workflow_dispatch: {}
jobs:
  ${COPILOT_SETUP_JOB_NAME}:
    runs-on: ${preferredRunner(opts)}
    timeout-minutes: ${Math.min(COPILOT_SETUP_TIMEOUT_MINUTES, COPILOT_SETUP_TIMEOUT_MAX)}
    permissions:
      contents: read
    steps:
${setupSteps}
`
}

function buildCiWorkflow(opts: Required<ScaffoldOpts>): string {
  const osList = opts.ci.matrix.length > 0 ? opts.ci.matrix : [...DEFAULT_CI_MATRIX]
  const commands = [opts.commands.build, opts.commands.typecheck, opts.commands.lint, opts.commands.test]
    .filter((command): command is string => command !== undefined && command.trim() !== "")
  const runLines = commands.length > 0
    ? commands.map((command) => `          ${command}`).join("\n")
    : "          echo \"TODO: add build/typecheck/lint/test commands\""
  const matrixOs = "${{ matrix.os }}"

  return `name: CI

on:
  pull_request:
  push:
    branches: [${opts.defaultBranch.startsWith("<!--") ? "main" : opts.defaultBranch}]

jobs:
  quality-gate:
    name: quality-gate (${matrixOs})
    runs-on: ${matrixOs}
    strategy:
      fail-fast: false
      matrix:
        os: [${osList.join(", ")}]
    steps:
      - uses: actions/checkout@v4
${setupStepsFor(opts)}
      - name: Run repository quality gate
        run: |
${runLines}
`
}

function setupStepsFor(opts: Required<ScaffoldOpts>): string {
  const pm = opts.packageManager
  if (pm === "bun") {
    return `      - uses: oven-sh/setup-bun@v2
      - name: Install dependencies
        run: bun install --frozen-lockfile`
  }
  if (pm === "pnpm") {
    return `      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm
      - uses: pnpm/action-setup@v4
        with:
          run_install: false
      - name: Install dependencies
        run: pnpm install --frozen-lockfile`
  }
  if (pm === "yarn") {
    return `      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: yarn
      - name: Install dependencies
        run: yarn install --immutable`
  }
  if (pm === "npm") {
    return `      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - name: Install dependencies
        run: npm ci`
  }
  if (opts.techStack.toLowerCase().includes("go")) {
    return `      - uses: actions/setup-go@v5
        with:
          go-version-file: go.mod`
  }
  if (opts.techStack.toLowerCase().includes("rust")) {
    return `      - name: Set up Rust
        run: rustup show`
  }
  if (opts.techStack.toLowerCase().includes("python")) {
    return `      - uses: actions/setup-python@v5
        with:
          python-version: "3.x"
      - name: Install dependencies
        run: |
          python -m pip install --upgrade pip
          if [ -f requirements.txt ]; then pip install -r requirements.txt; fi`
  }
  return `      - name: Set up environment
        run: echo "TODO: add language/runtime setup"`
}

function preferredRunner(opts: Required<ScaffoldOpts>): string {
  const primary = opts.ci.primaryOs?.toLowerCase() ?? ""
  if (primary.includes("windows")) return "windows-latest"
  if (primary.includes("mac")) return "macos-latest"
  return "ubuntu-latest"
}

function buildPullRequestTemplate(opts: Required<ScaffoldOpts>): string {
  return `## Summary

Describe the change and why it matters.

## Type of change

- [ ] Feature
- [ ] Bug fix
- [ ] Documentation
- [ ] Test / CI
- [ ] Refactor / maintenance
- [ ] Security

## Acceptance criteria

- [ ] Criteria are listed or linked
- [ ] Each criterion is verified by test, command output, screenshot, or review evidence

## Failure modes considered and tested

List the realistic failure modes you considered, how you tested each one, and any remaining risk.

| Failure mode | Evidence / command / test | Result |
| --- | --- | --- |
| <!-- TODO: add failure mode --> | <!-- TODO: add evidence --> | <!-- TODO: pass/fail --> |

## Definition of Done checklist

- [ ] Build passes: ${commandOrTodo(opts.commands.build, "record build command")}
- [ ] Typecheck passes: ${commandOrTodo(opts.commands.typecheck, "record typecheck command")}
- [ ] Lint passes: ${commandOrTodo(opts.commands.lint, "record lint command")}
- [ ] Tests pass: ${commandOrTodo(opts.commands.test, "record test command")}
- [ ] Tests were added or strengthened, or a justification is included
- [ ] Documentation / ADR / changelog / history / learnings updated as applicable
- [ ] CI green on required matrix
- [ ] No generated-authorship attribution in commits, PR text, docs, or code comments

## UI evidence

${opts.uiEvidenceRequired ? "Attach before/after screenshots or recordings for every user-visible surface changed." : "If user-visible behavior changed, attach before/after screenshots, recordings, or CLI output."}

## Notes / follow-ups

List deployment notes, risks, and intentionally deferred work.
`
}

function buildAdrTemplate(): string {
  return `# ADR-0000: [Title]

## Status

Proposed | Accepted | Deprecated | Superseded

## Date

YYYY-MM-DD

## Context

Describe the forces at play: technical, product, operational, social, and project-specific. What issue motivates this decision? What constraints exist?

## Decision

State the architecture decision clearly. Use full sentences and active voice. Explain what we are doing and why.

## Consequences

### Positive

- What becomes easier or possible?

### Negative

- What becomes harder or what trade-offs are introduced?

### Neutral

- What else changes?

## Notes

Link related issues, PRs, plans, research, or ADRs.
`
}

function buildAdrIndex(opts: Required<ScaffoldOpts>): string {
  return `# 0001. Record architecture decisions

## Status

Accepted

## Context

${opts.repoName} needs durable decision records so future contributors can understand why architectural and process choices were made instead of rediscovering them from code or chat history.

## Decision

Record significant architecture and long-lived process decisions as ADRs under \`docs/adr/\` or the repository's established ADR directory. Use the Nygard-style template at \`docs/adrs/0000-template.md\` when creating new records.

## Consequences

### Positive

- Decisions become reviewable, linkable, and durable.
- New agents and contributors can check prior constraints before proposing changes.

### Negative

- Meaningful decisions require a small documentation step in the same PR.

### Neutral

- Small implementation details do not need ADRs; reserve records for decisions with lasting consequences.
`
}

function buildHistoryTemplate(): string {
  return `# YYYY-MM-DD — Short title

## Summary

What happened, what changed, and why this entry exists.

## Impact

Who or what was affected?

## Root cause / decision path

What caused the issue or led to the decision?

## Fix / outcome

What was done, and how was it verified?

## Follow-ups

- [ ] <!-- TODO: add follow-up or write "none" -->

## Links

- PR:
- Issue:
- ADR / plan / research:
`
}

function buildDatedEntryReadme(title: "Plans" | "Research"): string {
  const lower = title.toLowerCase()
  return `# ${title}

Use one Markdown file per entry with the naming convention:

` + "`YYYY-MM-DD-slug.md`" + `

Examples:

- ` + "`2026-01-31-add-search-index.md`" + `
- ` + "`2026-01-31-evaluate-cache-options.md`" + `

Each ${lower} entry should include:

- date and owner
- short context
- decision, plan, or findings
- acceptance criteria or research question
- verification evidence or citations
- links to related issues, PRs, ADRs, and follow-ups
`
}

function buildLearnings(opts: Required<ScaffoldOpts>): string {
  return `# Learnings

Record durable project learnings here so future work can avoid rediscovering them.

## Current repo facts

- Repo: ${opts.repoName}
- Stack: ${opts.techStack}
- Test command: ${commandOrTodo(opts.commands.test, "record test command")}
- Primary OS: ${opts.ci.primaryOs ?? "<!-- TODO: choose primary OS -->"}

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

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/), and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html) when versioned releases are published.

## [Unreleased]

### Added

### Changed

### Deprecated

### Removed

### Fixed

### Security
`
}

function capitalize(value: string): string {
  return `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`
}
