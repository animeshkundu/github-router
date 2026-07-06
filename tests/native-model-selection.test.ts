// Phase 3 — native selection of the four non-Claude models
// (gpt-5.5, gpt-5.3-codex, gemini-3.5-flash, gemini-3.1-pro-preview) in
// Claude Code's model picker.
//
// The mechanism (verified against installed Claude Code 2.1.201): enable
// gateway model discovery AND pre-seed its on-disk cache
// (<CLAUDE_CONFIG_DIR>/cache/gateway-models.json) with the real Copilot
// ids. The cache-read path applies no id filter (the /^(claude|anthropic)/i
// filter is only on the blocked network-fetch path), so the real ids
// surface as picker rows and route through the /v1/messages shim. This
// suite pins: catalog gating, cache schema/content, the additive+presence
// -guarded env injection, and non-regression on the opus/sonnet/haiku
// tier defaults.

import { afterEach, beforeEach, expect, test, describe } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as nodePath from "node:path"

import { PATHS } from "../src/lib/paths"
import {
  clearGatewayModelCache,
  getClaudeCodeEnvVars,
  nativeSelectableModelsInCatalog,
  seedGatewayModelCache,
} from "../src/lib/server-setup"
import { state } from "../src/lib/state"

const FOUR_TARGET_IDS = [
  "gpt-5.5",
  "gpt-5.3-codex",
  "gemini-3.5-flash",
  "gemini-3.1-pro-preview",
] as const

function catalogModel(id: string) {
  return {
    id,
    name: id,
    object: "model",
    vendor: "openai",
    version: "1",
    preview: false,
    model_picker_enabled: true,
    capabilities: {
      family: "gpt",
      object: "model",
      tokenizer: "o200k_base",
      type: "chat",
      supports: { tool_calls: true },
    },
    supported_endpoints: ["/responses"],
  }
}

function setCatalog(ids: ReadonlyArray<string>) {
  state.models = { object: "list", data: ids.map(catalogModel) as never }
}

// getClaudeCodeEnvVars seeds PATHS.CLAUDE_CONFIG_DIR/cache when the catalog
// has targets. Remove that artifact between tests so the router's real
// config dir stays clean (best-effort — never throws).
const REAL_CACHE_FILE = nodePath.join(
  PATHS.CLAUDE_CONFIG_DIR,
  "cache",
  "gateway-models.json",
)
function cleanRealCacheArtifact() {
  try {
    fs.rmSync(REAL_CACHE_FILE, { force: true })
  } catch {
    /* best-effort */
  }
}

let savedModels: typeof state.models
const TOUCHED_ENV = [
  "CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "ANTHROPIC_SMALL_FAST_MODEL",
] as const
let savedEnv: Record<string, string | undefined>

beforeEach(() => {
  savedModels = state.models
  savedEnv = {}
  for (const k of TOUCHED_ENV) {
    savedEnv[k] = process.env[k]
    delete process.env[k]
  }
})

afterEach(() => {
  state.models = savedModels
  for (const k of TOUCHED_ENV) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
  cleanRealCacheArtifact()
})

describe("nativeSelectableModelsInCatalog", () => {
  test("returns [] when the catalog is empty / unset", () => {
    state.models = undefined
    expect(nativeSelectableModelsInCatalog()).toEqual([])
    state.models = { object: "list", data: [] as never }
    expect(nativeSelectableModelsInCatalog()).toEqual([])
  })

  test("returns only the target models present in the catalog (graceful per-tier gating)", () => {
    // Simulate a lower tier where only gpt-5.5 is licensed.
    setCatalog(["claude-opus-4.8", "gpt-5.5"])
    const got = nativeSelectableModelsInCatalog()
    expect(got.map((m) => m.id)).toEqual(["gpt-5.5"])
    expect(got[0].display_name).toBe("GPT-5.5")
  })

  test("returns all four (with the exact -preview gemini id) when all are catalogued", () => {
    setCatalog([...FOUR_TARGET_IDS, "claude-opus-4.8"])
    const ids = nativeSelectableModelsInCatalog().map((m) => m.id)
    expect(ids).toEqual([...FOUR_TARGET_IDS])
    // The exact gemini slug is the preview id — never the bare one.
    expect(ids).toContain("gemini-3.1-pro-preview")
    expect(ids).not.toContain("gemini-3.1-pro")
  })
})

describe("seedGatewayModelCache", () => {
  test("writes the gateway-models cache with the schema Claude Code reads", () => {
    const dir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "gw-cache-"))
    const serverUrl = "http://127.0.0.1:8787"
    const models = [
      { id: "gpt-5.5", display_name: "GPT-5.5" },
      { id: "gemini-3.1-pro-preview", display_name: "Gemini 3.1 Pro (preview)" },
    ]
    const wrote = seedGatewayModelCache(serverUrl, models, dir)
    expect(wrote).toBe(true)

    const file = nodePath.join(dir, "cache", "gateway-models.json")
    expect(fs.existsSync(file)).toBe(true)
    const parsed = JSON.parse(fs.readFileSync(file, "utf-8"))

    // baseUrl MUST equal the ANTHROPIC_BASE_URL Claude Code sees, or the
    // cache is discarded by oxn().
    expect(parsed.baseUrl).toBe(serverUrl)
    // fetchedAt is a required number in Claude Code's cache schema.
    expect(typeof parsed.fetchedAt).toBe("number")
    // Each model is {id, display_name}.
    expect(parsed.models).toEqual(models)
  })

  test("no-op (returns false, writes nothing) when the model list is empty", () => {
    const dir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "gw-cache-"))
    expect(seedGatewayModelCache("http://127.0.0.1:8787", [], dir)).toBe(false)
    expect(fs.existsSync(nodePath.join(dir, "cache", "gateway-models.json"))).toBe(
      false,
    )
  })

  test("best-effort: never throws on an unwritable config dir (returns false)", () => {
    // A path whose parent is a regular file cannot be mkdir'd — the write
    // must be swallowed, not propagated (a missing picker row must never
    // break launch).
    const base = fs.mkdtempSync(nodePath.join(os.tmpdir(), "gw-cache-"))
    const filePath = nodePath.join(base, "not-a-dir")
    fs.writeFileSync(filePath, "x")
    let result: boolean | undefined
    expect(() => {
      result = seedGatewayModelCache(
        "http://127.0.0.1:8787",
        [{ id: "gpt-5.5", display_name: "GPT-5.5" }],
        filePath,
      )
    }).not.toThrow()
    expect(result).toBe(false)
  })

  test("no torn read: no leftover .tmp file after a successful write", () => {
    const dir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "gw-cache-"))
    seedGatewayModelCache(
      "http://127.0.0.1:8787",
      [{ id: "gpt-5.5", display_name: "GPT-5.5" }],
      dir,
    )
    const leftovers = fs
      .readdirSync(nodePath.join(dir, "cache"))
      .filter((f) => f.endsWith(".tmp"))
    expect(leftovers).toEqual([])
  })
})

describe("clearGatewayModelCache", () => {
  test("removes an existing seeded cache file", () => {
    const dir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "gw-cache-"))
    seedGatewayModelCache(
      "http://127.0.0.1:8787",
      [{ id: "gpt-5.5", display_name: "GPT-5.5" }],
      dir,
    )
    const file = nodePath.join(dir, "cache", "gateway-models.json")
    expect(fs.existsSync(file)).toBe(true)
    clearGatewayModelCache(dir)
    expect(fs.existsSync(file)).toBe(false)
  })

  test("never throws when there is no cache file to remove", () => {
    const dir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "gw-cache-"))
    expect(() => clearGatewayModelCache(dir)).not.toThrow()
  })
})

describe("getClaudeCodeEnvVars — native model selection injection", () => {
  test("enables gateway discovery when >=1 target is in the catalog", () => {
    setCatalog([...FOUR_TARGET_IDS])
    const vars = getClaudeCodeEnvVars("http://127.0.0.1:8787")
    expect(vars.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY).toBe("1")
  })

  test("does NOT enable discovery when no target is in the catalog", () => {
    setCatalog(["claude-opus-4.8", "claude-sonnet-5"])
    const vars = getClaudeCodeEnvVars("http://127.0.0.1:8787")
    expect(vars).not.toHaveProperty("CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY")
  })

  test("no targets in catalog → clears any prior seeded cache", () => {
    // Simulate a stale seed from an earlier catalog state.
    fs.mkdirSync(nodePath.dirname(REAL_CACHE_FILE), { recursive: true })
    fs.writeFileSync(
      REAL_CACHE_FILE,
      JSON.stringify({ baseUrl: "http://127.0.0.1:8787", fetchedAt: 1, models: [] }),
    )
    expect(fs.existsSync(REAL_CACHE_FILE)).toBe(true)
    setCatalog(["claude-opus-4.8"])
    getClaudeCodeEnvVars("http://127.0.0.1:8787")
    expect(fs.existsSync(REAL_CACHE_FILE)).toBe(false)
  })

  test("no catalog at all → discovery not enabled (unchanged picker on lesser tiers)", () => {
    state.models = undefined
    const vars = getClaudeCodeEnvVars("http://127.0.0.1:8787")
    expect(vars).not.toHaveProperty("CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY")
  })

  test("presence guard: a user-set CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY value is preserved (not overwritten)", () => {
    setCatalog([...FOUR_TARGET_IDS])
    // User opted out explicitly. The proxy must NOT inject its own value —
    // it leaves the key off `vars` so the parent's value flows through.
    process.env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY = "0"
    const vars = getClaudeCodeEnvVars("http://127.0.0.1:8787")
    expect(vars).not.toHaveProperty("CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY")
  })

  test("ADDITIVE: the injection never overwrites the opus/sonnet/haiku tier defaults, ANTHROPIC_MODEL, or ANTHROPIC_SMALL_FAST_MODEL", () => {
    setCatalog([...FOUR_TARGET_IDS])
    const vars = getClaudeCodeEnvVars("http://127.0.0.1:8787", "claude-opus-4-8[1m]")
    // Enabling native selection must not disturb the tier rows.
    expect(vars.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe("claude-opus-4-8")
    expect(vars.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe("claude-sonnet-5")
    expect(vars.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe("claude-sonnet-5")
    expect(vars.ANTHROPIC_SMALL_FAST_MODEL).toBe("claude-sonnet-5")
    // The active model (from the model arg) is untouched by the injection.
    expect(vars.ANTHROPIC_MODEL).toBe("claude-opus-4-8[1m]")
    // And the injection did add its own additive lever.
    expect(vars.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY).toBe("1")
  })

  test("seeds the gateway-model cache (real Copilot ids) under CLAUDE_CONFIG_DIR when targets are present", () => {
    setCatalog(["gpt-5.5", "gemini-3.1-pro-preview"])
    const vars = getClaudeCodeEnvVars("http://127.0.0.1:8787")
    // CLAUDE_CONFIG_DIR the child reads is where we seed the cache.
    expect(vars.CLAUDE_CONFIG_DIR).toBe(PATHS.CLAUDE_CONFIG_DIR)
    const parsed = JSON.parse(fs.readFileSync(REAL_CACHE_FILE, "utf-8"))
    expect(parsed.baseUrl).toBe("http://127.0.0.1:8787")
    expect(parsed.models.map((m: { id: string }) => m.id)).toEqual([
      "gpt-5.5",
      "gemini-3.1-pro-preview",
    ])
  })
})
