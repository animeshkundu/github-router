// Real prod-runtime (Node + real undici) proof that the mesh egress ProxyAgent sends
// `Proxy-Authorization: Bearer <token>` on its CONNECT. Spawned as a `node` child by
// the Bun test (mesh-egress-integration.test.ts) because Bun's fetch ignores undici's
// `dispatcher`, so the ProxyAgent path can only run under Node — the production
// runtime (dist/main.js shebang is node).
//
// It mirrors applyMeshEgressProxy's Node branch: a ProxyAgent with the Bearer in the
// `headers` option, driven by undici's fetch. undici tunnels an https target via
// CONNECT, so we target an https URL; the proxy records the CONNECT's
// Proxy-Authorization and then tears the tunnel down (we do NOT need a working TLS
// origin — the assertion is purely that the Bearer rode the CONNECT). The fetch is
// EXPECTED to fail; success is `seenProxyAuth` containing the Bearer.
//
// Prints one JSON line: { seenProxyAuth: string[] }.
const http = require("node:http")
const { ProxyAgent, fetch: undiciFetch } = require("undici")

const AUTH_HEADER = process.argv[2]

const seenProxyAuth = []

function startProxy() {
  const proxy = http.createServer()
  proxy.on("connect", (req, clientSocket) => {
    const auth = req.headers["proxy-authorization"]
    seenProxyAuth.push(Array.isArray(auth) ? auth[0] : auth)
    // Record only; tear the tunnel down so we don't need a live TLS origin.
    clientSocket.write("HTTP/1.1 502 Bad Gateway\r\n\r\n")
    clientSocket.destroy()
  })
  return new Promise((resolve) => {
    proxy.listen(0, "127.0.0.1", () => resolve({ proxy, port: proxy.address().port }))
  })
}

async function main() {
  const { proxy, port } = await startProxy()
  try {
    const agent = new ProxyAgent({
      uri: `http://127.0.0.1:${port}`,
      headers: { "Proxy-Authorization": AUTH_HEADER },
    })
    try {
      // https target → undici tunnels via CONNECT through the proxy. Expected to fail
      // (the proxy tears the tunnel down); we only care that the CONNECT carried auth.
      await undiciFetch("https://mesh-peer.invalid/api/control/sessions", { dispatcher: agent })
    } catch {
      // expected
    } finally {
      await agent.close().catch(() => {})
    }
  } finally {
    proxy.close()
  }
  process.stdout.write(JSON.stringify({ seenProxyAuth }))
}

main().catch(() => {
  process.stdout.write(JSON.stringify({ seenProxyAuth }))
  process.exit(0)
})
