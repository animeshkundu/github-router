/**
 * Unit tests for the pure/injectable Stop-gate policy helpers. These tests avoid
 * running repo scripts; the only stable app-dir write is the explicit
 * trustRepo/isRepoTrusted round-trip, whose created trust file is removed.
 */

import { describe, expect, test } from "bun:test"

import { createHash, randomUUID } from "node:crypto"
import { promises as fs } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import { fileBlockBudget } from "../src/lib/orchestration/stop-gate-hook"
import {
  fileBaselineStore,
  isRepoTrusted,
  isSubagentContext,
  regressions,
  repoRoot,
  stopGateEnabledForRepo,
  trustRepo,
} from "../src/lib/orchestration/stop-gate-policy"
import { PATHS } from "../src/lib/paths"

async function uniqueTempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(tmpdir(), `${prefix}-${randomUUID()}-`))
}

async function gitInit(cwd: string): Promise<void> {
  const proc = Bun.spawn(["git", "init"], { cwd, stdout: "pipe", stderr: "pipe" })
  const exitCode = await proc.exited
  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text()
    throw new Error(`git init failed with ${exitCode}: ${stderr}`)
  }
}

function trustFileForRoot(root: string): string {
  const key = createHash("sha256").update(path.resolve(root)).digest("hex").slice(0, 32)
  return path.join(PATHS.APP_DIR, "stop-gate", "trust", key)
}

describe("isSubagentContext", () => {
  test("non-empty agent_type or agent_id marks a subagent context", () => {
    expect(isSubagentContext({ agent_type: "Explore" })).toBe(true)
    expect(isSubagentContext({ agent_id: "a1" })).toBe(true)
  })

  test("only missing, undefined, or null agent fields are top-level context", () => {
    expect(isSubagentContext({})).toBe(false)
    expect(isSubagentContext({ agent_type: undefined })).toBe(false)
    expect(isSubagentContext({ agent_id: undefined })).toBe(false)
    expect(isSubagentContext({ agent_type: null })).toBe(false)
    expect(isSubagentContext({ agent_id: null })).toBe(false)
  })

  test("any present non-null agent marker stands the gate down", () => {
    expect(isSubagentContext({ agent_type: "" })).toBe(true)
    expect(isSubagentContext({ agent_id: "" })).toBe(true)
    expect(isSubagentContext({ agent_type: 123 })).toBe(true)
    expect(isSubagentContext({ agent_id: true })).toBe(true)
  })
})

describe("regressions", () => {
  test("returns only currently failing checks absent from the baseline", () => {
    expect(regressions(["a", "b"], new Set(["a"]))).toEqual(["b"])
  })

  test("null baseline means first evaluation: no regressions", () => {
    expect(regressions(["a"], null)).toEqual([])
  })

  test("checks already failing in the baseline are not regressions", () => {
    expect(regressions(["a"], new Set(["a"]))).toEqual([])
  })
})

describe("fileBaselineStore", () => {
  test("get before set returns null, then round-trips a Set of failures", async () => {
    const dir = await uniqueTempDir("ghr-baseline")
    try {
      const store = fileBaselineStore(dir)
      expect(await store.get("session-A")).toBeNull()
      await store.set("session-A", ["x"])
      expect(await store.get("session-A")).toEqual(new Set(["x"]))
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  test("baselines are isolated by session id and round-trip multiple values", async () => {
    const dir = await uniqueTempDir("ghr-baseline")
    try {
      const store = fileBaselineStore(dir)
      await store.set("session-A", ["x", "y"])
      expect(await store.get("session-A")).toEqual(new Set(["x", "y"]))
      expect(await store.get("session-B")).toBeNull()
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })
})

describe("fileBlockBudget reset", () => {
  test("record twice -> count 2; reset -> count 0", async () => {
    const dir = await uniqueTempDir("ghr-budget")
    try {
      const budget = fileBlockBudget(dir)
      await budget.record("session-A")
      await budget.record("session-A")
      expect(await budget.count("session-A")).toBe(2)
      await budget.reset("session-A")
      expect(await budget.count("session-A")).toBe(0)
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  test("reset is scoped to one session", async () => {
    const dir = await uniqueTempDir("ghr-budget")
    try {
      const budget = fileBlockBudget(dir)
      await budget.record("session-A")
      await budget.record("session-B")
      await budget.reset("session-A")
      expect(await budget.count("session-A")).toBe(0)
      expect(await budget.count("session-B")).toBe(1)
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })
})

describe("stopGateEnabledForRepo and trust store", () => {
  test("disable env force-off wins even for a trusted repo", async () => {
    expect(await stopGateEnabledForRepo("/does/not/matter", {
      GH_ROUTER_DISABLE_STOP_GATE: "1",
      GH_ROUTER_ENABLE_STOP_GATE: "1",
    })).toBe(false)
  })

  test("enable env force-on returns true without requiring trust", async () => {
    const dir = await uniqueTempDir("ghr-untrusted-force-on")
    try {
      expect(await stopGateEnabledForRepo(dir, { GH_ROUTER_ENABLE_STOP_GATE: "1" })).toBe(true)
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  test("with neither env flag, an untrusted cwd is disabled", async () => {
    const dir = await uniqueTempDir("ghr-untrusted")
    try {
      expect(await isRepoTrusted(dir)).toBe(false)
      expect(await stopGateEnabledForRepo(dir, {})).toBe(false)
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  test("trustRepo then isRepoTrusted round-trips for a fresh git repo and cleans the trust file", async () => {
    const dir = await uniqueTempDir("ghr-trusted-repo")
    let trustFile: string | undefined
    try {
      await gitInit(dir)
      const root = await trustRepo(dir)
      expect(root).toBe(await repoRoot(dir))
      trustFile = trustFileForRoot(root)
      expect(await isRepoTrusted(dir)).toBe(true)
      expect((await fs.readFile(trustFile, "utf8")).startsWith(`${root}\n`)).toBe(true)
    } finally {
      if (trustFile) await fs.rm(trustFile, { force: true })
      await fs.rm(dir, { recursive: true, force: true })
    }
  })
})
