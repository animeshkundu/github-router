import { describe, it, expect } from "bun:test"

import {
  buildScaffoldFiles,
  COPILOT_SETUP_ALLOWED_KEYS,
  COPILOT_SETUP_JOB_NAME,
  COPILOT_SETUP_TIMEOUT_MAX,
} from "~/lib/first-mate/scaffold-spec"

describe("buildScaffoldFiles", () => {
  it("emits the exact expected file set", () => {
    const files = buildScaffoldFiles({ repoName: "test-repo" })
    const paths = files.map((f) => f.path).sort()
    expect(paths).toEqual([
      ".github/copilot-instructions.md",
      ".github/instructions/tests.instructions.md",
      ".github/workflows/copilot-setup-steps.yml",
      "AGENTS.md",
      "CHANGELOG.md",
      "CLAUDE.md",
      "GEMINI.md",
      "LEARNINGS.md",
      "docs/adr/0001-record-architecture-decisions.md",
      "docs/plans/README.md",
      "docs/research/README.md",
    ].sort())
  })

  it("copilot-setup-steps.yml has job named copilot-setup-steps", () => {
    const files = buildScaffoldFiles({ repoName: "test-repo" })
    const workflow = files.find((f) => f.path === ".github/workflows/copilot-setup-steps.yml")!
    expect(workflow).toBeDefined()
    expect(workflow.content).toContain(`${COPILOT_SETUP_JOB_NAME}:`)
  })

  it("copilot-setup-steps.yml timeout is ≤ COPILOT_SETUP_TIMEOUT_MAX", () => {
    const files = buildScaffoldFiles({ repoName: "test-repo" })
    const workflow = files.find((f) => f.path === ".github/workflows/copilot-setup-steps.yml")!
    const match = workflow.content.match(/timeout-minutes:\s*(\d+)/)
    expect(match).toBeTruthy()
    const timeout = parseInt(match![1], 10)
    expect(timeout).toBeLessThanOrEqual(COPILOT_SETUP_TIMEOUT_MAX)
  })

  it("COPILOT_SETUP_JOB_NAME equals copilot-setup-steps", () => {
    expect(COPILOT_SETUP_JOB_NAME).toBe("copilot-setup-steps")
  })

  it("COPILOT_SETUP_TIMEOUT_MAX is ≤ 59", () => {
    expect(COPILOT_SETUP_TIMEOUT_MAX).toBeLessThanOrEqual(59)
  })

  it("AGENTS.md CLAUDE.md GEMINI.md and copilot-instructions.md have same content", () => {
    const files = buildScaffoldFiles({ repoName: "test-repo" })
    const agents = files.find((f) => f.path === "AGENTS.md")!
    const claude = files.find((f) => f.path === "CLAUDE.md")!
    const gemini = files.find((f) => f.path === "GEMINI.md")!
    const copilot = files.find((f) => f.path === ".github/copilot-instructions.md")!
    expect(claude.content).toBe(agents.content)
    expect(gemini.content).toBe(agents.content)
    expect(copilot.content).toBe(agents.content)
  })

  it("tests.instructions.md has applyTo frontmatter", () => {
    const files = buildScaffoldFiles({ repoName: "test-repo" })
    const tests = files.find((f) => f.path === ".github/instructions/tests.instructions.md")!
    expect(tests.content).toContain("applyTo:")
  })
})

describe("COPILOT_SETUP_ALLOWED_KEYS", () => {
  it("contains required keys", () => {
    expect(COPILOT_SETUP_ALLOWED_KEYS).toContain("steps")
    expect(COPILOT_SETUP_ALLOWED_KEYS).toContain("timeout-minutes")
    expect(COPILOT_SETUP_ALLOWED_KEYS).toContain("runs-on")
  })
})
