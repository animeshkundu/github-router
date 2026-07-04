import { afterEach, describe, expect, test } from "bun:test"

import {
  maybeSpawnDaemon,
  shouldAutoSpawnDaemon,
  wireDaemonTeardown,
  type DaemonSpawnOptions,
} from "~/lib/first-mate/scheduler/autospawn"

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

  test("child stdin is piped so the parent can EOF it for a graceful stop", () => {
    let seen: DaemonSpawnOptions | undefined
    const spawn = (_cmd: string[], spawnOpts: DaemonSpawnOptions) => {
      seen = spawnOpts
      return { pid: 7, kill: () => {}, endStdin: () => {} }
    }
    maybeSpawnDaemon({
      env: { GH_ROUTER_FM_DAEMON: "1" },
      agentsEnabled: true,
      repoRoot: "/repo",
      spawn,
    })
    // stdin MUST be a pipe (parent holds the write end); stdout/stderr ignored.
    expect(seen?.stdio[0]).toBe("pipe")
    expect(seen?.stdio[1]).toBe("ignore")
    expect(seen?.stdio[2]).toBe("ignore")
  })

  test("handle.endStdin defaults to a no-op when the spawner omits it", () => {
    const spawn = () => ({ pid: 9, kill: () => {} }) // no endStdin
    const handle = maybeSpawnDaemon({
      env: { GH_ROUTER_FM_DAEMON: "1" },
      agentsEnabled: true,
      repoRoot: "/repo",
      spawn,
    })
    expect(handle).toBeDefined()
    expect(() => handle?.endStdin()).not.toThrow() // safe no-op
  })
})

describe("wireDaemonTeardown", () => {
  // Minimal once-emitter capturing handlers so we can drive each teardown path.
  function makeProc() {
    const handlers = new Map<string, () => void>()
    return {
      proc: {
        once: (e: string, fn: () => void) => {
          handlers.set(e, fn)
        },
      } as Pick<NodeJS.Process, "once">,
      fire: (e: string) => handlers.get(e)?.(),
      has: (e: string) => handlers.has(e),
    }
  }

  test("SIGINT: EOF stdin FIRST, then kill after the grace window (backstop)", () => {
    const order: string[] = []
    const handle = {
      pid: 1,
      kill: () => order.push("kill"),
      endStdin: () => order.push("endStdin"),
    }
    const { proc, fire } = makeProc()
    let deferred: (() => void) | undefined
    let unrefd = false
    const setTimer = (fn: () => void) => {
      deferred = fn
      return { unref: () => (unrefd = true) }
    }
    wireDaemonTeardown(handle, { proc, setTimer })

    fire("SIGINT")
    expect(order).toEqual(["endStdin"]) // graceful EOF fired; kill deferred
    expect(unrefd).toBe(true) // non-blocking: the grace timer is unref'd
    deferred?.() // grace window elapses → hard backstop kill
    expect(order).toEqual(["endStdin", "kill"])
  })

  test("SIGTERM path behaves identically to SIGINT", () => {
    const order: string[] = []
    const handle = {
      pid: 1,
      kill: () => order.push("kill"),
      endStdin: () => order.push("endStdin"),
    }
    const { proc, fire } = makeProc()
    let deferred: (() => void) | undefined
    wireDaemonTeardown(handle, {
      proc,
      setTimer: (fn) => {
        deferred = fn
        return { unref: () => {} }
      },
    })
    fire("SIGTERM")
    expect(order).toEqual(["endStdin"])
    deferred?.()
    expect(order).toEqual(["endStdin", "kill"])
  })

  test("'exit': EOF then kill SYNCHRONOUSLY (timers can't run) — backstop preserved", () => {
    const order: string[] = []
    const handle = {
      pid: 1,
      kill: () => order.push("kill"),
      endStdin: () => order.push("endStdin"),
    }
    const { proc, fire } = makeProc()
    wireDaemonTeardown(handle, { proc, setTimer: (fn) => ({ unref: () => void fn }) })
    fire("exit")
    expect(order).toEqual(["endStdin", "kill"]) // orphan-prevention kill always runs
  })

  test("kill and endStdin each run at most once across multiple teardown events", () => {
    let kills = 0
    let ends = 0
    const handle = { pid: 1, kill: () => (kills += 1), endStdin: () => (ends += 1) }
    const { proc, fire } = makeProc()
    let deferred: (() => void) | undefined
    wireDaemonTeardown(handle, {
      proc,
      setTimer: (fn) => {
        deferred = fn
        return { unref: () => {} }
      },
    })
    fire("SIGINT")
    deferred?.() // kill via grace timer
    fire("exit") // exit also tries to EOF + kill
    expect(ends).toBe(1)
    expect(kills).toBe(1)
  })

  test("a throwing kill/endStdin never propagates out of teardown", () => {
    const handle = {
      pid: 1,
      kill: () => {
        throw new Error("kill boom")
      },
      endStdin: () => {
        throw new Error("end boom")
      },
    }
    const { proc, fire } = makeProc()
    wireDaemonTeardown(handle, { proc, setTimer: (fn) => ({ unref: () => void fn }) })
    expect(() => fire("exit")).not.toThrow()
  })

  test("registers once-handlers for SIGINT, SIGTERM, and exit", () => {
    const handle = { pid: 1, kill: () => {}, endStdin: () => {} }
    const { proc, has } = makeProc()
    wireDaemonTeardown(handle, { proc, setTimer: (fn) => ({ unref: () => void fn }) })
    expect(has("SIGINT")).toBe(true)
    expect(has("SIGTERM")).toBe(true)
    expect(has("exit")).toBe(true)
  })
})


