import { CONDENSED_OPERATING_SEQUENCE, DEFINITION_OF_GREATNESS } from "./operating-protocol"

export const COPILOT_SETUP_JOB_NAME = "copilot-setup-steps" as const
export const COPILOT_SETUP_PATH = ".github/workflows/copilot-setup-steps.yml" as const
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

export type ScaffoldFinalDestination = "github-pages" | "npm" | "pypi" | "crates" | "ghcr" | "go-proxy" | "actions-marketplace" | "vscode-marketplace" | "unknown"

export interface ScaffoldOpts {
  repoName: string
  repoDescription?: string
  defaultBranch?: string
  techStack?: string
  packageManager?: string
  finalDestination?: ScaffoldFinalDestination
  hasSite?: boolean
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
  "SECURITY.md",
  ".github/CONTRIBUTING.md",
  "CODE_OF_CONDUCT.md",
  "SUPPORT.md",
  "GOVERNANCE.md",
  "ADOPTERS.md",
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
    { path: COPILOT_SETUP_PATH, content: buildCopilotSetupWorkflow(normalized) },
    { path: ".github/workflows/ci.yml", content: buildCiWorkflow(normalized) },
    ...(normalized.hasSite ? [
      { path: ".github/workflows/pages.yml", content: buildPagesWorkflow(normalized) },
      { path: "public/robots.txt", content: buildRobotsTxt() },
      { path: "public/sitemap.xml", content: buildSitemap() },
      { path: "public/seo-head.html", content: buildSeoHead() },
      { path: "public/404.html", content: buildNotFoundPage() },
      { path: "public/.well-known/security.txt", content: buildSecurityTxt() },
    ] : []),
    { path: ".github/workflows/codeql.yml", content: buildCodeqlWorkflow(normalized) },
    { path: ".github/dependabot.yml", content: buildDependabot(normalized) },
    { path: ".github/workflows/release.yml", content: buildReleaseWorkflow(normalized) },
    { path: ".github/workflows/publish.yml", content: buildPublishWorkflow(normalized) },
    { path: ".github/workflows/media.yml", content: buildMediaWorkflow(normalized) },
    { path: ".github/workflows/maintainability.yml", content: buildMaintainabilityWorkflow(normalized) },
    { path: ".github/pull_request_template.md", content: buildPullRequestTemplate(normalized) },
    { path: ".github/ISSUE_TEMPLATE/config.yml", content: buildIssueTemplateConfig() },
    { path: "SECURITY.md", content: buildSecurityPolicy(normalized) },
    { path: ".github/CONTRIBUTING.md", content: buildContributing(normalized) },
    { path: "CODE_OF_CONDUCT.md", content: buildCodeOfConduct() },
    { path: "SUPPORT.md", content: buildSupport() },
    { path: ".github/CODEOWNERS", content: buildCodeowners() },
    { path: "GOVERNANCE.md", content: buildGovernance() },
    { path: ".github/FUNDING.yml", content: buildFunding() },
    { path: "ADOPTERS.md", content: buildAdopters() },
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

    // Self-heal a known-inert copilot-setup-steps.yml even in add-missing-only /
    // enhance mode. An environment file with no real dependency install leaves the
    // cloud agent's container without deps, so it can't build/lint/test and returns
    // an EMPTY draft PR — the #1 cause of unproductive coding-agent runs. Such a
    // stub must never be preserved. Narrow by design (see copilotSetupIsInert): a
    // user's real custom setup is not matched.
    if (file.path === COPILOT_SETUP_PATH && copilotSetupIsInert(existingByPath.get(file.path) ?? "")) {
      filesToCommit.push(file)
      reports.push({ path: file.path, status: "overwritten" })
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

/**
 * True when an existing `copilot-setup-steps.yml` is one of OUR inert stubs — a
 * bare "echo" environment step with NO dependency install. Such a file leaves the
 * Copilot cloud agent's container without dependencies, so it cannot build / lint /
 * test and returns an empty draft PR (the #1 real-world cause of empty coding-agent
 * PRs). Narrow by design: a real custom setup (any recognized install command) is
 * NOT matched, so a user's hand-tuned environment is never clobbered.
 */
export function copilotSetupIsInert(content: string): boolean {
  if (content.trim().length === 0) return false
  const INSTALL_TOKENS = [
    "npm ci",
    "npm install",
    "pnpm install",
    "yarn install",
    "bun install",
    "go mod download",
    "cargo fetch",
    "pip install",
    "Detect toolchain and install",
  ]
  if (INSTALL_TOKENS.some((token) => content.includes(token))) return false
  // No recognized install AND the shape is our echo-only "Set up environment" stub.
  return /run:\s*echo\b/.test(content) || content.includes("Set up environment")
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
    finalDestination: opts.finalDestination ?? "unknown",
    hasSite: opts.hasSite ?? false,
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
    ? "- UI-impacting changes include before/after screenshots of the RENDERED result (product UI, and the README / Pages / docs as they render) at real viewports (mobile + desktop), light + dark — driven in a browser, never guessed from code."
    : "- If a change affects user-visible UI or CLI output, include before/after evidence in the PR — for UI, a screenshot of the rendered result at real viewports, not a code diff."
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
      method: ["Write an ADR for every non-trivial technical or process decision; prefer radical simplicity and delete accidental complexity.", "Design Stripe-grade APIs and developer experience: coherent naming, actionable errors, stable contracts, safe defaults, copy-paste quickstarts, and Diataxis tutorials/how-to/reference/explanation docs.", "Use trunk-based development with short-lived branches and feature flags, a test pyramid, continuous delivery, and CI/CD. Track all DORA four keys; speed and stability reinforce each other rather than trade off.", "Define and enforce product budgets: a timed cold-start quickstart under five minutes, WCAG 2.2 AA, Core Web Vitals thresholds in CI, and defaults that just work.", "Delegate scoped delivery to planner/implementer/tester and require adversarial reviewer evidence before calling the system ready."],
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
    branches: [${opts.defaultBranch.startsWith("<!--") ? "main # TODO: confirm the default branch" : opts.defaultBranch}]

permissions:
  contents: read

jobs:
  quality-gate:
    name: quality-gate (${matrixOs})
    runs-on: ${matrixOs}
    strategy:
      fail-fast: false
      matrix:
        os: [${osList.join(", ")}]
    steps:
      - uses: actions/checkout@${CHECKOUT_SHA} # v4
${setupStepsFor(opts)}
      - name: Run repository quality gate
        run: |
${runLines}
`
}

function setupStepsFor(opts: Required<ScaffoldOpts>): string {
  const pm = opts.packageManager
  if (pm === "bun") {
    return `      - uses: oven-sh/setup-bun@735343b667d3e6f658f44d0eca948eb6282f2b76 # v2
      - name: Install dependencies
        run: bun install --frozen-lockfile`
  }
  if (pm === "pnpm") {
    return `      - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4
        with:
          node-version: 22
          cache: pnpm
      - uses: pnpm/action-setup@7d2c2a2c7a1fb2f07e4646f7b4602195e3d0c57e # v4
        with:
          run_install: false
      - name: Install dependencies
        run: pnpm install --frozen-lockfile`
  }
  if (pm === "yarn") {
    return `      - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4
        with:
          node-version: 22
          cache: yarn
      - name: Install dependencies
        run: yarn install --immutable`
  }
  if (pm === "npm") {
    return `      - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4
        with:
          node-version: 22
          cache: npm
      - name: Install dependencies
        run: npm ci`
  }
  if (opts.techStack.toLowerCase().includes("go")) {
    return `      - uses: actions/setup-go@0a12ed9d6a96ab950c8f026ed9f722fe0da7ef32 # v5
        with:
          go-version-file: go.mod
      - name: Download modules
        run: go mod download`
  }
  if (opts.techStack.toLowerCase().includes("rust")) {
    return `      - name: Set up Rust
        run: rustup show
      - name: Fetch dependencies
        run: cargo fetch`
  }
  if (opts.techStack.toLowerCase().includes("python")) {
    return `      - uses: actions/setup-python@42375524e23c412d93fb67b49958b491fce71c38 # v5
        with:
          python-version: "3.x"
      - name: Install dependencies
        run: |
          python -m pip install --upgrade pip
          if [ -f requirements.txt ]; then pip install -r requirements.txt; fi
          if [ -f pyproject.toml ]; then pip install -e . || pip install .; fi`
  }
  // Fallback: our static stack detection did not match a known ecosystem. NEVER
  // emit an inert no-op here — a Copilot cloud agent whose environment has no
  // installed dependencies cannot build/lint/test, so it commits nothing and the
  // task returns an EMPTY draft (the #1 real-world cause of empty coding-agent
  // PRs). Instead, detect the dependency manifest at runtime and install for real,
  // failing LOUDLY (never silently) when nothing is recognized.
  return `      - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4
        with:
          node-version: 22
      - name: Detect toolchain and install dependencies
        shell: bash
        run: |
          set -euo pipefail
          if [ -f bun.lockb ] || [ -f bun.lock ]; then
            npm install -g bun && bun install --frozen-lockfile
          elif [ -f pnpm-lock.yaml ]; then
            corepack enable && pnpm install --frozen-lockfile
          elif [ -f yarn.lock ]; then
            corepack enable && yarn install --immutable
          elif [ -f package-lock.json ]; then
            npm ci
          elif [ -f package.json ]; then
            npm install
          elif [ -f go.mod ]; then
            go mod download
          elif [ -f Cargo.toml ]; then
            cargo fetch
          elif [ -f requirements.txt ]; then
            python -m pip install --upgrade pip && pip install -r requirements.txt
          elif [ -f pyproject.toml ]; then
            python -m pip install --upgrade pip && { pip install -e . || pip install .; }
          else
            echo "::warning::copilot-setup-steps found no recognized dependency manifest; the agent environment may be missing dependencies. Add a real install step for this repo's stack."
          fi`
}

const CHECKOUT_SHA = "11bd71901bbe5b1630ceea73d27597364c9af683"
const CONFIGURE_PAGES_SHA = "983d7736d9b0ae728b81ab479565c72886d7745b"
const UPLOAD_PAGES_SHA = "56afc609e74202658d3ffba0e8f6dda462b719fa"
const DEPLOY_PAGES_SHA = "decdde0ac072f6f71b3a7fa0b3c73a7a62cc8a28"
const UPLOAD_ARTIFACT_SHA = "65462800fd760344b1a7b4382951275a0abb4808"

function buildPagesWorkflow(opts: Required<ScaffoldOpts>): string {
  const branch = opts.defaultBranch.startsWith("<!--") ? "main # TODO: confirm the default branch" : opts.defaultBranch
  return `name: Pages

on:
  push:
    branches: [${branch}]
  workflow_dispatch:

permissions:
  contents: read

concurrency:
  group: pages
  cancel-in-progress: false

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@${CHECKOUT_SHA} # v4
      - uses: actions/configure-pages@${CONFIGURE_PAGES_SHA} # v5
      - name: Build site and stamp deployed revision
        run: |
          ${opts.commands.build ?? "echo \"TODO: build the site into _site\""}
          mkdir -p _site
          printf '%s\\n' "\${{ github.sha }}" > _site/BUILD_SHA.txt
      - uses: actions/upload-pages-artifact@${UPLOAD_PAGES_SHA} # v3
        with:
          path: _site
  deploy:
    needs: build
    runs-on: ubuntu-latest
    environment:
      name: github-pages
      url: \${{ steps.deployment.outputs.page_url }}
    permissions:
      pages: write
      id-token: write
    steps:
      - name: Deploy Pages
        id: deployment
        uses: actions/deploy-pages@${DEPLOY_PAGES_SHA} # v4
`
}

function codeqlLanguages(opts: Required<ScaffoldOpts>): string {
  const stack = opts.techStack.toLowerCase()
  const languages: string[] = []
  if (/javascript|typescript|node|react|vue|svelte/.test(stack)) languages.push("javascript-typescript")
  if (stack.includes("python")) languages.push("python")
  if (stack.includes("go")) languages.push("go")
  if (/rust|cargo/.test(stack)) languages.push("rust")
  return languages.length > 0 ? languages.join(", ") : "javascript-typescript # TODO: confirm CodeQL language"
}

function buildCodeqlWorkflow(opts: Required<ScaffoldOpts>): string {
  return `name: CodeQL

on:
  push:
    branches: [${opts.defaultBranch.startsWith("<!--") ? "main # TODO: confirm the default branch" : opts.defaultBranch}]
  pull_request:
  schedule:
    - cron: "17 3 * * 1"

permissions:
  contents: read

jobs:
  analyze:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      security-events: write
    strategy:
      matrix:
        language: [${codeqlLanguages(opts)}]
    steps:
      - uses: actions/checkout@${CHECKOUT_SHA} # v4
      - uses: github/codeql-action/init@b374143c1149a9115d881581d29b8390bbcbb59c # v3
        with:
          languages: \${{ matrix.language }}
      - uses: github/codeql-action/autobuild@b374143c1149a9115d881581d29b8390bbcbb59c # v3
      - uses: github/codeql-action/analyze@b374143c1149a9115d881581d29b8390bbcbb59c # v3
`
}

function dependabotEcosystem(opts: Required<ScaffoldOpts>): string {
  if (["npm", "bun", "pnpm", "yarn"].includes(opts.packageManager)) return "npm"
  if (opts.finalDestination === "pypi") return "pip"
  if (opts.finalDestination === "crates") return "cargo"
  if (opts.finalDestination === "go-proxy") return "gomod"
  if (opts.finalDestination === "ghcr") return "docker"
  return "<!-- TODO: choose a supported package ecosystem -->"
}

function buildDependabot(opts: Required<ScaffoldOpts>): string {
  return `version: 2
updates:
  - package-ecosystem: "${dependabotEcosystem(opts)}"
    directory: "/"
    schedule:
      interval: weekly
  - package-ecosystem: github-actions
    directory: "/"
    schedule:
      interval: weekly
`
}

function releaseType(opts: Required<ScaffoldOpts>): string {
  if (opts.finalDestination === "pypi") return "python"
  if (opts.finalDestination === "crates") return "rust"
  if (opts.finalDestination === "go-proxy") return "go"
  if (opts.finalDestination === "npm" || opts.finalDestination === "vscode-marketplace" || opts.finalDestination === "actions-marketplace") return "node"
  return "simple"
}

function buildReleaseWorkflow(opts: Required<ScaffoldOpts>): string {
  return `name: Release

on:
  push:
    branches: [${opts.defaultBranch.startsWith("<!--") ? "main # TODO: confirm the default branch" : opts.defaultBranch}]

permissions:
  contents: read

jobs:
  release-please:
    runs-on: ubuntu-latest
    permissions:
      contents: write
      pull-requests: write
    steps:
      - uses: googleapis/release-please-action@a02a34c4d625f9be7cb89156071d8567266a2445 # v4
        with:
          release-type: ${releaseType(opts)}
# This workflow creates the tag, changelog, and GitHub Release. Publishing is
# deliberately separate in publish.yml and starts only on release: published.
`
}

function apiCompatibilitySteps(opts: Required<ScaffoldOpts>): string {
  if (opts.finalDestination === "crates") {
    return `      - name: Check Rust API compatibility
        run: |
          cargo install cargo-semver-checks --locked
          cargo semver-checks check-release`
  }
  if (opts.finalDestination === "npm" || opts.finalDestination === "vscode-marketplace" || opts.finalDestination === "actions-marketplace") {
    return `      - name: Check TypeScript API compatibility
        if: \${{ hashFiles('api-extractor.json') != '' }}
        run: npx --no-install api-extractor run --local
      - name: API compatibility wiring reminder
        if: \${{ hashFiles('api-extractor.json') == '' }}
        run: echo "TODO: configure @microsoft/api-extractor and commit its API report"`
  }
  return `      - name: Declare API compatibility policy
        run: echo "TODO: wire the ecosystem's breaking-change checker when this repository exposes a stable public API"`
}

function buildMaintainabilityWorkflow(opts: Required<ScaffoldOpts>): string {
  const exampleCommand = opts.commands.test ?? "echo \"TODO: execute every documented example or doctest in CI\""
  return `name: Maintainability

on:
  pull_request:
  push:
    branches: [${opts.defaultBranch.startsWith("<!--") ? "main # TODO: confirm the default branch" : opts.defaultBranch}]

permissions:
  contents: read

jobs:
  policy-gates:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@${CHECKOUT_SHA} # v4
      - name: REUSE and SPDX compliance
        run: |
          python -m pip install reuse
          reuse lint
      - name: Dependency license policy
        run: echo "TODO: wire the ecosystem-specific dependency-license scanner and approved-license policy"
${apiCompatibilitySteps(opts)}
      - name: Execute documented examples
        run: ${exampleCommand}
`
}

function buildPublishWorkflow(opts: Required<ScaffoldOpts>): string {
  const common = `name: Publish\n\non:\n  release:\n    types: [published]\n\npermissions:\n  contents: read\n\n`
  if (opts.finalDestination === "npm") return `${common}jobs:\n  npm:\n    runs-on: ubuntu-latest\n    environment: npm\n    permissions:\n      contents: read\n      id-token: write\n      attestations: write\n    steps:\n      - uses: actions/checkout@${CHECKOUT_SHA} # v4\n      - name: Set up Node for OIDC trusted publishing\n        uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4\n        with:\n          node-version: 22\n          registry-url: https://registry.npmjs.org\n      - run: npm ci\n      - run: npm pack\n      - uses: actions/attest-build-provenance@e8998f949152b193b063cb0ec769d69d929409be # v2\n        with:\n          subject-path: '*.tgz'\n      - run: npm publish --provenance --access public *.tgz\n`
  if (opts.finalDestination === "pypi") return `${common}jobs:\n  pypi:\n    runs-on: ubuntu-latest\n    environment: pypi\n    permissions:\n      contents: read\n      id-token: write\n      attestations: write\n    steps:\n      - uses: actions/checkout@${CHECKOUT_SHA} # v4\n      - run: python -m pip install --upgrade build\n      - run: python -m build\n      - uses: pypa/gh-action-pypi-publish@ed0c53931b1dc9bd32cbe73a98c7f6766f8a527e # v1.13.0\n      - uses: actions/attest-build-provenance@e8998f949152b193b063cb0ec769d69d929409be # v2\n        with:\n          subject-path: dist/*\n`
  if (opts.finalDestination === "crates") return `${common}jobs:\n  crates:\n    runs-on: ubuntu-latest\n    environment: crates-io\n    permissions:\n      contents: read\n      id-token: write\n      attestations: write\n    steps:\n      - uses: actions/checkout@${CHECKOUT_SHA} # v4\n      - id: auth\n        uses: rust-lang/crates-io-auth-action@e919bc7605cde86df457cf5b93c5e103838bd879 # v1\n      - run: cargo publish\n        env:\n          CARGO_REGISTRY_TOKEN: \${{ steps.auth.outputs.token }}\n      - uses: actions/attest-build-provenance@e8998f949152b193b063cb0ec769d69d929409be # v2\n        with:\n          subject-path: target/package/*.crate\n`
  if (opts.finalDestination === "ghcr") return `${common}jobs:\n  ghcr:\n    runs-on: ubuntu-latest\n    environment: ghcr\n    permissions:\n      contents: read\n      packages: write\n      id-token: write\n      attestations: write\n    steps:\n      - uses: actions/checkout@${CHECKOUT_SHA} # v4\n      - uses: docker/login-action@9780b0c442fbb1117ed29e0efdff1e18412f7567 # v3\n        with:\n          registry: ghcr.io\n          username: \${{ github.actor }}\n          password: \${{ github.token }}\n      - name: Build and push image\n        id: build\n        uses: docker/build-push-action@ca052bb54ab0790a636c9b5f226502c73d547a25 # v5\n        with:\n          push: true\n          tags: ghcr.io/\${{ github.repository }}:\${{ github.event.release.tag_name }}\n          provenance: true\n          sbom: true\n      - uses: sigstore/cosign-installer@4959ce089c160fddf62f7b42464195ba1a56d382 # v3\n      - name: Keyless-sign image digest\n        run: cosign sign --yes "ghcr.io/\${{ github.repository }}@\${{ steps.build.outputs.digest }}"\n      - uses: actions/attest-build-provenance@e8998f949152b193b063cb0ec769d69d929409be # v2\n        with:\n          subject-name: ghcr.io/\${{ github.repository }}\n          subject-digest: \${{ steps.build.outputs.digest }}\n          push-to-registry: true\n`
  return `${common}jobs:\n  destination-note:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo "TODO: ${opts.finalDestination === "go-proxy" ? "Go modules publish through signed SemVer tags and proxy.golang.org; no registry upload is required" : opts.finalDestination === "github-pages" ? "Pages deployment is handled by pages.yml; no package registry applies" : opts.finalDestination === "actions-marketplace" ? "complete Marketplace listing and maintain the floating major tag; no OIDC registry exists" : opts.finalDestination === "vscode-marketplace" ? "VS Code Marketplace does not support OIDC; require explicit human approval before configuring its PAT-based publish exception" : "resolve the final destination before enabling publication"}."\n`
}

function buildMediaWorkflow(opts: Required<ScaffoldOpts>): string {
  const install = opts.commands.install ?? "echo \"TODO: record the install command\""
  const HAS_PW = "${{ hashFiles('**/playwright.config.*') != '' }}"
  const NO_PW = "${{ hashFiles('**/playwright.config.*') == '' }}"
  const HAS_LHCI = "${{ hashFiles('**/lighthouserc.*', '**/.lighthouserc.*') != '' }}"
  return `name: Media evidence & UI verification

on:
  workflow_dispatch:
  # Enable on PRs once your UI/site paths are known, so visual-regression + a11y actually PROTECT
  # every user-viewable surface on each change (until then the steps below no-op green):
  # pull_request:
  #   paths: ["<!-- TODO: your UI/site source globs -->"]

permissions:
  contents: read

# Pillar D — UI/UX and every user-viewable surface are VERIFIED BY BROWSING: drive the running
# artifact in a real browser and judge the RENDERED pixels. Never infer UI quality from source,
# a passing build, or an HTTP 200. See docs/playbook/README.md Phase 4 (iterate-to-polish loop).
jobs:
  verify-ui:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@${CHECKOUT_SHA} # v4
      - name: State-matrix screenshots + visual regression (Playwright)
        if: ${HAS_PW}
        run: |
          ${install}
          npx --no-install playwright install --with-deps chromium
          # Your spec MUST drive each key screen through ALL states — empty / loading / error / success /
          # first-run / edge — at 375 / 768 / 1280 x light+dark (page.emulateMedia), and assert
          # expect(page).toHaveScreenshot() against committed baselines so any unintended pixel change fails.
          npx --no-install playwright test
      - name: Accessibility gate (axe-core, zero serious/critical)
        if: ${HAS_PW}
        run: echo "TODO: assert @axe-core/playwright inside the spec above; fail on ANY serious/critical violation on each key screen AND state; keyboard-reach + visible focus + >=24px targets (WCAG 2.2)."
      - name: Core Web Vitals + Lighthouse budgets (web surfaces)
        if: ${HAS_LHCI}
        run: npx --no-install @lhci/cli autorun
      - name: Capture launch media (screenshots, 1200x630 og-image, demo)
        run: |
          echo "TODO: capture desktop + mobile launch screenshots and a 1200x630 og-image.png from the RENDERED site."
          echo "Optional: install VHS from a checksum-pinned release and record artifacts/demo.gif."
          ${opts.commands.build ?? "true"}
      - name: Wire-up reminder (no browser verification configured yet)
        if: ${NO_PW}
        run: echo "TODO: add a Playwright config + a state-matrix spec (toHaveScreenshot + @axe-core/playwright) so UI is VERIFIED BY BROWSING, not guessed. See docs/playbook/README.md Phase 4."
      - uses: actions/upload-artifact@${UPLOAD_ARTIFACT_SHA} # v4
        with:
          name: launch-media
          path: |
            artifacts/screenshots/**
            artifacts/og-image.png
            artifacts/demo.gif
            playwright-report/**
            test-results/**
          if-no-files-found: warn
`
}

function buildRobotsTxt(): string {
  return `User-agent: *\nAllow: /\nSitemap: <!-- TODO: insert the canonical absolute sitemap URL -->\n`
}

function buildSitemap(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n  <!-- TODO: generate canonical absolute <url><loc> entries during the site build. -->\n</urlset>\n`
}

function buildSeoHead(): string {
  return `<!-- Merge these tags into the site's real <head>; replace every TODO with canonical absolute URLs. -->\n<link rel="canonical" href="<!-- TODO: canonical page URL -->">\n<meta property="og:type" content="website">\n<meta property="og:title" content="<!-- TODO: product name -->">\n<meta property="og:description" content="<!-- TODO: concise value proposition -->">\n<meta property="og:image" content="<!-- TODO: absolute 1200x630 og-image URL -->">\n<meta name="twitter:card" content="summary_large_image">\n<script type="application/ld+json">{"@context":"https://schema.org","@type":"SoftwareApplication","name":"<!-- TODO: product name -->","url":"<!-- TODO: canonical site URL -->"}</script>\n`
}

function buildNotFoundPage(): string {
  return `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="robots" content="noindex"><title>Not found</title></head><body><main><h1>Page not found</h1><p><a href="/">Return home</a></p></main></body></html>\n`
}

function buildSecurityTxt(): string {
  return `Contact: <!-- TODO: security disclosure email or HTTPS form -->\nExpires: <!-- TODO: RFC 3339 date less than one year from publication -->\nCanonical: <!-- TODO: absolute /.well-known/security.txt URL -->\nPolicy: <!-- TODO: absolute SECURITY.md or security-policy URL -->\nPreferred-Languages: en\n`
}

function buildSecurityPolicy(opts: Required<ScaffoldOpts>): string {
  return `# Security policy

## Supported versions

<!-- TODO: list supported release lines and their security-support windows. -->

## Reporting a vulnerability

Please do not open a public issue. Use GitHub Private Vulnerability Reporting for ${opts.repoName}, or contact <!-- TODO: monitored security disclosure address -->.

## Response targets

- Acknowledge a report within **2 business days**.
- Provide an initial assessment or request for more information within **7 calendar days**.
- Share remediation status at least every **14 calendar days** until closure.

These are response targets, not a promise that every report can be fixed within a fixed period. Coordinated disclosure timing will be agreed with the reporter.
`
}

function buildContributing(opts: Required<ScaffoldOpts>): string {
  return `# Contributing

## Set up

1. Read the repository guidance and relevant ADRs.
2. Install dependencies: ${commandOrTodo(opts.commands.install, "confirm install command")}
3. Run tests: ${commandOrTodo(opts.commands.test, "record test command")}

## Find a first contribution

Look for issues labeled 'good first issue' or 'help wanted'. Before starting larger work, comment with the behavior you intend to change and the verification you will add.

## Pull requests

Keep one concern per PR. Include acceptance criteria, tests, failure modes considered, documentation updates, and exact verification output. Follow the repository's code of conduct and do not weaken CI to land a change.
`
}

function buildCodeOfConduct(): string {
  return `# Contributor Covenant Code of Conduct

## Our pledge

We pledge to make participation in this community a harassment-free experience for everyone, regardless of age, body size, disability, ethnicity, sex characteristics, gender identity and expression, experience, education, socioeconomic status, nationality, appearance, race, caste, color, religion, or sexual identity and orientation.

## Our standards

Use welcoming and inclusive language, respect differing viewpoints, accept constructive feedback, focus on what is best for the community, and show empathy. Harassment, insults, public or private intimidation, and publishing others' private information are unacceptable.

## Enforcement

Report unacceptable behavior to <!-- TODO: private conduct-reporting channel -->. Maintainers will investigate promptly, protect reporter privacy where possible, and apply proportionate corrective action.

This policy adopts the Contributor Covenant, version 2.1. See https://www.contributor-covenant.org/version/2/1/code_of_conduct.html for the full enforcement guidelines and attribution required by that license.
`
}

function buildSupport(): string {
  return `# Support

## Questions and help

<!-- TODO: name the supported discussion forum, issue category, or community channel. -->

## Bugs

Search existing issues, then open a bug report with reproduction steps, expected and actual behavior, environment details, and relevant logs with secrets removed.

## Security

Do not report vulnerabilities publicly. Follow [SECURITY.md](SECURITY.md).

## Scope and response

Support is provided on a best-effort basis. <!-- TODO: state maintained versions, normal response expectations, and commercial support if any. -->
`
}

function buildCodeowners(): string {
  return `# TODO: replace placeholder owners with real maintainers or teams.\n* @OWNER/MAINTAINERS\n.github/ @OWNER/MAINTAINERS\nSECURITY.md @OWNER/SECURITY\n`
}

function buildGovernance(): string {
  return `# Governance

## Roles

- Contributors propose changes and participate in review.
- Maintainers review, release, triage, and steward project health.
- Security responders handle private vulnerability reports.

<!-- TODO: list current maintainers, affiliations, and contact paths. -->

## Decisions

Routine reversible decisions use lazy consensus in issues or PRs. Architecture and durable process changes require an ADR. Conflicts of interest must be disclosed. Security-sensitive and irreversible decisions require explicit maintainer approval.

## Becoming or leaving a maintainer

Maintainer nominations should be based on sustained, constructive contributions and community trust, not employer or funding status. Record nominations and decisions publicly. Departing maintainers should transfer ownership and access promptly.

## Sustainability

Review contributor response time, repeat-contributor rate, contributor absence factor, organizational diversity, release cadence, and adopter evidence at least quarterly. These lagging signals, not this file's presence, show whether governance works.
`
}

function buildFunding(): string {
  return `# TODO: uncomment and fill only funding platforms the project actually owns.\n# github: [maintainer]\n# open_collective: project\n# custom: [https://example.invalid/sponsor]\n`
}

function buildAdopters(): string {
  return `# Adopters

Real users may add themselves through a pull request. Do not add organizations without their consent.

| Organization / project | Public evidence | How it is used | Contact or PR |
| --- | --- | --- | --- |
| <!-- TODO: verified adopter --> | <!-- public URL --> | <!-- production, evaluation, integration --> | <!-- consent evidence --> |
`
}

function buildIssueTemplateConfig(): string {
  return `blank_issues_enabled: false\ncontact_links:\n  - name: Security vulnerability\n    url: <!-- TODO: GitHub private vulnerability reporting URL -->\n    about: Report security issues privately; do not open a public issue.\n  - name: Support\n    url: <!-- TODO: discussions or support URL -->\n    about: Ask usage questions and get help.\n`
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

${opts.uiEvidenceRequired ? "Attach screenshots of the RENDERED result for every user-viewable surface changed — the product UI, and any changed README / Pages / docs as they render — at mobile + desktop, light + dark, driven in a real browser. Never infer UI quality from source or a passing build." : "If user-visible behavior changed, attach before/after evidence — for UI, a screenshot of the rendered result at real viewports; for a CLI, the real output."}

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

## Definition of greatness (verifiable)

${DEFINITION_OF_GREATNESS}

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
- Enforce WCAG 2.2 AA and Core Web Vitals budgets in CI. Defaults must just work.
- Verify every user-viewable surface BY BROWSING, never by guessing from code. Drive the running artifact through each state (empty / loading / error / success / first-run / edge) at 375 / 768 / 1280 x light+dark, screenshot the actual pixels, critique them against a professional bar (visual hierarchy, spacing rhythm, type/readability, restrained palette, alignment, motion-with-purpose, and whether each state genuinely helps), fix the top defects at the design-system level, then re-drive and re-capture until the vision rubric is clean and the deterministic gates are green (visual-regression \`toHaveScreenshot\`, \`@axe-core/playwright\` zero serious/critical, contrast, CWV). Commit the baselines so polish cannot silently regress.

Decision criteria: the frozen cut list works as one coherent journey and every quality budget has executable or observed evidence.

Exit checkpoint: required CI is green; a cold-start recording/log reaches first value in under five minutes; a real deployment returns HTTP 200; accessibility and Web Vitals reports meet their budgets; the state-matrix Playwright screenshots + visual-regression baselines are committed and green, axe reports zero serious/critical, and the UI was judged from the rendered pixels, not the source.

## Phase 5 — Launch

- Turn the README into the landing page: the beachhead job, proof, five-minute quickstart, examples, limits, and next action above internal architecture detail.
- Publish the GitHub Pages site and complete the Diataxis documentation. Treat docs as marketing because they let prospects experience competence before adoption.
- Launch first where the beachhead persona already lives. Sequence, do not spray: Show HN for Hacker News builders, dev.to for developer education, Product Hunt for its discovery audience, and build-in-public for communities already following the problem.
- Give each channel a channel-native artifact and measurable activation link. Respond to questions and capture objections as discovery input.
- Verify every launch surface as it actually RENDERS, never from markdown or a 200: browse the repo page and screenshot the rendered README in light AND dark (every image/badge loads, the theme-adaptive hero swaps, relative links resolve, no raw-markdown artifacts), the live Pages site and docs (nav works, no overflow), the latest Release page (notes render, links resolve), and the og / social share-card (1200x630, legible when shared). Fix whatever looks off, re-capture, and only then call it launched.

Decision criteria: launch traffic reaches the instrumented aha path and produces conversations or usage from the selected beachhead, not merely impressions.

Exit checkpoint: public URLs return HTTP 200; channel posts are live; analytics record real visitors reaching or failing the aha event; support responses and objections are linked; the rendered README, Pages, docs, Release page, and og-card were driven + screenshotted and read well, not merely reachable.

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
