import { describe, it, expect, afterEach } from "bun:test"

import {
  buildScaffoldFiles,
  COPILOT_SETUP_ALLOWED_KEYS,
  COPILOT_SETUP_JOB_NAME,
  COPILOT_SETUP_TIMEOUT_MAX,
  planScaffoldFiles,
} from "~/lib/first-mate/scaffold-spec"
import { createFirstMateTools } from "~/lib/first-mate/tools"
import { state } from "~/lib/state"

describe("buildScaffoldFiles", () => {
  it("emits the exact expected file set", () => {
    const files = buildScaffoldFiles({ repoName: "test-repo" })
    const paths = files.map((f) => f.path).sort()
    expect(paths).toEqual([
      ".claude/agents/implementer.md",
      ".claude/agents/planner.md",
      ".claude/agents/researcher.md",
      ".claude/agents/reviewer.md",
      ".claude/agents/tester.md",
      ".github/agents/implementer.md",
      ".github/agents/planner.md",
      ".github/agents/researcher.md",
      ".github/agents/reviewer.md",
      ".github/agents/tester.md",
      ".github/copilot-instructions.md",
      ".github/instructions/tests.instructions.md",
      ".github/pull_request_template.md",
      ".github/workflows/ci.yml",
      ".github/workflows/copilot-setup-steps.yml",
      "AGENTS.md",
      "CHANGELOG.md",
      "CLAUDE.md",
      "GEMINI.md",
      "LEARNINGS.md",
      "docs/adr/0001-record-architecture-decisions.md",
      "docs/adrs/0000-template.md",
      "docs/history/0000-template.md",
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

  it("role agents use the fixed schema and are mirrored", () => {
    const files = buildScaffoldFiles({ repoName: "test-repo" })
    const githubPlanner = files.find((f) => f.path === ".github/agents/planner.md")!
    const claudePlanner = files.find((f) => f.path === ".claude/agents/planner.md")!
    expect(githubPlanner.content).toBe(claudePlanner.content)
    expect(githubPlanner.content).toContain("name: planner")
    for (const section of ["## Purpose", "## When to use", "## Inputs (cold-start contract)", "## Method", "## Quality bar", "## Output contract", "## Self-reminder"]) {
      expect(githubPlanner.content).toContain(section)
    }
  })

  it("gears guidance and CI from detected options", () => {
    const files = buildScaffoldFiles({
      repoName: "owner/web",
      repoDescription: "A web product.",
      defaultBranch: "trunk",
      techStack: "TypeScript, React",
      packageManager: "bun",
      commands: { build: "bun run build", typecheck: "bun run typecheck", lint: "bun run lint", test: "bun test", dev: "bun run dev" },
      tests: { framework: "bun:test", directory: "tests/", glob: "**/*.test.ts" },
      ci: { primaryOs: "windows-latest", matrix: ["windows-latest", "ubuntu-latest"] },
      uiEvidenceRequired: true,
    })
    const guidance = files.find((f) => f.path === "CLAUDE.md")!
    const ci = files.find((f) => f.path === ".github/workflows/ci.yml")!
    expect(guidance.content).toContain("A web product.")
    expect(guidance.content).toContain("`bun run typecheck`")
    expect(guidance.content).toContain("UI-impacting changes include before/after screenshots")
    expect(ci.content).toContain("windows-latest")
    expect(ci.content).toContain("bun run build")
  })

  it("enhance mode appends only missing ## sections for guidance files", () => {
    const desired = [{ path: "CLAUDE.md", content: "# Title\n\n## Existing\n\nnew\n\n## Missing\n\nbody\n" }]
    const plan = planScaffoldFiles({
      mode: "enhance",
      desired,
      existing: [{ path: "CLAUDE.md", content: "# Custom\n\n## Existing\n\nkeep me\n" }],
    })
    expect(plan.filesToCommit).toHaveLength(1)
    expect(plan.filesToCommit[0]!.content).toContain("keep me")
    expect(plan.filesToCommit[0]!.content).toContain("## Missing")
    expect(plan.filesToCommit[0]!.content).not.toContain("new")
    expect(plan.reports[0]).toEqual({ path: "CLAUDE.md", status: "enhanced", appendedSections: ["## Missing"] })
  })
})

describe("COPILOT_SETUP_ALLOWED_KEYS", () => {
  it("contains required keys", () => {
    expect(COPILOT_SETUP_ALLOWED_KEYS).toContain("steps")
    expect(COPILOT_SETUP_ALLOWED_KEYS).toContain("timeout-minutes")
    expect(COPILOT_SETUP_ALLOWED_KEYS).toContain("runs-on")
  })
})

describe("scaffold_repo no-op (all files already present)", () => {
  const originalFetch = globalThis.fetch
  const savedToken = state.githubAgentToken

  afterEach(() => {
    globalThis.fetch = originalFetch
    state.githubAgentToken = savedToken
  })

  it("commits nothing, opens NO pull request, and creates no branch", async () => {
    state.githubAgentToken = "agent-token"

    const jsonResponse = (body: unknown, status = 200): Response =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      })

    let pullsPosted = false
    let branchDeleted = false
    const fetchMock = ((input: string, init?: RequestInit): Response => {
      const method = init?.method ?? "GET"
      const { pathname } = new URL(input)

      // If the plan is no-op, branch creation should not happen.
      if (method === "GET" && pathname.endsWith("/git/ref/heads/main")) {
        return jsonResponse({ object: { sha: "basesha" } })
      }
      if (method === "POST" && pathname.endsWith("/git/refs")) {
        return new Response("unexpected branch creation", { status: 500 })
      }
      // Detection and existing-file reads find all scaffold files present, so
      // nothing is committed.
      if (method === "GET" && pathname.includes("/git/ref/heads/scaffold/")) {
        return jsonResponse({ object: { sha: "basesha" } })
      }
      if (method === "GET" && pathname.includes("/contents/")) {
        return jsonResponse({ type: "file", encoding: "base64", content: Buffer.from("# Existing\n\n## Project overview\n\nkeep\n", "utf8").toString("base64") })
      }
      // No-op cleanup: the orphan branch is deleted.
      if (method === "DELETE" && pathname.includes("/git/refs/heads/scaffold/")) {
        branchDeleted = true
        return jsonResponse({}, 204)
      }
      // PR creation MUST NOT happen (GitHub would 422 with no commits).
      if (method === "POST" && pathname.endsWith("/pulls")) {
        pullsPosted = true
        return jsonResponse({ message: "No commits between base and head" }, 422)
      }
      return new Response(`unexpected ${method} ${pathname}`, { status: 500 })
    }) as unknown as typeof fetch
    globalThis.fetch = fetchMock

    const tool = createFirstMateTools().find((t) => t.toolNameHttp === "scaffold_repo")
    if (tool === undefined) throw new Error("scaffold_repo tool not found")

    const res = await tool.handler({ repo: "octo/repo", base_ref: "main", mode: "add-missing-only" })

    expect(res.isError).toBeUndefined()
    const payload = JSON.parse(res.content[0]!.text) as {
      committed: string[]
      pr: string | null
      note?: string
    }
    expect(payload.committed).toEqual([])
    expect(payload.pr).toBeNull()
    expect(payload.note).toContain("nothing to scaffold")
    expect(pullsPosted).toBe(false)
    expect(branchDeleted).toBe(false)
  })
})
