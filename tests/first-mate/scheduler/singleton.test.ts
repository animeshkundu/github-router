import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import fsp from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { acquireDaemonSingleton } from "~/lib/first-mate/scheduler/singleton"

let dir: string
const pidPath = (): string => path.join(dir, "scheduler.daemon.pid")
const recordedPid = (): number =>
  (JSON.parse(fs.readFileSync(pidPath(), "utf8")) as { pid: number }).pid
const noSleep = async (): Promise<void> => {}

beforeEach(async () => {
  dir = await fsp.mkdtemp(path.join(tmpdir(), "fm-singleton-"))
})
afterEach(async () => {
  await fsp.rm(dir, { recursive: true, force: true }).catch(() => {})
})

describe("daemon process singleton (pidfile)", () => {
  test("first acquire wins and writes an identity record", async () => {
    const r = await acquireDaemonSingleton({ dir, selfPid: 100, isAlive: () => true })
    expect(r.acquired).toBe(true)
    expect(recordedPid()).toBe(100)
  })

  test("a second live daemon is refused (default policy)", async () => {
    await acquireDaemonSingleton({ dir, selfPid: 100, isAlive: () => true })
    const r2 = await acquireDaemonSingleton({ dir, selfPid: 200, isAlive: () => true })
    expect(r2.acquired).toBe(false)
    expect(r2.existingPid).toBe(100)
    // The incumbent's record is left intact.
    expect(recordedPid()).toBe(100)
  })

  test("a stale pidfile (dead pid) is taken over", async () => {
    await acquireDaemonSingleton({ dir, selfPid: 100, isAlive: () => true })
    // pid 100 is now dead; a fresh daemon takes over.
    const r2 = await acquireDaemonSingleton({
      dir,
      selfPid: 200,
      isAlive: (pid) => pid !== 100,
    })
    expect(r2.acquired).toBe(true)
    expect(recordedPid()).toBe(200)
  })

  test("terminate policy waits for the incumbent to EXIT, then takes over", async () => {
    await acquireDaemonSingleton({ dir, selfPid: 100, isAlive: () => true })
    const killed: number[] = []
    // The incumbent stays alive for a few probes after SIGTERM, then exits.
    let aliveProbes = 0
    const r2 = await acquireDaemonSingleton({
      dir,
      selfPid: 200,
      isAlive: (pid) => {
        if (pid !== 100) return false
        aliveProbes += 1
        return aliveProbes <= 3 // alive at the initial check + 2 poll probes
      },
      onConflict: "terminate",
      terminate: (pid) => killed.push(pid),
      pollMs: 1,
      terminateWaitMs: 100,
      sleep: noSleep,
    })
    expect(r2.acquired).toBe(true)
    expect(killed).toEqual([100])
    expect(recordedPid()).toBe(200)
  })

  test("terminate policy REFUSES if the incumbent never exits (no double-run)", async () => {
    await acquireDaemonSingleton({ dir, selfPid: 100, isAlive: () => true })
    const r2 = await acquireDaemonSingleton({
      dir,
      selfPid: 200,
      isAlive: () => true, // incumbent never dies
      onConflict: "terminate",
      terminate: () => {},
      pollMs: 1,
      terminateWaitMs: 10,
      sleep: noSleep,
    })
    expect(r2.acquired).toBe(false)
    expect(r2.existingPid).toBe(100)
    expect(recordedPid()).toBe(100) // the live incumbent is NOT overwritten
  })

  test("release only removes the pidfile if it still carries our token", async () => {
    const r = await acquireDaemonSingleton({ dir, selfPid: 100, isAlive: () => true })
    // A successor took over the pidfile (100 looks dead) — different token.
    await acquireDaemonSingleton({
      dir,
      selfPid: 999,
      isAlive: (pid) => pid !== 100,
    })
    await r.release()
    expect(fs.existsSync(pidPath())).toBe(true) // successor's pidfile preserved
    expect(recordedPid()).toBe(999)
  })

  test("release removes our own pidfile", async () => {
    const r = await acquireDaemonSingleton({ dir, selfPid: 100, isAlive: () => true })
    await r.release()
    expect(fs.existsSync(pidPath())).toBe(false)
  })

  test("re-acquire by the SAME pid is idempotent (not a conflict)", async () => {
    await acquireDaemonSingleton({ dir, selfPid: 100, isAlive: () => true })
    const again = await acquireDaemonSingleton({ dir, selfPid: 100, isAlive: () => true })
    expect(again.acquired).toBe(true)
  })

  test("a corrupt pidfile is treated as stale and taken over", async () => {
    await fsp.writeFile(pidPath(), "not-json{{{")
    const r = await acquireDaemonSingleton({ dir, selfPid: 300, isAlive: () => true })
    expect(r.acquired).toBe(true)
    expect(recordedPid()).toBe(300)
  })

  test("a created-but-not-yet-written (empty) pidfile is preserved; B refuses (R3 #2)", async () => {
    // Simulate an incumbent that created the pidfile but has not yet written its
    // JSON — the empty-file window. A second daemon must NOT delete it (that is
    // the double-acquire) and must NOT acquire.
    await fsp.writeFile(pidPath(), "")
    const r = await acquireDaemonSingleton({ dir, selfPid: 200, isAlive: () => true })
    expect(r.acquired).toBe(false)
    // The incumbent's file is left intact and untouched for it to finish writing.
    expect(fs.existsSync(pidPath())).toBe(true)
    expect(await fsp.readFile(pidPath(), "utf8")).toBe("")
  })

  test("an AGED empty pidfile (crashed mid-create) is retired and taken over (R3 #2)", async () => {
    // An empty file older than the grace window is debris, not a live peer — it
    // must not wedge startup forever.
    await fsp.writeFile(pidPath(), "")
    const old = new Date(Date.now() - 60_000)
    await fsp.utimes(pidPath(), old, old)
    const r = await acquireDaemonSingleton({ dir, selfPid: 300, isAlive: () => true })
    expect(r.acquired).toBe(true)
    expect(recordedPid()).toBe(300)
  })
})
