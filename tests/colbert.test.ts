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

afterEach(async () => {
  await fs.rm(colbertDir, { recursive: true, force: true }).catch(() => {})
  delete process.env.GH_ROUTER_DISABLE_SEMANTIC_SEARCH
})

// ---------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------

describe("colbert manifest", () => {
  test("every platform asset carries a 64-hex sha256", async () => {
    const m = await import("../src/lib/colbert/manifest")
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
    const m = await import("../src/lib/colbert/manifest")
    expect(/^[0-9a-f]{40}$/.test(m.MODEL_REVISION)).toBe(true)
  })

  test("ships INT8 model only (no FP32 model.onnx)", async () => {
    const m = await import("../src/lib/colbert/manifest")
    const names = m.MODEL_FILES.map((f) => f.name)
    expect(names).toContain("model_int8.onnx")
    expect(names).not.toContain("model.onnx")
  })

  test("colbertPlatformSupported true for win/darwin/linux x64, false for unknown", async () => {
    const m = await import("../src/lib/colbert/manifest")
    expect(m.colbertPlatformSupported("win32", "x64")).toBe(true)
    expect(m.colbertPlatformSupported("darwin", "arm64")).toBe(true)
    expect(m.colbertPlatformSupported("linux", "x64")).toBe(true)
    expect(m.colbertPlatformSupported("sunos" as NodeJS.Platform, "mips")).toBe(false)
  })

  test("colgrep darwin/linux assets are tar.xz; windows is zip", async () => {
    const m = await import("../src/lib/colbert/manifest")
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
    const { dropColgrepSecrets } = await import("../src/lib/colbert/provision")
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
    const { dropColgrepSecrets } = await import("../src/lib/colbert/provision")
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
    const cap = await import("../src/lib/mcp-capabilities")
    // No artifacts on disk in the temp home → gate must be false so the
    // tool is invisible and the {code, web} surface is unchanged.
    expect(cap.semanticSearchEnabled()).toBe(false)
  })

  test("false when opted out even if (hypothetically) present", async () => {
    process.env.GH_ROUTER_DISABLE_SEMANTIC_SEARCH = "1"
    const cap = await import("../src/lib/mcp-capabilities")
    expect(cap.semanticSearchEnabled()).toBe(false)
  })

  test("true only when artifacts present AND smoke ok AND not opted out", async () => {
    // Synthesize the on-disk presence the gate checks.
    const prov = await import("../src/lib/colbert/provision")
    const binDir = path.dirname(prov.colgrepBinaryPath())
    const modelDir = prov.colbertModelDir()
    const ortPath = prov.colbertOrtDylibPath()
    await fs.mkdir(binDir, { recursive: true })
    await fs.mkdir(modelDir, { recursive: true })
    await fs.mkdir(path.dirname(ortPath), { recursive: true })
    await fs.writeFile(prov.colgrepBinaryPath(), "binary")
    await fs.writeFile(path.join(modelDir, "model_int8.onnx"), "model")
    await fs.writeFile(ortPath, "dylib")
    // smoke marker — must match the version-keyed content colbertSmokeOk
    // validates (binary + ORT SHAs + model revision from the manifest).
    await fs.mkdir(colbertDir, { recursive: true })
    const man = await import("../src/lib/colbert/manifest")
    const validMarker =
      `colbert-smoke-ok\n` +
      `binary=${man.colgrepBinAsset()!.sha256}\n` +
      `ort=${man.ortLibAsset()!.sha256}\n` +
      `model=${man.MODEL_REVISION}\n`
    await fs.writeFile(path.join(colbertDir, ".smoke-ok"), validMarker)

    const cap = await import("../src/lib/mcp-capabilities")
    expect(prov.colbertArtifactsPresent()).toBe(true)
    expect(prov.colbertSmokeOk()).toBe(true)
    expect(cap.semanticSearchEnabled()).toBe(true)

    // Removing the smoke marker flips the gate off (handoff guard).
    await fs.rm(path.join(colbertDir, ".smoke-ok"), { force: true })
    expect(cap.semanticSearchEnabled()).toBe(false)
  })

  test("a stale (wrong-version) smoke marker is rejected (re-pin invalidates)", async () => {
    const prov = await import("../src/lib/colbert/provision")
    const binDir = path.dirname(prov.colgrepBinaryPath())
    const modelDir = prov.colbertModelDir()
    const ortPath = prov.colbertOrtDylibPath()
    await fs.mkdir(binDir, { recursive: true })
    await fs.mkdir(modelDir, { recursive: true })
    await fs.mkdir(path.dirname(ortPath), { recursive: true })
    await fs.writeFile(prov.colgrepBinaryPath(), "binary")
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
// Staleness keying + freshness verdict
// ---------------------------------------------------------------------

describe("index-store: meta keying + freshness verdict", () => {
  test("metaHashForWorkspace is stable + path-keyed", async () => {
    const store = await import("../src/lib/colbert/index-store")
    const a = store.metaHashForWorkspace("/tmp/repo-a")
    const a2 = store.metaHashForWorkspace("/tmp/repo-a")
    const b = store.metaHashForWorkspace("/tmp/repo-b")
    expect(a).toBe(a2) // deterministic
    expect(a).not.toBe(b) // distinct workspaces → distinct keys
    expect(/^[0-9a-f]{8}$/.test(a)).toBe(true)
  })

  test("absent meta → verdict absent", async () => {
    const store = await import("../src/lib/colbert/index-store")
    const v = await store.freshnessVerdict("/tmp/never-indexed-xyz")
    expect(v.verdict).toBe("absent")
  })

  test("status:building → verdict building (no spawn)", async () => {
    const store = await import("../src/lib/colbert/index-store")
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
    const store = await import("../src/lib/colbert/index-store")
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

  test("status:ready but no completed index on disk → building (never fake-ready)", async () => {
    const store = await import("../src/lib/colbert/index-store")
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
    const store = await import("../src/lib/colbert/index-store")
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
    const store = await import("../src/lib/colbert/index-store")
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
    const store = await import("../src/lib/colbert/index-store")
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
    const store = await import("../src/lib/colbert/index-store")
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

describe("runSemanticSearch: no-fallback contract", () => {
  test("absent workspace → unavailable isError (no other search run)", async () => {
    const store = await import("../src/lib/colbert/index-store")
    store.__resetInitDebounceForTests()
    const { runSemanticSearch } = await import("../src/lib/colbert/runner")
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
    const store = await import("../src/lib/colbert/index-store")
    const ws = path.join(TEST_HOME, "ws-runner-building")
    await store.writeColbertMeta({
      workspace: ws,
      model: "LateOn-Code-edge",
      modelRev: "rev",
      status: "building",
      buildPid: process.pid,
    })
    const { runSemanticSearch } = await import("../src/lib/colbert/runner")
    const r = await runSemanticSearch({ query: "auth", workspace: ws })
    expect(r.status).toBe("building")
    expect(r.isError).not.toBe(true)
    expect(r.results).toBeUndefined()
    expect(r.notice).toBeTruthy()
  })

  test("failed index → failed isError, NO results", async () => {
    const store = await import("../src/lib/colbert/index-store")
    const ws = path.join(TEST_HOME, "ws-runner-failed")
    await store.writeColbertMeta({
      workspace: ws,
      model: "LateOn-Code-edge",
      modelRev: "rev",
      status: "failed",
    })
    const { runSemanticSearch } = await import("../src/lib/colbert/runner")
    const r = await runSemanticSearch({ query: "auth", workspace: ws })
    expect(r.status).toBe("failed")
    expect(r.isError).toBe(true)
    expect(r.results).toBeUndefined()
  })

  test("failed (transient, under cap, backoff elapsed) → self-heal kicks + retry notice", async () => {
    const store = await import("../src/lib/colbert/index-store")
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
    const { runSemanticSearch } = await import("../src/lib/colbert/runner")
    const r = await runSemanticSearch({ query: "auth", workspace: ws })
    expect(r.status).toBe("failed")
    expect(r.isError).toBe(true)
    expect(r.notice).toMatch(/re-index was started|retry/i)
  })

  test("failed (capped: failedAttempts >= MAX) → operator-actionable, no retry promise", async () => {
    const store = await import("../src/lib/colbert/index-store")
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
    const { runSemanticSearch } = await import("../src/lib/colbert/runner")
    const r = await runSemanticSearch({ query: "auth", workspace: ws })
    expect(r.status).toBe("failed")
    expect(r.isError).toBe(true)
    expect(r.notice).toMatch(/keeps failing/i)
  })

  test("crashed (building + dead PID + no index) → persists failed+crashed, retry notice", async () => {
    const store = await import("../src/lib/colbert/index-store")
    store.__resetInitDebounceForTests()
    const ws = path.join(TEST_HOME, "ws-runner-crashed")
    await store.writeColbertMeta({
      workspace: ws,
      model: "LateOn-Code-edge",
      modelRev: "rev",
      status: "building", // stranded, no buildPid → crashed verdict
    })
    const { runSemanticSearch } = await import("../src/lib/colbert/runner")
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
    const store = await import("../src/lib/colbert/index-store")
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
    const { runSemanticSearch } = await import("../src/lib/colbert/runner")
    const r = await runSemanticSearch({ query: "auth", workspace: ws })
    // crashed verdict reads the carried streak (2) + 1 = 3 → at the cap →
    // operator-actionable, NOT another retry (this is the storm guard).
    expect(r.notice).toMatch(/keeps failing/i)
    const meta = await store.readColbertMeta(ws)
    expect(meta?.failedAttempts).toBe(3)
  })
})

describe("startupKickAllowed (restart anti-burn guard)", () => {
  test("absent / ready / under-cap-error → allowed; capped / stuck → blocked", async () => {
    const store = await import("../src/lib/colbert/index-store")
    const { startupKickAllowed } = await import("../src/lib/colbert/runner")

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
    const prov = await import("../src/lib/colbert/provision")
    const m = await import("../src/lib/colbert/manifest")
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
    const m = await import("../src/lib/colbert/manifest")
    if (!m.colbertPlatformSupported()) return // can't exercise on unsupported host
    const prov = await import("../src/lib/colbert/provision")
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
    const lc = await import("../src/lib/colbert/lifecycle")
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
    const { PATHS } = await import("../src/lib/paths")
    const lc = await import("../src/lib/colbert/lifecycle")
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
    const { PATHS } = await import("../src/lib/paths")
    const lc = await import("../src/lib/colbert/lifecycle")
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
    const { runManagedExeCapture } = await import("../src/lib/exec")
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
    const { runManagedExeCapture } = await import("../src/lib/exec")
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
    const { mcpRoutes } = await import("../src/routes/mcp/route")
    const { __resetInFlightForTests } = await import("../src/routes/mcp/handler")
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
    const { state } = await import("../src/lib/state")
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

