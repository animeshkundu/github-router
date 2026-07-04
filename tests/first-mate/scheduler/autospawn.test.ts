import { afterEach, describe, expect, test } from "bun:test"

import { maybeSpawnDaemon, shouldAutoSpawnDaemon } from "~/lib/first-mate/scheduler/autospawn"

const saved = process.env.GH_ROUTER_FM_DAEMON
afterEach(() => {
  if (saved === undefined) delete process.env.GH_ROUTER_FM_DAEMON
  else process.env.GH_ROUTER_FM_DAEMON = saved
})

describe("daemon auto-spawn gate", () => {
  test("default OFF in agents mode (opt-in only)", () => {
    // Default OFF: the [fm-heartbeat] cron is the proven driver; the daemon is
    // opt-in via GH_ROUTER_FM_DAEMON=1 until its remaining hardening lands.
    expect(shouldAutoSpawnDaemon({}, true)).toBe(false)
    expect(shouldAutoSpawnDaemon({ GH_ROUTER_FM_DAEMON: "1" }, true)).toBe(true)
  })

  test("only the explicit =1 opt-in enables; other values stay off", () => {
    expect(shouldAutoSpawnDaemon({ GH_ROUTER_FM_DAEMON: "0" }, true)).toBe(false)
    expect(shouldAutoSpawnDaemon({ GH_ROUTER_FM_DAEMON: "true" }, true)).toBe(false)
  })

  test("never spawns outside agents mode", () => {
    expect(shouldAutoSpawnDaemon({}, false)).toBe(false)
    expect(shouldAutoSpawnDaemon({ GH_ROUTER_FM_DAEMON: "1" }, false)).toBe(false)
  })

  test("maybeSpawnDaemon spawns via the injected spawner only when opted in", () => {
    const calls: string[][] = []
    const spawn = (cmd: string[]) => {
      calls.push(cmd)
      return { pid: 4242, kill: () => {} }
    }
    const on = maybeSpawnDaemon({
      env: { GH_ROUTER_FM_DAEMON: "1" },
      agentsEnabled: true,
      repoRoot: "/repo",
      spawn,
    })
    expect(on?.pid).toBe(4242)
    expect(calls[0]?.[0]).toBe("bun")
    expect(calls[0]?.[1]).toContain("first-mate-daemon.ts")

    calls.length = 0
    // Default (no opt-in) → no spawn.
    const off = maybeSpawnDaemon({ env: {}, agentsEnabled: true, spawn })
    expect(off).toBeUndefined()
    expect(calls.length).toBe(0)

    const noAgents = maybeSpawnDaemon({
      env: { GH_ROUTER_FM_DAEMON: "1" },
      agentsEnabled: false,
      spawn,
    })
    expect(noAgents).toBeUndefined()
  })

  test("a throwing spawner never crashes bootstrap", () => {
    const boom = () => {
      throw new Error("spawn failed")
    }
    expect(
      maybeSpawnDaemon({ env: { GH_ROUTER_FM_DAEMON: "1" }, agentsEnabled: true, spawn: boom }),
    ).toBeUndefined()
  })

  test("finding 6: no-op (no false spawn) when the daemon script is absent", () => {
    // Real (non-injected) spawner path: in a dist/global install the .ts entry
    // isn't present, so we must NOT attempt `bun <missing.ts>` — return undefined.
    const handle = maybeSpawnDaemon({
      env: { GH_ROUTER_FM_DAEMON: "1" },
      agentsEnabled: true,
      repoRoot: "/nonexistent-repo-root-xyz",
    })
    expect(handle).toBeUndefined()
  })
})
