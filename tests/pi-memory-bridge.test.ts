import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { describe, expect, test } from "bun:test"

import { buildPiMemoryBridgeSection, buildPiExtensionSource } from "~/lib/pi-extension"
import {
  buildMirrorBridgeSection,
  capMemoryIndex,
  collectBridgeInputs,
  extractAtImports,
  extractScopeGlobs,
  mergeBridgeIntoAgentsMd,
  PI_BRIDGE_FENCE_BEGIN,
  PI_BRIDGE_FENCE_END,
  PI_BRIDGE_SECTION_FLOOR_BYTES,
  PI_BRIDGE_STATIC_BUDGET_BYTES,
  redactSecrets,
  resolveImportsPure,
  ruleMatchesFile,
  splitFrontmatter,
} from "~/lib/pi-memory-bridge"
import { buildPiAppendSystem, PI_CONTEXT_CONTRACT_LINE } from "~/lib/pi-models-settings"
import { bridgeShadowWarnings, inspectMirrorPrecedence, planSkillWrites } from "~/lib/pi-mirror-guards"

const emptyCollected = {
  copilotInstructions: [],
  unscopedRules: [],
  scopedRules: [],
  userGlobal: [],
  imports: [],
  skipped: [],
}

/**
 * Execute the REAL generated extension against a fake `pi` and call its
 * commands, returning what each one notified.
 *
 * Grepping the generated source only proves a string was emitted; this proves
 * the runtime value reached the user, which is what the truncation report is
 * for. The module imports nothing but `node:child_process` at load time, so it
 * can be evaluated directly with a `data:` URL.
 */
async function runGeneratedExtension(src: string): Promise<Map<string, string>> {
  const registered = new Map<string, { handler: (args: unknown, ctx: unknown) => Promise<void> }>()
  const notified = new Map<string, string>()
  const pi = {
    registerCommand(name: string, def: { handler: (args: unknown, ctx: unknown) => Promise<void> }) {
      registered.set(name, def)
    },
    on() {},
    registerTool() {},
    registerAgent() {},
  }
  const mod = await import(`data:text/javascript;base64,${Buffer.from(src).toString("base64")}`)
  await (mod.default ?? mod)(pi)
  for (const name of ["memory", "context"]) {
    const def = registered.get(name)
    if (!def) continue
    await def.handler({}, { cwd: "/tmp/repo", ui: { notify: (text: string) => notified.set(name, text) } })
  }
  return notified
}

/** A repo-shaped collection: 4 static files across 4 groups + 2 scoped rules. */
function realistic() {
  return {
    copilotInstructions: [
      { file: "/r/.github/copilot-instructions.md", content: "Use bun. Never run npm install -g." },
    ],
    unscopedRules: [{ file: "/r/.claude/rules/style.md", content: "Prefer Result types over exceptions." }],
    userGlobal: [
      { file: "/home/u/.claude/CLAUDE.md", content: "Answer in British English." },
      { file: "/home/u/.copilot/copilot-instructions.md", content: "Prefer rg over grep." },
    ],
    imports: [{ file: "/r/docs/conventions.md", content: "Tests live in tests/." }],
    scopedRules: [
      { file: "/r/.claude/rules/frontend.md", body: "tsx rules", globs: ["**/*.tsx"], source: "claude-rules" },
      {
        file: "/r/.github/instructions/api.instructions.md",
        body: "api rules",
        globs: ["src/api/**"],
        source: "copilot-instructions",
      },
    ],
    skipped: [],
  }
}

describe("pi-memory-bridge frontmatter + globs", () => {
  test("extracts paths/applyTo/globs incl lists", () => {
    expect(extractScopeGlobs('paths: "**/*.ts"')).toEqual(["**/*.ts"])
    expect(extractScopeGlobs('applyTo: "**/*.ts,**/*.tsx"')).toEqual(["**/*.ts", "**/*.tsx"])
    expect(extractScopeGlobs('globs:\n  - "src/**"\n  - docs/')).toEqual(["src/**", "docs/"])
    expect(extractScopeGlobs("description: hi")).toEqual([])
  })

  test("splits frontmatter", () => {
    const { frontmatter, body } = splitFrontmatter('---\npaths: "**"\n---\nhello')
    expect(frontmatter).toContain("paths")
    expect(body).toBe("hello")
  })

  test("glob matching incl basename + **", () => {
    expect(ruleMatchesFile(["**/*.ts"], "/repo/src/a.ts", "/repo")).toBe(true)
    expect(ruleMatchesFile(["**/*.ts"], "/repo/src/a.py", "/repo")).toBe(false)
    expect(ruleMatchesFile(["*.ts"], "/repo/deep/a.ts", "/repo")).toBe(true)
    expect(ruleMatchesFile(["docs/"], "/repo/docs/a.md", "/repo")).toBe(false)
    expect(ruleMatchesFile(["docs/**"], "/repo/docs/a.md", "/repo")).toBe(true)
    expect(ruleMatchesFile([], "/repo/a.ts", "/repo")).toBe(false)
  })
})

describe("pi-memory-bridge imports + caps", () => {
  test("extracts @ refs", () => {
    expect(extractAtImports("@AGENTS.md\nhello")).toContain("AGENTS.md")
    expect(extractAtImports("no refs")).toEqual([])
  })

  test("resolves with cycle + depth safety", () => {
    const readFile = (abs: string): string | undefined => {
      if (abs.endsWith("b.md")) return "@c.md"
      if (abs.endsWith("c.md")) return "@b.md"
      return undefined
    }
    const out = resolveImportsPure(
      [{ file: "/repo/a.md", content: "@b.md" }],
      readFile,
      "/home/u",
    )
    expect(out.map((e) => e.file)).toEqual(["/repo/b.md", "/repo/c.md"])
  })

  test("caps memory index at 200 lines", () => {
    const raw = Array.from({ length: 400 }, (_, i) => `line ${i}`).join("\n")
    expect(capMemoryIndex(raw).split("\n").length).toBeLessThanOrEqual(200)
  })

  test("redacts secrets", () => {
    expect(redactSecrets("token ghp_abcdefgh1234")).toContain("[REDACTED]")
    expect(redactSecrets("x")).toBe("x")
  })
})

describe("pi-memory-bridge mirror section", () => {
  test("compacts to instruction text: one heading per group, relative paths, no title", () => {
    const { section, stats } = buildMirrorBridgeSection(realistic(), { repoRoot: "/r", homeDir: "/home/u" })

    expect(section).toContain(PI_BRIDGE_FENCE_BEGIN)
    expect(section).toContain(PI_BRIDGE_FENCE_END)
    // The block is a per-turn prompt cost: no redundant title, no provenance
    // comments, no absolute paths.
    expect(section).not.toContain("# gh-router memory bridge")
    expect(section).not.toContain("<!-- source:")
    expect(section).not.toContain("/home/u/")
    expect(section).toContain("`~/.claude/CLAUDE.md`")
    expect(section).toContain("`.github/copilot-instructions.md`")
    // One heading per GROUP, not per file: the two user-global files share one.
    expect(section.split("## User-global instructions").length).toBe(2)
    expect(section.split("## ").length).toBe(6) // 5 groups + the leading fence text split
    expect(section).toContain("## Path-scoped rules (attached on first matching read/edit/write)")
    expect(stats.staticFiles).toBe(4)
    expect(stats.scopedRules).toBe(2)
    expect(stats.truncated).toBe(false)
    expect(stats.bytes).toBe(Buffer.byteLength(section))
    // Measured before the compaction: 972 B on this fixture. It must shrink.
    expect(stats.bytes).toBeLessThan(700)
  })

  test("keeps bodies verbatim (a file:line list is not flattened into the source line)", () => {
    const { section } = buildMirrorBridgeSection(
      {
        ...emptyCollected,
        unscopedRules: [
          { file: "/r/.claude/rules/style.md", content: "See src/a.ts:12 and src/b.ts:34\nfor the pattern." },
        ],
      },
      { repoRoot: "/r", homeDir: "/home/u" },
    )
    expect(section).toContain("See src/a.ts:12 and src/b.ts:34\nfor the pattern.")
  })

  test("emits nothing when the repo has no bridged rules", () => {
    const { section, stats } = buildMirrorBridgeSection(emptyCollected, { repoRoot: "/r" })
    expect(section).toBe("")
    expect(stats.bytes).toBe(0)
    expect(stats.truncated).toBe(false)
  })

  test("merge leaves the user's file untouched when the section is empty", () => {
    expect(mergeBridgeIntoAgentsMd("# mine\n", "")).toBe("# mine\n")
    expect(mergeBridgeIntoAgentsMd(undefined, "")).toBe("")
  })

  test("an empty section strips a fence this launcher wrote previously", () => {
    // The repo got cleaned up, so nothing is bridged any more. Keeping the old
    // block would advertise guidance that no longer exists AND keep paying for
    // it on every turn; the user's own text around it must survive.
    const stale = `# mine\n\n${PI_BRIDGE_FENCE_BEGIN}\n\n## Gone\n\n\`a\` — b\n\n${PI_BRIDGE_FENCE_END}\n\nAFTER\n`
    const merged = mergeBridgeIntoAgentsMd(stale, "")
    expect(merged).not.toContain(PI_BRIDGE_FENCE_BEGIN)
    expect(merged).not.toContain("## Gone")
    expect(merged).toContain("# mine")
    expect(merged).toContain("AFTER")

    // A file that was only the fence disappears entirely rather than becoming
    // an empty file with a stray blank line.
    const onlyFence = `${PI_BRIDGE_FENCE_BEGIN}\n\nx\n\n${PI_BRIDGE_FENCE_END}\n`
    expect(mergeBridgeIntoAgentsMd(onlyFence, "")).toBe("")
  })

  test("merge is idempotent via fence replace, byte for byte", () => {
    const one = buildMirrorBridgeSection(
      { ...emptyCollected, copilotInstructions: [{ file: "a", content: "one" }] },
      {},
    )
    const once = mergeBridgeIntoAgentsMd("# mine", one.section)
    const two = buildMirrorBridgeSection(
      { ...emptyCollected, copilotInstructions: [{ file: "a", content: "two" }] },
      {},
    )
    const twice = mergeBridgeIntoAgentsMd(once, two.section)
    expect(twice).toContain("# mine")
    expect(twice).toContain("two")
    expect(twice).not.toContain("one")
    expect(twice.split(PI_BRIDGE_FENCE_BEGIN).length).toBe(2)
  })

  test("merging the same section repeatedly does not grow the file", () => {
    // A fingerprint every relaunch would compound: the old `before + section +
    // after` concatenation appended one blank line per launch forever.
    const { section } = buildMirrorBridgeSection(
      { ...emptyCollected, copilotInstructions: [{ file: "a", content: "body" }] },
      {},
    )
    const first = mergeBridgeIntoAgentsMd(undefined, section)
    let file = first
    for (let i = 0; i < 5; i++) file = mergeBridgeIntoAgentsMd(file, section)
    expect(file).toBe(first)

    // Same with user content on both sides of the fence.
    const seeded = `# mine\n\n- rule\n\n${section}\nAFTER\n`
    let withUser = mergeBridgeIntoAgentsMd(seeded, section)
    const snapshot = withUser
    for (let i = 0; i < 5; i++) withUser = mergeBridgeIntoAgentsMd(withUser, section)
    expect(withUser).toBe(snapshot)
    expect(withUser).toContain("# mine")
    expect(withUser).toContain("AFTER")
  })

  test("a huge first group cannot starve the later ones", () => {
    const huge = "x".repeat(40_000)
    const { section, stats } = buildMirrorBridgeSection(
      {
        copilotInstructions: [{ file: "/r/.github/copilot-instructions.md", content: huge }],
        unscopedRules: [{ file: "/r/.claude/rules/style.md", content: "KEEP-ME: prefer Result types." }],
        userGlobal: [{ file: "/home/u/.claude/CLAUDE.md", content: "KEEP-ME-TOO: British English." }],
        scopedRules: [],
        imports: [],
        skipped: [],
      },
      { repoRoot: "/r", homeDir: "/home/u" },
    )
    expect(stats.truncated).toBe(true)
    expect(stats.bytes).toBeLessThanOrEqual(PI_BRIDGE_STATIC_BUDGET_BYTES)
    // The later groups still carry their own text, not a bare truncation marker.
    expect(section).toContain("KEEP-ME: prefer Result types.")
    expect(section).toContain("KEEP-ME-TOO: British English.")
  })

  test("a group that still cannot fit is a NAMED omission, not a silence", () => {
    // One oversized group followed by 40 that cannot all fit: the surplus is
    // reported by name. The old behaviour was one row per file, which spent the
    // budget on markers and pushed the block past the ceiling.
    const { section, stats } = buildMirrorBridgeSection(
      {
        copilotInstructions: [{ file: "/r/.github/copilot-instructions.md", content: "y".repeat(60_000) }],
        unscopedRules: Array.from({ length: 40 }, (_, i) => ({
          file: `/r/.claude/rules/r${i}.md`,
          content: "A".repeat(2_000),
        })),
        userGlobal: [],
        scopedRules: [],
        imports: [],
        skipped: [],
      },
      { repoRoot: "/r", homeDir: "/home/u" },
    )
    expect(stats.truncated).toBe(true)
    // The omission is NAMED (count + sources), not a bare truncation marker and
    // not a silent gap. The count leads so the row stays useful even when its
    // own name list has to be cut, and it is ONE row rather than one per file.
    expect(section).toMatch(/Omitted for budget \(\d+\)/)
    expect(section.match(/Omitted for budget/g)?.length).toBe(1)
    expect(stats.bytes).toBeLessThanOrEqual(PI_BRIDGE_STATIC_BUDGET_BYTES)
    // The group also still carries at least one real rule: an omission row on
    // its own would be a report about rules the model cannot see either way.
    const secondGroup = section.split("## Unscoped project rules")[1] ?? ""
    expect(secondGroup).toMatch(/`\.claude\/rules\/r\d+\.md` — A+/)
  })

  test("the 24 KB ceiling holds on every adversarial shape", () => {
    // The fence used to be appended AFTER the ledger was settled, and the
    // omission row was one row per file, so a group of small files could stack
    // past the ceiling. Both are priced in now; this pins it.
    const huge = { file: "/r/a.md", content: "x".repeat(80_000) }
    const forty = Array.from({ length: 40 }, (_, i) => ({ file: `/r/r${i}.md`, content: "y".repeat(2_000) }))
    const scoped = Array.from({ length: 500 }, (_, i) => ({
      file: `/r/.claude/rules/s${i}.md`,
      body: "b",
      globs: ["**/*.ts"],
      source: "claude-rules",
    }))
    const shapes = [
      { copilotInstructions: [huge], unscopedRules: [], userGlobal: [], imports: [], scopedRules: [], skipped: [] },
      { copilotInstructions: [huge], unscopedRules: forty, userGlobal: [], imports: [], scopedRules: [], skipped: [] },
      {
        copilotInstructions: [huge],
        unscopedRules: [huge],
        userGlobal: [huge],
        imports: [huge],
        scopedRules: [],
        skipped: [],
      },
      { copilotInstructions: [huge], unscopedRules: [], userGlobal: [], imports: [], scopedRules: scoped, skipped: [] },
      {
        copilotInstructions: [huge],
        unscopedRules: [huge],
        userGlobal: [],
        imports: [],
        scopedRules: scoped,
        skipped: [],
      },
    ]
    for (const shape of shapes) {
      const { section, stats } = buildMirrorBridgeSection(shape, { repoRoot: "/r", homeDir: "/home/u" })
      expect(stats.bytes).toBe(Buffer.byteLength(section))
      expect(stats.bytes).toBeLessThanOrEqual(PI_BRIDGE_STATIC_BUDGET_BYTES)
    }
  })

  test("a huge static slice cannot make the lazy scoped list unreachable", () => {
    // Those rules exist nowhere else in this launch: if the list is squeezed to
    // nothing, the model never learns they exist and no lazy attach can fire.
    const { section } = buildMirrorBridgeSection(
      {
        copilotInstructions: [{ file: "/r/a.md", content: "a".repeat(80_000) }],
        unscopedRules: [{ file: "/r/b.md", content: "b".repeat(80_000) }],
        userGlobal: [],
        imports: [],
        scopedRules: [{ file: "/r/.claude/rules/api.md", body: "x", globs: ["src/api/**"], source: "claude-rules" }],
        skipped: [],
      },
      { repoRoot: "/r", homeDir: "/home/u" },
    )
    expect(section).toContain("## Path-scoped rules")
    expect(section).toContain("`.claude/rules/api.md` — `src/api/**`")
  })

  test("redacts BEFORE capping, so a cut cannot leave half a secret", () => {
    // The cap lands in the middle of the body, which is where a secret can be
    // split. Scanning a band of filler lengths is deliberate: the old order
    // (cap, then redact the joined section) leaked a `ghp_…` fragment at
    // scattered filler lengths in this range, so a single fixed length would
    // pass by luck on one order and fail by luck on the other.
    const SECRET = `ghp_${"A".repeat(36)}`
    const leaked: Array<number> = []
    for (let filler = 23_300; filler <= 23_700; filler += 1) {
      const { section } = buildMirrorBridgeSection(
        {
          copilotInstructions: [
            {
              file: "/r/.github/copilot-instructions.md",
              content: `${"z".repeat(filler)} ${SECRET} ${"y".repeat(200)}`,
            },
          ],
          unscopedRules: [],
          scopedRules: [],
          userGlobal: [],
          imports: [],
          skipped: [],
        },
        { repoRoot: "/r" },
      )
      if (/ghp_/.test(section)) leaked.push(filler)
    }
    expect(leaked).toEqual([])
  })

  test("respects the section floor constant", () => {
    expect(PI_BRIDGE_SECTION_FLOOR_BYTES).toBe(1_500)
    expect(PI_BRIDGE_SECTION_FLOOR_BYTES).toBeLessThan(PI_BRIDGE_STATIC_BUDGET_BYTES)
  })
})

describe("pi-memory-bridge dedupe", () => {
  test("a symlinked rule is collected once, not twice", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "gh-bridge-dedupe-"))
    const home = path.join(root, "home")
    const repo = path.join(root, "repo")
    const rules = path.join(repo, ".claude", "rules")
    try {
      await fs.mkdir(rules, { recursive: true })
      await fs.mkdir(home, { recursive: true })
      await fs.writeFile(path.join(repo, ".git"), "gitdir: nowhere\n")
      const real = path.join(rules, "a.md")
      await fs.writeFile(real, "ONLY-ONCE rule body\n")
      // A second name for the SAME inode must not produce a second copy.
      await fs.symlink(real, path.join(rules, "b.md"))

      const collected = await collectBridgeInputs(repo, home)
      const bodies = [...collected.unscopedRules, ...collected.scopedRules].filter((r) =>
        ("content" in r ? r.content : r.body).includes("ONLY-ONCE"),
      )
      expect(bodies.length).toBe(1)
      expect(collected.deduped).toBe(1)
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })
})

describe("pi-memory-bridge extension", () => {
  test("emits lazy attach + /memory + /context only when bridge present", () => {
    const withBridge = buildPiExtensionSource({
      profileId: "cheapest",
      bridge: {
        stats: { staticFiles: 1, scopedRules: 1, imports: 0, skipped: 0, truncated: false, bytes: 400 },
        scopedRules: [{ file: "f", body: "b", globs: ["**/*.ts"], source: "s" }],
      },
    })
    expect(withBridge).toContain("tool_result")
    expect(withBridge).toContain("memory")
    expect(withBridge).toContain("/context")

    const bare = buildPiExtensionSource({ profileId: "cheapest" })
    expect(bare).not.toContain("tool_result")
  })

  test("bridge section builder is fail-open text", () => {
    const lines = buildPiMemoryBridgeSection({
      stats: { staticFiles: 0, scopedRules: 1, imports: 0, skipped: 0, truncated: false, bytes: 0 },
      scopedRules: [{ file: "f", body: "b", globs: ["**"], source: "s" }],
    })
    expect(lines.join("\n")).toContain("attached")
  })

  test("/memory and /context report truncation and byte count", async () => {
    // Executed, not grepped. The generated source is a real ES module, so the
    // only way to know the number reaches the user is to run it and read what
    // it notifies. A `toContain("bytes")` assertion passed even while the value
    // was dropped on the floor.
    const stats = { staticFiles: 1, scopedRules: 0, imports: 0, skipped: 0, truncated: true, bytes: 12_345 }
    const src = buildPiExtensionSource({ profileId: "cheapest", bridge: { stats, scopedRules: [] } })
    const shown = await runGeneratedExtension(src)
    const memory = shown.get("memory") ?? ""
    const context = shown.get("context") ?? ""
    expect(memory).toContain("12345 bytes")
    expect(memory).toContain("TRUNCATED")
    expect(context).toContain("12345 bytes")
    expect(context).toContain("TRUNCATED")

    // Untruncated: same numbers, no alarming word.
    const clean = await runGeneratedExtension(
      buildPiExtensionSource({
        profileId: "cheapest",
        bridge: { stats: { ...stats, truncated: false, bytes: 603 }, scopedRules: [] },
      }),
    )
    expect(clean.get("memory")).toContain("603 bytes")
    expect(clean.get("memory")).not.toContain("TRUNCATED")
    expect(clean.get("context")).toContain("603 bytes")
    expect(clean.get("context")).not.toContain("TRUNCATED")
  })
})

describe("pi-memory-bridge precedence guards", () => {
  test("reports AGENTS.override.md, SYSTEM.md and a trusted project APPEND_SYSTEM.md", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "gh-bridge-guards-"))
    const mirror = path.join(root, "mirror")
    const cwd = path.join(root, "proj")
    try {
      await fs.mkdir(mirror, { recursive: true })
      await fs.mkdir(path.join(cwd, ".pi"), { recursive: true })
      expect(await inspectMirrorPrecedence(mirror, cwd)).toEqual({
        agentsOverride: false,
        systemMd: false,
        projectAppendSystem: null,
        userClaudeMd: null,
      })

      await fs.writeFile(path.join(mirror, "AGENTS.override.md"), "# mine\n")
      await fs.writeFile(path.join(mirror, "SYSTEM.md"), "replace it\n")
      await fs.writeFile(path.join(cwd, ".pi", "APPEND_SYSTEM.md"), "project digest\n")
      expect(await inspectMirrorPrecedence(mirror, cwd)).toEqual({
        agentsOverride: true,
        systemMd: true,
        projectAppendSystem: path.join(cwd, ".pi", "APPEND_SYSTEM.md"),
        userClaudeMd: null,
      })
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  test("reports a user CLAUDE.md that our own AGENTS.md would outrank", async () => {
    // Measured against Pi's `loadProjectContextFiles`: with only `CLAUDE.md` in
    // the agent dir, Pi loads it; once `AGENTS.md` sits beside it, the user's
    // file is dropped, because one context file is read per directory and
    // `AGENTS.md` comes first. Nothing about that launch looks wrong, which is
    // exactly why it has to be reported.
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "gh-bridge-claude-md-"))
    const mirror = path.join(root, "mirror")
    try {
      await fs.mkdir(mirror, { recursive: true })
      const claudeMd = path.join(mirror, "CLAUDE.md")
      await fs.writeFile(claudeMd, "Answer in British English.\n")
      expect((await inspectMirrorPrecedence(mirror, root)).userClaudeMd).toBe(claudeMd)
      // A directory at that path is not a context file Pi would load.
      await fs.rm(claudeMd)
      await fs.mkdir(claudeMd)
      expect((await inspectMirrorPrecedence(mirror, root)).userClaudeMd).toBeNull()
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  test("a user skill of the same name is kept, not overwritten", async () => {    const root = await fs.mkdtemp(path.join(os.tmpdir(), "gh-bridge-skills-"))
    const mirror = path.join(root, "mirror")
    try {
      await fs.mkdir(path.join(mirror, "skills", "gh-oracle"), { recursive: true })
      const userSkill = path.join(mirror, "skills", "gh-oracle", "SKILL.md")
      await fs.writeFile(userSkill, "USER SKILL\n")

      const plan = await planSkillWrites(mirror, [
        { dir: "gh-oracle", content: "ROUTER SKILL\n" },
        { dir: "gh-delegate", content: "ROUTER DELEGATE\n" },
      ])
      expect(plan.write.map((s) => s.dir)).toEqual(["gh-delegate"])
      expect(plan.shadowed.map((s) => s.dir)).toEqual(["gh-oracle"])
      // The user's bytes are untouched.
      expect(await fs.readFile(userSkill, "utf8")).toBe("USER SKILL\n")
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })
})

describe("pi-memory-bridge shadow warnings", () => {
  const mirror = "/m"
  const none = { agentsOverride: false, systemMd: false, projectAppendSystem: null, userClaudeMd: null }

  test("both directions of Pi's one-context-file rule are reported", () => {
    const warnings = bridgeShadowWarnings(
      { ...none, agentsOverride: true, userClaudeMd: "/m/CLAUDE.md" },
      { bridgeActive: true, mirrorDir: mirror },
    )
    expect(warnings).toHaveLength(2)
    expect(warnings[0]).toContain("/m/AGENTS.override.md")
    expect(warnings[0]).toContain("NOT loaded")
    expect(warnings[1]).toContain("/m/CLAUDE.md")
    expect(warnings[1]).toContain("NOT loaded")
  })

  test("neither is reported when no block was written", () => {
    // A launch that bridged nothing left `AGENTS.md` alone, so `CLAUDE.md` still
    // loads and the override shadows nothing of ours. Warning here would send
    // the user to fix a problem that does not exist.
    expect(
      bridgeShadowWarnings(
        { ...none, agentsOverride: true, userClaudeMd: "/m/CLAUDE.md" },
        { bridgeActive: false, mirrorDir: mirror },
      ),
    ).toEqual([])
  })

  test("the CLAUDE.md warning is suppressed when the user already owns AGENTS.md", () => {
    // Pi has preferred `AGENTS.md` over `CLAUDE.md` since before this launch, so
    // the bridge is not the reason the user's CLAUDE.md goes unread. The
    // override warning still fires: that one IS ours to report.
    const warnings = bridgeShadowWarnings(
      { ...none, agentsOverride: true, userClaudeMd: "/m/CLAUDE.md" },
      { bridgeActive: true, mirrorDir: mirror, userOwnsAgentsMd: true },
    )
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain("AGENTS.override.md")
  })

  test("SYSTEM.md and the project APPEND_SYSTEM.md are not this function's job", () => {
    // Those two defeat the launch whether or not a block was written, so the
    // launcher reports them unconditionally at mirror setup. Keeping them out
    // of here is what lets this function gate on `bridgeActive` alone.
    expect(
      bridgeShadowWarnings(
        { ...none, systemMd: true, projectAppendSystem: "/proj/.pi/APPEND_SYSTEM.md" },
        { bridgeActive: false, mirrorDir: mirror },
      ),
    ).toEqual([])
    expect(
      bridgeShadowWarnings(
        { ...none, systemMd: true, projectAppendSystem: "/proj/.pi/APPEND_SYSTEM.md" },
        { bridgeActive: true, mirrorDir: mirror },
      ),
    ).toEqual([])
  })
})

describe("pi-memory-bridge context contract line", () => {
  test("the digest names AGENTS.md only when the bridge wrote one", () => {
    const withBridge = buildPiAppendSystem("local", { peers: true, bridge: true })
    const without = buildPiAppendSystem("local", { peers: true, bridge: false })
    const absent = buildPiAppendSystem("local", { peers: true })
    expect(withBridge).toContain(PI_CONTEXT_CONTRACT_LINE)
    expect(without).not.toContain(PI_CONTEXT_CONTRACT_LINE)
    expect(absent).not.toContain(PI_CONTEXT_CONTRACT_LINE)
    // It says follow-and-cite, not restate: the measured failure mode.
    expect(PI_CONTEXT_CONTRACT_LINE).toContain("do not restate")
    expect(PI_CONTEXT_CONTRACT_LINE.indexOf("AGENTS.md")).toBeGreaterThan(-1)
  })
})
