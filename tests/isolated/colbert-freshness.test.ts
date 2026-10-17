/**
 * Tests for serve-while-stale freshness (Phase 2c).
 *
 * An LLM editing session dirties the tree constantly; a refuse-when-stale
 * policy makes semantic search permanently unavailable during exactly those
 * sessions. These tests pin the replacement contract: stale-by-content with
 * a small, fully-enumerated delta SERVES labeled results; engine/suspect
 * stale and large deltas still refuse.
 *
 * Sandbox mirrors tests/isolated/colbert.test.ts (mocked homedir, guarded
 * writes, real git repos) in miniature. Own process (isolated/) because of
 * the process-global `node:os` mock.
 *
 * Servability is platform-gated: on a platform-arch with no prebuilt
 * colgrep/ORT asset there is nothing to serve WITH, so `freshnessVerdict`
 * answers `unsupported` where it would otherwise answer `fresh` or a servable
 * `stale/content`. Each test states the contract of the host it is on rather
 * than skipping the file — see `PLATFORM_SUPPORTED` / `hostCannotServe`.
 */

import { afterEach, describe, expect, mock, test } from "bun:test"
import { execFileSync } from "node:child_process"
import fs from "node:fs/promises"
import fsSync from "node:fs"
import os from "node:os"
import path from "node:path"

const REAL_TMPDIR = os.tmpdir()
const TEST_HOME = await fs.mkdtemp(path.join(REAL_TMPDIR, "gh-router-fresh-test-"))
mock.module("node:os", () => ({
  default: { homedir: () => TEST_HOME, tmpdir: () => REAL_TMPDIR },
  homedir: () => TEST_HOME,
  tmpdir: () => REAL_TMPDIR,
}))

const appDir = path.join(TEST_HOME, ".local", "share", "github-router")
const colbertDir = path.join(appDir, "colbert")

/**
 * Does this platform-arch have a prebuilt colgrep/ORT asset?
 *
 * The verdict machine below is platform-independent, but SERVABILITY is not:
 * with no prebuilt engine, `freshnessVerdict` substitutes `unsupported` for
 * `fresh` and for a servable `stale/content` (there is nothing to serve WITH),
 * while the already-non-servable diagnostics keep their verdict. Tests here
 * therefore assert the contract of the host they run on instead of skipping the
 * file: an x64 CI runner exercises the supported shape, an arm64 box the other.
 */
const PLATFORM_SUPPORTED = (await import("../../src/lib/colbert/manifest")).colbertPlatformSupported()

/**
 * True when this host cannot serve semantic results at all, in which case the
 * caller's servable-branch assertions do not apply. Asserts that host contract
 * (`unsupported`, never servable) before returning, so the unsupported branch is
 * pinned rather than skipped.
 */
async function hostCannotServe(ws: string): Promise<boolean> {
  if (PLATFORM_SUPPORTED) return false
  const store = await import("../../src/lib/colbert/index-store")
  const v = await store.freshnessVerdict(ws)
  expect(v.verdict).toBe("unsupported")
  expect(store.isServableVerdict(v)).toBe(false)
  return true
}

async function writeInsideTestHome(target: string, content: string): Promise<void> {
  const rel = path.relative(path.resolve(TEST_HOME), path.resolve(target))
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`refusing to write outside the test home: ${target}`)
  }
  await fs.mkdir(path.dirname(target), { recursive: true })
  await fs.writeFile(target, content)
}

function git(ws: string, args: Array<string>): string {
  return execFileSync("git", args, { cwd: ws, stdio: "pipe" }).toString()
}

interface IndexedRepo {
  ws: string
  head: string
}

/** Real git repo + ready meta + coherent on-disk index. */
async function mkIndexedRepo(name: string): Promise<IndexedRepo> {
  const store = await import("../../src/lib/colbert/index-store")
  const manifest = await import("../../src/lib/colbert/manifest")
  const prov = await import("../../src/lib/colbert/provision")
  const ws = fsSync.realpathSync(
    await fs.mkdtemp(path.join(TEST_HOME, `${name}-`)),
  )
  await fs.mkdir(ws, { recursive: true })
  git(ws, ["init", "-q"])
  git(ws, ["config", "user.email", "t@example.invalid"])
  git(ws, ["config", "user.name", "t"])
  await fs.writeFile(path.join(ws, "a.txt"), "a\n")
  git(ws, ["add", "-A"])
  git(ws, ["commit", "-qm", "a"])
  const head = git(ws, ["rev-parse", "HEAD"]).trim()

  await store.writeColbertMeta({
    workspace: ws,
    model: "LateOn-Code-edge",
    modelRev: manifest.MODEL_REVISION,
    binarySha: manifest.colgrepBinAsset()?.sha256,
    ortSha: manifest.ortLibAsset()?.sha256,
    status: "ready",
    lastIndexedHead: head,
    lastIndexedDirty: false,
    lastIndexedAt: new Date().toISOString(),
    failedAttempts: 0,
    ownerInstanceId: "test",
  })

  // Coherent physical index the project-dir lookup can find.
  const indicesDir = path.join(colbertDir, "indices")
  const projectDir = path.join(indicesDir, `${name}-hash`)
  await fs.mkdir(path.join(projectDir, "index"), { recursive: true })
  await writeInsideTestHome(
    path.join(projectDir, "project.json"),
    JSON.stringify({
      path: store.canonicalWorkspace(ws),
      model: prov.canonicalColbertModelDir(),
    }),
  )
  await writeInsideTestHome(
    path.join(projectDir, "index", "0.metadata.json"),
    JSON.stringify({ embedding_offset: 0, num_embeddings: 3 }),
  )
  return { ws, head }
}

afterEach(async () => {
  const runner = await import("../../src/lib/colbert/runner")
  runner.__setInitRunnerForTests(undefined)
  await runner.__waitForAllInitsForTests()
  await fs.rm(colbertDir, { recursive: true, force: true }).catch(() => {})
})

describe("freshness delta + servability", () => {
  test("clean tree, same HEAD → fresh, servable, no delta", async () => {
    const store = await import("../../src/lib/colbert/index-store")
    const { ws } = await mkIndexedRepo("fresh")
    if (await hostCannotServe(ws)) return
    const v = await store.freshnessVerdict(ws)
    expect(v.verdict).toBe("fresh")
    expect(store.isServableVerdict(v)).toBe(true)
    expect(v.staleFiles ?? []).toEqual([])
  })

  test("one dirty file → stale/content with the file listed, servable", async () => {
    const store = await import("../../src/lib/colbert/index-store")
    const { ws } = await mkIndexedRepo("dirty1")
    await fs.writeFile(path.join(ws, "a.txt"), "a changed\n")
    if (await hostCannotServe(ws)) return
    const v = await store.freshnessVerdict(ws)
    expect(v.verdict).toBe("stale")
    expect(v.staleKind).toBe("content")
    expect(v.staleFiles).toContain("a.txt")
    expect(v.staleTruncated).toBe(false)
    expect(store.isServableVerdict(v)).toBe(true)
  })

  test("untracked files count toward the delta", async () => {
    const store = await import("../../src/lib/colbert/index-store")
    const { ws } = await mkIndexedRepo("untracked")
    await fs.writeFile(path.join(ws, "new.txt"), "new\n")
    if (await hostCannotServe(ws)) return
    const v = await store.freshnessVerdict(ws)
    expect(v.verdict).toBe("stale")
    expect(v.staleKind).toBe("content")
    expect(v.staleFiles).toContain("new.txt")
    expect(store.isServableVerdict(v)).toBe(true)
  })

  test("HEAD moved by one commit → stale/content with diff files, servable", async () => {
    const store = await import("../../src/lib/colbert/index-store")
    const { ws } = await mkIndexedRepo("moved")
    await fs.writeFile(path.join(ws, "b.txt"), "b\n")
    git(ws, ["add", "-A"])
    git(ws, ["commit", "-qm", "b"])
    if (await hostCannotServe(ws)) return
    const v = await store.freshnessVerdict(ws)
    expect(v.verdict).toBe("stale")
    expect(v.staleKind).toBe("content")
    expect(v.staleFiles).toContain("b.txt")
    expect(store.isServableVerdict(v)).toBe(true)
  })

  test("large delta (>200 files) → stale/content but NOT servable", async () => {
    const store = await import("../../src/lib/colbert/index-store")
    const { ws } = await mkIndexedRepo("bigdelta")
    for (let i = 0; i < 250; i++) {
      await fs.writeFile(path.join(ws, `f${i}.txt`), "x\n")
    }
    if (await hostCannotServe(ws)) return
    const v = await store.freshnessVerdict(ws)
    expect(v.verdict).toBe("stale")
    expect(v.staleKind).toBe("content")
    expect(v.staleTruncated).toBe(false) // 250 < 1000 enum cap: fully listed…
    expect(v.staleFiles?.length).toBe(250)
    expect(store.isServableVerdict(v)).toBe(false) // …but over the serve cap
  })

  test("engine SHA mismatch → staleKind engine, NOT servable", async () => {
    const store = await import("../../src/lib/colbert/index-store")
    const { ws } = await mkIndexedRepo("engine")
    const meta = await store.readColbertMeta(ws)
    await store.writeColbertMeta({
      ...meta!,
      workspace: ws,
      binarySha: "stale-binary-sha",
    })
    // On a host with no prebuilt engine the comparison this test targets cannot
    // run at all (both shas are `undefined`), so the host contract stands in:
    // an index recorded against a foreign engine is not servable here either.
    if (await hostCannotServe(ws)) return
    const v = await store.freshnessVerdict(ws)
    expect(v.verdict).toBe("stale")
    expect(v.staleKind).toBe("engine")
    expect(store.isServableVerdict(v)).toBe(false)
  })

  test("isServableVerdict unit table", async () => {
    const store = await import("../../src/lib/colbert/index-store")
    const base = { verdict: "fresh" as const, meta: null }
    expect(store.isServableVerdict(base)).toBe(true)
    expect(
      store.isServableVerdict({
        ...base,
        verdict: "stale",
        staleKind: "content",
        staleFiles: ["a"],
        staleTruncated: false,
      }),
    ).toBe(true)
    expect(
      store.isServableVerdict({
        ...base,
        verdict: "stale",
        staleKind: "content",
        staleFiles: new Array(201).fill("f"),
        staleTruncated: false,
      }),
    ).toBe(false)
    expect(
      store.isServableVerdict({
        ...base,
        verdict: "stale",
        staleKind: "content",
        staleFiles: ["a"],
        staleTruncated: true,
      }),
    ).toBe(false)
    expect(
      store.isServableVerdict({ ...base, verdict: "stale", staleKind: "engine" }),
    ).toBe(false)
    expect(
      store.isServableVerdict({ ...base, verdict: "stale", staleKind: "suspect" }),
    ).toBe(false)
    for (const verdict of [
      "building",
      "failed",
      "crashed",
      "corrupt",
      "absent",
      "unsupported",
    ] as const) {
      expect(store.isServableVerdict({ ...base, verdict })).toBe(false)
    }
  })

  test("never-indexed workspace reports the platform verdict where nothing can build, `absent` where it can", async () => {
    // `absent` is an instruction as much as a state: the runner reacts by
    // kicking a background build, and `index --status` prints it as the
    // freshness verdict. On a platform-arch with no prebuilt colgrep/ORT that
    // build cannot start (the engine lookup fails before colgrep runs), so the
    // honest answer is the platform one. The gate used to cover only the
    // servable states, which left this case telling the operator to index a
    // workspace that could never be indexed.
    const store = await import("../../src/lib/colbert/index-store")
    const ws = fsSync.realpathSync(
      fsSync.mkdtempSync(path.join(REAL_TMPDIR, "gh-router-noidx-")),
    )
    execFileSync("git", ["init"], { cwd: ws, stdio: "pipe" })
    const v = await store.freshnessVerdict(ws)
    expect(v.verdict).toBe(PLATFORM_SUPPORTED ? "absent" : "unsupported")
    // Whichever it is, the runner must not be told this is servable.
    expect(store.isServableVerdict(v)).toBe(false)
    await fs.rm(ws, { recursive: true, force: true })
  })
})

describe("runner serve-while-stale", () => {
  async function fakeBinaries(): Promise<void> {
    const prov = await import("../../src/lib/colbert/provision")
    await writeInsideTestHome(prov.colgrepBinaryPath(), "binary")
    await fs.mkdir(path.dirname(prov.colbertOrtDylibPath()), { recursive: true })
    await writeInsideTestHome(prov.colbertOrtDylibPath(), "dylib")
  }

  function cannedSearchHits(ws: string) {
    return {
      stdout: JSON.stringify([
        {
          unit: {
            file: path.join(ws, "a.txt"),
            line: 1,
            name: "a",
            signature: "a",
            code: "a\n",
          },
          score: 0.9,
        },
      ]),
      stderr: "",
      code: 0,
      timedOut: false,
      stdoutTruncated: false,
      stalled: false,
    }
  }

  test("serveStale serves a small content delta labeled stale + kicks refresh", async () => {
    const runner = await import("../../src/lib/colbert/runner")
    const { ws } = await mkIndexedRepo("servestale")
    await fakeBinaries()
    await fs.writeFile(path.join(ws, "a.txt"), "a changed\n")
    // Counts everything that goes through the mocked runner entry (the serve
    // AND the background refresh kick share it).
    let runnerCalls = 0
    runner.__setInitRunnerForTests((async () => {
      runnerCalls++
      return cannedSearchHits(ws)
    }) as never)
    try {
      const r = await runner.runSemanticSearch({
        query: "a",
        workspace: ws,
        serveStale: true,
      })
      if (!PLATFORM_SUPPORTED) {
        // No prebuilt engine: the verdict is `unsupported`, so the runner
        // reports it and — unlike the `absent`/`stale` paths — must NOT kick a
        // build that can only die in the binary lookup.
        expect(r.status).toBe("unavailable")
        expect(r.isError).toBe(true)
        expect(r.notice).toMatch(/platform/i)
        expect(r.stale_files).toBeUndefined()
        expect(runnerCalls).toBe(0)
        return
      }
      expect(r.status).toBe("ready")
      expect(r.source).toBe("semantic")
      expect(r.results?.length).toBeGreaterThan(0)
      expect(r.freshness).toBe("stale")
      expect(r.stale_files).toBe(1)
    } finally {
      runner.__setInitRunnerForTests(undefined)
    }
  })

  test("without serveStale the same delta refuses (strict contract preserved)", async () => {
    const runner = await import("../../src/lib/colbert/runner")
    const { ws } = await mkIndexedRepo("strictstale")
    await fakeBinaries()
    await fs.writeFile(path.join(ws, "a.txt"), "a changed\n")
    let runnerCalls = 0
    runner.__setInitRunnerForTests((async () => {
      runnerCalls++
      return cannedSearchHits(ws)
    }) as never)
    try {
      const r = await runner.runSemanticSearch({ query: "a", workspace: ws })
      if (!PLATFORM_SUPPORTED) {
        expect(r.status).toBe("unavailable")
        expect(r.isError).toBe(true)
        expect(r.results).toBeUndefined()
        expect(r.freshness).toBeUndefined()
        expect(runnerCalls).toBe(0)
        return
      }
      expect(r.status).toBe("stale")
      expect(r.results).toBeUndefined()
      expect(r.freshness).toBeUndefined()
    } finally {
      runner.__setInitRunnerForTests(undefined)
    }
  })
})
