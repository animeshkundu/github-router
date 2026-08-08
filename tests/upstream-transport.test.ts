/**
 * Tests for the upstream transport policy in `src/lib/upstream-transport.ts`
 * and `src/lib/proxy.ts`.
 *
 * Why this file exists: an earlier attempt to disable HTTP/2 set `allowH2` on
 * the agent built inside `initProxyFromEnv`, which is gated on `--proxy-env`
 * (default false) and therefore never runs. The change would have been inert in
 * production while looking correct in review. These tests pin the two things
 * that failure mode needed — that the policy is applied on a path that always
 * executes, and that the direct and proxied agents cannot drift apart.
 *
 * The NEGOTIATED-protocol assertion deliberately does not live here: proving
 * what ALPN actually resolves to requires a real TLS peer, and an in-process
 * substitute would re-create the very gap this file exists to close. It lives
 * in `scripts/check-upstream-alpn.mjs` (`bun run check:alpn`), which measures
 * the live handshake. That distinction is not academic — while writing this
 * change, `allowH2:false` on the Agent was silently defeated by supplying a
 * custom `connect` connector, and only the live check caught it.
 */

import { describe, expect, test } from "bun:test"
import { getGlobalDispatcher } from "undici"

import { initUpstreamTransport, upstreamAgentOptions } from "../src/lib/proxy"

/**
 * The policy reads env at agent-construction time, so a plain set/restore is
 * enough — no cache-busting import, which is precisely why it is resolved that
 * way rather than as a module-level const.
 */
function optionsWithEnv(env: Record<string, string | undefined>): {
  allowH2: boolean
  connections: number
} {
  const saved: Record<string, string | undefined> = {}
  for (const [key, value] of Object.entries(env)) {
    saved[key] = process.env[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  try {
    return upstreamAgentOptions()
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

describe("upstream transport policy", () => {
  // The default. undici enables h2 for itself; the project never chose that,
  // and under h2 one connection-fatal fault takes out every concurrent request
  // instead of the one that was on the socket.
  test("HTTP/2 is disabled by default", () => {
    expect(upstreamAgentOptions().allowH2).toBe(false)
  })

  test("connections are bounded, not unlimited", () => {
    const { connections } = upstreamAgentOptions()
    expect(Number.isInteger(connections)).toBe(true)
    expect(connections).toBeGreaterThan(0)
  })

  // The escape hatch is what makes this a lever rather than a verdict: the
  // root fault is unexplained and h2 is only correlated with it, so restoring
  // multiplexing must not require a code change.
  test("GH_ROUTER_UPSTREAM_ALLOW_H2=1 restores multiplexing", () => {
    expect(optionsWithEnv({ GH_ROUTER_UPSTREAM_ALLOW_H2: "1" }).allowH2).toBe(
      true,
    )
    expect(
      optionsWithEnv({ GH_ROUTER_UPSTREAM_ALLOW_H2: undefined }).allowH2,
    ).toBe(false)
  })

  // Anything other than the exact opt-in leaves the safe default in place.
  test.each(["0", "false", "true", "yes", ""])(
    "GH_ROUTER_UPSTREAM_ALLOW_H2=%p does not enable h2",
    (value) => {
      expect(
        optionsWithEnv({ GH_ROUTER_UPSTREAM_ALLOW_H2: value }).allowH2,
      ).toBe(false)
    },
  )

  test("connection bound is env-overridable", () => {
    expect(
      optionsWithEnv({ GH_ROUTER_UPSTREAM_MAX_CONNECTIONS: "12" }).connections,
    ).toBe(12)
  })

  // The regression guard for the inert-fix failure mode: the policy must be
  // installed by a function callers invoke unconditionally, and it must
  // actually replace the process-wide dispatcher.
  //
  // COVERAGE GAP, stated rather than hidden: the suite runs under Bun, where
  // this function is a documented no-op, so CI does not execute the Node branch
  // that actually installs the dispatcher. `bun run check:alpn` is what covers
  // it — that script runs under Node and asserts the protocol a real `fetch()`
  // negotiates. Closing this properly needs a Node test lane.
  test("initUpstreamTransport installs a global dispatcher", () => {
    const before = getGlobalDispatcher()
    initUpstreamTransport()
    const after = getGlobalDispatcher()
    if (typeof Bun !== "undefined") {
      // Under Bun `fetch` does not route through undici dispatchers, so this
      // is a documented no-op rather than a silent failure.
      expect(after).toBe(before)
      return
    }
    expect(after).not.toBe(before)
  })
})
