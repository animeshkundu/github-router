import { afterEach, describe, expect, test } from "bun:test"

import { maybeSpawnDaemon, shouldAutoSpawnDaemon } from "~/lib/first-mate/scheduler/autospawn"

const saved = process.env.GH_ROUTER_FM_DAEMON
afterEach(() => {
  if (saved === undefined) delete process.env.GH_ROUTER_FM_DAEMON
  else process.env.GH_ROUTER_FM_DAEMON = saved
})

describe("daemon auto-spawn gate", () => {
  test("default ON in agents mode", () => {
    expect(shouldAutoSpawnDaemon({}, true)).toBe(true)
    expect(shouldAutoSpawnDaemon({ GH_ROUTER_FM_DAEMON: "1" }, true)).toBe(true)
  })

  test("escape hatch =0 disables", () => {
    expect(shouldAutoSpawnDaemon({ GH_ROUTER_FM_DAEMON: "0" }, true)).toBe(false)
  })

  test("never spawns outside agents mode", () => {
    expect(shouldAutoSpawnDaemon({}, false)).toBe(false)
    expect(shouldAutoSpawnDaemon({ GH_ROUTER_FM_DAEMON: "1" }, false)).toBe(false)
  })

  test("maybeSpawnDaemon spawns via the injected spawner only when gated on", () => {
    const calls: string[][] = []
    const spawn = (cmd: string[]) => {
      calls.push(cmd)
      return { pid: 4242, kill: () => {} }
    }
    const on = maybeSpawnDaemon({ env: {}, agentsEnabled: true, repoRoot: "/repo", spawn })
    expect(on?.pid).toBe(4242)
    expect(calls[0]?.[0]).toBe("bun")
    expect(calls[0]?.[1]).toContain("first-mate-daemon.ts")

    calls.length = 0
    const off = maybeSpawnDaemon({ env: { GH_ROUTER_FM_DAEMON: "0" }, agentsEnabled: true, spawn })
    expect(off).toBeUndefined()
    expect(calls.length).toBe(0)

    const noAgents = maybeSpawnDaemon({ env: {}, agentsEnabled: false, spawn })
    expect(noAgents).toBeUndefined()
  })

  test("a throwing spawner never crashes bootstrap", () => {
    const boom = () => {
      throw new Error("spawn failed")
    }
    expect(maybeSpawnDaemon({ env: {}, agentsEnabled: true, spawn: boom })).toBeUndefined()
  })
})
