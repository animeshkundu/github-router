import { existsSync } from "node:fs"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { afterAll, beforeAll, describe, expect, test } from "bun:test"

import {
  buildForeignAgentIndex,
  buildReservedNames,
  countForeignAgentFiles,
  piForeignRepoRoot,
  piForeignSlug,
  planForeignArtifacts,
  writeForeignArtifacts,
  type PiForeignPlan,
} from "~/lib/pi-foreign-artifacts"

/**
 * A throwaway project + home + mirror. Every test writes its own copy so the
 * suite never reads the developer's real `~/.claude`, `~/.copilot` or repo.
 */
interface Fixture {
  root: string
  repo: string
  home: string
  mirror: string
  write: (rel: string, body: string) => Promise<void>
  read: (rel: string) => Promise<string>
  exists: (rel: string) => boolean
  plan: (opts?: {
    emittedAgents?: ReadonlyArray<string>
    emittedSkills?: ReadonlyArray<string>
    emittedPrompts?: ReadonlyArray<string>
  }) => Promise<PiForeignPlan>
  cleanup: () => Promise<void>
}

async function makeFixture(files: Record<string, string>): Promise<Fixture> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-foreign-"))
  const repo = path.join(root, "repo")
  const home = path.join(root, "home")
  const mirror = path.join(root, "mirror")
  const write = async (rel: string, body: string): Promise<void> => {
    const file = path.join(root, rel)
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, body, "utf8")
  }
  const read = (rel: string): Promise<string> => fs.readFile(path.join(root, rel), "utf8")
  const exists = (rel: string): boolean => existsSync(path.join(root, rel))
  // A `.git` marker makes the repo root resolvable without invoking git.
  await write("repo/.git/HEAD", "ref: refs/heads/main\n")
  for (const [rel, body] of Object.entries(files)) await write(rel, body)
  return {
    root,
    repo,
    home,
    mirror,
    write,
    read,
    exists,
    plan: async (opts = {}) => {
      const reservedNames = await buildReservedNames({
        mirrorDir: mirror,
        repoRoot: repo,
        homeDir: home,
        emittedAgents: opts.emittedAgents ?? [],
        emittedSkills: opts.emittedSkills ?? [],
        emittedPrompts: opts.emittedPrompts ?? [],
      })
      return planForeignArtifacts({
        repoRoot: repo,
        homeDir: home,
        mirrorDir: mirror,
        reservedNames,
      })
    },
    cleanup: () => fs.rm(root, { recursive: true, force: true }),
  }
}

/** Frontmatter helper so fixtures read as artifacts, not as string soup. */
function agentFile(opts: {
  name: string
  description?: string
  tools?: string
  model?: string
  aliases?: string
  body?: string
}): string {
  const lines = ["---", `name: ${opts.name}`]
  if (opts.description !== undefined) lines.push(`description: ${opts.description}`)
  if (opts.tools) lines.push(`tools: ${opts.tools}`)
  if (opts.model) lines.push(`model: ${opts.model}`)
  if (opts.aliases) lines.push(`aliases: ${opts.aliases}`)
  lines.push("---", opts.body ?? `${opts.name} body`, "")
  return lines.join("\n")
}

function skillFile(opts: { name?: string; description?: string; allowed?: string; body?: string }): string {
  const lines = ["---"]
  if (opts.name) lines.push(`name: ${opts.name}`)
  if (opts.description) lines.push(`description: ${opts.description}`)
  if (opts.allowed) lines.push(`allowed-tools: ${opts.allowed}`)
  lines.push("---", opts.body ?? "skill body", "")
  return lines.join("\n")
}

describe("piForeignSlug", () => {
  test("collapses anything illegal into a single separator", () => {
    // The slug is a path segment AND a registry name, so it is computed before
    // any write: `..` must never survive into a path.
    expect(piForeignSlug("Copilot Deploy!")).toBe("copilot-deploy")
    expect(piForeignSlug("--spaced  Name--")).toBe("spaced-name")
    expect(piForeignSlug("../../etc/passwd")).toBe("etc-passwd")
    expect(piForeignSlug("Explore")).toBe("explore")
    expect(piForeignSlug("")).toBe("foreign")
    expect(piForeignSlug("../")).toBe("foreign")
    // Pi's own skill-name limit; a longer name is a HARD error on load.
    expect(piForeignSlug("a".repeat(120)).length).toBe(64)
  })
})

describe("translation", () => {
  let fx: Fixture
  let plan: PiForeignPlan

  beforeAll(async () => {
    fx = await makeFixture({
      // ---- skills: Claude project, Copilot project, Claude user ----
      "repo/.claude/skills/claude-project/SKILL.md": skillFile({
        name: "claude-project",
        description: "A Claude skill",
        allowed: "read, grep",
        body: "Claude skill body",
      }),
      "repo/.github/skills/copilot-project/SKILL.md": skillFile({
        name: "copilot-project",
        description: "A Copilot skill",
      }),
      "home/.claude/skills/claude-user/SKILL.md": skillFile({
        name: "claude-user",
        description: "A user-scope Claude skill",
      }),
      // A flat `.md` skill (Claude allows both shapes).
      "repo/.claude/skills/flat-skill.md": skillFile({
        name: "flat-skill",
        description: "Flat skill file",
      }),
      // ---- prompts: Claude commands (nested + flat duo), Copilot prompts ----
      "repo/.claude/commands/deploy.md": "Deploy ${1} now\n",
      "repo/.claude/commands/nested/deploy.md": "Nested deploy $ARGUMENTS\n",
      "repo/.github/prompts/gh-review.prompt.md": "---\nmode: agent\n---\nCopilot review $1\n",
      // A prompt name owned by both namespaces: `.claude` sorts first, so the
      // Claude command keeps `deploy` and the Copilot one is renamed.
      "repo/.github/prompts/deploy.prompt.md": "Copilot deploy $ARGUMENTS\n",
      // ---- agents: Copilot project, Claude project, Claude user ----
      "repo/.github/agents/copilot-agent.agent.md": agentFile({
        name: "Copilot Agent",
        description: "A Copilot agent",
        tools: "read, edit, bash",
        model: "claude-sonnet-4",
        aliases: "ca, cagent",
        body: "Copilot agent body",
      }),
      "repo/.claude/agents/claude-agent.md": agentFile({
        name: "claude-agent",
        description: "A Claude agent",
        model: "opus",
        body: "Claude agent body",
      }),
      "home/.claude/agents/ghost-user.md": agentFile({
        name: "ghost-user",
        description: "A user-scope Claude agent",
      }),
    })
    plan = await fx.plan()
  })

  afterAll(async () => {
    await fx.cleanup()
  })

  test("skills are translated with name+description only", () => {
    const byName = new Map(plan.skills.map((s) => [s.name, s.content]))
    expect([...byName.keys()].sort()).toEqual([
      "claude-project",
      "claude-user",
      "copilot-project",
      "flat-skill",
    ])
    const claude = byName.get("claude-project") as string
    // `name:` is DROPPED on purpose: Pi resolves a skill from the frontmatter
    // when present and from the parent directory otherwise, so keeping
    // `name: gh-oracle` inside `gh-oracle-2/SKILL.md` would make both copies
    // load as `gh-oracle` and the foreign one lose as a `collision`.
    expect(claude).not.toContain("name:")
    expect(claude).toContain("description: A Claude skill")
    // An allowlist Pi cannot enforce is prose, not frontmatter: an
    // unresolvable entry in pi-subagents' strict list hard-fails the child.
    expect(claude).not.toContain("allowed-tools:")
    expect(claude).toContain("> Authored tool policy (advisory in Pi): read, grep.")
    expect(claude).toContain("> Bridged by github-router from Claude `.claude/skills/claude-project/SKILL.md`.")
    expect(claude).toContain("Claude skill body")
  })

  test("prompts are flattened and keep their placeholders", () => {
    const byName = new Map(plan.prompts.map((p) => [p.name, p.content]))
    // `nested/deploy.md` flattens to `nested-deploy` BEFORE the collision
    // check, and `.prompt.md` strips to the same stem as `.md`, so only the
    // Copilot copy of `deploy` needs an ordinal.
    expect([...byName.keys()].sort()).toEqual(["deploy", "deploy-2", "gh-review", "nested-deploy"])
    // Placeholders are passed through untouched: rewriting them would change
    // what the command means.
    expect(byName.get("deploy")).toContain("Deploy ${1} now")
    expect(byName.get("deploy-2")).toContain("Copilot deploy $ARGUMENTS")
    expect(byName.get("nested-deploy")).toContain("Nested deploy $ARGUMENTS")
    expect(byName.get("gh-review")).toContain("Copilot review $1")
    expect(byName.get("gh-review")).not.toContain("mode: agent")
    expect(byName.get("deploy")).toContain("> Bridged by github-router from Claude `.claude/commands/deploy.md`.")
  })

  test("agents carry no tools, no model, no aliases", () => {
    const byName = new Map(plan.agents.map((a) => [a.name, a]))
    expect([...byName.keys()].sort()).toEqual(["claude-agent", "copilot-agent", "ghost-user"])
    const copilot = byName.get("copilot-agent")
    expect(copilot).toBeDefined()
    expect(copilot?.description).toBe("A Copilot agent")
    // `model:` would be a Copilot slug `isUnavailableSubagentModel` refuses,
    // so every run of that agent would fail; `aliases:` is another registry
    // identity that can collide invisibly. Both are dropped, and the agent
    // runs on the launch's lead model like every other foreign agent.
    expect(copilot?.body).not.toContain("model:")
    expect(copilot?.body).not.toContain("aliases:")
    expect(copilot?.body).not.toContain("claude-sonnet-4")
    // The authored tool policy survives as prose.
    expect(copilot?.body).toContain("> Authored tool policy (advisory in Pi): read, edit, bash.")
    expect(copilot?.body).toContain("> Bridged by github-router from Copilot `.github/agents/copilot-agent.agent.md`.")
    expect(copilot?.body).toContain("Copilot agent body")
    expect(copilot?.source).toBe("copilot")
    expect(copilot?.scope).toBe("project")
    expect(byName.get("claude-agent")?.source).toBe("claude")
    expect(byName.get("ghost-user")?.scope).toBe("user")
  })

  test("scope comes from the root, not from the artifact", () => {
    expect(plan.agents.find((a) => a.name === "claude-agent")?.file).toBe(".claude/agents/claude-agent.md")
    expect(plan.agents.find((a) => a.name === "ghost-user")?.file).toBe("~/.claude/agents/ghost-user.md")
    expect(plan.skills.find((s) => s.name === "claude-user")).toBeDefined()
  })

  test("no agent file is ever written", async () => {
    await writeForeignArtifacts(fx.mirror, plan)
    // The whole point of the runtime registry: an agent FILE would become a
    // configured agent, and `mergeRuntimeAgents` validates those on EVERY
    // discovery, so one collision breaks every subagent call in the process.
    expect(existsSync(path.join(fx.mirror, "agents"))).toBe(false)
    const written = await fs.readdir(path.join(fx.mirror, "skills"))
    expect(written.sort()).toEqual(["claude-project", "claude-user", "copilot-project", "flat-skill"])
    const prompts = await fs.readdir(path.join(fx.mirror, "prompts"))
    expect(prompts.sort()).toEqual(["deploy-2.md", "deploy.md", "gh-review.md", "nested-deploy.md"])
  })

  test("overwrites are counted, and a fresh mirror has none", async () => {
    const again = await writeForeignArtifacts(fx.mirror, plan)
    // `overwritten` is the tripwire for the silent-clobber failure: the
    // planner reserves every owned name, so a non-zero count means the
    // reservation scan is wrong, not that the user asked for it.
    expect(again.overwritten).toBeGreaterThan(0)
    // ...but the first write into a fresh mirror replaces nothing.
    const fresh = await makeFixture({})
    try {
      const clean = await writeForeignArtifacts(fresh.mirror, plan)
      expect(clean.overwritten).toBe(0)
      expect(clean.skills).toBe(plan.skills.length)
      expect(clean.prompts).toBe(plan.prompts.length)
    } finally {
      await fresh.cleanup()
    }
  })
})

describe("collisions", () => {
  /**
   * The rule, exercised in one fixture: everything a foreign name can walk
   * into. Each row is a distinct failure mode reproduced against the real
   * loaders earlier in this session.
   */
  let fx: Fixture
  let plan: PiForeignPlan

  beforeAll(async () => {
    fx = await makeFixture({
      // --- the router's own artifacts (this launch) ---
      "mirror/agents/explore.md": agentFile({ name: "Explore", description: "router recon" }),
      "mirror/skills/gh-oracle/SKILL.md": skillFile({ description: "router oracle", body: "ROUTER ORACLE" }),
      "mirror/prompts/review.md": "ROUTER REVIEW\n",
      // --- the user's own configured agents ---
      "repo/.pi/agents/deployer.md": agentFile({
        name: "deployer",
        description: "deployer",
        aliases: "ship, release",
      }),
      // A disabled agent still owns its identity keys: the collision check runs
      // on the configured list BEFORE the disable filter.
      "repo/.pi/agents/ghost.md": `---\nname: ghost\ndescription: g\ndisabled: true\n---\nbody\n`,
      // A user-held name with no relation to the router.
      "home/.pi/agent/agents/claude-writer.md": agentFile({ name: "claude-writer", description: "mine" }),
      // --- the foreign side ---
      "repo/.github/agents/code.agent.md": agentFile({ name: "code", description: "foreign code" }),
      "repo/.claude/agents/writer.md": agentFile({ name: "writer", description: "project writer", body: "project writer body" }),
      "home/.claude/agents/writer.md": agentFile({ name: "writer", description: "user writer", body: "user writer body" }),
      "repo/.github/agents/ship.agent.md": agentFile({ name: "ship", description: "collides with an alias" }),
      "repo/.github/agents/ghost.agent.md": agentFile({ name: "ghost", description: "collides with a disabled agent" }),
      "repo/.github/agents/claude-writer.agent.md": agentFile({ name: "claude-writer", description: "collides with a user agent" }),
      "repo/.github/agents/copilot-deploy.agent.md": agentFile({ name: "Copilot Deploy", description: "slugged" }),
      // Router-owned names: the role already exists, so these are SKIPPED.
      "repo/.github/agents/explore2.agent.md": agentFile({ name: "Explore", description: "foreign recon" }),
      "repo/.github/agents/reviewer.agent.md": agentFile({ name: "reviewer", description: "foreign reviewer" }),
      "repo/.github/agents/developer.agent.md": agentFile({ name: "developer", description: "builtin alias" }),
      "repo/.github/agents/claude-code.agent.md": agentFile({ name: "claude-code", description: "adapter name" }),
      // A skill and a prompt asking for names the router already owns.
      "repo/.claude/skills/gh-oracle/SKILL.md": skillFile({
        name: "gh-oracle",
        description: "foreign oracle",
        body: "FOREIGN ORACLE",
      }),
      "repo/.claude/commands/review.md": "FOREIGN REVIEW\n",
    })
    plan = await fx.plan({
      emittedAgents: ["explore"],
      emittedSkills: ["gh-oracle"],
      emittedPrompts: ["review"],
    })
  })

  afterAll(async () => {
    await fx.cleanup()
  })

  test("authored names are kept when nothing owns them", () => {
    const names = plan.agents.map((a) => a.name)
    // `code` is NOT reserved: prefix-style renaming (`claude-code`) would walk
    // straight into the pi-subagents builtin of that exact name.
    expect(names).toContain("code")
    expect(plan.agents.find((a) => a.name === "code")?.renamedFrom).toBeUndefined()
    expect(names).toContain("copilot-deploy")
  })

  test("a taken name becomes <slug>-<scope>, deterministically", () => {
    const byName = new Map(plan.agents.map((a) => [a.name, a]))
    // Same authored name from two scopes: the project copy keeps the authored
    // name, the user copy takes the scope suffix.
    expect(byName.get("writer")?.file).toBe(".claude/agents/writer.md")
    expect(byName.get("writer-user")?.renamedFrom).toBe("writer")
    expect(byName.get("writer-user")?.file).toBe("~/.claude/agents/writer.md")
    // An alias of a configured agent is a registry identity too.
    expect(byName.get("ship-project")?.renamedFrom).toBe("ship")
    // A `disabled: true` agent still owns its keys.
    expect(byName.get("ghost-project")?.renamedFrom).toBe("ghost")
    // A user-held file name.
    expect(byName.get("claude-writer-project")?.renamedFrom).toBe("claude-writer")
  })

  test("a name the router owns is skipped with a reason, never renamed", () => {
    const skipped = new Map(plan.skipped.map((s) => [s.name, s.reason]))
    for (const owned of ["Explore", "reviewer", "developer", "claude-code"]) {
      expect(skipped.get(owned)).toContain("owned by gh-router or a pi-subagents builtin")
      // Never renamed into existence: `reviewer-2` would make the catalog lie
      // about which of the two is authoritative.
      expect(plan.agents.some((a) => a.name.startsWith(owned))).toBe(false)
    }
    // Project-scope roster name.
    expect(skipped.get("Explore")).toContain("owned by gh-router")
  })

  test("skills and prompts are renamed, never skipped", () => {
    // The file is the only carrier of a skill or a command, so dropping one
    // would silently lose user content. An ordinal is the honest label: the
    // counterpart is a reserved name, not a cross-scope peer.
    expect(plan.skills.map((s) => s.name)).toEqual(["gh-oracle-2"])
    expect(plan.skills[0].renamedFrom).toBe("gh-oracle")
    expect(plan.prompts.map((p) => p.name)).toEqual(["review-2"])
    expect(plan.prompts[0].renamedFrom).toBe("review")
    // Nothing in the reserved sets is reported as skipped for these two
    // namespaces — only missing descriptions are.
    expect(plan.skipped.filter((s) => s.name === "gh-oracle" || s.name === "review")).toEqual([])
  })

  test("writing them leaves the router's own files byte-identical", async () => {
    const written = await writeForeignArtifacts(fx.mirror, plan)
    expect(written).toEqual({ skills: 1, prompts: 1, overwritten: 0 })
    // Router's skill untouched, foreign body in the ordinal copy.
    expect(await fx.read("mirror/skills/gh-oracle/SKILL.md")).toContain("ROUTER ORACLE")
    expect(await fx.read("mirror/skills/gh-oracle-2/SKILL.md")).toContain("FOREIGN ORACLE")
    // Router's command untouched, foreign body in the ordinal copy.
    expect(await fx.read("mirror/prompts/review.md")).toBe("ROUTER REVIEW\n")
    expect(await fx.read("mirror/prompts/review-2.md")).toContain("FOREIGN REVIEW")
    // And no agent file, ever.
    const agents = await fs.readdir(path.join(fx.mirror, "agents"))
    expect(agents).toEqual(["explore.md"])
  })
})

describe("the collision matrix", () => {
  /**
   * Every shape of foreign name in one fixture: the control run that says the
   * rule is complete rather than accidentally sufficient. Order is asserted
   * separately from content, because the plan is ordered by scope then path —
   * an assertion on the raw array would fail on an unrelated ordering change
   * and hide which name landed where.
   */
  let fx: Fixture
  let plan: PiForeignPlan

  beforeAll(async () => {
    fx = await makeFixture({
      "mirror/agents/explore.md": agentFile({ name: "Explore", description: "router recon" }),
      "repo/.pi/agents/deployer.md": agentFile({ name: "deployer", description: "d", aliases: "ship, release" }),
      "repo/.pi/agents/ghost.md": `---\nname: ghost\ndescription: g\ndisabled: true\n---\nbody\n`,
      "home/.pi/agent/agents/claude-writer.md": agentFile({ name: "claude-writer", description: "mine" }),
      "repo/.github/agents/code.agent.md": agentFile({ name: "code", description: "c" }),
      "repo/.github/agents/writer.agent.md": agentFile({ name: "writer", description: "project writer" }),
      "home/.claude/agents/writer.md": agentFile({ name: "writer", description: "user writer", body: "user body" }),
      "repo/.github/agents/ship.agent.md": agentFile({ name: "ship", description: "s" }),
      "repo/.github/agents/release.agent.md": agentFile({ name: "release", description: "r" }),
      "repo/.github/agents/ghost2.agent.md": agentFile({ name: "ghost", description: "g2" }),
      "repo/.github/agents/claude-writer2.agent.md": agentFile({ name: "claude-writer", description: "cw" }),
      "repo/.github/agents/deploy2.agent.md": agentFile({ name: "Copilot Deploy", description: "cd" }),
      "repo/.github/agents/reviewer.agent.md": agentFile({ name: "reviewer", description: "rv" }),
      "repo/.github/agents/developer.agent.md": agentFile({ name: "developer", description: "dev" }),
      "repo/.github/agents/claude-code.agent.md": agentFile({ name: "claude-code", description: "cc" }),
    })
    plan = await fx.plan({ emittedAgents: ["explore"] })
  })

  afterAll(async () => {
    await fx.cleanup()
  })

  test("8 bridged, 3 skipped", () => {
    expect(plan.agents.map((a) => a.name).sort()).toEqual([
      "claude-writer-project",
      "code",
      "copilot-deploy",
      "ghost-project",
      "release-project",
      "ship-project",
      "writer",
      "writer-user",
    ])
    expect(plan.skipped.map((s) => s.name).sort()).toEqual(["claude-code", "developer", "reviewer"])
  })

  test("project names precede user names in the plan", () => {
    // The suffix is first-come, so this ordering IS the guarantee that a
    // project artifact keeps its authored name over a user artifact.
    const idx = (name: string): number => plan.agents.findIndex((a) => a.name === name)
    expect(idx("writer")).toBeLessThan(idx("writer-user"))
    expect(plan.agents[idx("writer")].scope).toBe("project")
    expect(plan.agents[idx("writer-user")].scope).toBe("user")
  })

  test("every bridged name is unique case-insensitively", async () => {
    const names = plan.agents.map((a) => a.name.toLowerCase())
    expect(new Set(names).size).toBe(names.length)
    // And none of them is in a reserved set.
    const reserved = await buildReservedNames({
      mirrorDir: fx.mirror,
      repoRoot: fx.repo,
      homeDir: fx.home,
      emittedAgents: ["explore"],
    })
    for (const name of plan.agents.map((a) => a.name)) {
      expect(reserved.agents.has(name.toLowerCase())).toBe(false)
    }
  })
})

describe("dual-emit dedupe", () => {
  test("byte-identical agent files bridge once", async () => {
    // first-mate writes each role into `.github/agents` AND `.claude/agents`
    // with byte-identical bodies. Without content-keyed dedupe the second copy
    // becomes `planner-2` and the catalog double-lists every role.
    const role = (name: string) =>
      agentFile({ name, description: `${name} role`, tools: "read, edit" })
    const fx = await makeFixture({
      "repo/.github/agents/planner.md": role("planner"),
      "repo/.claude/agents/planner.md": role("planner"),
      "repo/.github/agents/tester.md": role("tester"),
      "repo/.claude/agents/tester.md": role("tester"),
      "repo/.github/agents/ceo.md": role("ceo"),
      "repo/.claude/agents/ceo.md": role("ceo"),
    })
    try {
      const plan = await fx.plan()
      expect(plan.agents.map((a) => a.name).sort()).toEqual(["ceo", "planner", "tester"])
      expect(plan.skipped.every((s) => s.reason.startsWith("duplicate of an identical definition"))).toBe(true)
      expect(plan.skipped.length).toBe(3)
    } finally {
      await fx.cleanup()
    }
  })

  test("different bodies under one name are NOT deduped", async () => {
    const fx = await makeFixture({
      "repo/.github/agents/writer.md": agentFile({ name: "writer", description: "copilot writer", body: "copilot body" }),
      "repo/.claude/agents/writer.md": agentFile({ name: "writer", description: "claude writer", body: "claude body" }),
    })
    try {
      const plan = await fx.plan()
      // Both scopes are project here, so the second takes the scope suffix
      // rather than being mistaken for a duplicate. `.claude` sorts before
      // `.github`, so the Claude copy keeps the authored name.
      expect(plan.agents.map((a) => a.name)).toEqual(["writer", "writer-project"])
      expect(plan.agents[0].body).toContain("claude body")
      expect(plan.agents[1].body).toContain("copilot body")
    } finally {
      await fx.cleanup()
    }
  })
})

describe("caps and redaction", () => {
  test("an oversized agent body is capped, not dropped", async () => {
    const fx = await makeFixture({
      "repo/.github/agents/big.agent.md": agentFile({
        name: "big",
        description: `d ${"x".repeat(400)}`,
        body: "y".repeat(20_000),
      }),
    })
    try {
      const plan = await fx.plan()
      const spec = plan.agents[0]
      expect(spec.name).toBe("big")
      // pi-subagents caps `systemPrompt` at 1 MiB; the bridge is far stricter
      // so one giant foreign agent cannot dominate the mirror.
      expect(Buffer.byteLength(spec.body, "utf8")).toBeLessThanOrEqual(8 * 1024)
      expect(spec.body).toContain("truncated")
      expect(spec.description.length).toBeLessThanOrEqual(200)
    } finally {
      await fx.cleanup()
    }
  })

  test("secrets pasted into a foreign artifact are redacted", async () => {
    const fx = await makeFixture({
      "repo/.claude/agents/leaky.md": agentFile({
        name: "leaky",
        description: "leaky",
        body: "export GITHUB_TOKEN=ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      }),
    })
    try {
      const plan = await fx.plan()
      // A foreign artifact is user prose that never went through the router;
      // copying it verbatim would move any pasted token into a second tree.
      expect(plan.agents[0].body).not.toContain("ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
      expect(plan.agents[0].body).toContain("REDACTED")
    } finally {
      await fx.cleanup()
    }
  })
})

describe("missing descriptions", () => {
  test("are skipped and reported, never silently dropped", async () => {
    const fx = await makeFixture({
      "repo/.github/agents/no-desc.md": "---\nname: nodesc\n---\nbody\n",
      "repo/.claude/skills/no-desc/SKILL.md": "---\nname: nodesc-skill\n---\nbody\n",
    })
    try {
      const plan = await fx.plan()
      expect(plan.agents).toEqual([])
      expect(plan.skills).toEqual([])
      const reasons = plan.skipped.map((s) => s.reason)
      // Pi HARD-fails a skill with no description (`core/skills.js:252-254`),
      // and an agent index row with an empty description is unreachable.
      expect(reasons).toContain("skill has no description (Pi requires one)")
      expect(reasons).toContain("no description in frontmatter (not a usable agent definition)")
      // Every skip names its file.
      for (const skip of plan.skipped) expect(skip.file.length).toBeGreaterThan(0)
    } finally {
      await fx.cleanup()
    }
  })
})

describe("repo and home resolution", () => {
  test("the repo root is the git top-level, not the cwd", async () => {
    // Launching from a subdirectory is ordinary, and every foreign root is
    // repo-relative. Resolving against the cwd would bridge nothing from a
    // nested shell.
    const fx = await makeFixture({ "repo/.github/agents/ceo.md": agentFile({ name: "ceo", description: "c" }) })
    try {
      const nested = path.join(fx.repo, "src", "nested")
      await fs.mkdir(nested, { recursive: true })
      expect(await piForeignRepoRoot(nested)).toBe(fx.repo)
    } finally {
      await fx.cleanup()
    }
  })

  test("no repository above the cwd degrades to the cwd instead of throwing", async () => {
    const fx = await makeFixture({})
    try {
      // The mkdtemp root has no `.git` anywhere above it under /var or /tmp.
      expect(await piForeignRepoRoot(fx.home)).toBe(fx.home)
    } finally {
      await fx.cleanup()
    }
  })
})

describe("countForeignAgentFiles", () => {
  test("counts the six agent roots and nothing else", async () => {
    const fx = await makeFixture({
      "repo/.github/agents/a.agent.md": agentFile({ name: "a", description: "a" }),
      "repo/.github/agents/b.agent.md": agentFile({ name: "b", description: "b" }),
      "repo/.claude/agents/c.md": agentFile({ name: "c", description: "c" }),
      "home/.claude/agents/d.md": agentFile({ name: "d", description: "d" }),
      "home/.copilot/agents/e.agent.md": agentFile({ name: "e", description: "e" }),
      // Not an agent root: skills and prompts must not inflate the count.
      "repo/.claude/skills/s/SKILL.md": skillFile({ name: "s", description: "s" }),
      "repo/.claude/commands/x.md": "x",
      // Not a `.md`.
      "repo/.github/agents/notes.txt": "n",
    })
    try {
      // The count exists only to tell a non-`--foreign` user the flag exists,
      // so it must be a count of DEFINITIONS, not of arbitrary files.
      expect(await countForeignAgentFiles({ repoRoot: fx.repo, homeDir: fx.home })).toBe(5)
    } finally {
      await fx.cleanup()
    }
  })

  test("a dual-emitted role counts once, not once per root", async () => {
    // first-mate writes each role into both foreign roots with identical
    // bodies; a file count would read as double the roles the user has.
    const role = agentFile({ name: "planner", description: "plans" })
    const fx = await makeFixture({
      "repo/.github/agents/planner.md": role,
      "repo/.claude/agents/planner.md": role,
      "repo/.github/agents/ceo.agent.md": role,
    })
    try {
      expect(await countForeignAgentFiles({ repoRoot: fx.repo, homeDir: fx.home })).toBe(2)
    } finally {
      await fx.cleanup()
    }
  })

  test("an absent root counts zero instead of throwing", async () => {
    const fx = await makeFixture({})
    try {
      expect(await countForeignAgentFiles({ repoRoot: fx.repo, homeDir: fx.home })).toBe(0)
    } finally {
      await fx.cleanup()
    }
  })
})

describe("buildForeignAgentIndex", () => {
  test("is empty with nothing to announce", () => {
    expect(buildForeignAgentIndex([])).toBe("")
  })

  test("names the lazy-loading contract in its header", async () => {
    const fx = await makeFixture({
      "repo/.github/agents/ceo.agent.md": agentFile({ name: "ceo", description: "Owns strategy" }),
    })
    try {
      const plan = await fx.plan()
      const index = buildForeignAgentIndex(plan.agents)
      // Runtime agents are never advertised through pi-subagents' own catalog,
      // so this section is the model's only signal that they exist.
      expect(index).toContain("They are NOT preloaded")
      expect(index).toContain('subagent({action:"list", options:{search:"<term>"}})')
      expect(index).toContain("lead model")
      expect(index).toContain("- ceo [copilot, project] — Owns strategy")
    } finally {
      await fx.cleanup()
    }
  })

  test("stays under its byte cap and says how many were omitted", () => {
    const many = Array.from({ length: 200 }, (_, i) => ({
      name: `agent-${i}`,
      originalName: `agent-${i}`,
      description: `Description ${i} ${"z".repeat(150)}`,
      body: "b",
      source: "claude" as const,
      scope: "project" as const,
      file: `.claude/agents/agent-${i}.md`,
    }))
    const index = buildForeignAgentIndex(many)
    // Whole rows only: a half-written row would make the model call an agent
    // whose description it cannot read.
    expect(Buffer.byteLength(index, "utf8")).toBeLessThanOrEqual(4 * 1024)
    expect(index).toMatch(/\+\d+ more/)
    expect(index.split("\n").every((line) => !line.startsWith("- agent-") || line.includes("—"))).toBe(true)
  })
})

/* ------------------------------------------------------------------ */
/* End-to-end against the REAL pi-subagents registry                   */
/* ------------------------------------------------------------------ */

const PI_SUBAGENTS_REGISTRY = path.join(
  process.env.HOME ?? "",
  ".local/share/github-router/pi-mirrors/pi-agent-25053-9a820577/npm/node_modules/pi-subagents/src/agents/runtime-agent-registry.js",
)

/**
 * The bridge's whole claim is that its specs are ACCEPTED by the package Pi
 * actually runs. A mock would prove nothing: the failures this module exists
 * to prevent (builtin collision, configured collision, duplicate identity)
 * live inside `registerRuntimeAgent` and `mergeRuntimeAgents`.
 *
 * Skipped when the package is not installed — CI has no Pi mirror — but the
 * step is not optional on a developer machine, which is where a drift in
 * `BUILTIN_AGENT_NAMES` would be caught.
 */
const hasRegistry = existsSync(PI_SUBAGENTS_REGISTRY)

describe.skipIf(!hasRegistry)("real pi-subagents registry", () => {
  test("every bridged spec registers and merges cleanly", async () => {
    const registry = await import(PI_SUBAGENTS_REGISTRY)
    const fx = await makeFixture({
      "mirror/agents/explore.md": agentFile({ name: "Explore", description: "router recon" }),
      "repo/.github/agents/ceo.agent.md": agentFile({ name: "ceo", description: "Owns strategy" }),
      "repo/.github/agents/code.agent.md": agentFile({ name: "code", description: "code agent" }),
      "repo/.github/agents/reviewer.agent.md": agentFile({ name: "reviewer", description: "foreign reviewer" }),
      "repo/.claude/agents/writer.md": agentFile({ name: "writer", description: "p writer" }),
      "home/.claude/agents/writer.md": agentFile({ name: "writer", description: "u writer", body: "u body" }),
      "repo/.github/agents/deploy.agent.md": agentFile({ name: "deployer", description: "d" }),
      "repo/.pi/agents/deployer.md": agentFile({ name: "deployer", description: "user deployer" }),
    })
    try {
      const plan = await fx.plan({ emittedAgents: ["explore"] })
      const signaled: Array<{ request: unknown; registrations: Array<{ dispose: () => void }> }> = []
      // `registerRuntimeAgent` validates the Pi handle structurally: it needs
      // both `on` and `registerTool`, or it throws before it ever looks at the
      // name. A fake that only has `events` proves nothing about collisions.
      const pi = {
        on: () => () => {},
        registerTool: () => {},
        events: {
          emit: (name: string, request: Record<string, unknown>) => {
            if (name !== "pi-subagents:runtime-agent-register:v1") return
            const entry: { request: unknown; registrations: Array<{ dispose: () => void }> } = {
              request,
              registrations: [],
            }
            signaled.push(entry)
            try {
              // `registerRuntimeAgent` takes `{pi, name, definition}`, not the
              // event envelope — the envelope is the package's own wire shape.
              const registration = registry.registerRuntimeAgent({
                pi: pi as never,
                name: request.name as string,
                definition: request.definition as never,
              })
              entry.registrations.push(registration)
              ;(request as Record<string, unknown>).result = { ok: true, registration }
            } catch (error) {
              ;(request as Record<string, unknown>).result = { ok: false, error }
            }
          },
        },
      }
      // Exactly what the generated extension does, one spec at a time.
      for (const spec of plan.agents) {
        pi.events.emit("pi-subagents:runtime-agent-register:v1", {
          version: 1,
          name: spec.name,
          definition: {
            description: spec.description,
            systemPrompt: spec.body,
            systemPromptMode: "replace",
            inheritProjectContext: true,
          },
        })
      }
      const results = signaled.map((s) => (s.request as Record<string, unknown>).result as Record<string, unknown>)
      expect(results.every((r) => r.ok === true)).toBe(true)

      // The configured side of the merge: the user's own pi agents.
      // `discovered` is the roster this launch wrote plus the user's own
      // configured agents — exactly what discovery hands to the merge.
      const merged = registry.mergeRuntimeAgents(pi as never, {
        agents: [
          { name: "Explore", aliases: [], description: "router recon", systemPrompt: "x" },
          { name: "deployer", aliases: [], description: "user deployer", systemPrompt: "x" },
        ],
        diagnostics: [],
      } as never)
      // Every bridged agent resolves as `runtime`, and the roster survived.
      const byName = new Map(merged.agents.map((a: { name: string }) => [a.name, a]))
      for (const spec of plan.agents) {
        expect(byName.get(spec.name)).toMatchObject({ source: "runtime" })
      }
      expect(byName.get("Explore")).toBeDefined()
      expect(byName.get("deployer")).toBeDefined()

      // Re-registering the same names would throw ('collides with runtime
      // agent'), which is why the extension disposes before it re-registers —
      // load-bearing on /reload, where the instance is recreated.
      for (const entry of signaled) for (const r of entry.registrations) r.dispose()
      const after = registry.mergeRuntimeAgents(pi as never, { agents: [], diagnostics: [] } as never)
      expect(after.agents.filter((a: { source: string }) => a.source === "runtime")).toEqual([])
    } finally {
      await fx.cleanup()
    }
  })
})

describe("skip reasons stay honest", () => {
  test("a dual-emitted router-owned role reports ownership twice, not a phantom duplicate", async () => {
    // first-mate emits `reviewer` into both foreign roots, and `reviewer` is
    // also a name the launch itself publishes. Both copies must say why they
    // were dropped — "duplicate of an identical definition already bridged"
    // would be false, because nothing was bridged.
    const content = agentFile({ name: "reviewer", description: "reviews" })
    const fx = await makeFixture({
      "repo/.github/agents/reviewer.md": content,
      "repo/.claude/agents/reviewer.md": content,
    })
    try {
      const plan = await fx.plan({ emittedAgents: ["Explore", "reviewer"] })
      expect(plan.agents).toEqual([])
      expect(plan.skipped.length).toBe(2)
      expect(plan.skipped.every((s) => s.reason.startsWith("name is owned by gh-router"))).toBe(true)
    } finally {
      await fx.cleanup()
    }
  })
})
