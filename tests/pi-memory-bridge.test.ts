import { describe, expect, test } from "bun:test"

import {
  buildPiMemoryBridgeSection,
  buildPiExtensionSource,
} from "~/lib/pi-extension"
import {
  buildMirrorBridgeSection,
  capMemoryIndex,
  extractAtImports,
  extractScopeGlobs,
  mergeBridgeIntoAgentsMd,
  PI_BRIDGE_FENCE_BEGIN,
  redactSecrets,
  resolveImportsPure,
  ruleMatchesFile,
  splitFrontmatter,
} from "~/lib/pi-memory-bridge"

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
    expect(out.length).toBeLessThanOrEqual(10)
    expect(out[0]?.file.endsWith("b.md")).toBe(true)
  })

  test("caps memory index at 200 lines", () => {
    const raw = Array.from({ length: 300 }, (_, i) => `- memory ${i}`).join("\n")
    expect(capMemoryIndex(raw).split("\n").length).toBeLessThanOrEqual(200)
  })

  test("redacts secrets", () => {
    expect(redactSecrets("key sk-live-abcdefghijklmnop")).not.toContain("sk-live-abcdefghijklmnop")
    expect(redactSecrets("-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----")).toContain(
      "[REDACTED",
    )
  })
})

describe("pi-memory-bridge mirror section", () => {
  test("builds fenced section with lazy pointer list", () => {
    const { section, stats } = buildMirrorBridgeSection(
      {
        copilotInstructions: [{ file: "/r/.github/copilot-instructions.md", content: "use bun" }],
        unscopedRules: [],
        scopedRules: [{ file: "/r/.claude/rules/fe.md", body: "tsx rules", globs: ["**/*.tsx"], source: "claude-rules" }],
        userGlobal: [],
        imports: [],
        skipped: [],
      },
      { repoRoot: "/r" },
    )
    expect(section).toContain(PI_BRIDGE_FENCE_BEGIN)
    expect(section).toContain("use bun")
    expect(section).toContain("Path-scoped rules (lazy)")
    expect(stats.staticFiles).toBe(1)
    expect(stats.scopedRules).toBe(1)
  })

  test("merge is idempotent via fence replace", () => {
    const { section } = buildMirrorBridgeSection(
      {
        copilotInstructions: [{ file: "a", content: "one" }],
        unscopedRules: [],
        scopedRules: [],
        userGlobal: [],
        imports: [],
        skipped: [],
      },
      {},
    )
    const once = mergeBridgeIntoAgentsMd("# mine", section)
    const { section: section2 } = buildMirrorBridgeSection(
      {
        copilotInstructions: [{ file: "a", content: "two" }],
        unscopedRules: [],
        scopedRules: [],
        userGlobal: [],
        imports: [],
        skipped: [],
      },
      {},
    )
    const twice = mergeBridgeIntoAgentsMd(once, section2)
    expect(twice).toContain("# mine")
    expect(twice).toContain("two")
    expect(twice).not.toContain("one")
    expect(twice.split(PI_BRIDGE_FENCE_BEGIN).length).toBe(2)
  })
})

describe("pi-memory-bridge extension", () => {
  test("emits lazy attach + /memory + /context only when bridge present", () => {
    const withBridge = buildPiExtensionSource({
      profileId: "cheapest",
      searchEnabled: false,
      browseEnabled: false,
      bridge: {
        stats: { staticFiles: 1, scopedRules: 1, imports: 0, skipped: 0 },
        scopedRules: [{ file: "f", body: "b", globs: ["**/*.ts"], source: "s" }],
      },
    })
    expect(withBridge).toContain("tool_result")
    expect(withBridge).toContain("memory")
    expect(withBridge).toContain("/context")

    const bare = buildPiExtensionSource({ profileId: "cheapest", searchEnabled: false, browseEnabled: false })
    expect(bare).not.toContain("tool_result")
  })

  test("bridge section builder is fail-open text", () => {
    const lines = buildPiMemoryBridgeSection({
      stats: { staticFiles: 0, scopedRules: 1, imports: 0, skipped: 0 },
      scopedRules: [{ file: "f", body: "b", globs: ["**"], source: "s" }],
    })
    expect(lines.join("\n")).toContain("attached")
  })
})
