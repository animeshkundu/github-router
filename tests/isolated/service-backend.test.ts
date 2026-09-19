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
        health: async () => ({ ok: true, indices: [] }),
        ensureIndex: async (name: string) => {
          if (!fakeIndices.has(name)) fakeIndices.set(name, [])
        },
        updateDocuments: async (
          name: string,
          documents: Array<string>,
          metadata: Array<Record<string, unknown>>,
        ) => {
          const docs = fakeIndices.get(name) ?? []
          documents.forEach((text, i) => docs.push({ text, metadata: metadata[i] ?? {} }))
          fakeIndices.set(name, docs)
        },
        deleteDocuments: async (name: string, condition: string, parameters: Array<unknown>) => {
          void condition
          const docs = fakeIndices.get(name) ?? []
          // Supports only the file-equality predicate the backend uses.
          const file = String(parameters[0] ?? "")
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
  delete process.env.GH_ROUTER_SEMANTIC_BACKEND
  delete process.env.GH_ROUTER_NEXTPLAID_BIN
  await mkModelDir()
})

afterEach(async () => {
  const b = await import("../../src/lib/colbert/service-backend")
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
