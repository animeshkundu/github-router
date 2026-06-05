import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"

import { BROWSER_TOOLS } from "~/lib/browser-mcp"
import {
  GROUP_META,
  MCP_GROUPS,
  NON_PERSONA_MCP_TOOLS,
  PERSONAS_READ,
  assertMcpToolSurfaceConsistent,
  isMcpGroup,
  type McpGroup,
} from "~/lib/peer-mcp-personas"

// Cross-cutting verifications for the five-server MCP split. The per-file
// behavior (scoped endpoints, collision fallback, config emit) is covered in
// routes-mcp / codex-mcp-config; this file pins the invariants that span
// modules — the browser MCP-name/wire-name decoupling, the renamed surface,
// the group metadata, and the uniqueness assertion.

describe("GROUP_META + group helpers", () => {
  test("every group has self-consistent metadata", () => {
    for (const g of MCP_GROUPS) {
      const meta = GROUP_META[g]
      expect(meta.preferredKey).toBe(g)
      expect(meta.urlSuffix).toBe(g)
      expect(meta.serverInfoName).toBe(`github-router-${g}`)
    }
  })

  test("MCP_GROUPS is exactly the five intent groups", () => {
    expect(([...MCP_GROUPS] as Array<string>).sort()).toEqual(
      ["browser", "decide", "peers", "search", "workers"].sort(),
    )
  })

  test("isMcpGroup accepts groups and rejects junk", () => {
    for (const g of MCP_GROUPS) expect(isMcpGroup(g)).toBe(true)
    expect(isMcpGroup("peerz")).toBe(false)
    expect(isMcpGroup("all")).toBe(false) // "all" is a scope, not a group
    expect(isMcpGroup(undefined)).toBe(false)
    expect(isMcpGroup(42)).toBe(false)
  })
})

describe("renamed non-persona surface", () => {
  const byName = new Map(NON_PERSONA_MCP_TOOLS.map((t) => [t.toolNameHttp, t]))

  test("search group exposes bare code + web (not the *_search names)", () => {
    expect(byName.get("code")?.group).toBe("search")
    expect(byName.get("web")?.group).toBe("search")
    expect(byName.has("code_search")).toBe(false)
    expect(byName.has("web_search")).toBe(false)
  })

  test("workers group exposes bare explore + implement", () => {
    expect(byName.get("explore")?.group).toBe("workers")
    expect(byName.get("implement")?.group).toBe("workers")
    expect(byName.has("worker_explore")).toBe(false)
    expect(byName.has("worker_implement")).toBe(false)
  })

  test("stand_in keeps its name and lives on decide", () => {
    expect(byName.get("stand_in")?.group).toBe("decide")
  })

  test("every non-persona tool declares a valid group", () => {
    for (const t of NON_PERSONA_MCP_TOOLS) {
      expect(isMcpGroup(t.group)).toBe(true)
    }
  })

  test("personas keep their names (peers group, unchanged)", () => {
    const personaNames = PERSONAS_READ.map((p) => p.toolNameHttp)
    expect(personaNames).toContain("codex_critic")
    expect(personaNames).toContain("opus_critic")
  })
})

describe("browser MCP-name vs wire-name decoupling", () => {
  const browserMcp = NON_PERSONA_MCP_TOOLS.filter((t) => t.group === "browser")

  test("at least the v1 browser surface is present", () => {
    // 19 tools in v1; assert a healthy count rather than an exact number so
    // the test doesn't churn when the surface grows.
    expect(browserMcp.length).toBeGreaterThanOrEqual(15)
  })

  test("MCP-facing browser names are bare (no browser_ prefix)", () => {
    for (const t of browserMcp) {
      expect(t.toolNameHttp.startsWith("browser_")).toBe(false)
    }
    const names = browserMcp.map((t) => t.toolNameHttp)
    expect(names).toContain("navigate")
    expect(names).toContain("open_tab")
  })

  test("BROWSER_TOOLS (the wire source of truth) keep browser_ prefix", () => {
    // The wire name = the original BROWSER_TOOLS toolNameHttp, which the
    // handler closures dispatch to the extension. The spread in
    // peer-mcp-personas strips the prefix from ONLY the MCP-facing name.
    for (const t of BROWSER_TOOLS) {
      expect(t.toolNameHttp.startsWith("browser_")).toBe(true)
    }
    // 1:1 mapping: every bare MCP name is a wire name minus `browser_`.
    const wire = new Set(BROWSER_TOOLS.map((t) => t.toolNameHttp))
    for (const t of browserMcp) {
      expect(wire.has(`browser_${t.toolNameHttp}`)).toBe(true)
    }
  })

  test("handler wire literals in browser-mcp/index.ts are physically unchanged", () => {
    // Directly proves the rename did NOT touch the strings dispatched to the
    // installed extension — so no extension reload is required.
    const src = readFileSync(
      path.join(import.meta.dir, "..", "src", "lib", "browser-mcp", "index.ts"),
      "utf8",
    )
    expect(src).toContain('dispatchBrowserTool("browser_navigate"')
    expect(src).toContain('dispatchBrowserTool("browser_read_page"')
    expect(src).toContain('dispatchBrowserTool("browser_open_tab"')
    // And it must NOT have been rewritten to a bare wire name.
    expect(src).not.toContain('dispatchBrowserTool("navigate"')
  })
})

describe("tool-surface uniqueness invariant", () => {
  test("assertMcpToolSurfaceConsistent passes on the live surface", () => {
    expect(() => assertMcpToolSurfaceConsistent()).not.toThrow()
  })

  test("no tool name collides across the unscoped union", () => {
    const all = [
      ...PERSONAS_READ.map((p) => p.toolNameHttp),
      ...NON_PERSONA_MCP_TOOLS.map((t) => t.toolNameHttp),
    ]
    expect(new Set(all).size).toBe(all.length)
  })

  test("each group's tool names are unique within the group", () => {
    const perGroup = new Map<McpGroup, Array<string>>()
    for (const p of PERSONAS_READ) {
      perGroup.set("peers", [...(perGroup.get("peers") ?? []), p.toolNameHttp])
    }
    for (const t of NON_PERSONA_MCP_TOOLS) {
      perGroup.set(t.group, [...(perGroup.get(t.group) ?? []), t.toolNameHttp])
    }
    for (const [, names] of perGroup) {
      expect(new Set(names).size).toBe(names.length)
    }
  })
})
