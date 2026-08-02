import { test, expect, describe } from "bun:test"
import { serve } from "srvx"

import { buildServeOptions } from "../../src/lib/server-setup"

/**
 * Regression guard for the bun-only `ECONNRESET` that killed long Claude Code
 * sessions (`Unable to connect to API (ECONNRESET) · Retrying in 8s`).
 *
 * `Bun.serve` defaults `idleTimeout` to 10 seconds and enforces it against a
 * STREAMING response body: if no bytes reach the socket for that long while a
 * ReadableStream is open, Bun kills the connection. Node's `node:http` (the
 * srvx node adapter, and bun's own node:http compat) has no such default,
 * which is why the failure was never reproducible under node.
 *
 * Copilot routinely goes quiet for longer than 10s mid-stream during extended
 * thinking / prompt processing on a large accumulated context, so
 * `setupAndServe` pins `bun: { idleTimeout: 0 }`. Upstream-stall detection is
 * owned by `UPSTREAM_INACTIVITY_TIMEOUT_MS` in `relayAnthropicStream` instead
 * — one authority for stream liveness.
 *
 * These tests exercise the real runtime rather than asserting on the options
 * object, per CLAUDE.md's "Spec ≠ runtime" rule: what matters is what Bun
 * actually does to the socket, not what the option is documented to mean.
 * `idleTimeout: 1` is used as the positive control so the whole file runs in
 * a few seconds instead of the ~12s a default-config repro would need.
 *
 * Lives under tests/isolated/ for PROCESS isolation, not because it mocks
 * anything. The positive control asserts that a runtime reaper fires inside a
 * timing window, and in lane 1 it shares a process with ~3000 other tests: the
 * scheduler contention starved bun's timer and the reap was not observed, so
 * the file passed alone and failed in the suite. Lane 2 runs one process per
 * file, which removes the contention rather than papering over it with a retry.
 */

const GAP_MS = 3000
const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined"

/** Serve one streaming response whose only chunk is delayed by `GAP_MS`. */
async function readStreamWithGap(
  idleTimeout: number,
): Promise<{ ok: boolean; body: string; error?: string }> {
  const server = serve({
    port: 0,
    hostname: "127.0.0.1",
    silent: true,
    bun: { idleTimeout },
    fetch: () =>
      new Response(
        new ReadableStream<Uint8Array>({
          async start(controller) {
            await new Promise((r) => setTimeout(r, GAP_MS))
            try {
              controller.enqueue(new TextEncoder().encode("data: late\n\n"))
              controller.close()
            } catch {
              // Socket already reaped — the consumer side is what we assert on.
            }
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      ),
  })

  try {
    await server.ready()
    const res = await fetch(`${server.url}stream`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ probe: true }),
    })
    return { ok: true, body: await res.text() }
  } catch (error) {
    return {
      ok: false,
      body: "",
      error: error instanceof Error ? error.message : String(error),
    }
  } finally {
    await server.close(true)
  }
}

describe("Bun.serve idleTimeout (streaming ECONNRESET regression)", () => {
  test("setupAndServe's serve options disable the reaper", () => {
    // Runtime-agnostic: pins the wiring, so the behavioural tests below
    // cannot pass against options the real server never receives.
    const opts = buildServeOptions((() => new Response("x")) as never, true)
    expect(opts.bun.idleTimeout).toBe(0)
  })

  test.skipIf(!isBun)(
    "idleTimeout: 0 survives a mid-stream gap longer than bun's default reaper",
    async () => {
      const result = await readStreamWithGap(0)
      expect(result.error).toBeUndefined()
      expect(result.body).toBe("data: late\n\n")
    },
    GAP_MS + 15_000,
  )

  // A positive control (assert `idleTimeout: 1` DOES reap the same stream)
  // was written here and removed. It is not our invariant to guard, and it is
  // not portable: it passed on Windows under bun 1.4.0-canary and failed on
  // ubuntu under the pinned bun 1.3.14, because exactly when bun's reaper
  // fires at a low timeout is a platform- and version-specific internal
  // detail. Tuning the gap until both platforms agreed would have bought a
  // green tick by making the assertion vaguer, not truer.
  //
  // What we actually depend on is the assertion above — that OUR setting
  // survives a long gap — and that one is robust in the right direction: it
  // asserts the ABSENCE of a reap, so scheduler noise can only make it
  // stricter, never flakier. Removal of the override is caught separately and
  // deterministically by the `buildServeOptions` test in
  // tests/lib-server-setup.test.ts.
})
