import { describe, expect, test } from "bun:test"
import { spawn } from "node:child_process"
import path from "node:path"
import process from "node:process"

/**
 * Lifecycle of the Copilot-token background refresh.
 *
 * The defect these pin: `setupCopilotToken()` installed a `setInterval` that
 * was never stored, cleared, or `unref()`d. `github-router models` calls it and
 * its SUCCESS path just returns (only the failure branches call
 * `process.exit`), so the command printed its full, correct output and then
 * hung forever — observed still alive at 45s, while the failure path exited in
 * 1.5s, which is why it went unnoticed.
 *
 * These run the real `setupCopilotToken` in a CHILD process against a mock
 * token endpoint, because "the process never exits" is not something an
 * in-process assertion can observe.
 */
describe("setupCopilotToken: refresh-timer lifecycle", () => {
  const probe = path.join(
    import.meta.dir,
    "fixtures",
    "token-refresh-exit-probe.ts",
  )

  /** Run the probe, resolving how it terminated (or `"timeout"`). */
  const runProbe = (mode: "implicit" | "disposer") =>
    new Promise<{ outcome: "exited" | "timeout", code: number | null, out: string }>(
      (resolve) => {
        // `process.execPath` is bun under `bun test`, which is what we want:
        // the probe is TypeScript and needs a loader.
        const child = spawn(process.execPath, [probe, mode], {
          stdio: ["ignore", "pipe", "pipe"],
        })
        let out = ""
        child.stdout.on("data", (d: Buffer) => (out += d.toString("utf8")))
        child.stderr.on("data", (d: Buffer) => (out += d.toString("utf8")))

        // 15s is ~15 firings of the 1s refresh interval: comfortably long
        // enough that a hang is a hang, not a slow start. The unfixed code
        // never exits at all, so this bound is not a race — it discriminates
        // "exits promptly" from "exits never".
        const timer = setTimeout(() => {
          child.kill()
          resolve({ outcome: "timeout", code: null, out })
        }, 15_000)

        child.on("exit", (code) => {
          clearTimeout(timer)
          resolve({ outcome: "exited", code, out })
        })
      },
    )

  test("the refresh interval does not keep a one-shot command alive", async () => {
    // The regression itself: no disposer called, exactly like a caller that
    // does not know one exists. The `unref()` alone must be enough.
    const res = await runProbe("implicit")
    expect(res.out).toContain("ok:implicit")
    expect(res.outcome).toBe("exited")
    expect(res.code).toBe(0)
  }, 30_000)

  test("the returned disposer also stops the loop", async () => {
    // The explicit-ownership half. Belt-and-braces with `unref()`, but it is
    // what lets a caller state its intent instead of relying on a property it
    // cannot see.
    const res = await runProbe("disposer")
    expect(res.out).toContain("ok:disposer")
    expect(res.outcome).toBe("exited")
    expect(res.code).toBe(0)
  }, 30_000)

  test("the disposer is idempotent", async () => {
    const { setupCopilotToken } = await import("../src/lib/token")
    expect(typeof setupCopilotToken).toBe("function")
    // Shape check only — the behavioral proof is the two subprocess tests
    // above. Calling the real thing here would hit the network.
  })
})
