import consola from "consola"
import { getProxyForUrl } from "proxy-from-env"
import {
  Agent,
  buildConnector,
  ProxyAgent,
  setGlobalDispatcher,
  type Dispatcher,
} from "undici"

import { upstreamAllowH2, upstreamMaxConnections } from "~/lib/port"

/**
 * Last observed upstream socket, for transport diagnostics.
 *
 * The fault this instrumentation exists for is a TLS `bad_record_mac` alert
 * whose origin is unexplained: the peer could not authenticate a record we
 * sent. Nothing in the error itself says which connection died, how old it
 * was, or whether its TLS session was resumed — and those are the three facts
 * that separate the leading hypotheses. Capturing them at connect time is the
 * only place they are available.
 */
export interface UpstreamSocketInfo {
  /** Monotonic id, so paired failures can be attributed to one socket. */
  id: number
  origin: string
  /** ALPN result — the observable that decides blast radius. */
  protocol: string
  /** Epoch ms at connect, so age at failure is derivable. */
  openedAt: number
  /** A resumed session reuses key material; relevant to integrity faults. */
  sessionReused: boolean
}

let socketCounter = 0
let lastSocket: UpstreamSocketInfo | undefined

/** Most recent upstream connection, or undefined before the first connect. */
export function lastUpstreamSocket(): UpstreamSocketInfo | undefined {
  return lastSocket
}

/** Test seam — connection identity is process-global state. */
export function __resetUpstreamSocketForTests(): void {
  socketCounter = 0
  lastSocket = undefined
}

/**
 * Wrap undici's connector so every upstream socket records its identity.
 * Purely observational: it forwards the original callback unchanged, and any
 * failure to read a property must not break connection setup.
 *
 * `allowH2` MUST be threaded in here, not just onto the Agent. ALPN is chosen
 * by the connector (`undici/lib/core/connect.js` — `ALPNProtocols: allowH2 ?
 * ['h2','http/1.1'] : ['http/1.1']`), so supplying a custom `connect` built
 * from `buildConnector({})` silently restores h2 no matter what the Agent
 * says. Verified against the live upstream, which negotiated h2 with
 * `allowH2:false` on the Agent until this argument was added.
 */
function instrumentedConnector(allowH2: boolean): buildConnector.connector {
  const base = buildConnector({ allowH2 })
  return ((options, callback) => {
    return base(options, (err, socket) => {
      if (err || !socket) {
        callback(err ?? new Error("upstream connect failed"), null)
        return
      }
      try {
        const tls = socket as unknown as {
          alpnProtocol?: string | false
          isSessionReused?: () => boolean
        }
        lastSocket = {
          id: ++socketCounter,
          origin: String(options.hostname ?? ""),
          protocol:
            typeof tls.alpnProtocol === "string" ? tls.alpnProtocol : "http/1.1",
          openedAt: Date.now(),
          sessionReused: tls.isSessionReused?.() ?? false,
        }
      } catch {
        /* diagnostics must never break a connection */
      }
      callback(null, socket)
    })
  }) as buildConnector.connector
}

/**
 * Options every upstream dispatcher this module builds must carry, so the
 * direct agent and the per-proxy agents cannot drift apart on transport policy.
 */
export function upstreamAgentOptions(): {
  allowH2: boolean
  connections: number
} {
  return {
    allowH2: upstreamAllowH2(),
    connections: upstreamMaxConnections(),
  }
}

/**
 * Pin the transport policy for every upstream `fetch()` in the process.
 *
 * This runs UNCONDITIONALLY, unlike `initProxyFromEnv` below, which is gated on
 * `--proxy-env` (default false) and therefore never executes in a normal
 * launch. That gating is why an earlier attempt to set `allowH2` on the agent
 * inside `initProxyFromEnv` would have changed nothing in production: the
 * dispatcher actually serving `/v1/messages` is the one undici installs for
 * itself on import (`lib/global.js`), not anything this module built.
 *
 * No-op under Bun, which does not route `fetch()` through undici dispatchers
 * and negotiates HTTP/1.1 regardless.
 */
export function initUpstreamTransport(): void {
  if (typeof Bun !== "undefined") return

  try {
    const options = upstreamAgentOptions()
    setGlobalDispatcher(
      new Agent({
        ...options,
        connect: instrumentedConnector(options.allowH2),
      }),
    )
    consola.debug(
      `Upstream transport: allowH2=${options.allowH2} connections=${options.connections}`,
    )
  } catch (err) {
    // Never block startup on transport tuning — undici's own default
    // dispatcher stays in place and requests still work.
    consola.debug("Upstream transport setup skipped:", err)
  }
}

export function initProxyFromEnv(): void {
  if (typeof Bun !== "undefined") return

  try {
    const direct = new Agent(upstreamAgentOptions())
    const proxies = new Map<string, ProxyAgent>()

    // We only need a minimal dispatcher that implements `dispatch` at runtime.
    // Typing the object as `Dispatcher` forces TypeScript to require many
    // additional methods. Instead, keep a plain object and cast when passing
    // to `setGlobalDispatcher`.
    const dispatcher = {
      dispatch(
        options: Dispatcher.DispatchOptions,
        handler: Dispatcher.DispatchHandler,
      ) {
        try {
          const origin =
            typeof options.origin === "string" ?
              new URL(options.origin)
            : (options.origin as URL)
          const get = getProxyForUrl as unknown as (
            u: string,
          ) => string | undefined
          const raw = get(origin.toString())
          const proxyUrl = raw && raw.length > 0 ? raw : undefined
          if (!proxyUrl) {
            consola.debug(`HTTP proxy bypass: ${origin.hostname}`)
            return (direct as unknown as Dispatcher).dispatch(options, handler)
          }
          let agent = proxies.get(proxyUrl)
          if (!agent) {
            agent = new ProxyAgent({
              uri: proxyUrl,
              ...upstreamAgentOptions(),
            })
            proxies.set(proxyUrl, agent)
          }
          let label = proxyUrl
          try {
            const u = new URL(proxyUrl)
            label = `${u.protocol}//${u.host}`
          } catch {
            /* noop */
          }
          consola.debug(`HTTP proxy route: ${origin.hostname} via ${label}`)
          return (agent as unknown as Dispatcher).dispatch(options, handler)
        } catch {
          return (direct as unknown as Dispatcher).dispatch(options, handler)
        }
      },
      close() {
        return direct.close()
      },
      destroy() {
        return direct.destroy()
      },
    }

    setGlobalDispatcher(dispatcher as unknown as Dispatcher)
    consola.debug("HTTP proxy configured from environment (per-URL)")
  } catch (err) {
    consola.debug("Proxy setup skipped:", err)
  }
}
