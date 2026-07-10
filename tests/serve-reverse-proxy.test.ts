import { afterEach, describe, expect, it } from "bun:test"
import http from "node:http"
import type { AddressInfo } from "node:net"
import { WebSocket, WebSocketServer } from "ws"

import { startReverseProxy, __test, SERVE_IDENTITY_PATH, SERVE_IDENTITY_SERVICE } from "~/lib/serve/reverse-proxy"

// ---- helpers -------------------------------------------------------------

async function getFreePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = http.createServer()
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as AddressInfo).port
      s.close(() => resolve(port))
    })
  })
}

function httpRequest(
  port: number,
  method: string,
  path: string,
  headers: Record<string, string> = {},
  body?: string,
): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, path, method, headers },
      (res) => {
        let b = ""
        res.on("data", (d) => (b += d))
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: b, headers: res.headers }))
      },
    )
    req.on("error", reject)
    if (body !== undefined) req.write(body)
    req.end()
  })
}

function httpGet(
  port: number,
  path: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
  return httpRequest(port, "GET", path, headers)
}

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!()
})

/** Start a fake CloudCLI-like upstream with a canned HTTP handler + WS echo. */
async function startUpstream(
  handler: http.RequestListener,
): Promise<{ port: number }> {
  const server = http.createServer(handler)
  const wss = new WebSocketServer({ server })
  wss.on("connection", (ws) => {
    ws.on("message", (m) => ws.send(`echo:${m}`))
    ws.send("hello")
  })
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()))
  const port = (server.address() as AddressInfo).port
  cleanups.push(
    () =>
      new Promise<void>((r) => {
        for (const c of wss.clients) c.terminate()
        wss.close()
        ;(server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.()
        server.close(() => r())
        // Fallback: don't let a lingering socket hang teardown.
        setTimeout(r, 500)
      }),
  )
  return { port }
}

async function startProxyTo(
  targetPort: number,
  token = "jwt-abc.def.ghi",
  extra: Partial<Parameters<typeof startReverseProxy>[0]> = {},
) {
  const bindPort = await getFreePort()
  const handle = await startReverseProxy({
    targetHost: "127.0.0.1",
    targetPort,
    bindHost: "127.0.0.1",
    bindPort,
    authToken: token,
    ...extra,
  })
  cleanups.push(() => handle.close())
  return handle
}

// ---- tests ---------------------------------------------------------------

describe("reverse-proxy single-instance identity endpoint", () => {
  it("answers a loopback probe with the service marker and NO attacker-usable url", async () => {
    const up = await startUpstream((_req, res) => res.end("upstream should not be reached"))
    const handle = await startProxyTo(up.port)
    const port = handle.port
    const res = await httpGet(port, SERVE_IDENTITY_PATH, { host: `127.0.0.1:${port}` })
    expect(res.status).toBe(200)
    const body = JSON.parse(res.body) as Record<string, unknown>
    expect(body.service).toBe(SERVE_IDENTITY_SERVICE)
    // The probe must never surface a URL the launcher would open — a squatter
    // could forge the marker, so the caller constructs the loopback origin itself.
    expect(body.url).toBeUndefined()
  })

  it("does NOT serve the identity endpoint to a non-loopback (dev-tunnel) Host", async () => {
    const up = await startUpstream((_req, res) => res.end("upstream"))
    const handle = await startProxyTo(up.port, "jwt", { allowDevtunnelHosts: true })
    const port = handle.port
    // A dev-tunnel Host passes the proxy's Host allowlist, but the identity
    // endpoint is loopback-only — so it 404s rather than leaking the version.
    const res = await httpGet(port, SERVE_IDENTITY_PATH, { host: "abc-5454.usw2.devtunnels.ms" })
    expect(res.status).toBe(404)
  })
})

describe("reverse-proxy injection", () => {
  it("injects the auth-token before </head> in HTML documents", async () => {
    const up = await startUpstream((_req, res) => {
      res.writeHead(200, { "content-type": "text/html" })
      res.end("<html><head><title>x</title></head><body>hi</body></html>")
    })
    const proxy = await startProxyTo(up.port, "tok-123")
    const res = await httpGet(proxy.port, "/")
    expect(res.status).toBe(200)
    expect(res.body).toContain("localStorage.setItem('auth-token'")
    expect(res.body).toContain('"tok-123"')
    // injected before </head>, before the body
    expect(res.body.indexOf("auth-token")).toBeLessThan(res.body.indexOf("</head>"))
  })

  it("prepends injection when the document has no </head>", async () => {
    const up = await startUpstream((_req, res) => {
      res.writeHead(200, { "content-type": "text/html" })
      res.end("<body>no head</body>")
    })
    const proxy = await startProxyTo(up.port)
    const res = await httpGet(proxy.port, "/")
    expect(res.body.startsWith("<script>")).toBe(true)
    expect(res.body).toContain("no head")
  })

  it("does NOT inject into non-HTML responses", async () => {
    const up = await startUpstream((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ ok: true }))
    })
    const proxy = await startProxyTo(up.port)
    const res = await httpGet(proxy.port, "/api/x")
    expect(res.body).toBe('{"ok":true}')
    expect(res.body).not.toContain("auth-token")
  })

  it("buildInjection embeds the token as a safe JS string literal", () => {
    const s = __test.buildInjection('a"b')
    expect(s).toContain('localStorage.setItem(\'auth-token\',"a\\"b")')
  })

  it("seeds claude-settings (empty allow-lists + skipPermissions) only when enabled", () => {
    const off = __test.buildInjection("tok", false)
    expect(off).not.toContain("claude-settings")
    const on = __test.buildInjection("tok", true)
    expect(on).toContain("claude-settings")
    // the stored value is a JSON string forcing the full toolset + no prompts
    expect(on).toContain('\\"allowedTools\\":[]')
    expect(on).toContain('\\"skipPermissions\\":true')
  })
})

describe("reverse-proxy provider façade", () => {
  it("rewrites intercepted 200 JSON responses and reframes headers", async () => {
    const up = await startUpstream((_req, res) => {
      const body = JSON.stringify({ ok: true })
      res.writeHead(200, {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(body),
      })
      res.end(body)
    })
    const proxy = await startProxyTo(up.port, "t", {
      providerFacade: {
        kindFor: (method, pathname) => method === "GET" && pathname === "/api/providers/claude/auth/status" ? "auth" : null,
        rewrite: async (_kind, json, query) => ({ json, scope: query.get("scope"), rewritten: true }),
      },
    })

    const res = await httpGet(proxy.port, "/api/providers/claude/auth/status?scope=user")
    expect(res.status).toBe(200)
    expect(JSON.parse(res.body)).toEqual({ json: { ok: true }, scope: "user", rewritten: true })
    expect(res.headers["content-type"]).toBe("application/json")
    expect(res.headers["content-encoding"]).toBeUndefined()
  })

  it("passes original intercepted bytes through on non-200, non-JSON, or null rewrites", async () => {
    const up = await startUpstream((req, res) => {
      if (req.url === "/bad-status") {
        res.writeHead(500, { "content-type": "application/json" })
        res.end(JSON.stringify({ error: true }))
        return
      }
      if (req.url === "/not-json") {
        res.writeHead(200, { "content-type": "text/plain" })
        res.end("plain")
        return
      }
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ unchanged: true }))
    })
    const proxy = await startProxyTo(up.port, "t", {
      providerFacade: {
        kindFor: () => "auth",
        rewrite: async () => null,
      },
    })

    expect(await httpGet(proxy.port, "/bad-status")).toMatchObject({ status: 500, body: '{"error":true}' })
    expect(await httpGet(proxy.port, "/not-json")).toMatchObject({ status: 200, body: "plain" })
    expect(await httpGet(proxy.port, "/null-rewrite")).toMatchObject({ status: 200, body: '{"unchanged":true}' })
  })

  it("pipes POST bodies through for intercepted command routes", async () => {
    let seen = ""
    const up = await startUpstream((req, res) => {
      req.on("data", (d) => (seen += d))
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" })
        res.end(JSON.stringify({ ok: true }))
      })
    })
    const proxy = await startProxyTo(up.port, "t", {
      providerFacade: {
        kindFor: (method, pathname) => method === "POST" && pathname === "/api/commands/list" ? "commands" : null,
        rewrite: async () => ({ ok: true, rewritten: true }),
      },
    })

    const res = await httpRequest(
      proxy.port,
      "POST",
      "/api/commands/list",
      { "content-type": "application/json" },
      JSON.stringify({ q: 1 }),
    )
    expect(res.status).toBe(200)
    expect(JSON.parse(res.body)).toEqual({ ok: true, rewritten: true })
    expect(seen).toBe('{"q":1}')
  })
})

describe("reverse-proxy Origin enforcement", () => {
  it("allows same-origin and missing-origin, rejects foreign origin", async () => {
    const up = await startUpstream((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" })
      res.end("ok")
    })
    const proxy = await startProxyTo(up.port)

    const noOrigin = await httpGet(proxy.port, "/")
    expect(noOrigin.status).toBe(200)

    const sameOrigin = await httpGet(proxy.port, "/", { origin: proxy.url })
    expect(sameOrigin.status).toBe(200)

    const foreign = await httpGet(proxy.port, "/", {
      origin: "http://evil.example",
    })
    expect(foreign.status).toBe(403)
  })

  it("rejects a foreign Host header (DNS-rebinding defense)", async () => {
    const up = await startUpstream((_req, res) => {
      res.writeHead(200, { "content-type": "text/html" })
      res.end("<html><head></head><body>secret</body></html>")
    })
    const proxy = await startProxyTo(up.port, "stolen-jwt")
    // A rebound attacker.com → 127.0.0.1 navigation carries a foreign Host and
    // no Origin; it must NOT receive the token-injected HTML.
    const res = await httpGet(proxy.port, "/", { host: "evil.example:4444" })
    expect(res.status).toBe(403)
    expect(res.body).not.toContain("stolen-jwt")
  })
})

describe("reverse-proxy remote-access allowlist (dev tunnels)", () => {
  const okHtml: http.RequestListener = (_req, res) => {
    res.writeHead(200, { "content-type": "text/html" })
    res.end("<html><head></head><body>hi</body></html>")
  }

  it("allows an explicitly allowlisted host+origin (--public-url)", async () => {
    const up = await startUpstream(okHtml)
    const proxy = await startProxyTo(up.port, "t", {
      extraAllowedHosts: ["abc-5454.usw2.devtunnels.ms"],
      extraAllowedOrigins: ["https://abc-5454.usw2.devtunnels.ms"],
    })
    const ok = await httpGet(proxy.port, "/", {
      host: "abc-5454.usw2.devtunnels.ms",
      origin: "https://abc-5454.usw2.devtunnels.ms",
    })
    expect(ok.status).toBe(200)
    // a DIFFERENT foreign host is still rejected
    const bad = await httpGet(proxy.port, "/", { host: "evil.example:1" })
    expect(bad.status).toBe(403)
  })

  it("allows any *.devtunnels.ms host+origin when devtunnel mode is on", async () => {
    const up = await startUpstream(okHtml)
    const proxy = await startProxyTo(up.port, "t", { allowDevtunnelHosts: true })
    const ok = await httpGet(proxy.port, "/", {
      host: "xyz-9.euw.devtunnels.ms",
      origin: "https://xyz-9.euw.devtunnels.ms",
    })
    expect(ok.status).toBe(200)
  })

  it("rejects devtunnel lookalikes and http (not https) origins", async () => {
    const up = await startUpstream(okHtml)
    const proxy = await startProxyTo(up.port, "t", { allowDevtunnelHosts: true })
    // lookalike host (no dot before devtunnels.ms)
    const look = await httpGet(proxy.port, "/", { host: "evil-devtunnels.ms" })
    expect(look.status).toBe(403)
    // suffix-append attack
    const suffix = await httpGet(proxy.port, "/", {
      host: "abc.devtunnels.ms.attacker.com",
    })
    expect(suffix.status).toBe(403)
    // http (non-tls) origin claiming a devtunnel host
    const insecure = await httpGet(proxy.port, "/", {
      host: "abc.devtunnels.ms",
      origin: "http://abc.devtunnels.ms",
    })
    expect(insecure.status).toBe(403)
  })

  it("does NOT allow devtunnel hosts when the mode is off (default)", async () => {
    const up = await startUpstream(okHtml)
    const proxy = await startProxyTo(up.port, "t")
    const res = await httpGet(proxy.port, "/", { host: "abc.devtunnels.ms" })
    expect(res.status).toBe(403)
  })
})

describe("reverse-proxy WebSocket upgrade", () => {
  // The positive round-trip needs real upgrade-socket relaying. Bun's node:http
  // compat cannot write a raw WS handshake back through the `upgrade` socket
  // (verified), so this can only run under Node — which is the shipped runtime
  // (`#!/usr/bin/env node`). Automated Node coverage: `scripts/serve-ws-smoke.mjs`
  // in the node-compat CI job; also exercised by the real chat E2E.
  it.skipIf(Boolean(process.versions.bun))(
    "proxies a WS connection end-to-end (same origin)",
    async () => {
    const up = await startUpstream((_req, res) => {
      res.writeHead(404)
      res.end()
    })
    const proxy = await startProxyTo(up.port)
    const msgs: string[] = []
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${proxy.port}/ws`, {
        headers: { origin: proxy.url },
      })
      const timer = setTimeout(() => reject(new Error("ws timeout")), 8000)
      ws.on("message", (m) => {
        msgs.push(String(m))
        if (msgs.length === 1) ws.send("ping")
        if (msgs.length === 2) {
          clearTimeout(timer)
          ws.close()
          resolve()
        }
      })
      ws.on("error", (e) => {
        clearTimeout(timer)
        reject(e)
      })
    })
    expect(msgs[0]).toBe("hello")
    expect(msgs[1]).toBe("echo:ping")
  })

  it("rejects a cross-origin WS upgrade", async () => {
    const up = await startUpstream((_req, res) => {
      res.writeHead(404)
      res.end()
    })
    const proxy = await startProxyTo(up.port)
    const result = await new Promise<string>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${proxy.port}/shell`, {
        headers: { origin: "http://evil.example" },
      })
      const timer = setTimeout(
        () => reject(new Error("cross-origin WS neither opened nor closed")),
        5000,
      )
      ws.on("open", () => {
        clearTimeout(timer)
        ws.close()
        resolve("OPENED-bad")
      })
      ws.on("close", () => {
        clearTimeout(timer)
        resolve("rejected-ok")
      })
      ws.on("error", () => {
        clearTimeout(timer)
        resolve("rejected-ok")
      })
    })
    expect(result).toBe("rejected-ok")
  })
})
