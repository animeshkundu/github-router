/**
 * Gate B browser fixtures — local two-origin static server.
 *
 * Starts TWO HTTP servers on EPHEMERAL ports (never hardcoded):
 *   - base server          → serves the page suite (iframe-torture, spa-hydrate,
 *                            blocker, longpage, same-origin-frame)
 *   - cross-origin server  → serves ONLY cross-origin-frame.html, on a DIFFERENT
 *                            port so it is a genuinely different origin
 *                            (scheme+host+port) than the base server.
 *
 * The cross-origin server is started first so its base URL can be injected into
 * iframe-torture.html (the `__CROSS_ORIGIN_BASE__` placeholder) at serve time.
 *
 * On startup it prints the chosen ports and writes manifest.runtime.json next to
 * the static manifest.json, with baseUrl / crossOriginBaseUrl filled in plus the
 * full groundTruth. The harness reads that runtime manifest. Stays up until SIGINT.
 *
 * Run:  bun tests/fixtures/browser/serve.ts
 */

import path from "node:path"

const FIXTURE_DIR = import.meta.dir
const HOST = "127.0.0.1"
const PLACEHOLDER = "__CROSS_ORIGIN_BASE__"

const STATIC_MANIFEST_PATH = path.join(FIXTURE_DIR, "manifest.json")
const RUNTIME_MANIFEST_PATH = path.join(FIXTURE_DIR, "manifest.runtime.json")

type ManifestShape = {
  baseUrl: string
  crossOriginBaseUrl: string
  fixtures: Array<{ id: string; path: string; groundTruth: Record<string, unknown> }>
  [k: string]: unknown
}

/** Allowlisted filenames per server — no arbitrary path resolution (no traversal). */
const BASE_FILES = new Set([
  "iframe-torture.html",
  "same-origin-frame.html",
  "spa-hydrate.html",
  "blocker.html",
  "longpage.html",
])
const CROSS_FILES = new Set(["cross-origin-frame.html"])

function contentTypeFor(name: string): string {
  if (name.endsWith(".html")) return "text/html; charset=utf-8"
  if (name.endsWith(".json")) return "application/json; charset=utf-8"
  return "text/plain; charset=utf-8"
}

function notFound(): Response {
  return new Response("Not found\n", {
    status: 404,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  })
}

/**
 * Serve one allowlisted file, optionally transforming its body. Files are read
 * fresh per request (small, and avoids any stale-cache surprises during an eval).
 */
async function serveFile(
  name: string,
  transform?: (body: string) => string,
): Promise<Response> {
  const filePath = path.join(FIXTURE_DIR, name)
  let body = await Bun.file(filePath).text()
  if (transform) body = transform(body)
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": contentTypeFor(name),
      // no-store so re-reads always reflect live page state (spa hydration,
      // consent gate, etc.) rather than a cached first paint.
      "cache-control": "no-store",
    },
  })
}

function indexResponse(title: string, links: string[]): Response {
  const items = links.map((l) => `<li><a href="${l}">${l}</a></li>`).join("")
  const html = `<!doctype html><meta charset="utf-8"><title>${title}</title>` +
    `<h1>${title}</h1><ul>${items}</ul>`
  return new Response(html, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  })
}

async function main() {
  const staticManifest = (await Bun.file(STATIC_MANIFEST_PATH).json()) as ManifestShape

  // 1) Cross-origin server first, so we know its origin before wiring the base page.
  const crossServer = Bun.serve({
    hostname: HOST,
    port: 0, // ephemeral
    async fetch(req) {
      const name = new URL(req.url).pathname.replace(/^\//, "")
      if (name === "" ) {
        return indexResponse("gate-b cross-origin server", ["/cross-origin-frame.html"])
      }
      if (CROSS_FILES.has(name)) return serveFile(name)
      return notFound()
    },
  })
  const crossOriginBaseUrl = `http://${HOST}:${crossServer.port}`

  // 2) Base server. iframe-torture.html gets the cross-origin origin injected.
  const baseServer = Bun.serve({
    hostname: HOST,
    port: 0, // ephemeral
    async fetch(req) {
      const name = new URL(req.url).pathname.replace(/^\//, "")
      if (name === "") {
        return indexResponse(
          "gate-b base server",
          ["/iframe-torture.html", "/spa-hydrate.html", "/blocker.html", "/longpage.html",
           "/same-origin-frame.html", "/manifest.runtime.json"],
        )
      }
      if (name === "manifest.runtime.json") return serveFile("manifest.runtime.json")
      if (name === "iframe-torture.html") {
        return serveFile(name, (body) => body.split(PLACEHOLDER).join(crossOriginBaseUrl))
      }
      if (BASE_FILES.has(name)) return serveFile(name)
      return notFound()
    },
  })
  const baseUrl = `http://${HOST}:${baseServer.port}`

  // 3) Resolve the manifest. `resolved` is the EXACT Contract 1 shape
  //    ({ baseUrl, crossOriginBaseUrl, fixtures[].{id,path,groundTruth} }) with no
  //    extra top-level keys, so the harness can parse it directly. The on-disk
  //    runtime manifest carries the same data plus annotation for humans.
  const resolved = {
    baseUrl,
    crossOriginBaseUrl,
    fixtures: staticManifest.fixtures,
  }
  const runtimeManifest: ManifestShape = {
    ...staticManifest,
    baseUrl,
    crossOriginBaseUrl,
    _runtime: {
      generatedBy: "tests/fixtures/browser/serve.ts",
      basePort: baseServer.port,
      crossOriginPort: crossServer.port,
      note:
        "Ephemeral ports chosen at startup. Markers tagged renderOnly in manifest.json " +
        "are base64-decoded at runtime and are NOT present in served HTML source.",
    },
  }
  await Bun.write(RUNTIME_MANIFEST_PATH, JSON.stringify(runtimeManifest, null, 2) + "\n")

  // 4) Race-free handshake: a SINGLE machine-readable line, emitted only after both
  //    servers are listening AND the runtime manifest is on disk. The harness scans
  //    child stdout for the `GATE_B_READY ` prefix and JSON.parses the remainder.
  //    Written straight to the fd (not console.log) so it is one atomic line.
  process.stdout.write("GATE_B_READY " + JSON.stringify(resolved) + "\n")

  // 5) Human-readable banner (ignored by the harness scanner).
  console.log("[gate-b fixtures] base server:          " + baseUrl)
  console.log("[gate-b fixtures] cross-origin server:  " + crossOriginBaseUrl)
  console.log("[gate-b fixtures] runtime manifest:     " + RUNTIME_MANIFEST_PATH)
  console.log("[gate-b fixtures] pages:")
  console.log("    " + baseUrl + "/iframe-torture.html   (cross+same-origin iframes, closed shadow)")
  console.log("    " + baseUrl + "/spa-hydrate.html       (marker hydrates ~1.5s after load)")
  console.log("    " + baseUrl + "/blocker.html           (marker revealed on 'Accept all')")
  console.log("    " + baseUrl + "/longpage.html          (800 items; target Item-757)")
  console.log("[gate-b fixtures] ready. Ctrl-C to stop.")

  const shutdown = (sig: string) => {
    console.log(`\n[gate-b fixtures] ${sig} received, stopping servers.`)
    baseServer.stop(true)
    crossServer.stop(true)
    process.exit(0)
  }
  process.on("SIGINT", () => shutdown("SIGINT"))
  process.on("SIGTERM", () => shutdown("SIGTERM"))
}

main().catch((err) => {
  console.error("[gate-b fixtures] fatal:", err)
  process.exit(1)
})
