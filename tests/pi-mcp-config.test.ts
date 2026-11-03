import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { buildPiExtensionSource, buildPiSkills } from "~/lib/pi-extension"
import { buildPiSettingsJson, PI_HELPERS_WEB_ACCESS } from "~/lib/pi-models-settings"
import {
  PI_MCP_NONCE_PLACEHOLDER,
  PI_MCP_SERVER_PREFIX,
  PI_MCP_SESSION_ID_HEADER,
  PI_MCP_WORKSPACE_PLACEHOLDER,
  peersGroupDescription,
  piMcpServerKey,
  readMcpServerKeys,
  resolvePiSurfaces,
  writePiMcpJson,
} from "~/lib/pi-mcp-config"

/**
 * Pi reaches every scoped MCP group through Pi's own `mcp.json`, which
 * built-in MCP reads from the Pi agent dir (the per-launch mirror under
 * `PI_CODING_AGENT_DIR`). Three properties are load-bearing and none is
 * visible from the file we happen to write:
 *
 *  - every key is `gh-router-<group>`, because a project `.pi/mcp.json`
 *    replaces a same-named user-level server wholesale, so a bare `ado` key
 *    would be hijacked by the workspace's own;
 *  - the bearer is the `${GH_ROUTER_HOOK_NONCE}` placeholder, not a token:
 *    the file outlives the token and Pi interpolates from the child env at
 *    connect time;
 *  - the `X-GH-Workspace` header rides the server entry, because native MCP
 *    sends no workspace of its own and the worker tools refuse a call that
 *    names neither one nor the header.
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
    profileId: "cheapest" as const,
    searchEnabled: false,
    bluebirdEnabled: false,
    adoEnabled: false,
    kustoEnabled: false,
    cloudAgentEnabled: false,
    browseAgentAvailable: false,
    directBrowserAvailable: false,
    artifactToolsAvailable: false,
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
    expect(both.groups.map((g) => g.group)).toEqual(["peers", "search", "ado", "kusto"])
    expect(resolvePiSurfaces({ ...base, adoEnabled: true }).groups.map((g) => g.group)).toEqual([
      "peers",
      "search",
      "ado",
    ])
    expect(resolvePiSurfaces({ ...base, kustoEnabled: true }).groups.map((g) => g.group)).toEqual([
      "peers",
      "search",
      "kusto",
    ])
  })

  test("search is unconditional; peers and browser are not", () => {
    // `search` is the one group every launch gets: `code` always answers (it
    // falls back to lexical) and `web` is Copilot-backed, so there is no
    // configuration in which the model should lack it.
    expect(resolvePiSurfaces({ ...base, peersEnabled: false }).groups.map((g) => g.group)).toEqual([
      "search",
    ])
    expect(resolvePiSurfaces({ ...base }).groups.map((g) => g.group)).toEqual(["peers", "search"])
    expect(resolvePiSurfaces({ ...base, directBrowserAvailable: true }).groups.map((g) => g.group)).toEqual(
      ["peers", "search", "browser"],
    )
    // Workers need the browse agent's model, not just the flag.
    expect(resolvePiSurfaces({ ...base, browseAgentAvailable: true }).groups.map((g) => g.group)).toEqual(
      ["peers", "search", "workers"],
    )
  })

  test("each Pi profile publishes the same groups Claude does for it", () => {
    // The pinned-profile branch of `src/claude.ts` and this function must not
    // drift: the four Copilot-led Pi profiles carry the same `allowedGroups`,
    // so the same flags produce the same seven groups on each of them. The
    // local pair diverges by one group (`workers`, never published) and is
    // covered separately.
    const everything = {
      ...base,
      adoEnabled: true,
      kustoEnabled: true,
      cloudAgentEnabled: true,
      browseAgentAvailable: true,
      directBrowserAvailable: true,
    }
    const expected = ["peers", "search", "workers", "browser", "ado", "kusto", "cloudagent"]
    for (const profileId of ["cheapest", "cheapest2", "balanced", "balanced2"] as const) {
      const groups = resolvePiSurfaces({ ...everything, profileId }).groups.map((g) => g.group)
      expect(groups).toEqual(expected)
      // The four standard-only groups are hard denies on every pinned
      // profile, so no flag combination can surface them.
      for (const denied of ["orchestrate", "decide", "fleet", "first-mate"]) {
        expect(groups).not.toContain(denied)
      }
    }
  })

  test("every group key is prefixed and has a description", () => {
    const s = resolvePiSurfaces({
      ...base,
      adoEnabled: true,
      kustoEnabled: true,
      cloudAgentEnabled: true,
      browseAgentAvailable: true,
      directBrowserAvailable: true,
    })
    expect(s.groups.length).toBe(7)
    for (const g of s.groups) {
      expect(piMcpServerKey(g.group)).toBe(`${PI_MCP_SERVER_PREFIX}${g.group}`)
      expect(piMcpServerKey(g.group)).not.toBe(g.group)
      // Under `deferred` exposure this line is the model's only pre-search
      // signal for what the server is, so it has to say something.
      expect(g.description.length).toBeGreaterThan(40)
    }
  })

  test("local profiles never publish workers, whatever the browse agent says", () => {
    // A worker is a Copilot-model subagent, so the group is off both local
    // profiles by descriptor even when its own gate passes.
    const everything = {
      ...base,
      adoEnabled: true,
      kustoEnabled: true,
      cloudAgentEnabled: true,
      browseAgentAvailable: true,
      directBrowserAvailable: true,
      artifactToolsAvailable: true,
    }
    const expected = ["peers", "search", "browser", "ado", "kusto", "cloudagent"]
    for (const profileId of ["local", "local2"] as const) {
      const groups = resolvePiSurfaces({ ...everything, profileId }).groups.map((g) => g.group)
      expect(groups).toEqual(expected)
      expect(groups).not.toContain("workers")
    }
  })
})

describe("peersGroupDescription", () => {
  test("an unrestricted surface keeps the full description", () => {
    // `undefined` means no allow-list; the standard launch surface.
    const text = peersGroupDescription(undefined, false)
    expect(text).toContain("codex_critic")
    expect(text).toContain("oracle")
  })

  test("a filtered surface names only what the filter admits", () => {
    // Every pinned profile registers a list, and naming a critic the MCP
    // handler answers with -32601 costs the model a turn.
    const oracleOnly = peersGroupDescription(new Set(["oracle"]), false)
    expect(oracleOnly).toContain("oracle")
    expect(oracleOnly).not.toContain("codex_critic")

    const empty = peersGroupDescription(new Set<string>(), true)
    expect(empty).not.toContain("oracle")
    expect(empty).toContain("artifact_")
  })

  test("an empty group with no artifact gate yields nothing to publish", () => {
    // `local` keeps the group for the artifact tools alone. Without them the
    // server would be advertised with no tools behind it.
    expect(peersGroupDescription(new Set<string>(), false)).toBe("")
  })

  test("the artifact sentence rides whatever the persona filter admits", () => {
    const both = peersGroupDescription(new Set(["oracle"]), true)
    expect(both).toContain("oracle")
    expect(both).toContain("artifact_")
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
      headers: {
        Authorization: PI_MCP_NONCE_PLACEHOLDER,
        "X-GH-Workspace": PI_MCP_WORKSPACE_PLACEHOLDER,
      },
      exposure: "deferred",
      description: "ado group",
    })
    expect(written.mcpServers["gh-router-kusto"].url).toBe("http://127.0.0.1:8787/mcp/kusto")
    // The placeholders are the whole point: a literal would put a live nonce
    // on disk for the life of the mirror, and native MCP sends no workspace
    // header of its own for the worker tools to read.
    expect(PI_MCP_NONCE_PLACEHOLDER).toBe("Bearer ${GH_ROUTER_HOOK_NONCE}")
    expect(PI_MCP_WORKSPACE_PLACEHOLDER).toBe("${GH_ROUTER_WORKSPACE}")
  })

  test("a launch session id rides every entry as a literal header", async () => {
    // Unlike the bearer, this one is written out: it is a random UUID, not a
    // secret, and the local consult needs a value Pi's env interpolation could
    // not supply. Omission is the other half of the contract — a launch with no
    // id must not leave an empty header behind.
    const mirror = await tmpdir()
    await writePiMcpJson({
      mirrorDir: mirror,
      workspace: await tmpdir(),
      serverUrl: "http://127.0.0.1:8787",
      groups: [ADO, KUSTO],
      sessionId: "9d1f0f6e-6a0f-4c02-8a54-2f0f2f8bb111",
    })
    const written = JSON.parse(await fs.readFile(path.join(mirror, "mcp.json"), "utf8"))
    for (const entry of Object.values<{ headers: Record<string, string> }>(written.mcpServers)) {
      expect(entry.headers[PI_MCP_SESSION_ID_HEADER]).toBe("9d1f0f6e-6a0f-4c02-8a54-2f0f2f8bb111")
    }

    const bare = await tmpdir()
    await writePiMcpJson({
      mirrorDir: bare,
      workspace: await tmpdir(),
      serverUrl: "http://127.0.0.1:8787",
      groups: [ADO],
      sessionId: "   ",
    })
    const bareWritten = JSON.parse(await fs.readFile(path.join(bare, "mcp.json"), "utf8"))
    expect(bareWritten.mcpServers["gh-router-ado"].headers).toEqual({
      Authorization: PI_MCP_NONCE_PLACEHOLDER,
      "X-GH-Workspace": PI_MCP_WORKSPACE_PLACEHOLDER,
    })
  })

  test("every entry is deferred, so no server can stall the first prompt", async () => {
    const mirror = await tmpdir()
    await writePiMcpJson({
      mirrorDir: mirror,
      workspace: await tmpdir(),
      serverUrl: "http://127.0.0.1:8787",
      groups: [ADO, KUSTO],
    })
    const written = JSON.parse(await fs.readFile(path.join(mirror, "mcp.json"), "utf8"))
    for (const entry of Object.values<Record<string, unknown>>(written.mcpServers)) {
      expect(entry["exposure"]).toBe("deferred")
    }
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

  test("a project file declaring our key is reported", async () => {
    const workspace = await tmpdir()
    await fs.mkdir(path.join(workspace, ".pi"), { recursive: true })
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
      { key: "gh-router-kusto", file: path.join(workspace, ".pi", "mcp.json") },
    ])
  })

  test("adapter-only project files are no longer scanned", async () => {
    // Native Pi reads `.pi/mcp.json` and nothing else. Warning about
    // `.mcp.json` or `.pi/mcp-adapter.json` would be a false positive about a
    // file the running Pi never opens.
    const workspace = await tmpdir()
    await fs.mkdir(path.join(workspace, ".pi"), { recursive: true })
    for (const file of [
      path.join(workspace, ".mcp.json"),
      path.join(workspace, ".pi", "mcp-adapter.json"),
    ]) {
      await fs.writeFile(
        file,
        JSON.stringify({ mcpServers: { "gh-router-ado": { url: "https://theirs.test" } } }),
      )
    }

    const result = await writePiMcpJson({
      mirrorDir: await tmpdir(),
      workspace,
      serverUrl: "http://127.0.0.1:8787",
      groups: [ADO],
    })

    expect(result.shadowed).toEqual([])
  })

  test("an unparseable project file produces no warning", async () => {
    const workspace = await tmpdir()
    await fs.mkdir(path.join(workspace, ".pi"), { recursive: true })
    await fs.writeFile(
      path.join(workspace, ".pi", "mcp.json"),
      '{\n  // hand-edited, JSONC\n  "mcpServers": {}\n}\n',
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
    profileId: "cheapest",
    searchEnabled: false,
    bluebirdEnabled: true,
    adoEnabled: false,
    kustoEnabled: false,
    cloudAgentEnabled: false,
    browseAgentAvailable: false,
    directBrowserAvailable: false,
    artifactToolsAvailable: false,
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

describe("native MCP replaced the adapter package", () => {
  test("no packages[] slice carries pi-mcp-adapter", () => {
    // An installed extension that registers `/mcp` replaces built-in MCP for
    // the session, and Pi then never reads `mcp.json` at all. The adapter is
    // therefore not an alternative to native MCP but a blocker for it.
    for (const profileId of ["cheapest", "cheapest2", "balanced", "balanced2"] as const) {
      const settings = buildPiSettingsJson({
        profileId,
        searchEnabled: true,
        browseEnabled: false,
        catalog: [],
      })
      expect(JSON.stringify(settings.packages)).not.toContain("pi-mcp-adapter")
    }
  })

  test("the generated extension is valid TypeScript for every profile", () => {
    const transpiler = new Bun.Transpiler({ loader: "ts" })
    for (const profileId of ["cheapest", "cheapest2", "balanced", "balanced2"] as const) {
      expect(() => transpiler.transformSync(buildPiExtensionSource({ profileId }))).not.toThrow()
    }
    // The checker can fail: an unescaped quote is what a bad template edit
    // produces, and it must not pass silently.
    expect(() => transpiler.transformSync('const a = "x "y"";\n')).toThrow()
  })
})
