/**
 * Tests for the ColBERT semantic-search sidecar.
 *
 * Covers: manifest integrity, the availability-based capability gate
 * (off by default in any unprovisioned env → tool absent, no regression
 * to the {code, web} surface), provisioning (mock download + SHA verify +
 * mismatch rejection), staleness keying + the freshness verdict, the
 * runner's no-fallback status envelopes (building / stale / absent /
 * failed), and lifecycle (PID ledger track/untrack/sweep, boot-time
 * meta reclassification).
 *
 * The download/network and real colgrep execution are NOT exercised here
 * — those are validated by the manual macOS spike documented in the PR.
 * These tests pin the deterministic router-side logic.
 */

import { afterEach, describe, expect, mock, test } from "bun:test"
import fs from "node:fs/promises"
import fsSync from "node:fs"
import os from "node:os"
import path from "node:path"

const REAL_TMPDIR = os.tmpdir()
const TEST_HOME = await fs.mkdtemp(path.join(REAL_TMPDIR, "gh-router-colbert-test-"))
mock.module("node:os", () => ({
  default: { homedir: () => TEST_HOME, tmpdir: () => REAL_TMPDIR },
  homedir: () => TEST_HOME,
  tmpdir: () => REAL_TMPDIR,
}))

const appDir = path.join(TEST_HOME, ".local", "share", "github-router")
const colbertDir = path.join(appDir, "colbert")

/**
 * Write ONLY inside the mocked test home, and abort loudly otherwise.
 *
 * This file installs a process-global `mock.module("node:os")` to point
 * `homedir()` at TEST_HOME, and then writes real files to paths derived from
 * it. Bun applies `mock.module` process-globally and `mock.restore()` cannot
 * undo it, so when this file shared lane 1 with the other ~200 test files —
 * ten of which also mock `node:os` — whichever mock installed last won for
 * everyone. When another file's mock (or the real `os`) was live here, these
 * writes landed on the USER'S REAL `~/.local/share/github-router/colbert/`.
 *
 * That is not hypothetical. It replaced the real `colgrep.exe` with a 6-byte
 * file containing the word "binary", which failed the provisioning smoke test,
 * removed the `.smoke-ok` marker, and silently disabled semantic search on the
 * developer's machine — surfacing only as "semantic search unavailable on this
 * host" with the artifacts apparently present.
 *
 * The file now lives in tests/isolated/ so it gets its own process. This guard
 * is the backstop for the day that isolation is broken again: a test that
 * cannot write where it thinks it is writing must FAIL, not quietly corrupt
 * the machine it is running on.
 */
async function writeInsideTestHome(target: string, content: string): Promise<void> {
  // path.relative, not startsWith: a prefix test accepts a SIBLING such as
  // `<TEST_HOME>-other`, which is outside the sandbox despite sharing a prefix.
  const rel = path.relative(path.resolve(TEST_HOME), path.resolve(target))
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(
      `refusing to write outside the test home — the node:os mock is not active.
`
        + `  target:    ${target}
`
        + `  TEST_HOME: ${TEST_HOME}
`
        + `This means a process-global mock.module collision routed a test write at real user state.`,
    )
  }
  await fs.writeFile(target, content)
}

afterEach(async () => {
  await (await import("../../src/lib/colbert/runner")).__waitForAllInitsForTests()
  await fs.rm(colbertDir, { recursive: true, force: true }).catch(() => {})
  delete process.env.GH_ROUTER_DISABLE_SEMANTIC_SEARCH
})

// ---------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------

describe("colbert manifest", () => {
  test("every platform asset carries a 64-hex sha256", async () => {
    const m = await import("../../src/lib/colbert/manifest")
    const hex = /^[0-9a-f]{64}$/
    for (const [pa, asset] of Object.entries(m.COLGREP_BIN)) {
      expect(hex.test(asset.sha256), `colgrep ${pa}`).toBe(true)
    }
    for (const [pa, asset] of Object.entries(m.ORT_LIB)) {
      expect(hex.test(asset.sha256), `ort ${pa}`).toBe(true)
    }
    for (const f of m.MODEL_FILES) {
      expect(hex.test(f.sha256), `model ${f.name}`).toBe(true)
    }
  })

  test("model revision is a 40-hex commit sha (version-pinned)", async () => {
    const m = await import("../../src/lib/colbert/manifest")
    expect(/^[0-9a-f]{40}$/.test(m.MODEL_REVISION)).toBe(true)
  })

  test("ships INT8 model only (no FP32 model.onnx)", async () => {
    const m = await import("../../src/lib/colbert/manifest")
    const names = m.MODEL_FILES.map((f) => f.name)
    expect(names).toContain("model_int8.onnx")
    expect(names).not.toContain("model.onnx")
  })

  test("colbertPlatformSupported true for win/darwin/linux x64, false for unknown", async () => {
    const m = await import("../../src/lib/colbert/manifest")
    expect(m.colbertPlatformSupported("win32", "x64")).toBe(true)
    expect(m.colbertPlatformSupported("darwin", "arm64")).toBe(true)
    expect(m.colbertPlatformSupported("linux", "x64")).toBe(true)
    expect(m.colbertPlatformSupported("sunos" as NodeJS.Platform, "mips")).toBe(false)
  })

  test("colgrep darwin/linux assets are tar.xz; windows is zip", async () => {
    const m = await import("../../src/lib/colbert/manifest")
    expect(m.COLGREP_BIN["darwin-arm64"].archive).toBe("tar.xz")
    expect(m.COLGREP_BIN["linux-x64"].archive).toBe("tar.xz")
    expect(m.COLGREP_BIN["win32-x64"].archive).toBe("zip")
  })
})

// ---------------------------------------------------------------------
// Child-env credential strip (security: no router secret reaches colgrep)
// ---------------------------------------------------------------------

describe("dropColgrepSecrets (child-env credential strip)", () => {
  test("drops router credentials + GH_ROUTER_* but keeps benign env", async () => {
    const { dropColgrepSecrets } = await import("../../src/lib/colbert/provision")
    const env = dropColgrepSecrets({
      PATH: "/usr/bin",
      HOME: "/home/x",
      COLGREP_DATA_DIR: "/data",
      ORT_DYLIB_PATH: "/lib/ort.dylib",
      GITHUB_TOKEN: "gho_secret",
      ANTHROPIC_AUTH_TOKEN: "sk-ant",
      ANTHROPIC_API_KEY: "sk-ant2",
      OPENAI_API_KEY: "sk-oai",
      COPILOT_TOKEN: "cop_secret",
      GH_ROUTER_WORKER_MAX_TURNS: "30",
      GH_ROUTER_ANYTHING: "x",
    })
    for (const k of [
      "GITHUB_TOKEN",
      "ANTHROPIC_AUTH_TOKEN",
      "ANTHROPIC_API_KEY",
      "OPENAI_API_KEY",
      "COPILOT_TOKEN",
      "GH_ROUTER_WORKER_MAX_TURNS",
      "GH_ROUTER_ANYTHING",
    ]) {
      expect(env[k], `${k} must be stripped`).toBeUndefined()
    }
    expect(env.PATH).toBe("/usr/bin")
    expect(env.HOME).toBe("/home/x")
    expect(env.COLGREP_DATA_DIR).toBe("/data")
    expect(env.ORT_DYLIB_PATH).toBe("/lib/ort.dylib")
  })

  test("operates on the caller's copy, never the live process.env", async () => {
    const { dropColgrepSecrets } = await import("../../src/lib/colbert/provision")
    process.env.GH_ROUTER_TEST_SENTINEL = "present"
    try {
      dropColgrepSecrets({ ...process.env })
      expect(process.env.GH_ROUTER_TEST_SENTINEL).toBe("present")
    } finally {
      delete process.env.GH_ROUTER_TEST_SENTINEL
    }
  })
})

// ---------------------------------------------------------------------
// Capability gate — off by default in an unprovisioned env
// ---------------------------------------------------------------------

describe("semanticSearchEnabled (internal colgrep-availability predicate)", () => {
  test("false when artifacts are absent (CI / sandbox / pre-provision)", async () => {
    const cap = await import("../../src/lib/mcp-capabilities")
    // No artifacts on disk in the temp home → gate must be false so the
    // tool is invisible and the {code, web} surface is unchanged.
    expect(cap.semanticSearchEnabled()).toBe(false)
  })

  test("false when opted out even if (hypothetically) present", async () => {
    process.env.GH_ROUTER_DISABLE_SEMANTIC_SEARCH = "1"
    const cap = await import("../../src/lib/mcp-capabilities")
    expect(cap.semanticSearchEnabled()).toBe(false)
  })

  test("true only when artifacts present AND smoke ok AND not opted out", async () => {
    // Synthesize the on-disk presence the gate checks.
    const prov = await import("../../src/lib/colbert/provision")
    const binDir = path.dirname(prov.colgrepBinaryPath())
    const modelDir = prov.colbertModelDir()
    const ortPath = prov.colbertOrtDylibPath()
    await fs.mkdir(binDir, { recursive: true })
    await fs.mkdir(modelDir, { recursive: true })
    await fs.mkdir(path.dirname(ortPath), { recursive: true })
    await writeInsideTestHome(prov.colgrepBinaryPath(), "binary")
    await fs.writeFile(path.join(modelDir, "model_int8.onnx"), "model")
    await fs.writeFile(ortPath, "dylib")
    // smoke marker — must match the version-keyed content colbertSmokeOk
    // validates (binary + ORT SHAs + model revision from the manifest).
    await fs.mkdir(colbertDir, { recursive: true })
    const man = await import("../../src/lib/colbert/manifest")
    const validMarker =
      `colbert-smoke-ok\n` +
      `binary=${man.colgrepBinAsset()!.sha256}\n` +
      `ort=${man.ortLibAsset()!.sha256}\n` +
      `model=${man.MODEL_REVISION}\n`
    await fs.writeFile(path.join(colbertDir, ".smoke-ok"), validMarker)

    const cap = await import("../../src/lib/mcp-capabilities")
    expect(prov.colbertArtifactsPresent()).toBe(true)
    expect(prov.colbertSmokeOk()).toBe(true)
    expect(cap.semanticSearchEnabled()).toBe(true)

    // Removing the smoke marker flips the gate off (handoff guard).
    await fs.rm(path.join(colbertDir, ".smoke-ok"), { force: true })
    expect(cap.semanticSearchEnabled()).toBe(false)
  })

  test("a stale (wrong-version) smoke marker is rejected (re-pin invalidates)", async () => {
    const prov = await import("../../src/lib/colbert/provision")
    const binDir = path.dirname(prov.colgrepBinaryPath())
    const modelDir = prov.colbertModelDir()
    const ortPath = prov.colbertOrtDylibPath()
    await fs.mkdir(binDir, { recursive: true })
    await fs.mkdir(modelDir, { recursive: true })
    await fs.mkdir(path.dirname(ortPath), { recursive: true })
    await writeInsideTestHome(prov.colgrepBinaryPath(), "binary")
    await fs.writeFile(path.join(modelDir, "model_int8.onnx"), "model")
    await fs.writeFile(ortPath, "dylib")
    await fs.mkdir(colbertDir, { recursive: true })
    // A marker from an OLD artifact set (wrong SHAs) must NOT satisfy the
    // gate — colbertSmokeOk validates the marker against current manifest
    // SHAs so a re-pin can't leave a stale "ready" advertisement.
    await fs.writeFile(
      path.join(colbertDir, ".smoke-ok"),
      "colbert-smoke-ok\nbinary=DEADBEEF\nort=DEADBEEF\nmodel=DEADBEEF\n",
    )
    expect(prov.colbertArtifactsPresent()).toBe(true)
    expect(prov.colbertSmokeOk()).toBe(false) // stale marker rejected
  })
})

// ---------------------------------------------------------------------
// Physical index integrity
// ---------------------------------------------------------------------

describe("index-store: PLAID shard integrity", () => {
  async function shardDir(rows: Array<unknown>): Promise<string> {
    const dir = await fs.mkdtemp(path.join(TEST_HOME, "shards-"))
    for (let i = 0; i < rows.length; i++) {
      const value = rows[i]
      await fs.writeFile(
        path.join(dir, `${i}.metadata.json`),
        typeof value === "string" ? value : JSON.stringify(value),
      )
    }
    return dir
  }

  test("coherent contiguous shards", async () => {
    const { validateIndexIntegrity } = await import("../../src/lib/colbert/index-store")
    const dir = await shardDir([
      { embedding_offset: 0, num_embeddings: 4 },
      { embedding_offset: 4, num_embeddings: 3 },
    ])
    expect(validateIndexIntegrity(dir)).toEqual({
      verdict: "coherent",
      shardCount: 2,
      embeddingCount: 7,
    })
  })

  test("zero shards is not-built", async () => {
    const { validateIndexIntegrity } = await import("../../src/lib/colbert/index-store")
    const dir = await shardDir([])
    expect(validateIndexIntegrity(dir)).toEqual({ verdict: "not-built" })
  })

  test("condemns overlaps and malformed JSON, but only flags gaps as suspect", async () => {
    const { validateIndexIntegrity } = await import("../../src/lib/colbert/index-store")
    const gap = await shardDir([
      { embedding_offset: 0, num_embeddings: 2 },
      { embedding_offset: 3, num_embeddings: 1 },
    ])
    const overlap = await shardDir([
      { embedding_offset: 0, num_embeddings: 3 },
      { embedding_offset: 2, num_embeddings: 1 },
    ])
    const offsetStart = await shardDir([
      { embedding_offset: 1, num_embeddings: 2 },
    ])
    const fractional = await shardDir([
      { embedding_offset: 0, num_embeddings: 1.5 },
    ])
    const malformed = await shardDir(["{"])
    // A gap is NOT proven illegal, and condemning deletes the index — so it
    // must never reach the destructive path.
    expect(validateIndexIntegrity(gap).verdict).toBe("suspect")
    expect(validateIndexIntegrity(offsetStart).verdict).toBe("suspect")
    expect(validateIndexIntegrity(overlap).verdict).toBe("corrupt")
    expect(validateIndexIntegrity(fractional).verdict).toBe("corrupt")
    expect(validateIndexIntegrity(malformed).verdict).toBe("corrupt")
  })

  test("a suspect layout falls back without deleting the index", async () => {
    const { freshnessVerdict } = await import("../../src/lib/colbert/index-store")
    expect(typeof freshnessVerdict).toBe("function")
    // Gaps map to `stale`, which rebuilds in the background and leaves the
    // bytes on disk — never `corrupt`, which quarantines and deletes.
    const gap = await shardDir([
      { embedding_offset: 0, num_embeddings: 2 },
      { embedding_offset: 5, num_embeddings: 1 },
    ])
    const { validateIndexIntegrity } = await import("../../src/lib/colbert/index-store")
    expect(validateIndexIntegrity(gap).verdict).not.toBe("corrupt")
  })
})

// ---------------------------------------------------------------------
// Staleness keying + freshness verdict
// ---------------------------------------------------------------------

describe("index-store: meta keying + freshness verdict", () => {
  test("metaHashForWorkspace is stable + path-keyed", async () => {
    const store = await import("../../src/lib/colbert/index-store")
    const a = store.metaHashForWorkspace("/tmp/repo-a")
    const a2 = store.metaHashForWorkspace("/tmp/repo-a")
    const b = store.metaHashForWorkspace("/tmp/repo-b")
    expect(a).toBe(a2) // deterministic
    expect(a).not.toBe(b) // distinct workspaces → distinct keys
    expect(/^[0-9a-f]{8}$/.test(a)).toBe(true)
  })

  test("absent meta → verdict absent", async () => {
    const store = await import("../../src/lib/colbert/index-store")
    const v = await store.freshnessVerdict("/tmp/never-indexed-xyz")
    expect(v.verdict).toBe("absent")
  })

  test("status:building → verdict building (no spawn)", async () => {
    const store = await import("../../src/lib/colbert/index-store")
    const ws = path.join(TEST_HOME, "ws-building")
    await store.writeColbertMeta({
      workspace: ws,
      model: "LateOn-Code-edge",
      modelRev: "rev",
      status: "building",
      buildPid: process.pid,
    })
    const v = await store.freshnessVerdict(ws)
    expect(v.verdict).toBe("building")
  })

  test("status:failed → verdict failed", async () => {
    const store = await import("../../src/lib/colbert/index-store")
    const ws = path.join(TEST_HOME, "ws-failed")
    await store.writeColbertMeta({
      workspace: ws,
      model: "LateOn-Code-edge",
      modelRev: "rev",
      status: "failed",
    })
    const v = await store.freshnessVerdict(ws)
    expect(v.verdict).toBe("failed")
  })

  test("status:ready with corrupt physical shards → corrupt (never fake-ready)", async () => {
    const store = await import("../../src/lib/colbert/index-store")
    const prov = await import("../../src/lib/colbert/provision")
    const manifest = await import("../../src/lib/colbert/manifest")
    const { PATHS } = await import("../../src/lib/paths")
    const ws = path.join(TEST_HOME, "ws-ready-corrupt")
    await fs.mkdir(ws, { recursive: true })
    const projectDir = path.join(PATHS.COLBERT_INDICES_DIR, "corrupt-project")
    await fs.mkdir(path.join(projectDir, "index"), { recursive: true })
    await fs.writeFile(
      path.join(projectDir, "project.json"),
      JSON.stringify({ project_path: ws, model: prov.canonicalColbertModelDir() }),
    )
    // Overlapping intervals — unambiguous corruption. A gap would only be
    // `suspect` and must NOT reach the destructive path.
    await fs.writeFile(
      path.join(projectDir, "index", "0.metadata.json"),
      JSON.stringify({ embedding_offset: 0, num_embeddings: 3 }),
    )
    await fs.writeFile(
      path.join(projectDir, "index", "1.metadata.json"),
      JSON.stringify({ embedding_offset: 2, num_embeddings: 1 }),
    )
    await store.writeColbertMeta({
      workspace: ws,
      model: "LateOn-Code-edge",
      modelRev: "rev",
      binarySha: manifest.colgrepBinAsset()?.sha256,
      ortSha: manifest.ortLibAsset()?.sha256,
      status: "ready",
    })
    expect((await store.freshnessVerdict(ws)).verdict).toBe("corrupt")
  })

  test("status:ready but no completed index on disk → building (never fake-ready)", async () => {
    const store = await import("../../src/lib/colbert/index-store")
    const ws = path.join(TEST_HOME, "ws-ready-no-index")
    await store.writeColbertMeta({
      workspace: ws,
      model: "LateOn-Code-edge",
      modelRev: "rev",
      status: "ready",
      lastIndexedHead: "deadbeef",
    })
    // No COLGREP_DATA_DIR project dir exists → completedIndexOnDisk false.
    const v = await store.freshnessVerdict(ws)
    expect(v.verdict).toBe("building")
  })

  test("building with a DEAD/absent build PID + no index → verdict crashed", async () => {
    const store = await import("../../src/lib/colbert/index-store")
    store.__resetInitDebounceForTests() // ensure no in-flight init for ws
    const ws = path.join(TEST_HOME, "ws-crashed")
    await store.writeColbertMeta({
      workspace: ws,
      model: "LateOn-Code-edge",
      modelRev: "rev",
      status: "building",
      // No buildPid → treated as not-running; no init in flight + no index
      // on disk → a crashed-mid-build escapee.
    })
    const v = await store.freshnessVerdict(ws)
    expect(v.verdict).toBe("crashed")
  })

  test("building with a LIVE build PID → still building (never reclassified)", async () => {
    const store = await import("../../src/lib/colbert/index-store")
    const ws = path.join(TEST_HOME, "ws-building-live")
    await store.writeColbertMeta({
      workspace: ws,
      model: "LateOn-Code-edge",
      modelRev: "rev",
      status: "building",
      buildPid: process.pid, // this test process — definitely alive
    })
    const v = await store.freshnessVerdict(ws)
    expect(v.verdict).toBe("building")
  })

  test("building, no PID, RECENT start → grace (building); OLD start → crashed", async () => {
    const store = await import("../../src/lib/colbert/index-store")
    store.__resetInitDebounceForTests()
    const mk = async (name: string, ageMs: number) => {
      const ws = path.join(TEST_HOME, name)
      await store.writeColbertMeta({
        workspace: ws,
        model: "LateOn-Code-edge",
        modelRev: "rev",
        status: "building",
        lastIndexedAt: new Date(Date.now() - ageMs).toISOString(),
      })
      return ws
    }
    // Within the 30s spawn-grace → cross-process spawn window, not crashed.
    expect((await store.freshnessVerdict(await mk("ws-grace", 1000))).verdict).toBe(
      "building",
    )
    // Past the grace, dead/absent PID, no index → crashed.
    expect(
      (await store.freshnessVerdict(await mk("ws-grace-old", 120_000))).verdict,
    ).toBe("crashed")
  })

  test("init debounce: second claim returns false until released", async () => {
    const store = await import("../../src/lib/colbert/index-store")
    store.__resetInitDebounceForTests()
    const ws = "/tmp/debounce-ws"
    expect(store.tryClaimInit(ws)).toBe(true)
    expect(store.isInitInFlight(ws)).toBe(true)
    expect(store.tryClaimInit(ws)).toBe(false) // already claimed
    store.releaseInit(ws)
    expect(store.isInitInFlight(ws)).toBe(false)
    expect(store.tryClaimInit(ws)).toBe(true) // free again
    store.releaseInit(ws)
  })
})

// ---------------------------------------------------------------------
// Runner — no-fallback status envelopes
// ---------------------------------------------------------------------

describe("index progress probe (shared init/search stall signal)", () => {
  test("indexDirSignature + makeIndexProgressProbe: only an OBSERVED frozen signature is a stall", async () => {
    const store = await import("../../src/lib/colbert/index-store")
    const { makeIndexProgressProbe } = await import("../../src/lib/colbert/runner")
    const { PATHS } = await import("../../src/lib/paths")

    // No project dir yet → `not-created`, which is the ABSENCE of evidence.
    // It must never be read as a stall, no matter how many times it repeats.
    // The previous contract gave one window of grace and then killed the
    // build; on Windows the path comparison could never match colgrep's
    // extended-length `project_path`, so this branch fired on every tick and
    // killed healthy, actively-writing builds — which were then classified
    // `stuck` and refused forever at a cap of 2. That was the outage.
    const unknown = path.join(TEST_HOME, "probe-unknown")
    fsSync.mkdirSync(unknown, { recursive: true })
    // Either non-observed state is correct here and both must be fail-safe:
    // `unknown` when the store dir itself is not readable yet, `not-created`
    // once it is but this workspace has no project dir.
    expect(store.indexDirSignature(unknown).kind).not.toBe("observed")
    const pUnknown = makeIndexProgressProbe(unknown)
    for (let i = 0; i < 5; i++) {
      expect(pUnknown()).toBe(true) // never a stall without evidence
    }

    // A real colgrep-style project dir whose project.json points at `ws`.
    const ws = path.join(TEST_HOME, "probe-ws")
    fsSync.mkdirSync(ws, { recursive: true })
    const projDir = path.join(PATHS.COLBERT_INDICES_DIR, "probe-proj")
    fsSync.mkdirSync(path.join(projDir, "index"), { recursive: true })
    fsSync.writeFileSync(
      path.join(projDir, "project.json"),
      JSON.stringify({ path: ws }),
    )
    fsSync.writeFileSync(path.join(projDir, "index", "a"), "x".repeat(10))

    const sig1 = store.indexDirSignature(ws)
    expect(sig1.kind).toBe("observed")

    const probe = makeIndexProgressProbe(ws)
    expect(probe()).toBe(true) // first concrete observation starts the clock
    // Observed, and unchanged since baseline → genuinely frozen.
    expect(probe()).toBe(false)
    // Grow the index dir → progressing again.
    fsSync.writeFileSync(path.join(projDir, "index", "b"), "y".repeat(100))
    expect(probe()).toBe(true)
    // Frozen again.
    expect(probe()).toBe(false)
  })

  test("indexDirSignature matches colgrep's Windows extended-length project_path", async () => {
    const store = await import("../../src/lib/colbert/index-store")
    const { PATHS } = await import("../../src/lib/paths")

    // colgrep writes `project_path` in extended-length form on Windows — 50
    // of 53 dirs on the machine where this was diagnosed. The old
    // canonicalization normalized that to `//?/q:/...` and compared it
    // against `q:/...`, so it NEVER matched and the probe was blind.
    const ws = path.join(TEST_HOME, "probe-extended")
    fsSync.mkdirSync(ws, { recursive: true })
    const stored =
      process.platform === "win32" ? `\\\\?\\${path.resolve(ws)}` : ws

    const projDir = path.join(PATHS.COLBERT_INDICES_DIR, "probe-extended-proj")
    fsSync.mkdirSync(path.join(projDir, "index"), { recursive: true })
    fsSync.writeFileSync(
      path.join(projDir, "project.json"),
      JSON.stringify({ project_path: stored }),
    )
    fsSync.writeFileSync(path.join(projDir, "index", "a"), "x".repeat(10))

    expect(store.indexDirSignature(ws).kind).toBe("observed")
  })
})

describe("runner result normalization", () => {
  test("relativize handles extended-length drive and UNC paths", async () => {
    const { relativize } = await import("../../src/lib/colbert/runner")
    expect(
      relativize(
        "\\\\?\\C:\\repo\\src\\file.ts",
        "C:\\repo",
        "\\\\?\\C:\\repo",
      ),
    ).toBe("src\\file.ts")
    expect(
      relativize(
        "\\\\?\\UNC\\server\\share\\repo\\src\\file.ts",
        "\\\\server\\share\\repo",
        "\\\\?\\UNC\\server\\share\\repo",
      ),
    ).toBe("src\\file.ts")
  })

  test("buildSnippet does not duplicate an indented signature", async () => {
    const { buildSnippet } = await import("../../src/lib/colbert/runner")
    expect(
      buildSnippet({
        signature: 'const auth = req.headers.authorization ?? ""',
        code: '  const auth = req.headers.authorization ?? ""\n  return auth',
      }),
    ).toBe('  const auth = req.headers.authorization ?? ""\n  return auth')
  })
})

describe("runSemanticSearch: no-fallback contract", () => {
  test("absent workspace → unavailable isError (no other search run)", async () => {
    const store = await import("../../src/lib/colbert/index-store")
    store.__resetInitDebounceForTests()
    const { runSemanticSearch } = await import("../../src/lib/colbert/runner")
    const r = await runSemanticSearch({
      query: "auth",
      workspace: path.join(TEST_HOME, "absent-ws"),
    })
    expect(r.status).toBe("unavailable")
    expect(r.isError).toBe(true)
    expect(r.results).toBeUndefined() // never ran a fallback search
    expect(r.notice).toMatch(/code_search/i)
  })

  test("building index → building notice, NOT isError, NO results", async () => {
    const store = await import("../../src/lib/colbert/index-store")
    const ws = path.join(TEST_HOME, "ws-runner-building")
    await store.writeColbertMeta({
      workspace: ws,
      model: "LateOn-Code-edge",
      modelRev: "rev",
      status: "building",
      buildPid: process.pid,
    })
    const { runSemanticSearch } = await import("../../src/lib/colbert/runner")
    const r = await runSemanticSearch({ query: "auth", workspace: ws })
    expect(r.status).toBe("building")
    expect(r.isError).not.toBe(true)
    expect(r.results).toBeUndefined()
    expect(r.notice).toBeTruthy()
  })

  test("corrupt index is quarantined and rebuilt into a working index", async () => {
    const store = await import("../../src/lib/colbert/index-store")
    const prov = await import("../../src/lib/colbert/provision")
    const manifest = await import("../../src/lib/colbert/manifest")
    const { PATHS } = await import("../../src/lib/paths")
    const runner = await import("../../src/lib/colbert/runner")
    store.__resetInitDebounceForTests()
    const ws = path.join(TEST_HOME, "ws-runner-corrupt")
    await fs.mkdir(ws, { recursive: true })
    await fs.mkdir(path.dirname(prov.colgrepBinaryPath()), { recursive: true })
    await fs.mkdir(path.dirname(prov.colbertOrtDylibPath()), { recursive: true })
    await writeInsideTestHome(prov.colgrepBinaryPath(), "binary")
    await fs.writeFile(prov.colbertOrtDylibPath(), "runtime")
    const projectDir = path.join(PATHS.COLBERT_INDICES_DIR, "runner-corrupt")
    await fs.mkdir(path.join(projectDir, "index"), { recursive: true })
    await fs.writeFile(
      path.join(projectDir, "project.json"),
      JSON.stringify({ project_path: ws, model: prov.canonicalColbertModelDir() }),
    )
    // Overlapping intervals — unambiguous corruption, so this legitimately
    // reaches quarantine. A gap alone would only be `suspect`.
    await fs.writeFile(
      path.join(projectDir, "index", "0.metadata.json"),
      JSON.stringify({ embedding_offset: 0, num_embeddings: 3 }),
    )
    await fs.writeFile(
      path.join(projectDir, "index", "1.metadata.json"),
      JSON.stringify({ embedding_offset: 2, num_embeddings: 1 }),
    )
    await store.writeColbertMeta({
      workspace: ws,
      model: "LateOn-Code-edge",
      modelRev: "rev",
      binarySha: manifest.colgrepBinAsset()?.sha256,
      ortSha: manifest.ortLibAsset()?.sha256,
      status: "ready",
    })

    runner.__setInitRunnerForTests((async () => {
      await fs.mkdir(path.join(projectDir, "index"), { recursive: true })
      await fs.writeFile(
        path.join(projectDir, "project.json"),
        JSON.stringify({ project_path: ws, model: prov.canonicalColbertModelDir() }),
      )
      await fs.writeFile(
        path.join(projectDir, "index", "0.metadata.json"),
        JSON.stringify({ embedding_offset: 0, num_embeddings: 3 }),
      )
      return {
        stdout: "",
        stderr: "",
        code: 0,
        timedOut: false,
        stdoutTruncated: false,
        stalled: false,
      }
    }) as never)
    try {
      const first = await runner.runSemanticSearch({ query: "auth", workspace: ws })
      expect(first.notice).toMatch(/corrupt.*rebuild/i)
      await runner.__waitForInitForTests(ws)

      const meta = await store.readColbertMeta(ws)
      expect(meta?.status).toBe("ready")
      expect(meta?.failedAttempts).toBe(0)
      expect(store.validateIndexIntegrity(path.join(projectDir, "index")).verdict).toBe("coherent")
      expect(await store.freshnessVerdict(ws)).toMatchObject({ verdict: "fresh" })
    } finally {
      runner.__setInitRunnerForTests(undefined)
    }
  })

  test("corrupt rebuild cap is operator-actionable and restart allows an under-cap retry", async () => {
    const store = await import("../../src/lib/colbert/index-store")
    const { startupKickAllowed } = await import("../../src/lib/colbert/runner")
    const ws = path.join(TEST_HOME, "ws-corrupt-cap")
    const base = {
      workspace: ws,
      model: "LateOn-Code-edge",
      modelRev: "rev",
      status: "failed" as const,
      failureClass: "corrupt" as const,
    }
    await store.writeColbertMeta({ ...base, failedAttempts: 1 })
    expect(await startupKickAllowed(ws)).toBe(true)
    await store.writeColbertMeta({ ...base, failedAttempts: 2 })
    expect(await startupKickAllowed(ws)).toBe(false)
    const result = await (await import("../../src/lib/colbert/runner")).runSemanticSearch({ query: "auth", workspace: ws })
    expect(result.notice).toMatch(/unavailable.*corrupt/i)
    expect(result.notice).not.toMatch(/re-index was started/i)
  })

  test("missing rebuild runtime is persisted and logged visibly", async () => {
    const store = await import("../../src/lib/colbert/index-store")
    const runner = await import("../../src/lib/colbert/runner")
    store.__resetInitDebounceForTests()
    const ws = path.join(TEST_HOME, "ws-init-launch-failure")
    await fs.mkdir(ws, { recursive: true })
    const errorSpy = mock(() => undefined)
    const consola = (await import("consola")).default
    const originalError = consola.error
    consola.error = errorSpy as unknown as typeof consola.error
    try {
      runner.kickBackgroundInit(ws)
      await runner.__waitForInitForTests(ws)
      const meta = await store.readColbertMeta(ws)
      expect(meta).toMatchObject({
        status: "failed",
        failureClass: "launch",
        failedAttempts: 1,
      })
      expect(errorSpy).toHaveBeenCalled()
      expect(store.isInitInFlight(ws)).toBe(false)
    } finally {
      consola.error = originalError
    }
  })

  test("failed index → failed isError, NO results", async () => {
    const store = await import("../../src/lib/colbert/index-store")
    const ws = path.join(TEST_HOME, "ws-runner-failed")
    await store.writeColbertMeta({
      workspace: ws,
      model: "LateOn-Code-edge",
      modelRev: "rev",
      status: "failed",
    })
    const { runSemanticSearch } = await import("../../src/lib/colbert/runner")
    const r = await runSemanticSearch({ query: "auth", workspace: ws })
    expect(r.status).toBe("failed")
    expect(r.isError).toBe(true)
    expect(r.results).toBeUndefined()
  })

  test("failed (transient, under cap, backoff elapsed) → self-heal kicks + retry notice", async () => {
    const store = await import("../../src/lib/colbert/index-store")
    store.__resetInitDebounceForTests()
    const ws = path.join(TEST_HOME, "ws-failed-retry")
    await store.writeColbertMeta({
      workspace: ws,
      model: "LateOn-Code-edge",
      modelRev: "rev",
      status: "failed",
      failureClass: "error",
      failedAttempts: 1,
      lastIndexedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(), // 1h ago
    })
    const { runSemanticSearch } = await import("../../src/lib/colbert/runner")
    const r = await runSemanticSearch({ query: "auth", workspace: ws })
    expect(r.status).toBe("failed")
    expect(r.isError).toBe(true)
    expect(r.notice).toMatch(/re-index was started|retry/i)
  })

  test("failed (capped: failedAttempts >= MAX) → operator-actionable, no retry promise", async () => {
    const store = await import("../../src/lib/colbert/index-store")
    store.__resetInitDebounceForTests()
    const ws = path.join(TEST_HOME, "ws-failed-capped")
    await store.writeColbertMeta({
      workspace: ws,
      model: "LateOn-Code-edge",
      modelRev: "rev",
      status: "failed",
      failureClass: "error",
      failedAttempts: 3,
      lastIndexedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    })
    const { runSemanticSearch } = await import("../../src/lib/colbert/runner")
    const r = await runSemanticSearch({ query: "auth", workspace: ws })
    expect(r.status).toBe("failed")
    expect(r.isError).toBe(true)
    expect(r.notice).toMatch(/unavailable/i)
    // The capped notice must NOT promise a retry, and must NOT hand the model
    // env-var tuning advice it cannot act on.
    expect(r.notice).not.toMatch(/started|shortly/i)
    expect(r.notice).not.toMatch(/GH_ROUTER_/)
  })

  test("crashed (building + dead PID + no index) → persists failed+crashed, retry notice", async () => {
    const store = await import("../../src/lib/colbert/index-store")
    store.__resetInitDebounceForTests()
    const ws = path.join(TEST_HOME, "ws-runner-crashed")
    await store.writeColbertMeta({
      workspace: ws,
      model: "LateOn-Code-edge",
      modelRev: "rev",
      status: "building", // stranded, no buildPid → crashed verdict
    })
    const { runSemanticSearch } = await import("../../src/lib/colbert/runner")
    const r = await runSemanticSearch({ query: "auth", workspace: ws })
    expect(r.status).toBe("failed")
    expect(r.isError).toBe(true)
    // The crash was persisted as failed+crashed with an incremented counter.
    const meta = await store.readColbertMeta(ws)
    expect(meta?.status).toBe("failed")
    expect(meta?.failureClass).toBe("crashed")
    expect(meta?.failedAttempts).toBe(1)
  })

  test("crashed streak survives the building write → cap still trips", async () => {
    const store = await import("../../src/lib/colbert/index-store")
    store.__resetInitDebounceForTests()
    const ws = path.join(TEST_HOME, "ws-crash-streak")
    // A re-kicked build that carried the streak into its `building` write,
    // then crashed abruptly (no final write): building + failedAttempts=2.
    await store.writeColbertMeta({
      workspace: ws,
      model: "LateOn-Code-edge",
      modelRev: "rev",
      status: "building",
      failedAttempts: 2,
      lastIndexedAt: new Date(Date.now() - 120_000).toISOString(), // past grace
    })
    const { runSemanticSearch } = await import("../../src/lib/colbert/runner")
    const r = await runSemanticSearch({ query: "auth", workspace: ws })
    // crashed verdict reads the carried streak (2) + 1 = 3 → at the cap →
    // operator-actionable, NOT another retry (this is the storm guard).
    expect(r.notice).toMatch(/unavailable/i)
    expect(r.notice).not.toMatch(/started|shortly/i)
    const meta = await store.readColbertMeta(ws)
    expect(meta?.failedAttempts).toBe(3)
  })

  // --- inputs-changed reset -------------------------------------------------
  //
  // `failedAttempts` is evidence about a SPECIFIC set of inputs, not a
  // permanent verdict. Without a reset condition the cap is a terminal dead
  // end: a workspace that failed 3 times stays unavailable for the life of
  // the process even after the cause is gone. That is the bug these pin —
  // observed live, with a complete healthy index on disk and the router
  // refusing to look at it ever again.

  /** A capped `failed` entry whose `failedAt` baseline the caller can vary. */
  const cappedAt = async (
    name: string,
    failedAt: Record<string, unknown>,
  ): Promise<string> => {
    const store = await import("../../src/lib/colbert/index-store")
    const manifest = await import("../../src/lib/colbert/manifest")
    store.__resetInitDebounceForTests()
    const ws = path.join(TEST_HOME, name)
    // A REAL git repo: the corpus-identity comparisons require a known head on
    // BOTH sides, so a bare temp dir (no git => head undefined) could never
    // exercise them. Real workspaces are repos.
    await fs.mkdir(ws, { recursive: true })
    const { execFileSync } = await import("node:child_process")
    const git = (args: Array<string>) =>
      execFileSync("git", args, { cwd: ws, stdio: "pipe" })
    git(["init", "-q"])
    git(["config", "user.email", "t@example.invalid"])
    git(["config", "user.name", "t"])
    await fs.writeFile(path.join(ws, "a.txt"), "a")
    git(["add", "-A"])
    git(["commit", "-qm", "a"])
    await store.writeColbertMeta({
      // Default the engine identity to the CURRENT values so a caller varying
      // one axis (say HEAD) isn't also implicitly varying the shas.
      binarySha: manifest.colgrepBinAsset()?.sha256,
      ortSha: manifest.ortLibAsset()?.sha256,
      workspace: ws,
      model: "LateOn-Code-edge",
      modelRev: "rev",
      status: "failed",
      failureClass: "error",
      failedAttempts: 3,
      failedAt: {
        binarySha: manifest.colgrepBinAsset()?.sha256,
        ortSha: manifest.ortLibAsset()?.sha256,
        modelRev: manifest.MODEL_REVISION,
        dirty: false,
        ...failedAt,
      },
      // Well outside FAILED_RETRY_BACKOFF_MS, so the backoff never masks the
      // behavior under test.
      lastIndexedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    } as never)
    return ws
  }

  test("capped failed + HEAD moved → streak cleared, rebuild kicked", async () => {
    const store = await import("../../src/lib/colbert/index-store")
    const ws = await cappedAt("ws-reset-head", { head: "old-head-sha" })
    const { runSemanticSearch } = await import("../../src/lib/colbert/runner")
    const r = await runSemanticSearch({ query: "auth", workspace: ws })

    // Still no results (nothing is served without a real rebuild), but the
    // dead end is gone: the streak is cleared and a retry is promised.
    expect(r.status).toBe("failed")
    expect(r.notice).toMatch(/inputs changed|rebuild was started/i)
    const meta = await store.readColbertMeta(ws)
    expect(meta?.failedAttempts).toBe(0)
  })

  test("capped failed + working tree dirty-state changed → streak cleared", async () => {
    const store = await import("../../src/lib/colbert/index-store")
    // HEAD is unchanged (undefined on both sides for a non-git temp dir); only
    // the dirty flag differs. This is the common local recovery — fixing a
    // malformed file WITHOUT committing — which a HEAD-only check would miss.
    const ws = await cappedAt("ws-reset-dirty", { dirty: true })
    const { runSemanticSearch } = await import("../../src/lib/colbert/runner")
    const r = await runSemanticSearch({ query: "auth", workspace: ws })

    expect(r.notice).toMatch(/inputs changed|rebuild was started/i)
    expect((await store.readColbertMeta(ws))?.failedAttempts).toBe(0)
  })

  test("capped failed + engine sha changed → streak cleared", async () => {
    const store = await import("../../src/lib/colbert/index-store")
    // A colgrep / ONNX-runtime upgrade may fix the very bug that failed, so a
    // streak earned by the old bits must not veto the new ones.
    const ws = await cappedAt("ws-reset-sha", {
      binarySha: "stale-binary-sha",
      ortSha: "stale-ort-sha",
    })
    const { runSemanticSearch } = await import("../../src/lib/colbert/runner")
    const r = await runSemanticSearch({ query: "auth", workspace: ws })

    expect(r.notice).toMatch(/inputs changed|rebuild was started/i)
    expect((await store.readColbertMeta(ws))?.failedAttempts).toBe(0)
  })

  test("capped failed + IDENTICAL inputs → stays capped, no reset, no kick", async () => {
    const store = await import("../../src/lib/colbert/index-store")
    const manifest = await import("../../src/lib/colbert/manifest")
    // Baseline that matches the current state exactly — nothing has changed,
    // so the cap must still bind. This is the guard against turning the fix
    // into a cap bypass / rebuild thrash.
    const ws = await cappedAt("ws-reset-none", {
      binarySha: manifest.colgrepBinAsset()?.sha256,
      ortSha: manifest.ortLibAsset()?.sha256,
      modelRev: manifest.MODEL_REVISION,
    })
    const { runSemanticSearch } = await import("../../src/lib/colbert/runner")
    const r = await runSemanticSearch({ query: "auth", workspace: ws })

    expect(r.status).toBe("failed")
    expect(r.notice).toMatch(/unavailable/i)
    expect(r.notice).not.toMatch(/inputs changed|started|shortly/i)
    expect((await store.readColbertMeta(ws))?.failedAttempts).toBe(3)
  })

  test("the reset fires ONCE, then the streak re-accumulates normally", async () => {
    const store = await import("../../src/lib/colbert/index-store")
    const ws = await cappedAt("ws-reset-once", { head: "old-head-sha" })
    const { runSemanticSearch, __waitForAllInitsForTests } = await import(
      "../../src/lib/colbert/runner"
    )

    // First query resets and kicks.
    const first = await runSemanticSearch({ query: "auth", workspace: ws })
    await __waitForAllInitsForTests()
    expect(first.notice).toMatch(/inputs changed/i)

    // The rebuild fails (no colgrep binary in this env) and must stamp a FRESH
    // baseline. If any failure path forgot to, the next query would see a
    // missing-or-stale baseline and reset again — an unbounded rebuild loop.
    const after = await store.readColbertMeta(ws)
    expect(after?.failedAt).toBeTruthy()

    for (let i = 0; i < 3; i++) {
      const again = await runSemanticSearch({ query: "auth", workspace: ws })
      await __waitForAllInitsForTests()
      expect(again.notice).not.toMatch(/inputs changed/i)
    }
  })

  test("the reset still honors the backoff (no rebuild storm)", async () => {
    const store = await import("../../src/lib/colbert/index-store")
    const ws = await cappedAt("ws-reset-backoff", { head: "old-head-sha" })
    // Move the failure to JUST NOW, inside FAILED_RETRY_BACKOFF_MS. Clearing
    // a streak is right; rebuilding without a throttle is not — on an actively
    // developed repo whose build genuinely fails, every commit and every
    // clean/dirty toggle would otherwise buy an immediate full re-index.
    const meta = await store.readColbertMeta(ws)
    await store.writeColbertMeta({
      ...meta!,
      lastIndexedAt: new Date().toISOString(),
    })

    const { runSemanticSearch } = await import("../../src/lib/colbert/runner")
    const r = await runSemanticSearch({ query: "auth", workspace: ws })

    // Streak cleared (the dead end is still gone) but NO rebuild promised.
    expect(r.notice).toMatch(/pending/i)
    expect(r.notice).not.toMatch(/was started/i)
    expect((await store.readColbertMeta(ws))?.failedAttempts).toBe(0)
  })

  test("a legacy entry with no failedAt baseline does NOT reset", async () => {
    const store = await import("../../src/lib/colbert/index-store")
    store.__resetInitDebounceForTests()
    const ws = path.join(TEST_HOME, "ws-reset-legacy")
    // Written before `failedAt` existed. A missing baseline means "unknown",
    // which must not read as "everything changed" — that would reset every
    // pre-upgrade entry on the first query after an upgrade.
    await store.writeColbertMeta({
      workspace: ws,
      model: "LateOn-Code-edge",
      modelRev: "rev",
      status: "failed",
      failureClass: "error",
      failedAttempts: 3,
      lastIndexedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    })
    const { runSemanticSearch } = await import("../../src/lib/colbert/runner")
    const r = await runSemanticSearch({ query: "auth", workspace: ws })

    expect(r.notice).not.toMatch(/inputs changed/i)
    expect((await store.readColbertMeta(ws))?.failedAttempts).toBe(3)
  })
})

describe("startupKickAllowed (restart anti-burn guard)", () => {
  test("absent / ready / under-cap-error → allowed; capped / stuck → blocked", async () => {
    const store = await import("../../src/lib/colbert/index-store")
    const { startupKickAllowed } = await import("../../src/lib/colbert/runner")

    const wsAbsent = path.join(TEST_HOME, "sk-absent")
    expect(await startupKickAllowed(wsAbsent)).toBe(true) // no meta

    const mk = async (name: string, m: Partial<Record<string, unknown>>) => {
      const ws = path.join(TEST_HOME, name)
      await store.writeColbertMeta({
        workspace: ws,
        model: "LateOn-Code-edge",
        modelRev: "rev",
        status: "failed",
        ...m,
      } as never)
      return ws
    }

    expect(await startupKickAllowed(await mk("sk-under", { failureClass: "error", failedAttempts: 1 }))).toBe(true)
    expect(await startupKickAllowed(await mk("sk-capped", { failureClass: "error", failedAttempts: 3 }))).toBe(false)
    expect(await startupKickAllowed(await mk("sk-stuck", { failureClass: "stuck", failedAttempts: 1 }))).toBe(false)
  })
})

// ---------------------------------------------------------------------
// Provisioning — mock download + SHA verify
// ---------------------------------------------------------------------

describe("provisionColbert: download + SHA verification", () => {
  test("unsupported platform → status unsupported, no download attempted", async () => {
    const prov = await import("../../src/lib/colbert/provision")
    const m = await import("../../src/lib/colbert/manifest")
    // Force an unsupported platform-arch by emptying the asset maps for
    // the running platform via a fetch that should never be called.
    let fetchCalled = false
    const origFetch = globalThis.fetch
    globalThis.fetch = (async () => {
      fetchCalled = true
      throw new Error("should not fetch on unsupported platform")
    }) as unknown as typeof fetch
    try {
      // Only assert the no-fetch property when this platform genuinely
      // has no manifest entry; on supported hosts this branch is skipped.
      if (!m.colbertPlatformSupported()) {
        const r = await prov.provisionColbert()
        expect(r.status).toBe("unsupported")
        expect(fetchCalled).toBe(false)
      }
    } finally {
      globalThis.fetch = origFetch
    }
  })

  test("SHA mismatch on the colgrep binary aborts provisioning (incomplete, no install)", async () => {
    const m = await import("../../src/lib/colbert/manifest")
    if (!m.colbertPlatformSupported()) return // can't exercise on unsupported host
    const prov = await import("../../src/lib/colbert/provision")
    // Mock fetch to return bytes whose SHA will NOT match the pinned
    // digest, for every artifact URL.
    const origFetch = globalThis.fetch
    globalThis.fetch = (async () =>
      new Response(Buffer.from("tampered-bytes"), { status: 200 })) as unknown as typeof fetch
    try {
      const r = await prov.provisionColbert()
      // The first artifact (binary) fails SHA verification → incomplete,
      // and the binary must NOT be installed on disk.
      expect(r.status).toBe("incomplete")
      const onDisk = await fs
        .stat(prov.colgrepBinaryPath())
        .then(() => true)
        .catch(() => false)
      expect(onDisk).toBe(false)
    } finally {
      globalThis.fetch = origFetch
    }
  })
})



describe("colbert lifecycle", () => {
  test("trackChild / untrackChild / sweepLiveChildren bookkeeping", async () => {
    const lc = await import("../../src/lib/colbert/lifecycle")
    lc.__unregisterColbertExitHandlersForTests()
    // A fake child object that captures kill() calls.
    let killed = false
    const fakeChild = {
      pid: 999999, // not a real PID — killManagedTree no-ops on POSIX kill
      once: () => {},
      kill: () => {
        killed = true
      },
    } as unknown as ReturnType<typeof import("node:child_process").spawn>
    lc.trackChild(fakeChild)
    expect(lc.liveChildCount()).toBe(1)
    lc.untrackChild(fakeChild)
    expect(lc.liveChildCount()).toBe(0)
    // Re-add and sweep clears the set.
    lc.trackChild(fakeChild)
    lc.sweepLiveChildren()
    expect(lc.liveChildCount()).toBe(0)
    void killed
  })

  test("boot sweep reclassifies building+dead-PID → failed", async () => {
    const { PATHS } = await import("../../src/lib/paths")
    const lc = await import("../../src/lib/colbert/lifecycle")
    const metaDir = PATHS.COLBERT_META_DIR
    await fs.mkdir(metaDir, { recursive: true })
    // A dead PID (very high, almost certainly not alive).
    const deadPid = 4_000_000_000
    const metaFile = path.join(metaDir, "abcd1234.json")
    await fs.writeFile(
      metaFile,
      JSON.stringify({
        workspace: "/tmp/x",
        model: "LateOn-Code-edge",
        modelRev: "rev",
        status: "building",
        buildPid: deadPid,
      }),
    )
    await lc.sweepStaleColbertMetaAtBoot()
    const after = JSON.parse(await fs.readFile(metaFile, "utf8"))
    expect(after.status).toBe("failed")
    await fs.rm(metaDir, { recursive: true, force: true }).catch(() => {})
  })

  test("boot sweep leaves a live-PID building entry untouched (never kills reused PID)", async () => {
    const { PATHS } = await import("../../src/lib/paths")
    const lc = await import("../../src/lib/colbert/lifecycle")
    const metaDir = PATHS.COLBERT_META_DIR
    await fs.mkdir(metaDir, { recursive: true })
    const metaFile = path.join(metaDir, "live1234.json")
    await fs.writeFile(
      metaFile,
      JSON.stringify({
        workspace: "/tmp/y",
        model: "LateOn-Code-edge",
        modelRev: "rev",
        status: "building",
        buildPid: process.pid, // alive
      }),
    )
    await lc.sweepStaleColbertMetaAtBoot()
    const after = JSON.parse(await fs.readFile(metaFile, "utf8"))
    expect(after.status).toBe("building") // untouched
    await fs.rm(metaDir, { recursive: true, force: true }).catch(() => {})
  })
})

// ---------------------------------------------------------------------
// runManagedExeCapture — timeout tree-kill / never-orphan (POSIX)
// ---------------------------------------------------------------------

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM"
  }
}

describe("runManagedExeCapture lifecycle (real child)", () => {
  // POSIX-only: spawns `sleep` and a child it forks, then verifies the
  // timeout tree-kill reaps the whole process group (never-orphan). On
  // Windows the equivalent is taskkill /T, exercised by the CI round-trip
  // (not reproducible here without a Windows host).
  const isWin = process.platform === "win32"

  test("timeout tree-kills a long-running child + its subprocess; promise resolves timedOut", async () => {
    if (isWin) return // taskkill /T path needs a Windows host
    const { runManagedExeCapture } = await import("../../src/lib/exec")
    const sh = "/bin/sh"
    // Parent shell spawns a child `sleep 60` and prints its PID, then
    // waits — so we can assert BOTH die when the group is killed.
    const script =
      "sleep 60 & child=$!; echo $child; wait"
    let capturedChildPid: number | undefined
    const res = await runManagedExeCapture(
      sh,
      ["-c", script],
      {
        timeoutMs: 600,
        onSpawn: (c) => {
          capturedChildPid = c.pid ?? undefined
        },
      },
    )
    expect(res.timedOut).toBe(true)
    // The parent shell PID is dead (killed by the group SIGKILL).
    if (capturedChildPid) {
      // Give the OS a beat to reap.
      await new Promise((r) => setTimeout(r, 200))
      expect(pidAlive(capturedChildPid)).toBe(false)
    }
    // The grandchild `sleep 60` PID (printed to stdout) must also be dead
    // — proves the process-GROUP kill reaped the tree, not just the
    // parent (never-orphan).
    const grandchildPid = Number.parseInt(res.stdout.trim(), 10)
    if (Number.isInteger(grandchildPid) && grandchildPid > 0) {
      await new Promise((r) => setTimeout(r, 200))
      expect(pidAlive(grandchildPid)).toBe(false)
    }
  })

  test("maxStdoutBytes cap tree-kills + sets stdoutTruncated", async () => {
    if (isWin) return
    const { runManagedExeCapture } = await import("../../src/lib/exec")
    // `yes` floods stdout forever; the byte cap must kill it.
    const res = await runManagedExeCapture(
      "/bin/sh",
      ["-c", "yes abcdefghij"],
      { timeoutMs: 5000, maxStdoutBytes: 4096 },
    )
    expect(res.stdoutTruncated).toBe(true)
    // Bounded — we stopped reading near the cap (allow generous slack for
    // in-flight chunks already buffered before the kill landed).
    expect(res.stdout.length).toBeLessThan(2 * 1024 * 1024)
  })
})


// ---------------------------------------------------------------------
// MCP surface regression — semantic_search folded into the `code` tool
// ---------------------------------------------------------------------

describe("MCP tools/list surface (regression guard)", () => {
  const NONCE = "0123456789abcdef".repeat(4)
  const PROXY_HOST = "127.0.0.1:18790"

  async function listToolNames(): Promise<Array<string>> {
    const { mcpRoutes } = await import("../../src/routes/mcp/route")
    const { __resetInFlightForTests } = await import("../../src/routes/mcp/handler")
    __resetInFlightForTests()
    const req = new Request(`http://${PROXY_HOST}/`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${NONCE}`,
        host: PROXY_HOST,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    })
    const res = await mcpRoutes.request(req)
    const json = (await res.json()) as {
      result: { tools: Array<{ name: string }> }
    }
    return json.result.tools.map((t) => t.name)
  }

  test("search group is {code, web}; `semantic_search` is no longer a standalone tool", async () => {
    // semantic_search was folded into the unified `code` tool (its default
    // mode runs ColBERT and transparently falls back to lexical), so the
    // search surface is stable at {code, web} regardless of colgrep
    // availability — `code` is always listed (it always returns results).
    const { state } = await import("../../src/lib/state")
    state.peerMcpNonce = NONCE
    state.models = { object: "list", data: [] } as never
    try {
      const names = await listToolNames()
      expect(names).not.toContain("semantic_search")
      expect(names).toContain("code")
      expect(names).toContain("web")
    } finally {
      state.peerMcpNonce = undefined
      state.models = undefined
    }
  })
})


describe("provisioning self-repair (corrupt install, valid sidecar)", () => {
  // The exact state that kept semantic search dead. Provisioning used to
  // short-circuit on `existsSync(dest) && sidecar === archiveSha`, which says
  // nothing about the bytes on disk. A lane-1 test with a leaked `node:os`
  // mock overwrote the real colgrep.exe with a 6-byte stub; the sidecar was
  // untouched and still valid, so every subsequent launch skipped the
  // re-download, failed the smoke test, removed `.smoke-ok`, and reported
  // "unavailable on this host" — permanently, until the binary was deleted by
  // hand. Preventing the corruption is not enough; the installer has to
  // notice and heal it.
  const ARCHIVE_SHA = "a".repeat(64)
  test("intact install with a full sidecar is reused (no needless re-download)", async () => {
    const prov = await import("../../src/lib/colbert/provision")
    const { createHash } = await import("node:crypto")
    const dir = await fs.mkdtemp(path.join(TEST_HOME, "intact-"))
    const dest = path.join(dir, "colgrep.exe")
    await fs.writeFile(dest, "GOOD-BINARY-BYTES")
    const installed = createHash("sha256").update("GOOD-BINARY-BYTES").digest("hex")
    await fs.writeFile(`${dest}.sha256`, `${ARCHIVE_SHA}\n${installed}`)

    expect(
      await prov.installedArtifactIsIntact(`${dest}.sha256`, dest, ARCHIVE_SHA),
    ).toBe(true)
  })

  test("CORRUPT install with a still-valid sidecar is rejected, forcing re-provision", async () => {
    const prov = await import("../../src/lib/colbert/provision")
    const { createHash } = await import("node:crypto")
    const dir = await fs.mkdtemp(path.join(TEST_HOME, "corrupt-"))
    const dest = path.join(dir, "colgrep.exe")
    await fs.writeFile(dest, "GOOD-BINARY-BYTES")
    const installed = createHash("sha256").update("GOOD-BINARY-BYTES").digest("hex")
    await fs.writeFile(`${dest}.sha256`, `${ARCHIVE_SHA}\n${installed}`)

    // Exactly what the leaked-mock test wrote over the real binary.
    await fs.writeFile(dest, "binary")

    expect(
      await prov.installedArtifactIsIntact(`${dest}.sha256`, dest, ARCHIVE_SHA),
    ).toBe(false)
  })

  test("legacy archive-only sidecar is treated as unverifiable, so installs self-heal", async () => {
    const prov = await import("../../src/lib/colbert/provision")
    const dir = await fs.mkdtemp(path.join(TEST_HOME, "legacy-"))
    const dest = path.join(dir, "colgrep.exe")
    await fs.writeFile(dest, "binary") // already-corrupted install in the wild
    await fs.writeFile(`${dest}.sha256`, ARCHIVE_SHA) // pre-fix sidecar format

    expect(
      await prov.installedArtifactIsIntact(`${dest}.sha256`, dest, ARCHIVE_SHA),
    ).toBe(false)
  })

  test("a re-pinned manifest still forces re-download", async () => {
    const prov = await import("../../src/lib/colbert/provision")
    const { createHash } = await import("node:crypto")
    const dir = await fs.mkdtemp(path.join(TEST_HOME, "repin-"))
    const dest = path.join(dir, "colgrep.exe")
    await fs.writeFile(dest, "GOOD-BINARY-BYTES")
    const installed = createHash("sha256").update("GOOD-BINARY-BYTES").digest("hex")
    await fs.writeFile(`${dest}.sha256`, `${ARCHIVE_SHA}\n${installed}`)

    expect(
      await prov.installedArtifactIsIntact(`${dest}.sha256`, dest, "b".repeat(64)),
    ).toBe(false)
  })
})

// ---------------------------------------------------------------------
// Operator visibility — the degraded-index launch banner
// ---------------------------------------------------------------------
//
// The failure that motivated this was SILENCE: semantic search degraded to
// lexical on a real repo for an unknown period and nobody noticed, because
// the only signals were a `notice` string the model reads and a debug log
// the file reporter drops. This banner is the one signal a human sees.

describe("colbertDegradedWarning (launch banner)", () => {
  test("warns for a terminally-failed index, silent otherwise", async () => {
    const store = await import("../../src/lib/colbert/index-store")
    const { colbertDegradedWarning } = await import("../../src/lib/colbert")

    const base = {
      model: "LateOn-Code-edge",
      modelRev: "rev",
    }

    // No meta at all → nothing to report.
    const wsNone = path.join(TEST_HOME, "warn-absent")
    expect(await colbertDegradedWarning(wsNone)).toBeNull()

    // A healthy index → silent. The banner must not cry wolf on every launch.
    const wsReady = path.join(TEST_HOME, "warn-ready")
    await store.writeColbertMeta({
      workspace: wsReady,
      ...base,
      status: "ready",
    })
    expect(await colbertDegradedWarning(wsReady)).toBeNull()

    // Failed → one actionable line naming the class and pointing at the log
    // that (as of this change) actually contains the failure.
    const wsFailed = path.join(TEST_HOME, "warn-failed")
    await store.writeColbertMeta({
      workspace: wsFailed,
      ...base,
      status: "failed",
      failureClass: "error",
    })
    const warning = await colbertDegradedWarning(wsFailed)
    expect(warning).toBeTruthy()
    expect(warning).toMatch(/DEGRADED/)
    expect(warning).toMatch(/error/)
    // Says lexical still works, so the user knows the blast radius.
    expect(warning).toMatch(/lexical/i)

    // The log pointer must match where the detail actually went. `claude` and
    // `codex` redirect warnings to ERROR_LOG_PATH via enableFileLogging();
    // `start` does not, so pointing it at the file would send the operator to
    // a stale or absent one.
    const toFile = await colbertDegradedWarning(wsFailed, { logsToFile: true })
    expect(toFile).toMatch(/error\.log/)
    expect(warning).not.toMatch(/error\.log/)

    // `stuck` is the one class with an actionable knob, so it keeps the
    // tuning hint that was removed from the model-facing notice.
    const wsStuck = path.join(TEST_HOME, "warn-stuck")
    await store.writeColbertMeta({
      workspace: wsStuck,
      ...base,
      status: "failed",
      failureClass: "stuck",
    })
    expect(await colbertDegradedWarning(wsStuck)).toMatch(
      /GH_ROUTER_COLBERT_INIT_STALL_MS/,
    )
  })
})

// ---------------------------------------------------------------------
// Store sweep — reclaims disk WITHOUT destroying real index data
// ---------------------------------------------------------------------
//
// These are the tests that make shipping deletion defensible. The scanner
// that decides "unreachable" is the same one that was wrong in this
// incident: under the old path comparison a perfectly healthy index looked
// unreachable, and a sweep written against that scanner would have deleted
// it. Every rule below therefore leans on evidence that does not depend on
// our path matching at all.

describe("sweepColbertStore (safe reclamation)", () => {
  test("reaps only provably-empty orphans; never touches real data", async () => {
    const { sweepColbertStore } = await import("../../src/lib/colbert/lifecycle")
    const { PATHS } = await import("../../src/lib/paths")
    const indices = PATHS.COLBERT_INDICES_DIR
    await fs.mkdir(indices, { recursive: true })

    const aged = new Date(Date.now() - 24 * 60 * 60 * 1000)
    const mk = async (
      name: string,
      opts: {
        projectJson?: boolean
        shards?: boolean
        lock?: boolean
        fresh?: boolean
      },
    ): Promise<string> => {
      const d = path.join(indices, name)
      await fs.mkdir(path.join(d, "index"), { recursive: true })
      if (opts.projectJson) {
        await fs.writeFile(path.join(d, "project.json"), JSON.stringify({ path: d }))
      }
      if (opts.shards) await fs.writeFile(path.join(d, "index", "0.codes.npy"), "x")
      if (opts.lock) await fs.writeFile(path.join(d, ".lock"), "")
      if (!opts.fresh) await fs.utimes(d, aged, aged)
      return d
    }

    const orphan = await mk("sweep-orphan", {})
    const withProject = await mk("sweep-real", { projectJson: true })
    const withShards = await mk("sweep-shards", { shards: true })
    const locked = await mk("sweep-locked", { lock: true })
    const freshOrphan = await mk("sweep-fresh", { fresh: true })
    const quarantine = await mk("sweep.corrupt-abc", {})

    await sweepColbertStore()

    // Reaped: nothing of value could have been in it.
    expect(fsSync.existsSync(orphan)).toBe(false)
    // Kept: each for a DIFFERENT reason, so a regression in any one rule shows.
    expect(fsSync.existsSync(withProject)).toBe(true) // real index data
    expect(fsSync.existsSync(withShards)).toBe(true) // work in progress
    expect(fsSync.existsSync(locked)).toBe(true) // another process owns it
    expect(fsSync.existsSync(freshOrphan)).toBe(true) // inside the grace window
    expect(fsSync.existsSync(quarantine)).toBe(true) // corrupt-repair owns it
  })

  test("reaps metadata for deleted workspaces, keeps it for live ones", async () => {
    const store = await import("../../src/lib/colbert/index-store")
    const { sweepColbertStore } = await import("../../src/lib/colbert/lifecycle")

    const live = path.join(TEST_HOME, "sweep-live-ws")
    await fs.mkdir(live, { recursive: true })
    const gone = path.join(TEST_HOME, "sweep-gone-ws")
    await fs.mkdir(gone, { recursive: true })

    const base = { model: "LateOn-Code-edge", modelRev: "rev", status: "ready" as const }
    await store.writeColbertMeta({ workspace: live, ...base })
    await store.writeColbertMeta({ workspace: gone, ...base })
    // The workspace disappears; its sidecar is now pure bookkeeping garbage.
    await fs.rm(gone, { recursive: true, force: true })
    // Age both sidecars past the settle window. A freshly-written entry is
    // deliberately never reaped: the reclassification pass rewrites
    // building+dead-PID to `failed` so the runner can self-heal, and reaping
    // that in the same sweep would erase the state before anything acts on it.
    const { PATHS } = await import("../../src/lib/paths")
    const { metaHashForWorkspace } = store
    const agedAt = new Date(Date.now() - 24 * 60 * 60 * 1000)
    for (const w of [live, gone]) {
      const f = path.join(PATHS.COLBERT_META_DIR, `${metaHashForWorkspace(w)}.json`)
      await fs.utimes(f, agedAt, agedAt)
    }

    await sweepColbertStore()

    expect(await store.readColbertMeta(live)).not.toBeNull()
    expect(await store.readColbertMeta(gone)).toBeNull()
  })

  test("never reaps a building workspace's metadata", async () => {
    const store = await import("../../src/lib/colbert/index-store")
    const { sweepColbertStore } = await import("../../src/lib/colbert/lifecycle")

    // A build in flight whose workspace is momentarily unreadable must not
    // have its bookkeeping deleted out from under it.
    const ws = path.join(TEST_HOME, "sweep-building-ws")
    await store.writeColbertMeta({
      workspace: ws,
      model: "LateOn-Code-edge",
      modelRev: "rev",
      status: "building",
    })
    await sweepColbertStore()
    expect(await store.readColbertMeta(ws)).not.toBeNull()
  })
})

// ---------------------------------------------------------------------
// Workspace identity — one key per workspace, on every OS
// ---------------------------------------------------------------------
//
// These need no colgrep artifacts, so they run on every CI OS rather than
// being skipped like the E2E colbert tests. That is the point: the bug they
// pin is a path-semantics bug, and path semantics differ per platform.

describe("canonicalWorkspace (cross-platform identity)", () => {
  test("every spelling of one workspace collapses to one key", async () => {
    const store = await import("../../src/lib/colbert/index-store")
    const ws = path.join(TEST_HOME, "identity-ws")
    await fs.mkdir(ws, { recursive: true })

    const spellings =
      process.platform === "win32"
        ? [
            ws,
            ws.replaceAll("\\", "/"),
            ws + path.sep,
            ws.toLowerCase(),
            // colgrep's stored form: the Windows extended-length prefix.
            "\\\\?\\" + path.resolve(ws),
          ]
        : [ws, `${ws}/`, path.join(ws, "."), path.join(ws, "sub", "..")]

    const keys = new Set(spellings.map((s) => store.canonicalWorkspace(s)))
    expect(keys.size).toBe(1)
    // The sidecar key must agree — it previously used a DIFFERENT
    // normalization, which is how one workspace got two meta files.
    expect(new Set(spellings.map((s) => store.metaHashForWorkspace(s))).size).toBe(1)
  })

  test("a symlinked workspace has the same identity as its real path", async () => {
    const store = await import("../../src/lib/colbert/index-store")
    const real = path.join(TEST_HOME, "identity-real")
    const link = path.join(TEST_HOME, "identity-link")
    await fs.mkdir(real, { recursive: true })
    try {
      await fs.symlink(real, link, "junction")
    } catch {
      return // no symlink privilege (Windows without Developer Mode)
    }

    // This is the macOS shape: /var -> /private/var and /tmp -> /private/tmp
    // mean EVERY temp workspace there is reached through a symlink. The meta
    // key used to skip realpath while the project-dir lookup applied it, so
    // one physical index got two identities and one of them always reported
    // `absent`.
    expect(store.canonicalWorkspace(link)).toBe(store.canonicalWorkspace(real))
    expect(store.metaHashForWorkspace(link)).toBe(store.metaHashForWorkspace(real))
  })

  test("case sensitivity follows the volume, not the platform", async () => {
    const store = await import("../../src/lib/colbert/index-store")
    const dir = path.join(TEST_HOME, "IdentityCase")
    await fs.mkdir(dir, { recursive: true })

    // Ask the filesystem itself rather than assuming from process.platform:
    // APFS can be formatted case-SENSITIVE and Linux routinely mounts
    // case-INSENSITIVE volumes, so the platform is wrong in both directions.
    const flipped = path.join(TEST_HOME, "identitycase")
    const volumeFolds = fsSync.existsSync(flipped)

    const same = store.canonicalWorkspace(dir) === store.canonicalWorkspace(flipped)
    expect(same).toBe(volumeFolds)
  })

  test("a not-yet-created workspace still gets a stable key", async () => {
    const store = await import("../../src/lib/colbert/index-store")
    // realpath throws here; the fallback must still be deterministic, or a
    // workspace would change identity the moment it is created.
    const ghost = path.join(TEST_HOME, "identity-ghost")
    expect(store.canonicalWorkspace(ghost)).toBe(store.canonicalWorkspace(ghost))
    expect(store.metaHashForWorkspace(ghost)).toBe(store.metaHashForWorkspace(ghost))
  })
})

// ---------------------------------------------------------------------
// Watchdog epoch — recovery for entries the router's own bugs poisoned
// ---------------------------------------------------------------------

describe("watchdogEpoch recovery", () => {
  test("a pre-fix failure marker stops short-circuiting the verdict", async () => {
    const store = await import("../../src/lib/colbert/index-store")
    const ws = path.join(TEST_HOME, "epoch-ws")
    await fs.mkdir(ws, { recursive: true })

    // Exactly the shapes the router's own bugs produced: `stuck` from the
    // blind watchdog, `corrupt` from a null project-dir lookup. Written with
    // NO epoch stamp, which is what every pre-upgrade sidecar looks like.
    for (const cls of ["stuck", "corrupt", "crashed"] as const) {
      const file = path.join(
        await PATHS_COLBERT_META(),
        `${store.metaHashForWorkspace(ws)}.json`,
      )
      await fs.mkdir(path.dirname(file), { recursive: true })
      await fs.writeFile(
        file,
        JSON.stringify({
          workspace: ws,
          model: "LateOn-Code-edge",
          modelRev: "rev",
          status: "failed",
          failureClass: cls,
          failedAttempts: 3,
        }),
      )

      const recovered = await store.readColbertMeta(ws)
      // Clearing the streak alone is NOT enough: `freshnessVerdict` returns
      // `failed` straight off `meta.status` before it looks at the disk, so a
      // zeroed counter would leave the workspace just as dead. The status has
      // to drop too, which makes the next verdict re-derive from the shards —
      // a genuinely corrupt index is then re-detected and re-quarantined.
      expect(recovered?.status).toBe("ready")
      expect(recovered?.failedAttempts).toBe(0)
      expect(recovered?.failureClass).toBeUndefined()
    }
  })

  test("a genuine `launch` failure is NOT cleared, and the reset is one-shot", async () => {
    const store = await import("../../src/lib/colbert/index-store")
    const ws = path.join(TEST_HOME, "epoch-launch-ws")
    await fs.mkdir(ws, { recursive: true })
    const file = path.join(
      await PATHS_COLBERT_META(),
      `${store.metaHashForWorkspace(ws)}.json`,
    )
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(
      file,
      JSON.stringify({
        workspace: ws,
        model: "LateOn-Code-edge",
        modelRev: "rev",
        status: "failed",
        failureClass: "launch", // a missing binary is about the environment
        failedAttempts: 3,
      }),
    )
    const kept = await store.readColbertMeta(ws)
    expect(kept?.status).toBe("failed")
    expect(kept?.failedAttempts).toBe(3)

    // And the reset cannot loop: a write stamps the current epoch, so a
    // recovered entry is not re-recovered on every subsequent read.
    const ws2 = path.join(TEST_HOME, "epoch-once-ws")
    await fs.mkdir(ws2, { recursive: true })
    const f2 = path.join(
      await PATHS_COLBERT_META(),
      `${store.metaHashForWorkspace(ws2)}.json`,
    )
    await fs.writeFile(
      f2,
      JSON.stringify({
        workspace: ws2,
        model: "LateOn-Code-edge",
        modelRev: "rev",
        status: "failed",
        failureClass: "stuck",
        failedAttempts: 2,
      }),
    )
    const first = await store.readColbertMeta(ws2)
    expect(first?.status).toBe("ready")
    await store.writeColbertMeta({ ...first!, status: "failed", failureClass: "stuck", failedAttempts: 2 })
    const second = await store.readColbertMeta(ws2)
    expect(second?.status).toBe("failed") // stamped → no second reset
  })
})

async function PATHS_COLBERT_META(): Promise<string> {
  // Resolved lazily so the node:os mock above is in effect.
  const { PATHS } = await import("../../src/lib/paths")
  return PATHS.COLBERT_META_DIR
}
