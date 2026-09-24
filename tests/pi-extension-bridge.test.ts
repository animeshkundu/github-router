import { describe, expect, test } from "bun:test"

import { buildPiExtensionSource } from "~/lib/pi-extension"
import { buildMirrorBridgeSection } from "~/lib/pi-memory-bridge"

describe("pi bridge MCP contracts", () => {
  test("code_search carries workspace with launch-env fallback", () => {
    const src = buildPiExtensionSource({
      profileId: "cheapest",
      searchEnabled: true,
      browseEnabled: false,
    })
    expect(src).toContain("GH_ROUTER_WORKSPACE")
    expect(src).toContain("X-GH-Workspace")
    // Explicit arg wins, env is the fallback, empty refuses locally.
    expect(src).toContain("params.workspace")
    expect(src).toContain("PI_WORKSPACE")
    expect(src).toContain("a workspace is required")
  })

  test("oracle/advisor send query+context only", () => {
    const src = buildPiExtensionSource({
      profileId: "cheapest",
      searchEnabled: false,
      browseEnabled: false,
    })
    expect(src).toContain('callMcp("peers", "oracle", { query, context }')
    expect(src).not.toContain("model: ORACLE_MODEL")
    expect(src).not.toContain("thinking: ORACLE_THINKING")
    expect(src).not.toContain("model: ADVISOR_MODEL")
    // Decision/options are merged into the MCP brief, not forwarded raw.
    expect(src).toContain("Options considered:")
    expect(src).toContain("Review this plan (advisory)")
  })

  test("browser uses stripped MCP names with tabId schemas", () => {
    const src = buildPiExtensionSource({
      profileId: "cheapest",
      searchEnabled: false,
      browseEnabled: true,
    })
    for (const name of ["open_tab", "navigate", "screenshot", "act", "observe", "extract"]) {
      expect(src).toContain(`"${name}"`)
      expect(src).toContain(`callMcp("browser", "${name}"`)
    }
    expect(src).not.toContain("browser_open_tab")
    expect(src).not.toContain("parameters: BrowserParams")
    expect(src).toContain("tabId is required")
  })
})

describe("pi bridge NUL sanitization", () => {
  test("mirror bridge section strips NUL bytes", () => {
    const { section } = buildMirrorBridgeSection(
      {
        copilotInstructions: [{ file: "a.md", content: "hel\0lo" }],
        unscopedRules: [],
        userGlobal: [],
        scopedRules: [],
        imports: [],
        skipped: [],
      },
      { repoRoot: "/re\0po" },
    )
    expect(section).not.toContain("\0")
    expect(section).toContain("hello")
  })
})
