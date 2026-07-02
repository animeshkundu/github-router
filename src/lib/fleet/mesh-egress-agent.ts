/**
 * Runtime-aware "route this fetch through the mesh loopback egress proxy" for a
 * mesh peer. Mirrors `~/lib/insecure-tls`'s `applyInsecureTls`: the BUILT proxy
 * runs under Node (bin shebang `#!/usr/bin/env node`), whose fetch (undici) routes
 * through a proxy via a `dispatcher` — undici's `ProxyAgent` — which is the only
 * mechanism that can carry a custom `Proxy-Authorization` header on the CONNECT.
 *
 * Bun is a DEV-ONLY runtime here (`bun run dev` / the test suite). Bun's fetch
 * `proxy` option cannot set a custom `Proxy-Authorization` header (only Basic auth
 * embedded as URL userinfo, which would (a) put the credential in a loggable URI
 * and (b) send Basic, not the contract's Bearer) and does not honor undici's
 * `dispatcher`. So under Bun we FAIL CLOSED with a clear dev-limitation error
 * rather than send an unauthenticated request the proxy would reject anyway. Prod
 * is Node, which carries the Bearer correctly.
 *
 * SECURITY: the egress token rides ONLY in the `Proxy-Authorization` HEADER value
 * carried by the ProxyAgent — never in the proxy URI (which could be logged) and
 * never in the request headers sent to the target origin. undici `ProxyAgent`'s
 * `token` option is Basic-auth ONLY, so we MUST use its `headers` option for the
 * Bearer. Per-request scope keeps Copilot upstream + other fleet instances untouched.
 */
import { ProxyAgent } from "undici"

import type { FleetMeshProxy } from "./registry"

const IS_BUN = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined"

/** Thrown when a mesh request is attempted under Bun (no Bearer-proxy support). */
export class MeshEgressUnsupportedRuntimeError extends Error {
  constructor() {
    super(
      "mesh egress routing is unsupported under Bun (dev runtime): Bun's fetch cannot send a "
        + "Proxy-Authorization Bearer header. Run the built Node binary (dist/main.js) to drive mesh peers.",
    )
    this.name = "MeshEgressUnsupportedRuntimeError"
  }
}

/**
 * Attach the egress-proxy mechanism to a fetch init for a single mesh peer request.
 * Node → a NEW undici `ProxyAgent` dispatcher whose CONNECT carries the Bearer
 * `Proxy-Authorization`. A new agent per request is intentional: the credential can
 * rotate when the sidecar restarts, so a cached agent could pin a stale token, and a
 * per-request agent avoids stashing the credential in longer-lived state. The caller
 * MUST `close()` the returned agent after the request (it holds a socket pool).
 *
 * `isBun` is injectable so BOTH branches are unit-testable under one interpreter.
 * Under Bun this THROWS {@link MeshEgressUnsupportedRuntimeError} (fail closed).
 */
export function applyMeshEgressProxy(
  init: Record<string, unknown>,
  meshProxy: FleetMeshProxy,
  isBun: boolean = IS_BUN,
): ProxyAgent {
  if (isBun) throw new MeshEgressUnsupportedRuntimeError()
  const agent = new ProxyAgent({
    uri: meshProxy.url,
    // Bearer via `headers`, NOT `token` (which is Basic-auth only in undici).
    headers: { "Proxy-Authorization": meshProxy.authHeader },
  })
  init.dispatcher = agent
  return agent
}

export { IS_BUN }
