import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { spawn } from "node:child_process"
import process from "node:process"

import {
  __keepAwakeChildPidForTests,
  __resetKeepAwakeForTests,
  keepAwakeEnabled,
  keepAwakeOptedIn,
  keepDisplayOn,
  startKeepAwake,
  stopKeepAwake,
} from "../src/lib/keep-awake"
import {
  buildHelperArgs,
  buildKeepAwakeScript,
  executionStateFlags,
  killHelper,
  spawnHelper,
} from "../src/lib/keep-awake/helper"

const isWin = process.platform === "win32"

// Save/restore the two env keys this feature reads so tests don't leak.
let savedDisable: string | undefined
let savedDisplay: string | undefined
beforeEach(() => {
  savedDisable = process.env.GH_ROUTER_DISABLE_KEEP_AWAKE
  savedDisplay = process.env.GH_ROUTER_KEEP_DISPLAY_ON
  delete process.env.GH_ROUTER_DISABLE_KEEP_AWAKE
  delete process.env.GH_ROUTER_KEEP_DISPLAY_ON
})
afterEach(() => {
  const restore = (k: string, v: string | undefined): void => {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  restore("GH_ROUTER_DISABLE_KEEP_AWAKE", savedDisable)
  restore("GH_ROUTER_KEEP_DISPLAY_ON", savedDisplay)
  __resetKeepAwakeForTests()
})

describe("keep-awake flags", () => {
  test("keepAwakeOptedIn: ON by default when unset", () => {
    expect(keepAwakeOptedIn()).toBe(true)
  })
  test("keepAwakeOptedIn: opt-out values disable", () => {
    for (const v of ["1", "true", "yes", "on", "TRUE", " On "]) {
      process.env.GH_ROUTER_DISABLE_KEEP_AWAKE = v
      expect(keepAwakeOptedIn()).toBe(false)
    }
  })
  test("keepAwakeOptedIn: off-ish values keep it ON", () => {
    for (const v of ["0", "false", "no", "off", ""]) {
      process.env.GH_ROUTER_DISABLE_KEEP_AWAKE = v
      expect(keepAwakeOptedIn()).toBe(true)
    }
  })
  test("keepDisplayOn: OFF by default, ON only for opt-in values", () => {
    expect(keepDisplayOn()).toBe(false)
    for (const v of ["1", "true", "yes", "on"]) {
      process.env.GH_ROUTER_KEEP_DISPLAY_ON = v
      expect(keepDisplayOn()).toBe(true)
    }
    for (const v of ["0", "false", "off", ""]) {
      process.env.GH_ROUTER_KEEP_DISPLAY_ON = v
      expect(keepDisplayOn()).toBe(false)
    }
  })
})

describe("keepAwakeEnabled (platform gate)", () => {
  test("false on non-win32 regardless of opt-out flag", () => {
    expect(keepAwakeEnabled("linux")).toBe(false)
    expect(keepAwakeEnabled("darwin")).toBe(false)
    process.env.GH_ROUTER_DISABLE_KEEP_AWAKE = "1"
    expect(keepAwakeEnabled("linux")).toBe(false)
  })
  test("win32: ON by default, OFF when opted out", () => {
    expect(keepAwakeEnabled("win32")).toBe(true)
    process.env.GH_ROUTER_DISABLE_KEEP_AWAKE = "1"
    expect(keepAwakeEnabled("win32")).toBe(false)
  })
})

describe("executionStateFlags + script (pure)", () => {
  test("system-only = 0x80000001, system+display = 0x80000003", () => {
    expect(executionStateFlags(false)).toBe(0x80000001)
    expect(executionStateFlags(true)).toBe(0x80000003)
  })
  test("buildKeepAwakeScript emits decimal [uint32] casts, never hex", () => {
    // Regression guard: win32 PowerShell parses `0x80000001` as a NEGATIVE
    // Int32 that fails the uint conversion; the script MUST use decimal.
    const sys = buildKeepAwakeScript(false)
    expect(sys).toContain("[uint32]2147483649") // ES_CONTINUOUS|ES_SYSTEM_REQUIRED
    expect(sys).toContain("[uint32]2147483648") // ES_CONTINUOUS (clear)
    expect(sys).not.toContain("0x8000")
    expect(sys).toContain("SetThreadExecutionState")
    expect(sys).toContain("kernel32.dll")
    expect(sys).toContain("[Console]::Out.WriteLine('OK')")
    expect(sys).toContain("[Console]::In.ReadLine()")

    const disp = buildKeepAwakeScript(true)
    expect(disp).toContain("[uint32]2147483651") // + ES_DISPLAY_REQUIRED
  })
  test("buildHelperArgs: -NoProfile -NonInteractive -Command <script>", () => {
    const args = buildHelperArgs(false)
    expect(args).toEqual([
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      buildKeepAwakeScript(false),
    ])
  })
})

describe("startKeepAwake non-win32 no-op", () => {
  test.skipIf(isWin)("no spawn; stop resolves immediately", async () => {
    // keepAwakeEnabled() is false off win32, so this is a total no-op.
    startKeepAwake()
    await stopKeepAwake()
    expect(true).toBe(true)
  })
})

// win32-only: exercise the real powershell.exe spawn. Justification for
// skipping elsewhere — the helper is win32-only by design (the platform
// gate is verified above by the platform-independent keepAwakeEnabled
// test), and there is no powershell.exe / SetThreadExecutionState on POSIX
// CI. Windows CI is the primary gate per the project's Windows-first rule.
const isPidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM"
  }
}
const waitForExit = (pid: number, timeoutMs: number): Promise<boolean> =>
  new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs
    const tick = (): void => {
      if (!isPidAlive(pid)) return resolve(true)
      if (Date.now() >= deadline) return resolve(false)
      setTimeout(tick, 150)
    }
    tick()
  })

describe("keep-awake helper spawn (win32)", () => {
  test.skipIf(!isWin)("readies, then exits 0 on stdin EOF (no taskkill)", async () => {
    const { handle, ready } = spawnHelper({
      displayRequired: false,
      readyTimeoutMs: 8000,
    })
    expect(handle).not.toBeNull()
    expect(await ready).toBe(true)
    // Close stdin ONLY (no taskkill): the helper must self-exit on EOF with
    // code 0 — the load-bearing crash-safety mechanism.
    const code = await new Promise<number | null>((r) => {
      handle!.child.once("exit", (c) => r(c))
      handle!.child.stdin?.end()
    })
    expect(code).toBe(0)
  }, 15000)

  test.skipIf(!isWin)("killHelper reaps the helper", async () => {
    const { handle, ready } = spawnHelper({
      displayRequired: false,
      readyTimeoutMs: 8000,
    })
    await ready
    const exited = new Promise<void>((r) => handle!.child.once("exit", () => r()))
    killHelper(handle!)
    await exited // resolves => the child terminated
    expect(isPidAlive(handle!.child.pid as number)).toBe(false)
  }, 15000)

  test.skipIf(!isWin)("startKeepAwake spawns once; stop releases the handle", async () => {
    startKeepAwake()
    const pid = __keepAwakeChildPidForTests()
    expect(pid).toBeGreaterThan(0)
    startKeepAwake() // idempotent: must NOT spawn a second helper
    expect(__keepAwakeChildPidForTests()).toBe(pid)
    await stopKeepAwake()
    expect(__keepAwakeChildPidForTests()).toBeUndefined() // handle released
    await stopKeepAwake() // idempotent no-op
  }, 15000)

  test.skipIf(!isWin)(
    "helper dies when its parent process exits WITHOUT cleanup (crash safety)",
    async () => {
      // A child runtime starts the helper and exits via process.exit(0)
      // WITHOUT calling stopKeepAwake/killHelper. The helper's stdin pipe
      // (owned by the child) then closes, so it must self-exit. This is the
      // SIGKILL/OOM/hard-exit invariant the design relies on.
      const code = [
        `import { spawnHelper } from "./src/lib/keep-awake/helper.ts";`,
        `const { handle, ready } = spawnHelper({ displayRequired: false, readyTimeoutMs: 8000 });`,
        `await ready;`,
        `console.log("HELPER_PID=" + handle.child.pid);`,
        `setTimeout(() => process.exit(0), 150);`,
      ].join("\n")
      const helperPid = await new Promise<number>((resolve, reject) => {
        const proc = spawn(process.execPath, ["-e", code], {
          cwd: process.cwd(),
          stdio: ["ignore", "pipe", "ignore"],
        })
        let out = ""
        proc.stdout?.on("data", (c: Buffer) => {
          out += c.toString("utf8")
        })
        proc.on("error", reject)
        proc.on("exit", () => {
          const m = out.match(/HELPER_PID=(\d+)/)
          if (m) resolve(Number(m[1]))
          else reject(new Error(`no HELPER_PID in child output: ${out}`))
        })
      })
      expect(helperPid).toBeGreaterThan(0)
      // After the parent exited, the orphaned helper must die on pipe EOF.
      expect(await waitForExit(helperPid, 10000)).toBe(true)
    },
    25000,
  )
})
