import { describe, expect, test } from "bun:test"

import {
  FAST_DISPATCH_GUARD_MATCHER,
  FastDispatchGuardInstallError,
  assertFastDispatchGuardInstalled,
  buildFastDispatchGuardHookCommand,
  installFastDispatchGuard,
} from "~/lib/orchestration/fast-dispatch-hook"

describe("fast dispatch hook wiring", () => {
  test("builds the stable internal hook command and anchored matcher", () => {
    expect(buildFastDispatchGuardHookCommand({ execPath: "/usr/bin/node", scriptPath: "/app/main.js" })).toBe(
      '"/usr/bin/node" "/app/main.js" internal-fast-dispatch-guard',
    )
    expect(new RegExp(FAST_DISPATCH_GUARD_MATCHER).test("Task")).toBe(true)
    expect(new RegExp(FAST_DISPATCH_GUARD_MATCHER).test("Agent")).toBe(true)
  })

  test("fast installation failure is fatal, standard installation failure is not", () => {
    expect(() => assertFastDispatchGuardInstalled(false, false)).not.toThrow()
    expect(() => assertFastDispatchGuardInstalled(true, true)).not.toThrow()
    expect(() => assertFastDispatchGuardInstalled(true, false)).toThrow(FastDispatchGuardInstallError)
  })

  test("uses PreToolUse and preserves the exact matcher", async () => {
    const calls: Array<unknown[]> = []
    await installFastDispatchGuard("/tmp/settings.json", "guard", async (...args) => {
      calls.push(args)
    })
    expect(calls).toEqual([["/tmp/settings.json", "guard", "PreToolUse", 10, FAST_DISPATCH_GUARD_MATCHER]])
  })
})
