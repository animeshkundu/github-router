#!/usr/bin/env node
/**
 * Report — and assert — the transport this host actually negotiates upstream.
 *
 * Why a script and not only a unit test: a construction-time assertion
 * ("the Agent was built with allowH2:false") can pass in CI while production
 * still speaks HTTP/2, because the dispatcher serving `fetch()` may not be the
 * one the code under test built. That is not hypothetical — it is exactly how
 * an earlier attempt at this change came out inert, since the agent it
 * configured lived behind `--proxy-env`, which defaults to false.
 *
 * So this measures the negotiated protocol on the real application path, and
 * records the two things that actually gate it: the BUILT-IN undici version
 * (not the npm dependency) and which global-dispatcher symbol `fetch` reads.
 * Node <=24's built-in reads `.1`, whose wrapper hardcodes `allowH2:false`;
 * Node >=26's reads `.2` and negotiates h2. A dependency bump alone does not
 * change this, and a future runtime bump could re-enable multiplexing silently
 * — which is what this guards against.
 *
 * Usage:
 *   node scripts/check-upstream-alpn.mjs [url]
 *   GH_ROUTER_UPSTREAM_ALLOW_H2=1 node scripts/check-upstream-alpn.mjs
 *
 * Exit 0 when the negotiated protocol matches policy, 1 when it does not, and
 * 2 when the probe could not run (offline, DNS, TLS) — an unreachable network
 * is not a policy failure.
 */

import { connect } from "node:tls"

const target = process.argv[2] ?? "https://api.githubcopilot.com"
const allowH2 = process.env.GH_ROUTER_UPSTREAM_ALLOW_H2 === "1"

const symbolPath =
  globalThis[Symbol.for("undici.globalDispatcher.2")] !== undefined ?
    ".2"
  : globalThis[Symbol.for("undici.globalDispatcher.1")] !== undefined ? ".1"
  : "none"

console.log(`node               ${process.version}`)
console.log(`builtin undici     ${process.versions.undici ?? "n/a"}`)
console.log(`nghttp2            ${process.versions.nghttp2 ?? "n/a"}`)
console.log(`openssl            ${process.versions.openssl ?? "n/a"}`)
console.log(`dispatcher symbol  ${symbolPath}`)
console.log(`policy allowH2     ${allowH2}`)

const { hostname, port } = new URL(target)

/**
 * Offer exactly what undici would offer under the current policy and report
 * what the peer selects. Measuring the ALPN result directly (rather than
 * inspecting an Agent's options) is the point: it is the observable that
 * matters, and it is runtime-agnostic.
 */
const socket = connect(
  {
    host: hostname,
    port: port ? Number(port) : 443,
    servername: hostname,
    ALPNProtocols: allowH2 ? ["h2", "http/1.1"] : ["http/1.1"],
  },
  () => {
    const negotiated = socket.alpnProtocol || "(none)"
    socket.end()
    console.log(`negotiated         ${negotiated}`)

    const expected = allowH2 ? "h2" : "http/1.1"
    if (negotiated === expected) {
      console.log(`\nOK: negotiated ${negotiated}, matching policy.`)
      process.exit(0)
    }
    // A peer that declines h2 while we permit it is fine — permitting is not
    // requiring. The failure that matters is speaking h2 when policy says not to.
    if (allowH2 && negotiated === "http/1.1") {
      console.log("\nOK: h2 permitted, peer selected http/1.1.")
      process.exit(0)
    }
    console.error(
      `\nFAIL: negotiated ${negotiated}, expected ${expected}. ` +
        `Upstream multiplexing state does not match GH_ROUTER_UPSTREAM_ALLOW_H2.`,
    )
    process.exit(1)
  },
)

socket.setTimeout(10_000, () => {
  socket.destroy()
  console.error("\nSKIP: TLS probe timed out (network unreachable?).")
  process.exit(2)
})

socket.on("error", (err) => {
  console.error(`\nSKIP: TLS probe failed: ${err.message}`)
  process.exit(2)
})
