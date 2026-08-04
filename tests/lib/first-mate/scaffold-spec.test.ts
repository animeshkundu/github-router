import { describe, it, expect, afterEach } from "bun:test"

import {
  buildScaffoldFiles,
  COPILOT_SETUP_ALLOWED_KEYS,
  COPILOT_SETUP_JOB_NAME,
  COPILOT_SETUP_PATH,
  COPILOT_SETUP_TIMEOUT_MAX,
  copilotSetupIsInert,
  planScaffoldFiles,
} from "~/lib/first-mate/scaffold-spec"
import { DEFINITION_OF_GREATNESS } from "~/lib/first-mate/operating-protocol"
import { createFirstMateTools } from "~/lib/first-mate/tools"
import { state } from "~/lib/state"
import { firstText } from "~/lib/attachments"

describe("buildScaffoldFiles", () => {
  it("emits the exact expected file set", () => {
    const files = buildScaffoldFiles({ repoName: "test-repo" })
    const paths = files.map((f) => f.path).sort()
    expect(paths).toEqual([
      ".claude/agents/ceo.md",
      ".claude/agents/cpo.md",
      ".claude/agents/cto.md",
      ".claude/agents/implementer.md",
      ".claude/agents/planner.md",
      ".claude/agents/researcher.md",
      ".claude/agents/reviewer.md",
      ".claude/agents/tester.md",
      ".github/agents/ceo.md",
      ".github/agents/cpo.md",
      ".github/agents/cto.md",
      ".github/agents/implementer.md",
      ".github/agents/planner.md",
      ".github/agents/researcher.md",
      ".github/agents/reviewer.md",
      ".github/agents/tester.md",
      ".github/CODEOWNERS",
      ".github/CONTRIBUTING.md",
      ".github/FUNDING.yml",
      ".github/ISSUE_TEMPLATE/config.yml",
      ".github/copilot-instructions.md",
      ".github/dependabot.yml",
      ".github/instructions/tests.instructions.md",
      ".github/pull_request_template.md",
      ".github/workflows/ci.yml",
      ".github/workflows/codeql.yml",
      ".github/workflows/copilot-setup-steps.yml",
      ".github/workflows/maintainability.yml",
      ".github/workflows/media.yml",
      ".github/workflows/publish.yml",
      ".github/workflows/release.yml",
      "ADOPTERS.md",
      "AGENTS.md",
      "CHANGELOG.md",
      "CLAUDE.md",
      "CODE_OF_CONDUCT.md",
      "GEMINI.md",
      "GOVERNANCE.md",
      "LEARNINGS.md",
      "SECURITY.md",
      "SUPPORT.md",
      "docs/adr/0001-record-architecture-decisions.md",
      "docs/adrs/0000-template.md",
      "docs/history/0000-template.md",
      "docs/plans/README.md",
      "docs/playbook/README.md",
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

  it("copilot-setup-steps.yml ALWAYS installs dependencies — never an inert echo stub", () => {
    // The #1 cause of empty cloud-agent draft PRs: an environment file with no
    // real install. Cover the dedicated ecosystems AND the fallback (unknown pm).
    const cases = [
      { packageManager: "npm", techStack: "TypeScript" },
      { packageManager: "bun", techStack: "TypeScript" },
      { packageManager: "pnpm", techStack: "TypeScript" },
      { techStack: "Go" },
      { techStack: "Rust" },
      { techStack: "Python" },
      // Fallback: stack our static detection does NOT match (sanger-viewer shape).
      { techStack: "TypeScript, React, Vite" },
      { techStack: "Elixir Phoenix" },
      {},
    ]
    for (const extra of cases) {
      const files = buildScaffoldFiles({ repoName: "o/r", ...extra })
      const setup = files.find((f) => f.path === COPILOT_SETUP_PATH)!.content
      expect(copilotSetupIsInert(setup)).toBe(false)
      expect(setup).not.toContain('echo "TODO: add language/runtime setup"')
    }
  })

  it("the fallback setup detects the dependency manifest at runtime", () => {
    const setup = buildScaffoldFiles({ repoName: "o/r", techStack: "TypeScript, Vite" }).find(
      (f) => f.path === COPILOT_SETUP_PATH,
    )!.content
    expect(setup).toContain("Detect toolchain and install")
    expect(setup).toContain("npm ci")
    expect(setup).toContain("package-lock.json")
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

  it("emits and mirrors the C-suite operator agents", () => {
    const files = buildScaffoldFiles({ repoName: "test-repo" })
    for (const role of ["ceo", "cto", "cpo"]) {
      const github = files.find((f) => f.path === `.github/agents/${role}.md`)!
      const claude = files.find((f) => f.path === `.claude/agents/${role}.md`)!
      expect(github).toBeDefined()
      expect(github.content).toBe(claude.content)
      expect(github.content).toContain(`name: ${role}`)
      expect(github.content).toContain("model: claude-opus-4.8")
      expect(github.content).toContain("externally verifiable")
    }
  })

  it("seeds an enhanceable product operating playbook", () => {
    const desired = buildScaffoldFiles({ repoName: "test-repo" })
    const playbook = desired.find((f) => f.path === "docs/playbook/README.md")!
    expect(playbook).toBeDefined()
    expect(playbook.content).toContain("## Phase 0 — Discover")
    expect(playbook.content).toContain("## Phase 8 — Grow")
    expect(playbook.content).toContain("## Governance")
    expect(playbook.content).toContain("## Anti-patterns")

    const plan = planScaffoldFiles({
      mode: "enhance",
      desired: [playbook],
      existing: [{ path: playbook.path, content: "# Custom playbook\n\n## Phase 0 — Discover\n\nkeep this\n" }],
    })
    expect(plan.filesToCommit).toHaveLength(1)
    expect(plan.filesToCommit[0]!.content).toContain("keep this")
    expect(plan.filesToCommit[0]!.content).toContain("## Phase 1 — Niche")
    expect(plan.reports[0]?.status).toBe("enhanced")
    expect(plan.reports[0]?.appendedSections).toContain("## Phase 1 — Niche")
  })

  it("guidance tells autonomous operators to proceed and record assumptions", () => {
    const files = buildScaffoldFiles({ repoName: "test-repo" })
    const guidance = files.find((f) => f.path === "AGENTS.md")!
    expect(guidance.content).toContain("## Operating autonomously")
    expect(guidance.content).toContain("do not pause for clarification")
    expect(guidance.content).toContain("State assumptions explicitly in the plan and PR body")
    expect(guidance.content).toContain("docs/playbook/README.md")
    expect(guidance.content).toContain("`ceo`, `cto`, or `cpo`")
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

  it("seeds secure greatness workflows and destination-specific npm publishing", () => {
    const files = buildScaffoldFiles({ repoName: "owner/pkg", defaultBranch: "main", techStack: "TypeScript", packageManager: "npm", finalDestination: "npm", hasSite: true })
    for (const path of [".github/workflows/pages.yml", ".github/workflows/codeql.yml", ".github/dependabot.yml", ".github/workflows/release.yml", ".github/workflows/publish.yml", ".github/workflows/media.yml"]) {
      expect(files.some((file) => file.path === path)).toBe(true)
    }
    const publish = files.find((file) => file.path === ".github/workflows/publish.yml")!.content
    expect(publish).toContain("npm publish --provenance")
    expect(publish).toContain("id-token: write")
    expect(publish).not.toContain("NPM_TOKEN")
    for (const workflow of files.filter((file) => file.path.endsWith(".yml") && file.path.includes("workflows/"))) {
      expect(workflow.content).toContain("permissions:")
      expect(workflow.content).toContain("contents: read")
      expect(workflow.content).not.toContain("pull_request_target")
      for (const match of workflow.content.matchAll(/uses:\s*[^\s@]+@([^\s#]+)/g)) {
        expect(match[1]).toMatch(/^[0-9a-f]{40}$/)
      }
    }
  })

  it("seeds PyPI trusted publishing for a detected Python destination", () => {
    const files = buildScaffoldFiles({ repoName: "owner/python", techStack: "Python", packageManager: "python", finalDestination: "pypi" })
    const publish = files.find((file) => file.path === ".github/workflows/publish.yml")!.content
    expect(publish).toContain("pypa/gh-action-pypi-publish@")
    expect(publish).toContain("environment: pypi")
    expect(publish).toContain("id-token: write")
    expect(publish).not.toMatch(/api[_-]?token|PYPI_TOKEN/i)
  })

  it("seeds community, sustainability, and trust artifacts", () => {
    const files = buildScaffoldFiles({ repoName: "owner/community" })
    for (const path of ["SECURITY.md", ".github/CONTRIBUTING.md", "CODE_OF_CONDUCT.md", "SUPPORT.md", ".github/CODEOWNERS", "GOVERNANCE.md", ".github/FUNDING.yml", "ADOPTERS.md", ".github/ISSUE_TEMPLATE/config.yml"]) {
      expect(files.some((file) => file.path === path)).toBe(true)
    }
    expect(files.find((file) => file.path === "SECURITY.md")!.content).toContain("2 business days")
    expect(files.find((file) => file.path === "GOVERNANCE.md")!.content).toContain("lagging signals")
    const maintainability = files.find((file) => file.path === ".github/workflows/maintainability.yml")!.content
    expect(maintainability).toContain("reuse lint")
    expect(maintainability).toContain("Dependency license policy")
    expect(maintainability).toContain("Execute documented examples")
  })

  it("attests and keyless-signs the pushed GHCR image digest", () => {
    const publish = buildScaffoldFiles({ repoName: "owner/service", finalDestination: "ghcr" }).find((file) => file.path === ".github/workflows/publish.yml")!.content
    expect(publish).toContain("id: build")
    expect(publish).toContain("cosign sign --yes")
    expect(publish).toContain("subject-digest: ${{ steps.build.outputs.digest }}")
    expect(publish).not.toContain("subject-path: Dockerfile")
  })

  it("gates Pages and SEO files on site detection", () => {
    const absent = buildScaffoldFiles({ repoName: "owner/lib", finalDestination: "npm", hasSite: false })
    expect(absent.some((file) => file.path === ".github/workflows/pages.yml")).toBe(false)
    expect(absent.some((file) => file.path === "public/robots.txt")).toBe(false)

    const present = buildScaffoldFiles({ repoName: "owner/site", finalDestination: "github-pages", hasSite: true })
    for (const path of [".github/workflows/pages.yml", "public/robots.txt", "public/sitemap.xml", "public/seo-head.html", "public/404.html", "public/.well-known/security.txt"]) {
      expect(present.some((file) => file.path === path)).toBe(true)
    }
    expect(present.find((file) => file.path === "public/404.html")!.content).toContain('name="robots" content="noindex"')
  })

  it("embeds the shared verifiable definition of greatness", () => {
    const playbook = buildScaffoldFiles({ repoName: "test-repo" }).find((file) => file.path === "docs/playbook/README.md")!
    expect(playbook.content).toContain("## Definition of greatness (verifiable)")
    expect(playbook.content).toContain(DEFINITION_OF_GREATNESS)
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
    const payload = JSON.parse(firstText(res)) as {
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

describe("copilotSetupIsInert", () => {
  it("flags our inert stubs and spares real installs", () => {
    expect(copilotSetupIsInert('- name: Set up environment\n  run: echo "TODO: add language/runtime setup"')).toBe(true)
    expect(copilotSetupIsInert('- name: Set up environment\n  run: echo "Environment ready"')).toBe(true)
    expect(copilotSetupIsInert("- name: Install dependencies\n  run: npm ci")).toBe(false)
    expect(copilotSetupIsInert("- run: bun install --frozen-lockfile")).toBe(false)
    expect(copilotSetupIsInert("- run: go mod download")).toBe(false)
    // A user's real custom setup (no recognized install token, no echo stub) is NOT clobbered.
    expect(copilotSetupIsInert("- name: Bootstrap\n  run: ./scripts/bootstrap")).toBe(false)
    // Empty/unreadable → never treated as inert (conservative).
    expect(copilotSetupIsInert("")).toBe(false)
  })
})

describe("planScaffoldFiles self-heals an inert copilot-setup-steps", () => {
  const good = buildScaffoldFiles({ repoName: "o/r", packageManager: "npm", techStack: "TypeScript" }).find(
    (f) => f.path === COPILOT_SETUP_PATH,
  )!

  it("regenerates a known-inert stub even in add-missing-only mode", () => {
    const plan = planScaffoldFiles({
      mode: "add-missing-only",
      desired: [good],
      existing: [{ path: COPILOT_SETUP_PATH, content: 'jobs:\n  copilot-setup-steps:\n    steps:\n      - name: Set up environment\n        run: echo "Environment ready"' }],
    })
    expect(plan.filesToCommit.map((f) => f.path)).toContain(COPILOT_SETUP_PATH)
    expect(plan.reports.find((r) => r.path === COPILOT_SETUP_PATH)?.status).toBe("overwritten")
  })

  it("preserves an existing setup that already installs (add-missing-only)", () => {
    const plan = planScaffoldFiles({
      mode: "add-missing-only",
      desired: [good],
      existing: [{ path: COPILOT_SETUP_PATH, content: "steps:\n  - name: Install\n    run: pnpm install --frozen-lockfile" }],
    })
    expect(plan.filesToCommit).toHaveLength(0)
    expect(plan.reports.find((r) => r.path === COPILOT_SETUP_PATH)?.status).toBe("skipped")
  })
})
