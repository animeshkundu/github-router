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
 * So this measures the negotiated protocol TWICE: once on the real fetch path
 * (an undici Agent configured exactly as `upstreamAgentOptions()` does, with the
 * protocol read off the socket the request actually used), and once as a raw
 * ALPN probe that reports what the peer would select. The first is the
 * assertion; the second is context for interpreting it, since a peer declining
 * h2 and a client refusing to offer it look identical from the outside.
 *
 * It also records the two things that actually gate exposure: the BUILT-IN undici version
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
import { Agent, buildConnector, setGlobalDispatcher } from "undici"

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
const expected = allowH2 ? "h2" : "http/1.1"

/**
 * Route a real `fetch()` through a dispatcher built the same way the proxy
 * builds it, and read the protocol off the socket that request used. This is
 * the assertion that matters: a construction-level check ("the Agent was built
 * with allowH2:false") passes even when the live handshake negotiates h2 —
 * which happened during development, because ALPN is chosen by the CONNECTOR
 * and a custom `connect` built from `buildConnector({})` re-enables h2 no
 * matter what the Agent says.
 */
async function measureFetchPath() {
  let observed
  const base = buildConnector({ allowH2 })
  const dispatcher = new Agent({
    allowH2,
    connections: 256,
    connect: (options, callback) =>
      base(options, (err, socket) => {
        if (err || !socket) return callback(err ?? new Error("connect failed"), null)
        observed =
          typeof socket.alpnProtocol === "string" ? socket.alpnProtocol : "http/1.1"
        callback(null, socket)
      }),
  })
  setGlobalDispatcher(dispatcher)
  // Any endpoint on the origin works; only the transport is under test, so a
  // 401/404 is as informative as a 200.
  // `globalThis.fetch` rather than the bare global: identical binding, but it
  // needs no eslint environment directive to resolve in a plain .mjs script.
  const response = await globalThis.fetch(target, { method: "GET" })
  await response.body?.cancel()
  await dispatcher.close()
  return observed
}

/** What the peer selects when offered both — context, not the assertion. */
function probePeerAlpn() {
  return new Promise((resolve) => {
    const socket = connect(
      {
        host: hostname,
        port: port ? Number(port) : 443,
        servername: hostname,
        ALPNProtocols: ["h2", "http/1.1"],
      },
      () => {
        const negotiated = socket.alpnProtocol || "(none)"
        socket.end()
        resolve(negotiated)
      },
    )
    socket.setTimeout(10_000, () => {
      socket.destroy()
      resolve("(timeout)")
    })
    socket.on("error", () => resolve("(error)"))
  })
}

try {
  const peerPrefers = await probePeerAlpn()
  console.log(`peer prefers       ${peerPrefers}`)

  const negotiated = await measureFetchPath()
  console.log(`fetch negotiated   ${negotiated ?? "(not observed)"}`)

  if (negotiated === undefined) {
    console.error("\nSKIP: no socket observed (connection reused or unreachable).")
    process.exit(2)
  }
  if (negotiated === expected) {
    console.log(`\nOK: fetch negotiated ${negotiated}, matching policy.`)
    process.exit(0)
  }
  // Permitting h2 is not requiring it — a peer that declines is fine. Speaking
  // h2 while policy says not to is the failure that matters.
  if (allowH2 && negotiated === "http/1.1") {
    console.log("\nOK: h2 permitted, peer selected http/1.1.")
    process.exit(0)
  }
  console.error(
    `\nFAIL: fetch negotiated ${negotiated}, expected ${expected}. ` +
      `Upstream multiplexing does not match GH_ROUTER_UPSTREAM_ALLOW_H2.`,
  )
  process.exit(1)
} catch (err) {
  console.error(`\nSKIP: probe could not run: ${err.message}`)
  process.exit(2)
}
