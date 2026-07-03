import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import fsp from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { acquireDaemonSingleton } from "~/lib/first-mate/scheduler/singleton"

let dir: string
const pidPath = (): string => path.join(dir, "scheduler.daemon.pid")

beforeEach(async () => {
  dir = await fsp.mkdtemp(path.join(tmpdir(), "fm-singleton-"))
})
afterEach(async () => {
  await fsp.rm(dir, { recursive: true, force: true }).catch(() => {})
})

describe("daemon process singleton (pidfile)", () => {
  test("first acquire wins and writes the pidfile", () => {
    const r = acquireDaemonSingleton({ dir, selfPid: 100, isAlive: () => true })
    expect(r.acquired).toBe(true)
    expect(fs.readFileSync(pidPath(), "utf8").trim()).toBe("100")
  })

  test("a second live daemon is refused (default policy)", () => {
    acquireDaemonSingleton({ dir, selfPid: 100, isAlive: () => true })
    const r2 = acquireDaemonSingleton({ dir, selfPid: 200, isAlive: () => true })
    expect(r2.acquired).toBe(false)
    expect(r2.existingPid).toBe(100)
    // The incumbent's pid is left intact.
    expect(fs.readFileSync(pidPath(), "utf8").trim()).toBe("100")
  })

  test("a stale pidfile (dead pid) is taken over", () => {
    acquireDaemonSingleton({ dir, selfPid: 100, isAlive: () => true })
    // pid 100 is now dead; a fresh daemon takes over.
    const r2 = acquireDaemonSingleton({ dir, selfPid: 200, isAlive: (pid) => pid !== 100 })
    expect(r2.acquired).toBe(true)
    expect(fs.readFileSync(pidPath(), "utf8").trim()).toBe("200")
  })

  test("terminate policy stops the incumbent then takes over", () => {
    acquireDaemonSingleton({ dir, selfPid: 100, isAlive: () => true })
    const killed: number[] = []
    const r2 = acquireDaemonSingleton({
      dir,
      selfPid: 200,
      isAlive: () => true,
      onConflict: "terminate",
      terminate: (pid) => killed.push(pid),
    })
    expect(r2.acquired).toBe(true)
    expect(killed).toEqual([100])
    expect(fs.readFileSync(pidPath(), "utf8").trim()).toBe("200")
  })

  test("release only removes the pidfile if it is still ours", () => {
    const r = acquireDaemonSingleton({ dir, selfPid: 100, isAlive: () => true })
    // A successor took over the pidfile.
    fs.writeFileSync(pidPath(), "999")
    r.release()
    expect(fs.existsSync(pidPath())).toBe(true) // successor's pidfile preserved
    expect(fs.readFileSync(pidPath(), "utf8").trim()).toBe("999")
  })

  test("re-acquire by the SAME pid is idempotent (not a conflict)", () => {
    acquireDaemonSingleton({ dir, selfPid: 100, isAlive: () => true })
    const again = acquireDaemonSingleton({ dir, selfPid: 100, isAlive: () => true })
    expect(again.acquired).toBe(true)
  })
})
