import { describe, expect, test } from "bun:test"

import { createFastLaunchCleanup } from "~/lib/fast-launch-cleanup"

describe("fast launch cleanup", () => {
  test("closes server, stops keep-awake, cleans runtime, then removes mirror once", async () => {
    const events: string[] = []
    const cleanup = createFastLaunchCleanup({
      server: { close: async () => { events.push("server.close") } },
      stopKeepAwake: async () => { events.push("keep-awake.stop") },
      runtimeCleanup: async () => { events.push("runtime.cleanup") },
      removeMirror: async () => { events.push("mirror.remove") },
    })

    await Promise.all([cleanup(), cleanup()])

    expect(events).toEqual([
      "server.close",
      "keep-awake.stop",
      "runtime.cleanup",
      "mirror.remove",
    ])
  })

  test("continues cleanup when earlier best-effort steps fail", async () => {
    const events: string[] = []
    const cleanup = createFastLaunchCleanup({
      server: { close: async () => { throw new Error("closed") } },
      stopKeepAwake: async () => { throw new Error("unavailable") },
      runtimeCleanup: async () => { events.push("runtime.cleanup") },
      removeMirror: async () => { events.push("mirror.remove") },
    })

    await expect(cleanup()).resolves.toBeUndefined()
    expect(events).toEqual(["runtime.cleanup", "mirror.remove"])
  })
})
