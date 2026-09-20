/**
 * Tests for `src/lib/colbert/service-backend.ts` (Phase 2e query path).
 *
 * The `./service` transport is faked in-memory (no sockets, no binary);
 * everything else is REAL: git repos, tree-sitter extraction, ripgrep
 * enumeration, freshness math. homedir is sandboxed to TEST_HOME so the
 * service sidecar never touches real user state.
 *
 * Isolated (own process): process-global `node:os` mock.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { execFileSync } from "node:child_process"
import fs from "node:fs/promises"
import fsSync from "node:fs"
import os from "node:os"
import path from "node:path"

const REAL_TMPDIR = os.tmpdir()
const TEST_HOME = await fs.mkdtemp(path.join(REAL_TMPDIR, "gh-router-svcbe-test-"))
mock.module("node:os", () => ({
  default: { homedir: () => TEST_HOME, tmpdir: () => REAL_TMPDIR },
  homedir: () => TEST_HOME,
  tmpdir: () => REAL_TMPDIR,
}))

// ---- In-memory fake service -------------------------------------------
interface FakeDoc {
  text: string
  metadata: Record<string, unknown>
}
const fakeIndices = new Map<string, Array<FakeDoc>>()
let startCalls = 0
let failStart = false
let updateCalls = 0
const deletedFiles: Array<string> = []
let dropCalls = 0
/** Deferred merge emulation (ms): accept now, apply later — like the real server. */
let deleteMergeDelayMs = 0
/** In-flight deferred merges (drained per test to avoid cross-test leaks). */
const fakePendingMerges: Array<Promise<void>> = []

mock.module("../../src/lib/colbert/service", () => ({
  indexNameForWorkspace: (ws: string) => `ws-mock-${ws.length}`,
  serverParallelSessions: () => 1,
  ServiceBusyError: class extends Error {},
  startManagedServer: async (_opts: unknown) => {
    startCalls += 1
    if (failStart) throw new Error("fake spawn failure")
    return {
      url: "http://127.0.0.1:9",
      client: {
        health: async () => ({
          ok: true,
          indices: [...fakeIndices.entries()].map(([name, docs]) => ({
            name,
            num_documents: docs.length,
            num_embeddings: docs.length,
            dimension: 48,
          })),
          updates: [],
        }),
        ensureIndex: async (name: string) => {
          if (!fakeIndices.has(name)) fakeIndices.set(name, [])
        },
        dropIndex: async (name: string) => {
          dropCalls += 1
          fakeIndices.delete(name)
          return true
        },
        updateDocuments: async (
          name: string,
          documents: Array<string>,
          metadata: Array<Record<string, unknown>>,
        ) => {
          updateCalls += documents.length
          const docs = fakeIndices.get(name) ?? []
          documents.forEach((text, i) => docs.push({ text, metadata: metadata[i] ?? {} }))
          fakeIndices.set(name, docs)
        },
        deleteDocuments: async (name: string, condition: string, parameters: Array<unknown>) => {
          void condition
          // Model the server's slow delete merge: 202 now, effect later.
          // Populate must wait for the drop before sending updates, or a
          // late delete wipes the new units (unrecoverable data loss).
          // The predicate applies at MERGE time against live state.
          if (deleteMergeDelayMs > 0) {
            const file = String(parameters[0] ?? "")
            deletedFiles.push(file)
            const at = Date.now() + deleteMergeDelayMs
            fakePendingMerges.push(
              (async () => {
                await Bun.sleep(Math.max(0, at - Date.now()))
                const live = fakeIndices.get(name) ?? []
                fakeIndices.set(name, live.filter((d) => d.metadata.file !== file))
              })(),
            )
            return
          }
          const docs = fakeIndices.get(name) ?? []
          // Supports only the file-equality predicate the backend uses.
          const file = String(parameters[0] ?? "")
          deletedFiles.push(file)
          fakeIndices.set(name, docs.filter((d) => d.metadata.file !== file))
        },
        search: async (name: string, query: string, opts: { topK?: number } = {}) => {
          const docs = fakeIndices.get(name) ?? []
          const terms = query.toLowerCase().split(/\s+/)
          const scored = docs
            .map((d, i) => ({
              i,
              score: terms.filter((t) => d.text.toLowerCase().includes(t)).length,
            }))
            .filter((s) => s.score > 0)
            .sort((a, b) => b.score - a.score)
            .slice(0, opts.topK ?? 15)
          return scored.map((s) => ({
            file: String(docs[s.i].metadata.file ?? "?"),
            line: Number(docs[s.i].metadata.line ?? 1),
            ...(docs[s.i].metadata.end_line !== undefined
              ? { end_line: Number(docs[s.i].metadata.end_line) }
              : {}),
            ...(typeof docs[s.i].metadata.name === "string"
              ? { name: String(docs[s.i].metadata.name) }
              : {}),
            score: s.score,
            metadata: docs[s.i].metadata,
          }))
        },
      },
      stop: async () => {},
    }
  },
}))

// Mock provision: model dir lives in TEST_HOME (created per test).
// Must mirror every provision export service-backend imports (Bun validates
// named imports against the mock): server provisioning is stubbed to
// "unavailable" so tests exercise the explicit-binary and fallback paths.
mock.module("../../src/lib/colbert/provision", () => ({
  canonicalColbertModelDir: () => path.join(TEST_HOME, "colbert-models", "edge"),
  colbertOrtDylibPath: () => path.join(TEST_HOME, "colbert-ort", "libort"),
  nextPlaidServerBinaryPath: (variant: string) =>
    path.join(TEST_HOME, "colbert-bin", `next-plaid-api${variant === "cuda" ? "-cuda" : ""}`),
  provisionNextPlaidServer: async () => ({ reason: "mocked: no server binary" }),
}))

type Backend = typeof import("../../src/lib/colbert/service-backend")
let backend: Backend

function git(ws: string, args: Array<string>): string {
  return execFileSync("git", args, { cwd: ws, stdio: "pipe" }).toString()
}

async function mkRepo(name: string): Promise<string> {
  const ws = fsSync.realpathSync(await fs.mkdtemp(path.join(TEST_HOME, `${name}-`)))
  await fs.mkdir(ws, { recursive: true })
  git(ws, ["init", "-q"])
  git(ws, ["config", "user.email", "t@example.invalid"])
  git(ws, ["config", "user.name", "t"])
  await fs.mkdir(path.join(ws, "src"))
  await fs.writeFile(
    path.join(ws, "src", "auth.ts"),
    "export function refreshAuthToken() { return 'tok' }\n",
  )
  git(ws, ["add", "-A"])
  git(ws, ["commit", "-qm", "a"])
  return ws
}

async function mkModelDir(): Promise<void> {
  await fs.mkdir(path.join(TEST_HOME, "colbert-models", "edge"), { recursive: true })
}

beforeEach(async () => {
  backend = await import("../../src/lib/colbert/service-backend")
  fakeIndices.clear()
  startCalls = 0
  failStart = false
  updateCalls = 0
  deletedFiles.length = 0
  dropCalls = 0
  deleteMergeDelayMs = 0
  fakePendingMerges.length = 0
  delete process.env.GH_ROUTER_SEMANTIC_BACKEND
  delete process.env.GH_ROUTER_NEXTPLAID_BIN
  await mkModelDir()
})

afterEach(async () => {
  const b = await import("../../src/lib/colbert/service-backend")
  await b.__waitForServicePopulateForTests()
  await Promise.all([...fakePendingMerges])
  fakePendingMerges.length = 0
  b.__resetServiceSingletonForTests()
  b.__resetServicePopulateForTests()
  delete process.env.GH_ROUTER_SEMANTIC_BACKEND
  delete process.env.GH_ROUTER_NEXTPLAID_BIN
  delete process.env.GH_ROUTER_NEXTPLAID_VARIANT
  delete process.env.GH_ROUTER_NEXTPLAID_CUDA
})

describe("backend selection", () => {
  test("default is colgrep; =service opts in", () => {
    expect(backend.semanticBackend()).toBe("colgrep")
    process.env.GH_ROUTER_SEMANTIC_BACKEND = "service"
    expect(backend.semanticBackend()).toBe("service")
    process.env.GH_ROUTER_SEMANTIC_BACKEND = "bogus"
    expect(backend.semanticBackend()).toBe("colgrep")
  })

  test("serviceBackendEnabled needs model + (binary or promoted download)", async () => {
    process.env.GH_ROUTER_SEMANTIC_BACKEND = "service"
    // Promoted SHAs (current manifest) make the backend actionable even
    // with no binary on disk — ensureServer provisions on demand.
    expect(backend.serviceBackendEnabled()).toBe(true)
    // Explicit binary also enables (classic path).
    process.env.GH_ROUTER_NEXTPLAID_BIN = process.execPath
    expect(backend.serviceBackendEnabled()).toBe(true)
    // ...but without the model dir it's still off either way.
    await fs.rm(path.join(TEST_HOME, "colbert-models"), { recursive: true, force: true })
    expect(backend.serviceBackendEnabled()).toBe(false)
  })

  test("serviceBackendProvisionable ignores the env opt-in (index auto path)", async () => {
    // No GH_ROUTER_SEMANTIC_BACKEND set here: provisionability is about
    // artifacts, not the query-path opt-in.
    expect(backend.serviceBackendProvisionable()).toBe(true)
    await fs.rm(path.join(TEST_HOME, "colbert-models"), { recursive: true, force: true })
    expect(backend.serviceBackendProvisionable()).toBe(false)
  })
})

describe("runServiceSearch", () => {
  // Point the resolver at a real executable (bun itself is never spawned
  // here — ensureServer is reached only via runServiceSearch, which uses
  // the mocked startManagedServer).
  beforeEach(() => {
    process.env.GH_ROUTER_NEXTPLAID_BIN = process.execPath
  })

  test("absent index → unavailable + kicks background populate", async () => {
    const ws = await mkRepo("svcabsent")
    const r = await backend.runServiceSearch({ query: "refreshAuthToken", workspace: ws })
    expect(r.status).toBe("unavailable")
    // Populate runs in background: poll for docs with a deadline.
    const t0 = Date.now()
    for (;;) {
      const docs = [...fakeIndices.values()].flat()
      if (docs.length > 0) break
      if (Date.now() - t0 > 30_000) throw new Error("populate never ran")
      await Bun.sleep(200)
    }
    expect(startCalls).toBeGreaterThan(0)
  })

  test("populated index serves mapped rows", async () => {
    const ws = await mkRepo("svcready")
    // First call kicks populate; wait for it, then search serves.
    expect((await backend.runServiceSearch({ query: "x", workspace: ws })).status).toBe(
      "unavailable",
    )
    const t0 = Date.now()
    let r = await backend.runServiceSearch({ query: "x", workspace: ws })
    while (r.status !== "ready" && Date.now() - t0 < 30_000) {
      await Bun.sleep(300)
      r = await backend.runServiceSearch({ query: "x", workspace: ws })
    }
    expect(r.status).toBe("ready")
    const r2 = await backend.runServiceSearch({
      query: "refreshAuthToken",
      workspace: ws,
      limit: 5,
    })
    expect(r2.status).toBe("ready")
    expect(r2.freshness).toBe("fresh")
    expect(r2.results?.length).toBeGreaterThan(0)
    expect(r2.results?.[0].file).toContain("auth.ts")
    expect(typeof r2.results?.[0].score).toBe("number")
  })

  test("dirty tree serves labeled stale", async () => {
    const ws = await mkRepo("svcstale")
    await backend.runServiceSearch({ query: "x", workspace: ws })
    const t0 = Date.now()
    for (;;) {
      const r = await backend.runServiceSearch({ query: "x", workspace: ws })
      if (r.status === "ready") break
      if (Date.now() - t0 > 30_000) throw new Error("never became ready")
      await Bun.sleep(300)
    }
    await fs.writeFile(path.join(ws, "src", "auth.ts"), "export function refreshAuthToken() { return 'v2' }\n")
    const r = await backend.runServiceSearch({ query: "refreshAuthToken", workspace: ws })
    expect(r.status).toBe("ready")
    expect(r.freshness).toBe("stale")
    expect(r.stale_files).toBe(1)
  })

  test("server start failure → unavailable (caller falls back)", async () => {
    failStart = true
    const ws = await mkRepo("svcfail")
    const r = await backend.runServiceSearch({ query: "x", workspace: ws })
    expect(r.status).toBe("unavailable")
  })
})

describe("server variant selection (cuda with cpu fallback)", () => {
  test("explicit GH_ROUTER_NEXTPLAID_VARIANT wins without probing hardware", async () => {
    process.env.GH_ROUTER_NEXTPLAID_VARIANT = "cuda"
    expect(await backend.selectServerVariant()).toBe("cuda")
    process.env.GH_ROUTER_NEXTPLAID_VARIANT = "cpu"
    expect(await backend.selectServerVariant()).toBe("cpu")
    process.env.GH_ROUTER_NEXTPLAID_VARIANT = "bogus"
    // Falls through to hardware detection (boolean either way, never throws).
    expect(typeof (await backend.selectServerVariant())).toBe("string")
  })

  test("hasCudaGpu never throws and returns a boolean", async () => {
    expect(typeof (await backend.hasCudaGpu())).toBe("boolean")
  })

  test("explicit binary resolves as-is; --cuda only via GH_ROUTER_NEXTPLAID_CUDA=1", async () => {
    process.env.GH_ROUTER_NEXTPLAID_BIN = process.execPath
    const plain = await backend.resolveServerBinaryWithVariant("cuda")
    expect(plain?.binary).toBe(process.execPath)
    expect(plain?.cuda).toBe(false)
    process.env.GH_ROUTER_NEXTPLAID_CUDA = "1"
    const gpu = await backend.resolveServerBinaryWithVariant("cuda")
    expect(gpu?.binary).toBe(process.execPath)
    expect(gpu?.cuda).toBe(true)
  })

  test("unresolvable variant → null or an on-disk binary (never a phantom path)", async () => {
    delete process.env.GH_ROUTER_NEXTPLAID_BIN
    const r = await backend.resolveServerBinaryWithVariant("cpu")
    if (r !== null) {
      // PATH fallback: only believable if the file exists.
      expect(fsSync.existsSync(r.binary)).toBe(true)
      expect(r.cuda).toBe(false)
    }
  })
})

describe("delta populate", () => {
  beforeEach(() => {
    process.env.GH_ROUTER_NEXTPLAID_BIN = process.execPath
  })

  /** Settle tuning for tests: the fake server applies writes synchronously. */
  const FAST_SETTLE = { minWaitMs: 10, pollMs: 10, timeoutMs: 1000 }

  async function mkRepo3(name: string): Promise<string> {
    const ws = fsSync.realpathSync(await fs.mkdtemp(path.join(TEST_HOME, `${name}-`)))
    await fs.mkdir(path.join(ws, "src"), { recursive: true })
    await fs.writeFile(path.join(ws, "src", "auth.ts"), "export function alphaOne() { return 1 }\n")
    await fs.writeFile(path.join(ws, "src", "util.ts"), "export function betaTwo() { return 2 }\n")
    await fs.writeFile(path.join(ws, "src", "stale.ts"), "export function gammaThree() { return 3 }\n")
    git(ws, ["init", "-q"])
    git(ws, ["config", "user.email", "t@example.invalid"])
    git(ws, ["config", "user.name", "t"])
    git(ws, ["add", "-A"])
    git(ws, ["commit", "-qm", "a"])
    return ws
  }

  function docsFor(file: string): Array<{ text: string }> {
    return [...fakeIndices.values()].flat().filter((d) => d.metadata.file === file)
  }

  test("second populate with no changes → unchanged, zero re-embeds", async () => {
    const ws = await mkRepo3("svcdelta")
    const first = await backend.populateWorkspace(ws, { settle: FAST_SETTLE })
    expect(first.status).toBe("ready")
    expect(first.updatedFiles).toBe(3)
    const updatesAfterFirst = updateCalls
    expect(updatesAfterFirst).toBeGreaterThan(0)

    const meta = await backend.readServiceMeta(ws)
    expect(Object.keys(meta?.fileHashes ?? {})).toHaveLength(3)
    // First populate deletes-then-updates each file (no-ops on an empty
    // index); the point is the second run adds none.
    const deletesAfterFirst = deletedFiles.length

    const second = await backend.populateWorkspace(ws, { settle: FAST_SETTLE })
    expect(second.status).toBe("unchanged")
    expect(second.unchanged).toBe(3)
    expect(updateCalls).toBe(updatesAfterFirst)
    expect(deletedFiles).toHaveLength(deletesAfterFirst)
  })

  test("changed file re-indexed once; unchanged files never duplicated", async () => {
    const ws = await mkRepo3("svcdelta2")
    await backend.populateWorkspace(ws, { settle: FAST_SETTLE })
    const keptBefore = docsFor("src/util.ts").length
    expect(keptBefore).toBeGreaterThan(0)

    await fs.writeFile(
      path.join(ws, "src", "auth.ts"),
      "export function alphaOneRenamed() { return 100 }\nexport function alphaExtra() { return 101 }\n",
    )
    const r = await backend.populateWorkspace(ws, { settle: FAST_SETTLE })
    expect(r.status).toBe("ready")
    expect(r.updatedFiles).toBe(1)
    expect(r.removedFiles).toBe(0)
    // Unchanged file's documents are byte-identical in count (no duplicates).
    expect(docsFor("src/util.ts")).toHaveLength(keptBefore)
    // Changed file serves the new symbol.
    expect(docsFor("src/auth.ts").some((d) => d.text.includes("alphaOneRenamed"))).toBe(true)
  })

  test("removed file documents deleted; added file indexed", async () => {
    const ws = await mkRepo3("svcdelta3")
    await backend.populateWorkspace(ws, { settle: FAST_SETTLE })
    expect(docsFor("src/stale.ts").length).toBeGreaterThan(0)

    await fs.rm(path.join(ws, "src", "stale.ts"))
    await fs.writeFile(path.join(ws, "src", "fresh.ts"), "export function deltaFour() { return 4 }\n")
    const r = await backend.populateWorkspace(ws, { settle: FAST_SETTLE })
    expect(r.status).toBe("ready")
    expect(r.removedFiles).toBe(1)
    expect(docsFor("src/stale.ts")).toHaveLength(0)
    expect(docsFor("src/fresh.ts").length).toBeGreaterThan(0)
    expect(deletedFiles).toContain("src/stale.ts")
  })

  test("dry-run classifies without touching the server or sidecar", async () => {
    const ws = await mkRepo3("svcdry")
    await backend.populateWorkspace(ws, { settle: FAST_SETTLE })
    const docsBefore = [...fakeIndices.values()].flat().length
    const metaBefore = await backend.readServiceMeta(ws)

    await fs.writeFile(path.join(ws, "src", "auth.ts"), "export function alphaChanged() { return 9 }\n")
    const r = await backend.populateWorkspace(ws, { dryRun: true, settle: FAST_SETTLE })
    expect(r.status).toBe("dry-run")
    expect(r.updatedFiles).toBe(1)
    expect(r.unchanged).toBe(2)
    expect([...fakeIndices.values()].flat()).toHaveLength(docsBefore)
    expect(await backend.readServiceMeta(ws)).toEqual(metaBefore)
  })

  test("full:true re-embeds everything even with no changes", async () => {
    const ws = await mkRepo3("svcfull")
    await backend.populateWorkspace(ws, { settle: FAST_SETTLE })
    const updatesAfterFirst = updateCalls
    const r = await backend.populateWorkspace(ws, { full: true, settle: FAST_SETTLE })
    expect(r.status).toBe("ready")
    expect(updateCalls).toBeGreaterThan(updatesAfterFirst)
  })

  test("no baseline with live server docs → whole-index drop, no per-file deletes", async () => {
    const ws = await mkRepo3("svcdrop")
    // Orphaned server state: a populated index with no sidecar (the
    // sidecar was deleted/lost). Seed docs directly under the fake index
    // name populate will compute: the mocked indexer keys on the
    // canonical workspace length, and canonicalization is platform
    // specific (Windows extended-length prefix strip), so derive it via
    // the REAL canonicalizer rather than guessing the spelling.
    const { canonicalWorkspace } = await import("../../src/lib/colbert/index-store")
    fakeIndices.set(`ws-mock-${canonicalWorkspace(ws).length}`, [
      { text: "stale", metadata: { file: "src/ghost.ts", line: 1 } },
    ])
    const r = await backend.populateWorkspace(ws, { settle: FAST_SETTLE })
    expect(r.status).toBe("ready")
    expect(dropCalls).toBe(1)
    expect(deletedFiles).toHaveLength(0)
    // Ghost docs are gone; real files are indexed exactly once each.
    const ghost = [...fakeIndices.values()]
      .flat()
      .filter((d) => d.metadata.file === "src/ghost.ts")
    expect(ghost).toHaveLength(0)
    expect(r.updatedFiles).toBe(3)
  })

  test("serviceFreshness: absent → fresh → stale on dirty", async () => {
    const ws = await mkRepo3("svcfresh")
    expect((await backend.serviceFreshness(ws)).verdict).toBe("absent")
    await backend.populateWorkspace(ws, { settle: FAST_SETTLE })
    expect((await backend.serviceFreshness(ws)).verdict).toBe("fresh")
    await fs.writeFile(path.join(ws, "src", "auth.ts"), "export function alphaChanged() { return 9 }\n")
    expect((await backend.serviceFreshness(ws)).verdict).toBe("stale")
  })
})

describe("waitForIndexSettled", () => {
  function stubClient(counts: Array<number | undefined>, fail = false) {
    let i = 0
    return {
      health: async () => {
        if (fail) throw new Error("down")
        const count = counts[Math.min(i, counts.length - 1)]
        i += 1
        return {
          ok: true as const,
          indices: [{ name: "ws-x", num_documents: count as number, num_embeddings: 0, dimension: 0 }],
          updates: [],
        }
      },
    }
  }

  test("waits for docs to appear and stabilize", async () => {
    const got = await backend.waitForIndexSettled(stubClient([0, 0, 5, 5, 5]), "ws-x", true, {
      minWaitMs: 10,
      pollMs: 10,
      timeoutMs: 1000,
    })
    expect(got).toBe(5)
  })

  test("already-settled nonzero index returns after min wait", async () => {
    const got = await backend.waitForIndexSettled(stubClient([7, 7, 7]), "ws-x", true, {
      minWaitMs: 10,
      pollMs: 10,
      timeoutMs: 1000,
    })
    expect(got).toBe(7)
  })

  test("timeout returns the last observed count", async () => {
    const got = await backend.waitForIndexSettled(stubClient([0, 0, 0]), "ws-x", true, {
      minWaitMs: 10,
      pollMs: 10,
      timeoutMs: 50,
    })
    expect(got).toBe(0)
  })

  test("aborted signal returns immediately", async () => {
    const ac = new AbortController()
    ac.abort()
    const got = await backend.waitForIndexSettled(stubClient([9]), "ws-x", true, {
      minWaitMs: 10_000,
      pollMs: 10,
      timeoutMs: 10_000,
    }, ac.signal)
    expect(got).toBe(undefined)
  })

  test("failing health degrades to undefined on timeout", async () => {
    const got = await backend.waitForIndexSettled(stubClient([], true), "ws-x", true, {
      minWaitMs: 10,
      pollMs: 10,
      timeoutMs: 50,
    })
    expect(got).toBe(undefined)
  })
})

describe("waitForDocCountDrop", () => {
  function dropStub(counts: Array<number | undefined>) {
    let i = 0
    return {
      health: async () => {
        const count = counts[Math.min(i, counts.length - 1)]
        i += 1
        return {
          ok: true as const,
          indices: [{ name: "ws-x", num_documents: count as number, num_embeddings: 0, dimension: 0 }],
          updates: [],
        }
      },
    }
  }

  test("returns once the count reaches the target", async () => {
    const got = await backend.waitForDocCountDrop(dropStub([5, 5, 3, 3]), "ws-x", 3, {
      timeoutMs: 1000,
      pollMs: 10,
    })
    expect(got).toBe(3)
  })

  test("already at/below target returns immediately", async () => {
    const got = await backend.waitForDocCountDrop(dropStub([2]), "ws-x", 3, {
      timeoutMs: 1000,
      pollMs: 10,
    })
    expect(got).toBe(2)
  })

  test("timeout throws (fail closed — no lying sidecar)", async () => {
    await expect(
      backend.waitForDocCountDrop(dropStub([5, 5, 5]), "ws-x", 3, { timeoutMs: 50, pollMs: 10 }),
    ).rejects.toThrow(/did not merge/)
  })

  test("aborted signal throws", async () => {
    const ac = new AbortController()
    ac.abort()
    await expect(
      backend.waitForDocCountDrop(dropStub([5]), "ws-x", 3, { timeoutMs: 1000, pollMs: 10 }, ac.signal),
    ).rejects.toThrow(/aborted/)
  })
})

describe("slow delete merge (ordering hazard)", () => {
  beforeEach(() => {
    process.env.GH_ROUTER_NEXTPLAID_BIN = process.execPath
  })

  const SLOW_SETTLE = { minWaitMs: 10, pollMs: 10, timeoutMs: 5000 }

  async function mkRepo(name: string): Promise<string> {
    const ws = fsSync.realpathSync(await fs.mkdtemp(path.join(TEST_HOME, `${name}-`)))
    await fs.mkdir(path.join(ws, "src"), { recursive: true })
    await fs.writeFile(path.join(ws, "src", "auth.ts"), "export function alphaOne() { return 1 }\n")
    await fs.writeFile(path.join(ws, "src", "util.ts"), "export function betaTwo() { return 2 }\n")
    git(ws, ["init", "-q"])
    git(ws, ["config", "user.email", "t@example.invalid"])
    git(ws, ["config", "user.name", "t"])
    git(ws, ["add", "-A"])
    git(ws, ["commit", "-qm", "a"])
    return ws
  }

  function docsFor(file: string): Array<{ text: string }> {
    return [...fakeIndices.values()].flat().filter((d) => d.metadata.file === file)
  }

  test("delete merging after updates never wipes new units", async () => {
    const ws = await mkRepo("svcslow")
    // Deletes apply 300ms after accept; the drop-wait (5s budget) observes
    // the merge before any update is sent.
    deleteMergeDelayMs = 300
    await backend.populateWorkspace(ws, { settle: SLOW_SETTLE })
    expect(docsFor("src/auth.ts").length).toBeGreaterThan(0)

    await fs.writeFile(
      path.join(ws, "src", "auth.ts"),
      "export function alphaRenamed() { return 100 }\n",
    )
    const r = await backend.populateWorkspace(ws, { settle: SLOW_SETTLE })
    expect(r.status).toBe("ready")
    expect(r.updatedFiles).toBe(1)
    // New units survived the slow delete merge (no data loss)…
    expect(docsFor("src/auth.ts").some((d) => d.text.includes("alphaRenamed"))).toBe(true)
    // …and the old units are gone (no duplicates).
    expect(docsFor("src/auth.ts").some((d) => d.text.includes("alphaOne"))).toBe(false)
    expect(docsFor("src/auth.ts")).toHaveLength(1)
  })

  test("delete merge slower than the budget fails closed (no sidecar write)", async () => {
    const ws = await mkRepo("svcslowfail")
    await backend.populateWorkspace(ws, { settle: SLOW_SETTLE })
    await fs.writeFile(path.join(ws, "src", "auth.ts"), "export function alphaV2() { return 2 }\n")
    // The delete will never visibly merge inside a 50ms budget.
    deleteMergeDelayMs = 2000
    await expect(
      backend.populateWorkspace(ws, { settle: { minWaitMs: 10, pollMs: 10, timeoutMs: 50 } }),
    ).rejects.toThrow(/did not merge/)
    // No sidecar write: the stale hashes force a retry instead of a lie.
    const meta = await backend.readServiceMeta(ws)
    expect(meta?.fileHashes?.["src/auth.ts"]).not.toBe(
      (await import("node:crypto")).createHash("sha256").update("export function alphaV2() { return 2 }\n").digest("hex"),
    )
  })
})
