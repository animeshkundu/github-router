import http from "node:http"
import type { AddressInfo, Socket } from "node:net"

/**
 * Standalone HTTP + WebSocket reverse proxy that fronts a locally-running
 * CloudCLI instance under github-router's own origin. It is deliberately NOT
 * routed through the srvx/Hono app — a separate lightweight proxy avoids
 * entangling CloudCLI's raw WebSocket upgrades (`/ws` chat, `/shell` node-pty
 * terminal) with the model-API server.
 *
 * Security responsibilities CloudCLI's OSS server does not handle itself:
 *  1. Injects `localStorage['auth-token']` into the served `index.html` so the
 *     SPA boots already-authenticated (true zero-login).
 *  2. Rejects foreign `Host` (DNS-rebinding defense — an `Origin`-only check
 *     still lets a rebound `attacker.com → 127.0.0.1` navigation fetch the
 *     token-injected HTML) AND foreign `Origin` on requests + WS upgrades
 *     (CloudCLI performs NO Origin check on `/ws` or `/shell`).
 */
export interface ReverseProxyOptions {
  targetHost: string
  targetPort: number
  bindHost: string
  bindPort: number
  /** JWT injected into the SPA so it boots authenticated. */
  authToken: string
  /**
   * Extra exact `host:port` values to accept beyond loopback (e.g. a specific
   * dev-tunnel host `abc-5454.usw2.devtunnels.ms`). Used for remote access.
   */
  extraAllowedHosts?: string[]
  /** Extra exact origins to accept (e.g. `https://abc-5454.usw2.devtunnels.ms`). */
  extraAllowedOrigins?: string[]
  /**
   * Accept ANY `*.devtunnels.ms` host + `https://*.devtunnels.ms` origin. A
   * convenience for Microsoft dev tunnels when the exact URL isn't pinned. Only
   * the user's own authenticated tunnel actually forwards to this loopback port,
   * so this does not weaken the same-user loopback trust boundary.
   */
  allowDevtunnelHosts?: boolean
}

export interface ReverseProxyHandle {
  url: string
  port: number
  close: () => Promise<void>
}

const HEAD_CLOSE = "</head>"

/**
 * Embed the token as a JS string literal. JSON.stringify escapes quotes and
 * backslashes; we additionally neutralize `<` so the value can never break out
 * of the surrounding <script> element regardless of contents.
 */
function buildInjection(token: string): string {
  const safe = JSON.stringify(token).replace(/</g, "\\u003c")
  return `<script>try{localStorage.setItem('auth-token',${safe})}catch(e){}</script>`
}

function headerLines(headers: http.IncomingHttpHeaders): string {
  return Object.entries(headers)
    .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(", ") : v}`)
    .join("\r\n")
}

export async function startReverseProxy(
  opts: ReverseProxyOptions,
): Promise<ReverseProxyHandle> {
  const { targetHost, targetPort, bindHost, bindPort, authToken } = opts
  const ownOrigin = `http://${bindHost}:${bindPort}`
  const injection = buildInjection(authToken)

  const allowedHosts = new Set([
    `127.0.0.1:${bindPort}`,
    `localhost:${bindPort}`,
    `[::1]:${bindPort}`,
    ...(opts.extraAllowedHosts ?? []).map((h) => h.toLowerCase()),
  ])
  const allowedOrigins = new Set([
    `http://127.0.0.1:${bindPort}`,
    `http://localhost:${bindPort}`,
    `http://[::1]:${bindPort}`,
    ...(opts.extraAllowedOrigins ?? []).map((o) => o.toLowerCase()),
  ])
  // `(^|\.)devtunnels.ms$` matches `x.devtunnels.ms` but not `evildevtunnels.ms`
  // / `evil-devtunnels.ms` (the char before must be start-of-string or a dot).
  const DEVTUNNEL_RE = /(^|\.)devtunnels\.ms$/i
  const isDevtunnelHost = (host: string): boolean =>
    !!opts.allowDevtunnelHosts && DEVTUNNEL_RE.test(host.replace(/:\d+$/, ""))
  const isDevtunnelOrigin = (origin: string): boolean => {
    if (!opts.allowDevtunnelHosts) return false
    try {
      const u = new URL(origin)
      return u.protocol === "https:" && DEVTUNNEL_RE.test(u.hostname)
    } catch {
      return false
    }
  }
  // Host defends against DNS-rebinding; Origin defends against cross-origin
  // browser access. A missing Origin (plain navigation / non-browser) is only
  // allowed once the Host has already been confirmed allowed.
  const hostAllowed = (host?: string): boolean =>
    !!host
    && (allowedHosts.has(host.toLowerCase()) || isDevtunnelHost(host.toLowerCase()))
  const originAllowed = (origin?: string): boolean =>
    !origin
    || allowedOrigins.has(origin.toLowerCase())
    || isDevtunnelOrigin(origin)

  // Track hijacked upgrade sockets so close() can destroy them — http.Server
  // .close() otherwise waits for them forever (shutdown hang).
  const liveSockets = new Set<Socket>()

  const server = http.createServer((clientReq, clientRes) => {
    clientReq.on("error", () => clientRes.destroy())
    clientRes.on("error", () => clientReq.destroy())

    if (!hostAllowed(clientReq.headers.host) || !originAllowed(clientReq.headers.origin)) {
      clientRes.writeHead(403, { "content-type": "text/plain" })
      clientRes.end("Forbidden")
      return
    }

    // Drop accept-encoding so HTML comes back uncompressed and stays
    // injectable (localhost, so the compression loss is negligible).
    const headers = { ...clientReq.headers }
    delete headers["accept-encoding"]

    const proxyReq = http.request(
      {
        host: targetHost,
        port: targetPort,
        path: clientReq.url,
        method: clientReq.method,
        headers,
      },
      (proxyRes) => {
        proxyRes.on("error", () => clientRes.destroy())
        const contentType = String(proxyRes.headers["content-type"] ?? "")
        if (contentType.includes("text/html")) {
          const chunks: Buffer[] = []
          proxyRes.on("data", (d) => chunks.push(Buffer.from(d)))
          proxyRes.on("end", () => {
            let html = Buffer.concat(chunks).toString("utf8")
            html = html.includes(HEAD_CLOSE)
              ? html.replace(HEAD_CLOSE, injection + HEAD_CLOSE)
              : injection + html
            const outHeaders = { ...proxyRes.headers }
            // We send a fresh fixed buffer, so any length/encoding framing the
            // upstream set is now wrong — drop it and let Node re-frame.
            delete outHeaders["content-length"]
            delete outHeaders["content-encoding"]
            delete outHeaders["transfer-encoding"]
            clientRes.writeHead(proxyRes.statusCode ?? 502, outHeaders)
            clientRes.end(html)
          })
        } else {
          clientRes.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers)
          proxyRes.pipe(clientRes)
        }
      },
    )
    proxyReq.on("error", (err) => {
      if (!clientRes.headersSent)
        clientRes.writeHead(502, { "content-type": "text/plain" })
      clientRes.end(`Bad gateway: ${err.message}`)
    })
    clientReq.pipe(proxyReq)
  })

  server.on("upgrade", (clientReq, clientSock: Socket, clientHead) => {
    // Attach error handling + track the socket IMMEDIATELY, before any async
    // window (a client reset during the upstream handshake must not crash us).
    clientSock.on("error", () => clientSock.destroy())
    liveSockets.add(clientSock)
    clientSock.once("close", () => liveSockets.delete(clientSock))

    if (!hostAllowed(clientReq.headers.host) || !originAllowed(clientReq.headers.origin)) {
      clientSock.destroy()
      return
    }

    const proxyReq = http.request({
      host: targetHost,
      port: targetPort,
      path: clientReq.url,
      method: clientReq.method,
      headers: clientReq.headers,
    })
    proxyReq.on("upgrade", (proxyRes, proxySock, proxyHead) => {
      clientSock.write(
        `HTTP/1.1 ${proxyRes.statusCode} ${proxyRes.statusMessage}\r\n${headerLines(
          proxyRes.headers,
        )}\r\n\r\n`,
      )
      if (clientHead && clientHead.length) proxySock.write(clientHead)
      if (proxyHead && proxyHead.length) proxySock.unshift(proxyHead)
      proxySock.pipe(clientSock)
      clientSock.pipe(proxySock)
      const cleanup = () => {
        proxySock.destroy()
        clientSock.destroy()
      }
      // Tear down on BOTH error and normal close, on either side (else the
      // paired socket leaks on every page refresh / terminal close).
      clientSock.on("error", cleanup)
      proxySock.on("error", cleanup)
      clientSock.on("close", cleanup)
      proxySock.on("close", cleanup)
    })
    // CloudCLI answered the upgrade with an ordinary response (e.g. 401/404 for
    // a missing/invalid JWT). Relay it and close so the browser WS doesn't hang.
    proxyReq.on("response", (proxyRes) => {
      try {
        clientSock.write(
          `HTTP/1.1 ${proxyRes.statusCode} ${proxyRes.statusMessage}\r\n${headerLines(
            proxyRes.headers,
          )}\r\n\r\n`,
        )
      } catch {
        /* socket already gone */
      }
      proxyRes.on("data", (d) => {
        clientSock.write(d as Buffer)
      })
      proxyRes.on("end", () => clientSock.end())
      proxyRes.on("error", () => clientSock.destroy())
    })
    proxyReq.on("error", () => clientSock.destroy())
    proxyReq.end()
  })

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error) => reject(err)
    server.once("error", onError)
    server.listen(bindPort, bindHost, () => {
      server.removeListener("error", onError)
      resolve()
    })
  })

  // Defense-in-depth: refuse to run if we somehow bound a non-loopback address.
  const addr = server.address() as AddressInfo | null
  if (addr && addr.address !== "127.0.0.1" && addr.address !== "::1") {
    await new Promise<void>((r) => server.close(() => r()))
    throw new Error(
      `reverse proxy refused non-loopback bind (got ${addr.address})`,
    )
  }

  return {
    url: ownOrigin,
    port: bindPort,
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of liveSockets) s.destroy()
        liveSockets.clear()
        const t = setTimeout(resolve, 1500) // never let shutdown hang
        server.close(() => {
          clearTimeout(t)
          resolve()
        })
      }),
  }
}

/** Exported for unit tests. */
export const __test = { buildInjection, HEAD_CLOSE }
