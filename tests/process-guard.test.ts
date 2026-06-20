import { describe, expect, test } from "bun:test"
import { spawn, spawnSync } from "node:child_process"
import process from "node:process"

import {
  buildNodeReaperScript,
  processGuardEnabled,
  startProcessGuard,
} from "../src/lib/process-guard"

describe("processGuardEnabled", () => {
  const save = process.env.GH_ROUTER_DISABLE_PROCESS_GUARD
  test("on by default", () => {
    delete process.env.GH_ROUTER_DISABLE_PROCESS_GUARD
    expect(processGuardEnabled()).toBe(true)
  })
  test("opted out with =1", () => {
    process.env.GH_ROUTER_DISABLE_PROCESS_GUARD = "1"
    expect(processGuardEnabled()).toBe(false)
    if (save === undefined) delete process.env.GH_ROUTER_DISABLE_PROCESS_GUARD
    else process.env.GH_ROUTER_DISABLE_PROCESS_GUARD = save
  })
})

describe("buildNodeReaperScript — start-time-verified reaper", () => {
  test("detached group → kills the process GROUP (-pid)", () => {
    const s = buildNodeReaperScript(4321, true)
    expect(s).toContain('process.kill(-PID, "SIGTERM")')
    expect(s).toContain('process.kill(-PID, "SIGKILL")')
  })
  test("non-detached → kills the lone pid (no negative target)", () => {
    const s = buildNodeReaperScript(4321, false)
    expect(s).toContain('process.kill(PID, "SIGTERM")')
    expect(s).not.toContain('process.kill(-PID, "SIGTERM")')
  })
  test("verifies identity (start-time) before killing — never wrong-kill", () => {
    const s = buildNodeReaperScript(4321, true)
    expect(s).toContain("startTime() === snap")
    expect(s).toContain("alive()")
    expect(s).toContain("treeKill()")
  })
  test("waits on stdin EOF as the parent-death signal (not PID polling)", () => {
    const s = buildNodeReaperScript(4321, true)
    expect(s).toContain('process.stdin.on("end"')
    expect(s).not.toContain("process.kill(proxyPid")
  })
  test("generated script is syntactically valid JS", () => {
    for (const detached of [true, false]) {
      expect(() => new Function(buildNodeReaperScript(99, detached))).not.toThrow()
    }
  })
})

describe("startProcessGuard", () => {
  test("is a no-op for a child with no pid (never throws)", () => {
    expect(() => startProcessGuard({ pid: undefined } as never)).not.toThrow()
  })
  const winOnly = process.platform === "win32" ? test : test.skip
  winOnly("is a no-op on win32 (Job Object is the crash net)", () => {
    // No reaper is spawned on Windows; the call must return cleanly.
    const fake = { pid: 999999 } as never
    expect(() => startProcessGuard(fake)).not.toThrow()
  })
})

/** Poll-based liveness check (process.kill(pid,0) throws when gone). */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

// E2E: the Windows crash guarantee we RELY ON instead of a reaper — Node's
// Job Object (KILL_ON_JOB_CLOSE) tears down the whole descendant tree when
// the proxy dies. Force-kill a parent (NO /T) and assert its GRANDCHILD is
// reaped by the OS. POSIX-skipped: this is a Windows-runtime mechanism (on
// POSIX a killed parent's children reparent to init — that's why POSIX has
// the reaper below instead). This is a canary: if a future Node drops the
// job object, the Windows crash path regresses and this test fails loudly.
const winE2E = process.platform === "win32" ? test : test.skip
describe("crash teardown — Windows Job Object (E2E)", () => {
  winE2E(
    "force-killing the proxy reaps the whole child tree (grandchild included)",
    async () => {
      const parentScript =
        `const { spawn } = require("node:child_process");` +
        `const gc = spawn(process.execPath, ["-e","setInterval(()=>{},1000)"], { stdio:"ignore" });` +
        `process.stdout.write("GC:" + gc.pid + "\\n");` +
        `setInterval(() => {}, 1000);`
      const parent = spawn(process.execPath, ["-e", parentScript], {
        stdio: ["ignore", "pipe", "ignore"],
      })
      const gcPid = await new Promise<number>((resolve, reject) => {
        let buf = ""
        const to = setTimeout(() => reject(new Error("no GC pid")), 5000)
        parent.stdout!.on("data", (c: Buffer) => {
          buf += c.toString()
          const m = buf.match(/GC:(\d+)/)
          if (m) {
            clearTimeout(to)
            resolve(Number(m[1]))
          }
        })
      })
      expect(isAlive(gcPid)).toBe(true)
      // Force-kill ONLY the parent (no /T). The job object must cascade.
      spawnSync("taskkill", ["/F", "/PID", String(parent.pid)], { stdio: "ignore" })
      // Give the OS a moment to close the job and tear the tree down.
      let alive = true
      for (let i = 0; i < 20 && alive; i++) {
        await new Promise((r) => setTimeout(r, 200))
        alive = isAlive(gcPid)
      }
      if (alive) spawnSync("taskkill", ["/F", "/PID", String(gcPid)], { stdio: "ignore" })
      expect(alive).toBe(false)
    },
    20000,
  )
})

// E2E: the POSIX crash guard — a detached node reaper reaps the CLI's
// process group when the proxy dies (stdin-pipe EOF). win32-skipped: the
// reaper is POSIX-only (Windows uses the job object above).
const posixE2E = process.platform === "win32" ? test.skip : test
describe("crash teardown — POSIX reaper (E2E)", () => {
  posixE2E(
    "reaper reaps the child's group on proxy-death EOF",
    async () => {
      const victim = spawn(
        process.execPath,
        ["-e", "setInterval(() => {}, 1000)"],
        { stdio: "ignore", detached: true },
      )
      await new Promise((r) => setTimeout(r, 250))
      const reaper = spawn(
        process.execPath,
        ["-e", buildNodeReaperScript(victim.pid as number, true)],
        { stdio: ["pipe", "ignore", "ignore"], detached: true },
      )
      try {
        await new Promise((r) => setTimeout(r, 400)) // snapshot start-time
        reaper.stdin?.end() // simulate proxy death → EOF
        // Poll liveness with a generous deadline rather than a single fixed
        // wait — under parallel test load the reaper's kill can take a beat.
        const vpid = victim.pid as number
        let alive = true
        for (let i = 0; i < 50 && alive; i++) {
          await new Promise((r) => setTimeout(r, 200))
          alive = isAlive(vpid)
        }
        expect(alive).toBe(false)
      } finally {
        try {
          if (victim.exitCode === null && victim.pid) process.kill(-victim.pid, "SIGKILL")
        } catch {
          /* already gone */
        }
        try {
          reaper.kill("SIGKILL")
        } catch {
          /* already gone */
        }
      }
    },
    15000,
  )
})
