import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import fsp from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

/**
 * TRUE end-to-end reliability tests: the harness runs as REAL OS processes
 * (Bun.spawn) against a SCRATCH ledger dir, GitHub faked as local file ops.
 * The fencing lease, durable outbox, and ledger OCC exercised here are the real
 * production modules. Fidelity of the controller's decision logic is covered
 * separately by drive-gate.test.ts (real advance()) + the unit suites.
 */

const HARNESS = path.join(import.meta.dirname, "harness-daemon.ts")
const REPO_ROOT = path.resolve(import.meta.dirname, "../../../..")

interface Proc {
  kill: (sig?: number | NodeJS.Signals) => void
  /** Close the child's stdin (EOF) — the cross-platform graceful kill switch. */
  closeStdin: () => void
  readonly exited: Promise<number>
}

const live: Proc[] = []

function spawnHarness(env: Record<string, string>): Proc {
  const proc = Bun.spawn(["bun", HARNESS], {
    cwd: REPO_ROOT,
    env: { ...process.env, ...env },
    stdin: "pipe",
    stdout: "ignore",
    stderr: "pipe",
  })
  const p: Proc = {
    kill: (sig) => proc.kill(sig as number),
    closeStdin: () => {
      try {
        proc.stdin.end()
      } catch {
        // already closed
      }
    },
    exited: proc.exited,
  }
  live.push(p)
  return p
}

afterEach(() => {
  for (const p of live.splice(0)) {
    try {
      p.kill("SIGKILL")
    } catch {
      // already gone
    }
  }
})

async function scratch(): Promise<{ dir: string; gh: string }> {
  const dir = await fsp.mkdtemp(path.join(tmpdir(), "fm-e2e-"))
  return { dir, gh: path.join(dir, "gh.log") }
}

function ledgerUnits(dir: string): Array<{ id?: string; phase: string }> {
  const file = path.join(dir, "o__e2e.json")
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as {
      units?: Array<{ id?: string; phase: string }>
    }
    return parsed.units ?? []
  } catch {
    return []
  }
}

function unitPhase(dir: string): string | undefined {
  return ledgerUnits(dir).find((u) => u.id === "u1")?.phase
}

function ghCount(gh: string): number {
  try {
    return fs
      .readFileSync(gh, "utf8")
      .split("\n")
      .filter((l) => l.trim().length > 0).length
  } catch {
    return 0
  }
}

async function waitFor(cond: () => boolean, timeoutMs: number): Promise<boolean> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (cond()) return true
    await new Promise((r) => setTimeout(r, 25))
  }
  return cond()
}

const DRIVE = { E2E_MODE: "drive", E2E_REPO: "o/e2e" }

describe("first-mate scheduler — TRUE multi-process E2E", () => {
  test("1. happy path: daemon drives a scratch mission to done, dispatch once", async () => {
    const { dir, gh } = await scratch()
    spawnHarness({ ...DRIVE, E2E_DIR: dir, E2E_GH: gh, E2E_TTL_MS: "5000" })
    const done = await waitFor(() => unitPhase(dir) === "done", 20_000)
    expect(done).toBe(true)
    expect(ghCount(gh)).toBe(1)
  }, 30_000)

  test("2. crash mid-tick → restart reconciles, NO double side-effect (poison-pill)", async () => {
    const { dir, gh } = await scratch()
    const p1 = spawnHarness({
      ...DRIVE,
      E2E_DIR: dir,
      E2E_GH: gh,
      E2E_CRASH: "after_sideeffect",
      E2E_TTL_MS: "5000",
    })
    const code = await p1.exited
    expect(code).toBe(137) // hard crash after the side effect
    expect(ghCount(gh)).toBe(1) // side effect happened once
    expect(unitPhase(dir)).toBe("plan") // ledger write did NOT happen pre-crash

    // Restart clean; must reconcile the outbox and NOT re-dispatch.
    spawnHarness({ ...DRIVE, E2E_DIR: dir, E2E_GH: gh, E2E_TTL_MS: "5000" })
    const done = await waitFor(() => unitPhase(dir) === "done", 20_000)
    expect(done).toBe(true)
    expect(ghCount(gh)).toBe(1) // STILL one — no double side effect, no poison-pill
  }, 30_000)

  test("3. cross-process contention: two writers, no lost update", async () => {
    const { dir } = await scratch()
    const a = spawnHarness({ E2E_MODE: "writer", E2E_REPO: "o/e2e", E2E_DIR: dir, E2E_WRITES: "12", E2E_ID: "a" })
    const b = spawnHarness({ E2E_MODE: "writer", E2E_REPO: "o/e2e", E2E_DIR: dir, E2E_WRITES: "12", E2E_ID: "b" })
    expect(await a.exited).toBe(0)
    expect(await b.exited).toBe(0)
    const units = ledgerUnits(dir)
    const uniqueIds = new Set(units.map((u) => u.id))
    expect(units.length).toBe(24) // O_EXCL lock + CAS → nothing lost
    expect(uniqueIds.size).toBe(24)
  }, 30_000)

  test("4. no double-drive: two daemons share the lease, only the holder dispatches", async () => {
    const { dir, gh } = await scratch()
    spawnHarness({ ...DRIVE, E2E_DIR: dir, E2E_GH: gh, E2E_TTL_MS: "5000" })
    spawnHarness({ ...DRIVE, E2E_DIR: dir, E2E_GH: gh, E2E_TTL_MS: "5000" })
    const done = await waitFor(() => unitPhase(dir) === "done", 20_000)
    expect(done).toBe(true)
    // Both processes were live, but the lease admits only one driver.
    expect(ghCount(gh)).toBe(1)
  }, 30_000)

  test("5. lease-expiry failover: holder killed, backup takes over, still one dispatch", async () => {
    const { dir, gh } = await scratch()
    const primary = spawnHarness({ ...DRIVE, E2E_DIR: dir, E2E_GH: gh, E2E_TTL_MS: "1000" })
    const dispatched = await waitFor(() => ghCount(gh) >= 1, 20_000)
    expect(dispatched).toBe(true)
    primary.kill("SIGKILL") // holder dies without releasing the lease
    await primary.exited
    // Backup can only acquire after the ~1s TTL expires.
    spawnHarness({ ...DRIVE, E2E_DIR: dir, E2E_GH: gh, E2E_TTL_MS: "1000" })
    const done = await waitFor(() => unitPhase(dir) === "done", 20_000)
    expect(done).toBe(true)
    expect(ghCount(gh)).toBe(1) // failover did not re-dispatch
  }, 40_000)

  test("6. kill switch: shutdown request halts cleanly and releases the lease", async () => {
    const { dir, gh } = await scratch()
    const p = spawnHarness({ ...DRIVE, E2E_DIR: dir, E2E_GH: gh, E2E_TTL_MS: "60000" })
    const up = await waitFor(() => fs.existsSync(path.join(dir, "scheduler.lease.json")), 20_000)
    expect(up).toBe(true)
    // Cross-platform kill switch: close stdin (EOF) to trigger the daemon's
    // graceful shutdown. This drives the SAME stop()→release()→exit(0) path an
    // external SIGTERM would on POSIX, but works identically on Windows, which
    // has no real POSIX signals (an external SIGTERM there is a hard
    // TerminateProcess that never runs the handler, so a signal-based assertion
    // would assert POSIX semantics Windows doesn't provide).
    p.closeStdin()
    const code = await p.exited
    expect(code).toBe(0) // stop() ran and the process exited cleanly

    // Lease was released (expired now), so a fresh acquirer could take over.
    const lease = JSON.parse(
      fs.readFileSync(path.join(dir, "scheduler.lease.json"), "utf8"),
    ) as { expiresMs: number }
    expect(lease.expiresMs).toBeLessThanOrEqual(Date.now())
  }, 30_000)

  test("7. REAL advance crash mid-dispatch → restart escalates, exactly-once", async () => {
    const { dir, gh } = await scratch()
    const REAL = { E2E_MODE: "real-drive", E2E_REPO: "o/e2e" }
    // First run: real advance() dispatches, the fake startTask appends to gh
    // then hard-crashes BEFORE the outbox is marked done.
    const p1 = spawnHarness({
      ...REAL,
      E2E_DIR: dir,
      E2E_GH: gh,
      E2E_CRASH: "after_sideeffect",
      E2E_TTL_MS: "600",
    })
    expect(await p1.exited).toBe(137)
    expect(ghCount(gh)).toBe(1) // the side effect happened exactly once
    // The dispatch intent persisted but no taskId was recorded (interrupted).
    const mid = ledgerUnits(dir).find((u) => u.id === "u1") as
      | { taskId?: string | null; dispatch?: unknown }
      | undefined
    expect(mid?.taskId ?? null).toBeNull()
    expect(mid?.dispatch).toBeDefined()

    // Restart clean: recovery must surface the interrupted dispatch to a human
    // and NEVER re-dispatch — the side effect stays at exactly one.
    const p2 = spawnHarness({ ...REAL, E2E_DIR: dir, E2E_GH: gh, E2E_TTL_MS: "600" })
    expect(await p2.exited).toBe(0)
    expect(ghCount(gh)).toBe(1) // no re-dispatch after recovery
    const escalations = fs
      .readFileSync(path.join(dir, "escalations.jsonl"), "utf8")
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as { target: string })
    expect(escalations.some((e) => e.target === "human")).toBe(true)
  }, 30_000)
})
