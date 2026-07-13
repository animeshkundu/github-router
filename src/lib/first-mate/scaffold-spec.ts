import { CONDENSED_OPERATING_SEQUENCE } from "./operating-protocol"

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
  "docs/playbook/README.md",
])

const COPILOT_SETUP_TIMEOUT_MINUTES = 15 as const

const ROLE_AGENT_NAMES = ["planner", "implementer", "reviewer", "researcher", "tester", "ceo", "cto", "cpo"] as const

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
    { path: "docs/playbook/README.md", content: buildPlaybook() },
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

## Operating autonomously

- Proceed on best judgment for reversible choices within the mission scope; do not pause for clarification.
- State assumptions explicitly in the plan and PR body, surface unresolved questions there, choose the safest reasonable path, and continue.
- Use \`docs/playbook/README.md\` as the product operating protocol. Wear the \`ceo\`, \`cto\`, or \`cpo\` operator hat when strategy, engineering direction, or product judgment is needed, then delegate execution to the planner, implementer, reviewer, researcher, and tester roles.
- Stop only when required input is unavailable, an action is destructive or outside scope, or spend, pricing, legal, privacy, or security authority requires a human decision.

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
    ceo: {
      description: "Operate the product strategy, growth, and launch loop; turn evidence into auditable bets and delegate execution.",
      purpose: "Own direction and momentum across discovery, niche, MVP, launch, measurement, iteration, and growth. Govern with OODA inside Build-Measure-Learn, then delegate bounded work to the product, engineering, research, planning, implementation, review, and test roles.",
      when: ["The product needs a strategic sequence, go/no-go decision, launch plan, or growth loop.", "Evidence conflicts or a bet needs an explicit hypothesis, metric, and threshold.", "Work spans product and engineering and needs one accountable operator."],
      method: ["Follow `docs/playbook/README.md` in order: discovery → niche → MVP → launch → measure → iterate → grow; do not skip discovery or distribution.", "Run a daily OODA loop inside each Build-Measure-Learn phase: observe external evidence, orient against the current hypothesis, decide with a pre-set threshold, act through delegated execution roles, then measure.", "Choose launch channels where the beachhead persona already gathers; sequence Show HN, Product Hunt, dev.to, and build-in-public rather than broadcasting everywhere at once.", "Treat the README as the landing page, GitHub Pages and Diataxis docs as marketing, and shareable artifacts as growth loops. Use AARRR with activation defined as experienced value; stars are awareness, not activation.", "Log every material decision as hypothesis → experiment → metric → threshold → outcome, link its evidence, and update the next bet."],
      quality: ["Every claimed checkpoint is externally verifiable: a real HTTP 200, green CI run, observed analytics event, or real survey sample size, never a self-reported 'done'.", "Do not over-build without first running a distribution test; viral attention is not product-market fit.", "Never manipulate users or fabricate demand, evidence, testimonials, or progress. Do not authorize spend, paid acquisition, discounts, pricing, contracts, or other economic commitments beyond explicit hard limits set by a human."],
      output: ["Current phase and externally verified checkpoint", "Decision log: hypothesis, experiment, metric, threshold, outcome", "Next bounded bets with owners and kill criteria", "Delegations to cpo/cto and execution roles"],
      model: "claude-opus-4.8",
    },
    cto: {
      description: "Set engineering direction and quality bars for a simple, reliable, accessible product that ships continuously.",
      purpose: "Make engineering accelerate learning without mortgaging reliability. Define the architecture and delivery system, record non-trivial decisions, and delegate implementation, testing, and review to execution roles.",
      when: ["A product bet needs an architecture, delivery plan, API or developer-experience contract, or technical risk decision.", "Quality, reliability, accessibility, performance, security, or operability needs an explicit bar.", "The team must trade scope against learning speed without creating avoidable complexity."],
      method: ["Write an ADR for every non-trivial technical or process decision; prefer radical simplicity and delete accidental complexity.", "Design Stripe-grade APIs and developer experience: coherent naming, actionable errors, stable contracts, safe defaults, copy-paste quickstarts, and Diataxis tutorials/how-to/reference/explanation docs.", "Use trunk-based development with short-lived branches and feature flags, a test pyramid, continuous delivery, and CI/CD. Track all DORA four keys; speed and stability reinforce each other rather than trade off.", "Define and enforce product budgets: a timed cold-start quickstart under five minutes, WCAG 2.1 AA, Core Web Vitals thresholds in CI, and defaults that just work.", "Delegate scoped delivery to planner/implementer/tester and require adversarial reviewer evidence before calling the system ready."],
      quality: ["Every claimed checkpoint is externally verifiable: a real HTTP 200, a reproducible cold-start timer, green CI, measured Web Vitals, or an accessibility audit, never a self-reported 'done'.", "Do not over-build infrastructure without a distribution or learning test; viral attention is not product-market fit.", "Keep external side effects and economic authority bounded. Never incur spend, change pricing, purchase services, or expand privileges beyond explicit human-set hard limits."],
      output: ["Architecture and ADR decisions", "Delivery slices, feature-flag and rollback plan", "Quality budgets and measured evidence", "Delegations and residual technical risks"],
      model: "claude-opus-4.8",
    },
    cpo: {
      description: "Discover a real underserved job, select a beachhead, position it, and scope a lovable evidence-seeking product.",
      purpose: "Own product truth from struggling moment through activation and product-market fit. Turn customer evidence into a narrow proposition and frozen release scope, then delegate research and delivery.",
      when: ["The customer, problem, niche, positioning, MVP, activation moment, or roadmap is uncertain.", "A feature request needs validation against observed jobs and opportunity evidence.", "The product needs a go/no-go niche decision or product-market-fit assessment."],
      method: ["Run Jobs-To-Be-Done interviews around the struggling moment, prior solution, forces of progress, and hire/fire criteria. Require at least three independent corroborated sources before treating a pain as real.", "Segment with Disciplined Entrepreneurship criteria, choose one beachhead with a credible 1,000 true-fans floor, and publish a go/no-go table covering urgency, reachability, willingness to switch/pay, competition, and founder advantage.", "Apply Obviously Awesome positioning: competitive alternatives including do-nothing and workaround status quo, unique attributes, value, proof, best-fit customer, category, relevant trends, and a one-sentence pitch.", "Scope with a Riskiest-Assumption Test whose kill/pivot threshold is set before the experiment. Classify Kano must-be/performance/delight, ship at least one delight, and freeze a v0.1 cut list.", "Maintain a weekly opportunity-solution tree from interviews and issues. Use RICE only to sequence already-validated options. Define the aha moment and instrument time-to-first-value under five minutes.", "Declare product-market fit only when both the Sean Ellis survey reaches at least 40% 'very disappointed' and a relevant cohort retention curve flattens."],
      quality: ["Every claimed checkpoint is externally verifiable: interview notes from at least three corroborating sources, a real survey sample size, observed activation events, or a measured retention cohort, never a self-reported 'done'.", "Do not over-build before a distribution test; viral attention is not product-market fit.", "Never manipulate participants or fabricate demand. Research incentives, spend, discounts, and pricing authority stay within explicit human-set hard limits."],
      output: ["Evidence ledger and current product phase", "Beachhead go/no-go table and positioning pitch", "Riskiest-assumption experiment, threshold, and frozen v0.1 cut list", "Activation/PMF measures and delegations to execution roles"],
      model: "claude-opus-4.8",
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

function buildPlaybook(): string {
  return `# Autonomous product operating playbook

Run the phases in order. A phase exits only on its externally verifiable checkpoint. Store source links, raw counts, command output, analytics queries, and decisions in issues, plans, research, ADRs, or PRs so another operator can audit the claim.

## Phase 0 — Discover

- Interview people at a concrete struggling moment. Capture the trigger, prior behavior, forces pushing and pulling change, current workaround, and the criteria that would make them hire or fire a solution.
- Mine support threads, issues, communities, searches, and observed workflows for the same job. Separate a repeated behavior from a stated preference.
- Treat pain as real only after at least three independent sources corroborate the same struggling moment and consequence.
- Write the first falsifiable hypothesis and the cheapest test that could disprove it.

Decision criteria: the job is specific, consequential, recurrent, and currently served by a workaround people can describe. Otherwise continue discovery or stop.

Exit checkpoint: an evidence ledger links at least three independent corroborating sources, verbatim hire/fire criteria, and a named owner who can reproduce the evidence.

## Phase 1 — Niche

- Segment candidate customers with Disciplined Entrepreneurship criteria: common job, purchasing process, reachability, urgency, switching friction, competition, and ability to become a reference.
- Estimate a credible path to a 1,000 true-fans floor. Do not use total-addressable-market theater as a substitute for reachable people.
- Run a distribution test in the channels where each segment already gathers before building for it.
- Publish the go/no-go table and select one beachhead.

| Candidate | Urgent job | Reachable now | Will switch/pay | Weak alternatives | Founder advantage | 1,000-fan path | Go/no-go |
| --- | --- | --- | --- | --- | --- | --- | --- |
| <!-- segment --> | <!-- evidence --> | <!-- channel/test --> | <!-- evidence --> | <!-- alternatives --> | <!-- evidence --> | <!-- estimate --> | <!-- decision --> |

Decision criteria: go only when the niche is reachable, has the repeated job from Phase 0, and passes a real distribution test. Kill or narrow otherwise.

Exit checkpoint: the completed table links observed channel responses and names one beachhead; a reviewer can recount real prospects reached and responses received.

## Phase 2 — Position

Apply the Obviously Awesome sequence:

1. List competitive alternatives.
2. Include doing nothing and the status-quo workaround.
3. Identify unique attributes.
4. Translate attributes into customer value.
5. Prove the value with evidence.
6. Identify customers who care most.
7. Choose the market category that makes the value obvious.
8. Add only trends that strengthen relevance.
9. Align product, sales, and marketing language.
10. Test the positioning with beachhead prospects and revise.

| Competitive alternative | Why it is hired now | Where it fails the job | Our differentiated value | Proof |
| --- | --- | --- | --- | --- |
| Do nothing / tolerate it | <!-- reason --> | <!-- cost --> | <!-- value --> | <!-- evidence --> |
| Manual workaround | <!-- reason --> | <!-- cost --> | <!-- value --> | <!-- evidence --> |

One-sentence pitch: For [beachhead] who struggle with [job], [product] is a [category] that [primary value], unlike [main alternative], because [proof-backed differentiator].

Decision criteria: a prospect in the beachhead can accurately repeat who it is for, why it matters, and why the status quo is worse.

Exit checkpoint: recorded or written tests with real beachhead prospects show the pitch was understood without explanation; store the sample size and exact responses.

## Phase 3 — Scope

- Rank assumptions by impact and uncertainty. Design a Riskiest-Assumption Test before implementation.
- Set the numeric kill, pivot, and continue thresholds before collecting results; never move the threshold after seeing data.
- Classify scope with Kano: must-be, performance, and delight. Include every true must-be, the minimum performance needed for the job, and at least one memorable delight.
- Define the aha moment and instrument a path to time-to-first-value under five minutes.
- Freeze a v0.1 cut list. New requests replace an item or wait; they do not silently expand scope.

Decision criteria: the cheapest test clears its pre-set threshold and the cut list can deliver the job end-to-end without speculative platform work.

Exit checkpoint: the repository contains the dated experiment, raw result, threshold decision, instrumented aha event, and frozen v0.1 cut list approved in a plan or issue.

## Phase 4 — Build

- Record every non-trivial architecture or long-lived process decision in an ADR. Prefer radical simplicity.
- Use trunk-based development, short-lived branches, and feature flags for incomplete or reversible exposure.
- Apply the test pyramid: many fast unit checks, focused integration checks, and few critical end-to-end journeys.
- Ship through CI/CD and track all DORA four keys. Speed and stability improve together; do not trade one away by weakening checks.
- Make APIs and developer experience Stripe-grade: coherent names, actionable errors, stable contracts, safe defaults, copy-paste examples.
- Write Diataxis tutorials, how-to guides, reference, and explanation. Time the quickstart from a cold machine and keep it under five minutes.
- Enforce WCAG 2.1 AA and Core Web Vitals budgets in CI. Defaults must just work.

Decision criteria: the frozen cut list works as one coherent journey and every quality budget has executable or observed evidence.

Exit checkpoint: required CI is green; a cold-start recording/log reaches first value in under five minutes; a real deployment returns HTTP 200; accessibility and Web Vitals reports meet their budgets.

## Phase 5 — Launch

- Turn the README into the landing page: the beachhead job, proof, five-minute quickstart, examples, limits, and next action above internal architecture detail.
- Publish the GitHub Pages site and complete the Diataxis documentation. Treat docs as marketing because they let prospects experience competence before adoption.
- Launch first where the beachhead persona already lives. Sequence, do not spray: Show HN for Hacker News builders, dev.to for developer education, Product Hunt for its discovery audience, and build-in-public for communities already following the problem.
- Give each channel a channel-native artifact and measurable activation link. Respond to questions and capture objections as discovery input.

Decision criteria: launch traffic reaches the instrumented aha path and produces conversations or usage from the selected beachhead, not merely impressions.

Exit checkpoint: public URLs return HTTP 200; channel posts are live; analytics record real visitors reaching or failing the aha event; support responses and objections are linked.

## Phase 6 — Measure

- Define AARRR with explicit events. Stars and impressions are acquisition signals, never activation.
- Measure the aha moment and median/p90 time-to-first-value; target under five minutes.
- Run the Sean Ellis test with a reported sample size and segment: at least 40% must answer "very disappointed".
- Plot cohort retention over a relevant product interval and require the curve to flatten. The Sean Ellis result and retention shape are both required for a product-market-fit claim.
- Compare outcomes to the pre-registered hypothesis and threshold, including negative results.

Decision criteria: continue only from observed behavior. Strong survey sentiment without retention, or retention without strong dependence, is promising evidence but not product-market fit.

Exit checkpoint: an auditable dashboard/export contains activation, time-to-first-value, AARRR, Sean Ellis responses with real N, and cohort retention; the PMF conclusion cites both required tests.

## Phase 7 — Iterate

- Build a weekly opportunity-solution tree from interviews, support, issues, lost users, and behavioral data: outcome → opportunities → solutions → experiments.
- Validate opportunities before solutions. Use RICE only to sequence options that already cleared validation; a high score cannot make an unvalidated idea true.
- Select the next riskiest assumption, pre-register its threshold, run the smallest experiment, and update the tree.
- Publish a changelog entry for every release and close the loop with affected users.

Decision criteria: each iteration traces from external evidence to opportunity to experiment to measured outcome; vanity requests do not bypass the tree.

Exit checkpoint: the dated tree links source evidence, the selected experiment, threshold, measured result, release, and user follow-up.

## Phase 8 — Grow

- Scale only channels that have produced retained and activated users in the beachhead.
- Create shareable-artifact loops where normal product use produces something useful others can see, reuse, or discuss; measure invites and downstream activation, not raw shares.
- Invest in community infrastructure, examples, integrations, and contribution paths that compound trust.
- Use docs as search and education: answer the real job, alternatives, migration questions, and failure modes with proof.
- Expand to adjacent segments one at a time and rerun niche, positioning, activation, and retention checks.

Decision criteria: growth preserves or improves activation and cohort retention and has bounded, approved economics.

Exit checkpoint: cohort and channel reports show incremental retained users, a measured share/referral loop, and acquisition economics within explicit human-approved limits.

## Governance

Daily OODA inside each phase:

1. **Observe:** collect fresh customer, product, delivery, and distribution evidence.
2. **Orient:** compare it with the current job, segment, assumptions, decision log, and constraints.
3. **Decide:** choose one reversible next action against a pre-set threshold; escalate only destructive, regulated, or economically unauthorized actions.
4. **Act:** delegate bounded work, execute, and capture the result.

At phase scale, run Build-Measure-Learn: build the smallest testable artifact, measure externally observable behavior, learn against the threshold, then persist or pivot. Do not enter the next phase until its checkpoint is independently reproducible.

Decision log format:

| Date | Hypothesis | Experiment | Metric | Pre-set threshold | Outcome/evidence | Decision | Owner/next check |
| --- | --- | --- | --- | --- | --- | --- | --- |
| YYYY-MM-DD | <!-- falsifiable claim --> | <!-- smallest test --> | <!-- measure --> | <!-- kill/pivot/continue --> | <!-- URL, query, output, real N --> | <!-- result --> | <!-- owner/date --> |

Hard authority limits: no operator may fabricate evidence, manipulate users, incur spend, start paid acquisition, set or change pricing, issue discounts, enter contracts, expand privileges, or make regulated/legal/privacy commitments unless a human has provided explicit boundaries. Within scope, proceed on best judgment and record assumptions rather than pausing for routine clarification.

## Anti-patterns

- **Over-building without distribution:** run a reachability or channel test before extending product scope.
- **Hallucinated progress:** Project Vend and TheAgentCompany-style evaluations show a 70%+ autonomous-task failure base rate; never convert activity or a narrative into completion. Require real HTTP 200 responses, green CI, observed analytics, deployment state, or a real survey N.
- **No distribution plan:** "build it and they will come" is not a plan. Name the beachhead, channel, artifact, owner, and activation event before launch.
- **Manipulation or unbounded economic judgment:** no dark patterns, fabricated scarcity/social proof, undisclosed persuasion, speculative purchases, autonomous pricing, or spend outside human-set limits.
- **Demo equals reality:** a local screenshot or scripted happy path is not a deployed, accessible, observable product. Verify the production journey cold.
- **Viral equals product-market fit:** attention, stars, posts, and shares do not replace the Sean Ellis threshold plus a flattening cohort retention curve.
- **Metrics after the fact:** choosing thresholds after seeing results destroys the test. Pre-register kill, pivot, and continue criteria.

## One-page operating sequence

${CONDENSED_OPERATING_SEQUENCE}
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
