import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { buildPiExtensionSource, buildPiSkills } from "~/lib/pi-extension"
import { buildPiSettingsJson, PI_HELPERS_WEB_ACCESS } from "~/lib/pi-models-settings"
import {
  PI_MCP_NONCE_PLACEHOLDER,
  PI_MCP_SERVER_PREFIX,
  piMcpServerKey,
  readMcpServerKeys,
  resolvePiSurfaces,
  writePiMcpJson,
} from "~/lib/pi-mcp-config"

/**
 * Pi reaches the Azure MCP groups through Pi's own `mcp.json`, which
 * `pi-mcp-adapter` reads from the Pi agent dir (the per-launch mirror under
 * `PI_CODING_AGENT_DIR`). Two properties are load-bearing and neither is
 * visible from the file we happen to write:
 *
 *  - every key is `gh-router-<group>`, because the adapter lets a project
 *    `.mcp.json` / `.pi/mcp.json` replace a same-named user-global server
 *    wholesale, so a bare `ado` key would be hijacked by the workspace's own;
 *  - the bearer is the `${GH_ROUTER_HOOK_NONCE}` placeholder, not a token:
 *    the file outlives the token and the adapter interpolates from the child
 *    env at connect time.
 */

const tmpDirs: Array<string> = []

async function tmpdir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "pi-mcp-"))
  tmpDirs.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })))
})

const ADO = { group: "ado", description: "ado group" }
const KUSTO = { group: "kusto", description: "kusto group" }

describe("resolvePiSurfaces", () => {
  const base = {
    searchEnabled: false,
    bluebirdEnabled: false,
    adoEnabled: false,
    kustoEnabled: false,
    helpersEnabled: true,
    peersEnabled: true,
  }

  test("Bluebird opens the code-search seam without --search", () => {
    const s = resolvePiSurfaces({ ...base, bluebirdEnabled: true })
    expect(s.codeSearch).toBe(true)
    expect(s.codeSearchBackend).toBe("bluebird")
    // The separation the seam exists for: `pi-web-access` and the ColBERT
    // skill prose ride `search`, which stays off.
    expect(s.search).toBe(false)
  })

  test("plain --search keeps the ColBERT seam", () => {
    const s = resolvePiSurfaces({ ...base, searchEnabled: true })
    expect(s.codeSearch).toBe(true)
    expect(s.search).toBe(true)
    expect(s.codeSearchBackend).toBe("colbert")
  })

  test("both engines on resolves to Bluebird, as the router does", () => {
    // `runUnifiedCodeSearch` short-circuits to Bluebird for semantic|lexical
    // whenever `state.bluebirdEnabled`, before it consults colgrep.
    const s = resolvePiSurfaces({ ...base, searchEnabled: true, bluebirdEnabled: true })
    expect(s.codeSearchBackend).toBe("bluebird")
  })

  test("neither engine leaves the seam off", () => {
    const s = resolvePiSurfaces(base)
    expect(s.codeSearch).toBe(false)
    expect(s.search).toBe(false)
  })

  test("groups follow their own gates, one entry each", () => {
    const both = resolvePiSurfaces({ ...base, adoEnabled: true, kustoEnabled: true })
    expect(both.groups.map((g) => g.group)).toEqual(["ado", "kusto"])
    expect(resolvePiSurfaces({ ...base, adoEnabled: true }).groups.map((g) => g.group)).toEqual(["ado"])
    expect(resolvePiSurfaces({ ...base, kustoEnabled: true }).groups.map((g) => g.group)).toEqual(["kusto"])
  })

  test("no adapter, no groups: helpers and peers both gate it", () => {
    expect(resolvePiSurfaces({ ...base, adoEnabled: true, kustoEnabled: true, helpersEnabled: false }).groups).toEqual([])
    expect(resolvePiSurfaces({ ...base, adoEnabled: true, kustoEnabled: true, peersEnabled: false }).groups).toEqual([])
  })

  test("every group key is prefixed and has a description", () => {
    const s = resolvePiSurfaces({ ...base, adoEnabled: true, kustoEnabled: true })
    expect(s.groups.length).toBe(2)
    for (const g of s.groups) {
      expect(piMcpServerKey(g.group)).toBe(`${PI_MCP_SERVER_PREFIX}${g.group}`)
      expect(piMcpServerKey(g.group)).not.toBe(g.group)
      expect(g.description.length).toBeGreaterThan(10)
    }
  })
})

describe("writePiMcpJson", () => {
  test("writes one remote entry per group with the nonce placeholder", async () => {
    const mirror = await tmpdir()
    const result = await writePiMcpJson({
      mirrorDir: mirror,
      workspace: await tmpdir(),
      serverUrl: "http://127.0.0.1:8787",
      groups: [ADO, KUSTO],
    })

    expect(result.added).toEqual(["gh-router-ado", "gh-router-kusto"])
    expect(result.skippedReason).toBeUndefined()
    expect(result.shadowed).toEqual([])

    const written = JSON.parse(await fs.readFile(path.join(mirror, "mcp.json"), "utf8"))
    expect(written.mcpServers["gh-router-ado"]).toEqual({
      type: "http",
      url: "http://127.0.0.1:8787/mcp/ado",
      headers: { Authorization: PI_MCP_NONCE_PLACEHOLDER },
      description: "ado group",
    })
    expect(written.mcpServers["gh-router-kusto"].url).toBe("http://127.0.0.1:8787/mcp/kusto")
    // The placeholder is the whole point: a literal would put a live nonce on
    // disk for the life of the mirror.
    expect(PI_MCP_NONCE_PLACEHOLDER).toBe("Bearer ${GH_ROUTER_HOOK_NONCE}")
  })

  test("merges over a user file instead of replacing it", async () => {
    const mirror = await tmpdir()
    const theirServer = {
      command: "npx",
      args: ["-y", "chrome-devtools-mcp@1.6.0"],
    }
    await fs.writeFile(
      path.join(mirror, "mcp.json"),
      JSON.stringify({
        imports: ["cursor"],
        mcpServers: { "chrome-devtools": theirServer },
      }, null, 2),
    )

    const result = await writePiMcpJson({
      mirrorDir: mirror,
      workspace: await tmpdir(),
      serverUrl: "http://127.0.0.1:8787",
      groups: [ADO],
    })

    expect(result.preserved).toEqual(["chrome-devtools"])
    const written = JSON.parse(await fs.readFile(path.join(mirror, "mcp.json"), "utf8"))
    expect(written.mcpServers["chrome-devtools"]).toEqual(theirServer)
    expect(written.mcpServers["gh-router-ado"].url).toBe("http://127.0.0.1:8787/mcp/ado")
    // Unknown top-level keys are the adapter's business, not ours.
    expect(written.imports).toEqual(["cursor"])
  })

  test("a user server named `ado` cannot displace ours", async () => {
    const mirror = await tmpdir()
    const theirAdo = { url: "https://example.test/mcp", headers: { Authorization: "Bearer theirs" } }
    await fs.writeFile(
      path.join(mirror, "mcp.json"),
      JSON.stringify({ mcpServers: { ado: theirAdo } }, null, 2),
    )

    const result = await writePiMcpJson({
      mirrorDir: mirror,
      workspace: await tmpdir(),
      serverUrl: "http://127.0.0.1:8787",
      groups: [ADO],
    })

    expect(result.preserved).toEqual(["ado"])
    const written = JSON.parse(await fs.readFile(path.join(mirror, "mcp.json"), "utf8"))
    expect(Object.keys(written.mcpServers).sort()).toEqual(["ado", "gh-router-ado"])
    expect(written.mcpServers["ado"]).toEqual(theirAdo)
    expect(written.mcpServers["gh-router-ado"].headers.Authorization).toBe(PI_MCP_NONCE_PLACEHOLDER)
  })

  test("an entry already under our own key is replaced", async () => {
    const mirror = await tmpdir()
    await fs.writeFile(
      path.join(mirror, "mcp.json"),
      JSON.stringify({
        mcpServers: { "gh-router-ado": { url: "http://stale.example/mcp/ado" } },
      }, null, 2),
    )

    await writePiMcpJson({
      mirrorDir: mirror,
      workspace: await tmpdir(),
      serverUrl: "http://127.0.0.1:8787",
      groups: [ADO],
    })

    const written = JSON.parse(await fs.readFile(path.join(mirror, "mcp.json"), "utf8"))
    expect(written.mcpServers["gh-router-ado"].url).toBe("http://127.0.0.1:8787/mcp/ado")
  })

  test("a malformed mirror file is left untouched", async () => {
    const mirror = await tmpdir()
    const body = '{ "mcpServers": { "x": '
    await fs.writeFile(path.join(mirror, "mcp.json"), body)

    const result = await writePiMcpJson({
      mirrorDir: mirror,
      workspace: await tmpdir(),
      serverUrl: "http://127.0.0.1:8787",
      groups: [ADO],
    })

    expect(result.skippedReason).toBe("malformed JSON")
    expect(result.added).toEqual([])
    expect(await fs.readFile(path.join(mirror, "mcp.json"), "utf8")).toBe(body)
  })

  test("a project file declaring our key is reported, per file", async () => {
    const workspace = await tmpdir()
    await fs.mkdir(path.join(workspace, ".pi"), { recursive: true })
    await fs.writeFile(
      path.join(workspace, ".mcp.json"),
      JSON.stringify({ mcpServers: { "gh-router-ado": { url: "https://theirs.test" } } }),
    )
    await fs.writeFile(
      path.join(workspace, ".pi", "mcp.json"),
      JSON.stringify({ mcpServers: { "gh-router-kusto": { url: "https://theirs.test" } } }),
    )

    const result = await writePiMcpJson({
      mirrorDir: await tmpdir(),
      workspace,
      serverUrl: "http://127.0.0.1:8787",
      groups: [ADO, KUSTO],
    })

    expect(result.shadowed).toEqual([
      { key: "gh-router-ado", file: path.join(workspace, ".mcp.json") },
      { key: "gh-router-kusto", file: path.join(workspace, ".pi", "mcp.json") },
    ])
  })

  test("an unparseable project file produces no warning", async () => {
    const workspace = await tmpdir()
    // `.pi/mcp-adapter.json` is written by the adapter's own editor, so a
    // JSONC body is a real possibility. No evidence, no warning.
    await fs.mkdir(path.join(workspace, ".pi"), { recursive: true })
    await fs.writeFile(
      path.join(workspace, ".pi", "mcp-adapter.json"),
      '{\n  // adapter settings\n  "settings": {}\n}\n',
    )

    const result = await writePiMcpJson({
      mirrorDir: await tmpdir(),
      workspace,
      serverUrl: "http://127.0.0.1:8787",
      groups: [ADO],
    })

    expect(result.shadowed).toEqual([])
  })

  test("readMcpServerKeys distinguishes absent from empty", () => {
    expect(readMcpServerKeys('{"mcpServers":{}}')).toEqual([])
    expect(readMcpServerKeys('{"settings":{}}')).toEqual([])
    expect(readMcpServerKeys('{"mcpServers":{"a":{}}}')).toEqual(["a"])
    expect(readMcpServerKeys("not json")).toBeNull()
    expect(readMcpServerKeys('["a"]')).toBeNull()
  })
})

describe("the seam does not move the other consumers", () => {
  // Exactly what src/pi.ts passes to each builder for a Bluebird-only launch:
  // `searchEnabled` (the raw flag) to settings + skills, `surfaces.codeSearch`
  // to the extension. These two assertions are what makes that split safe.
  const surfaces = resolvePiSurfaces({
    searchEnabled: false,
    bluebirdEnabled: true,
    adoEnabled: false,
    kustoEnabled: false,
    helpersEnabled: true,
    peersEnabled: true,
  })

  test("pi-web-access still ships (Bluebird is not a web-search backend)", () => {
    const settings = buildPiSettingsJson({
      profileId: "cheapest",
      searchEnabled: surfaces.search,
      browseEnabled: false,
      catalog: [],
      peers: true,
      helpers: true,
      ui: false,
    })
    expect(settings.packages).toContainEqual(PI_HELPERS_WEB_ACCESS)
  })

  test("no ColBERT skill prose is emitted", () => {
    const skills = buildPiSkills({
      profileId: "cheapest",
      peers: true,
      swe: false,
      search: surfaces.search,
    })
    expect(skills.map((s) => s.dir)).not.toContain("gh-search-first")
    // The seam is still on, so this is the prose gate, not a shipped-nothing run.
    expect(surfaces.codeSearch).toBe(true)
  })
})

describe("generated code_search description", () => {
  const build = (searchBackend?: "colbert" | "bluebird") =>
    buildPiExtensionSource({
      profileId: "cheapest",
      searchEnabled: true,
      ...(searchBackend ? { searchBackend } : {}),
      browseEnabled: false,
      peers: true,
    })

  test("Bluebird mode promises no local fallback", () => {
    const src = build("bluebird")
    expect(src).toContain("Azure DevOps")
    expect(src).not.toContain("falls back to lexical")
    // `source:"error"` is emitted as escaped quotes inside the generated
    // string literal; the raw sequence is what a reader of the file sees.
    expect(src).toContain('source \\"error\\"')
  })

  test("the default description is unchanged", () => {
    const src = build()
    expect(src).toContain("falls back to lexical with a label")
    expect(src).not.toContain("Azure DevOps")
    expect(src).toBe(build("colbert"))
  })

  test("both variants are valid TypeScript", () => {
    const transpiler = new Bun.Transpiler({ loader: "ts" })
    expect(() => transpiler.transformSync(build("bluebird"))).not.toThrow()
    expect(() => transpiler.transformSync(build("colbert"))).not.toThrow()
    // The checker can fail: an unescaped quote is what a bad template edit
    // produces, and it must not pass silently.
    expect(() => transpiler.transformSync('const a = "x "y"";\n')).toThrow()
  })
})
