import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import {
  type FleetInstanceInfo,
  type FleetMeshProxy,
  type FleetResolvedInstance,
  FleetRegistry,
  selectInstance,
} from "./registry"

/**
 * Mesh fleet discovery: read the local ai-or-die instance's `mesh/peers.json`
 * (written by its MeshManager from the sidecar's tailnet `Status()`) off disk and
 * synthesize token-less, mesh-auth fleet instances. No `AIORDIE_*` env, no HTTP,
 * no token — filesystem permissions are the gate. Discovered peers are driven
 * over the tailnet with NO Authorization header; each peer's own sidecar injects
 * the bearer (ACL-gated by `tag:aiordie`). See docs / the fleet plan.
 */

const DISCOVERY_CACHE_TTL_MS = 5_000
const PEERS_JSON_MAX_BYTES = 256 * 1024
// A mesh peer is only reachable while the sidecar that last wrote egress.json is
// still alive AND the file is recent. Stale past this window → treat as no egress.
const EGRESS_TTL_MS = 120_000
// A file whose updatedAt is in the future beyond this small allowance is garbage
// (or a bad clock); reject it. Same-box state should never be meaningfully ahead.
const EGRESS_FUTURE_SKEW_MS = 5_000
const EGRESS_JSON_MAX_BYTES = 64 * 1024

interface MeshPeersFile {
  self?: { hostname?: unknown; dnsName?: unknown }
  peers?: unknown
}

/** The ai-or-die app data dir (NOT github-router's) — mirrors MeshManager's `base`. */
function aiordieAppDir(): string {
  if (process.platform === "win32") {
    const localApp = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local")
    return path.join(localApp, "ai-or-die")
  }
  return path.join(os.homedir(), ".ai-or-die")
}

export function meshPeersFilePath(): string {
  const override = process.env.GH_ROUTER_FLEET_PEERS_FILE
  if (override && override.trim() !== "") return override.trim()
  return path.join(aiordieAppDir(), "mesh", "peers.json")
}

export function meshEgressFilePath(): string {
  const override = process.env.GH_ROUTER_FLEET_EGRESS_FILE
  if (override && override.trim() !== "") return override.trim()
  return path.join(aiordieAppDir(), "mesh", "egress.json")
}

export function meshDiscoveryDisabled(): boolean {
  return process.env.GH_ROUTER_FLEET_DISCOVERY === "0"
}

// A MagicDNS hostname under the tailnet's `.ts.net` zone. Lowercase, dot-separated
// DNS labels, no scheme/port/userinfo/whitespace, no empty or `..` labels. This is
// the trust boundary for a peer-reported name: only a strictly-shaped `.ts.net`
// host becomes a connection URL.
const TS_NET_DNS_RE = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+ts\.net$/

function validDnsName(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined
  const name = raw.trim().replace(/\.$/, "").toLowerCase()
  if (name.length === 0 || name.length > 253) return undefined
  if (!TS_NET_DNS_RE.test(name)) return undefined
  return name
}

function nonEmptyString(raw: unknown): string | undefined {
  return typeof raw === "string" && raw.trim() !== "" ? raw.trim() : undefined
}

/**
 * Read + validate the discovery file into resolved mesh instances. Pure I/O +
 * validation; never throws — a missing/unreadable/oversized/malformed file
 * yields `[]` (discovery is best-effort and must never break static fleet use).
 */
export async function readMeshPeers(
  readFileFn: (p: string) => Promise<string> = (p) => fs.readFile(p, "utf8"),
): Promise<Array<FleetResolvedInstance>> {
  if (meshDiscoveryDisabled()) return []

  let raw: string
  try {
    raw = await readFileFn(meshPeersFilePath())
  } catch {
    return []
  }
  if (Buffer.byteLength(raw, "utf8") > PEERS_JSON_MAX_BYTES) return []

  let parsed: MeshPeersFile
  try {
    parsed = JSON.parse(raw) as MeshPeersFile
  } catch {
    return []
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return []
  if (!Array.isArray(parsed.peers)) return []

  const selfDnsName = validDnsName(parsed.self?.dnsName)
  // FAIL CLOSED: without a valid self dnsName we cannot scope discovery to THIS
  // tailnet, so trust nothing rather than accept an arbitrary `.ts.net` host.
  if (selfDnsName === undefined) return []
  // Same-tailnet suffix (e.g. `tail123.ts.net`). A peer must live under it — a
  // hostile/foreign `.ts.net` name in the file can never become a connection URL.
  const tailnetSuffix = selfDnsName.slice(selfDnsName.indexOf(".") + 1)

  const seen = new Set<string>()
  const out: Array<FleetResolvedInstance> = []

  for (const peer of parsed.peers) {
    if (typeof peer !== "object" || peer === null) continue
    const record = peer as Record<string, unknown>
    const dnsName = validDnsName(record.dnsName)
    if (dnsName === undefined) continue
    if (dnsName === selfDnsName) continue // exclude self
    if (!dnsName.endsWith(`.${tailnetSuffix}`)) continue // same tailnet only
    if (seen.has(dnsName)) continue
    seen.add(dnsName)

    // The id is the validated dnsName: stable, unique, and confined to the
    // `.ts.net` namespace — so a peer-reported `hostname` can NEVER collide with a
    // human-chosen static id/label and hijack routing (selectInstance matches id
    // before label). hostname is display-only.
    const hostname = nonEmptyString(record.hostname)
    out.push({
      id: dnsName,
      label: hostname ?? dnsName,
      url: `https://${dnsName}`,
      token: "",
      auth: { type: "mesh" },
    })
  }
  return out
}

function toInfo(instance: FleetResolvedInstance): FleetInstanceInfo {
  return { id: instance.id, label: instance.label, url: instance.url }
}

interface MeshEgressFile {
  version?: unknown
  pid?: unknown
  updatedAt?: unknown
  url?: unknown
  token?: unknown
}

export interface ReadMeshEgressOptions {
  readFileFn?: (p: string) => Promise<string>
  /** Injectable clock (default Date.now) so the TTL check is deterministic in tests. */
  now?: () => number
  /**
   * Injectable liveness probe (default `process.kill(pid, 0)`). Returns true when
   * the pid is a live process. `process.kill(pid, 0)` throws ESRCH for a dead pid
   * and EPERM when the pid is alive but owned by another user — EPERM still means
   * ALIVE, so the default returns true on EPERM.
   */
  pidAlive?: (pid: number) => boolean
}

function defaultPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    // ESRCH → no such process (dead). EPERM → process exists but not ours (alive).
    return typeof err === "object" && err !== null && (err as { code?: unknown }).code === "EPERM"
  }
}

// The egress proxy MUST be loopback http with an explicit port and nothing else --
// the frozen contract is exactly `http://127.0.0.1:<port>` or `http://[::1]:<port>`.
// The sidecar binds it on loopback so the credential-bearing Proxy-Authorization
// never crosses a network hop. Reject any non-http scheme, non-loopback host,
// userinfo, path/query/hash, or a missing/default port: a proxy on a routable host
// would leak the header, and extra URL shape is not the contract.
function validLoopbackHttpUrl(raw: unknown): string | undefined {
  if (typeof raw !== "string" || raw.trim() === "") return undefined
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    return undefined
  }
  if (url.protocol !== "http:") return undefined
  // Reject embedded userinfo (a `http://user:pass@127.0.0.1` credential sink).
  if (url.username !== "" || url.password !== "") return undefined
  // Reject anything beyond scheme://host:port -- no path, query, or fragment.
  if ((url.pathname !== "" && url.pathname !== "/") || url.search !== "" || url.hash !== "") return undefined
  // Require an explicit port (the proxy is a specific ephemeral port; a default
  // :80 is not the contract shape).
  if (url.port === "") return undefined
  const host = url.hostname.replace(/^\[/, "").replace(/\]$/, "").toLowerCase()
  if (host !== "127.0.0.1" && host !== "::1") return undefined
  // Canonical, path-free form (URL.toString() would append a trailing "/").
  const hostPart = host === "::1" ? "[::1]" : host
  return `http://${hostPart}:${url.port}`
}

// The token rides in a `Proxy-Authorization` HTTP header, so any whitespace or
// control character would be a header-injection vector; require a single-line,
// non-empty, printable token. The class covers ASCII whitespace, C0 controls
// (U+0000-U+001F), DEL (U+007F), and C1 controls (U+0080-U+009F).
function validEgressToken(raw: unknown): string | undefined {
  if (typeof raw !== "string" || raw === "") return undefined
  // eslint-disable-next-line no-control-regex -- explicitly rejecting control chars
  if (/[\s\u0000-\u001f\u007f\u0080-\u009f]/.test(raw)) return undefined
  return raw
}

/**
 * Read + validate the sidecar's `mesh/egress.json` into a {@link FleetMeshProxy}.
 * Best-effort like {@link readMeshPeers}: NEVER throws — a missing / unreadable /
 * oversized / malformed / stale / dead-pid file yields `undefined`. The returned
 * `authHeader` is a credential: it lives only here and in the ProxyAgent header,
 * never in `FleetInstanceInfo` / logs / errors.
 */
export async function readMeshEgress(options: ReadMeshEgressOptions = {}): Promise<FleetMeshProxy | undefined> {
  if (meshDiscoveryDisabled()) return undefined
  const readFileFn = options.readFileFn ?? ((p) => fs.readFile(p, "utf8"))
  const now = options.now ?? (() => Date.now())
  const pidAlive = options.pidAlive ?? defaultPidAlive

  let raw: string
  try {
    raw = await readFileFn(meshEgressFilePath())
  } catch {
    return undefined
  }
  // Defend the never-throws contract against a readFileFn that resolves to a
  // non-string (e.g. a test mock or a Buffer): Buffer.byteLength on a non-string
  // would throw synchronously outside any try/catch.
  if (typeof raw !== "string") return undefined
  if (Buffer.byteLength(raw, "utf8") > EGRESS_JSON_MAX_BYTES) return undefined

  let parsed: MeshEgressFile
  try {
    parsed = JSON.parse(raw) as MeshEgressFile
  } catch {
    return undefined
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined

  if (parsed.version !== 1) return undefined

  const url = validLoopbackHttpUrl(parsed.url)
  if (url === undefined) return undefined

  const token = validEgressToken(parsed.token)
  if (token === undefined) return undefined

  // pid must be a positive integer AND currently alive. `pidAlive` (default
  // `process.kill(pid, 0)`, or a test injection) is wrapped so a platform quirk /
  // throwing injection can never break the never-throws contract.
  if (typeof parsed.pid !== "number" || !Number.isInteger(parsed.pid) || parsed.pid <= 0) return undefined
  let alive: boolean
  try {
    alive = pidAlive(parsed.pid)
  } catch {
    return undefined
  }
  if (!alive) return undefined

  // updatedAt must be a finite number within the freshness window. This is
  // SAME-BOX state, so both a too-old file (stale sidecar) and a too-far-FUTURE
  // file (garbage / bad clock) are rejected — the age must sit in [-skew, TTL].
  if (typeof parsed.updatedAt !== "number" || !Number.isFinite(parsed.updatedAt)) return undefined
  let age: number
  try {
    age = now() - parsed.updatedAt
  } catch {
    return undefined
  }
  // A non-finite age (e.g. now() returned NaN) would make BOTH bounds-checks false
  // and silently accept a stale file — reject it.
  if (!Number.isFinite(age)) return undefined
  if (age > EGRESS_TTL_MS || age < -EGRESS_FUTURE_SKEW_MS) return undefined

  return { url, authHeader: `Bearer ${token}` }
}

/**
 * Registry that merges a static `fleet.json` registry with mesh discovery. Static
 * ALWAYS wins on an id collision (a discovered peer sharing a static id is dropped
 * — never overwrites a configured instance, never merges auth across sources).
 * Discovery is cached briefly so a fan-out doesn't re-read the file per call, and a
 * failed discovery read leaves the static set untouched.
 *
 * The mesh egress proxy (from `egress.json`) is read in the SAME cached window and
 * attached to EVERY discovered mesh peer — the egress is per-conductor/self, shared
 * by all peers on this tailnet. Static bearer instances never carry one.
 */
export class MergedFleetRegistry {
  private readonly staticRegistry: FleetRegistry
  private readonly discover: () => Promise<Array<FleetResolvedInstance>>
  private readonly discoverEgress: () => Promise<FleetMeshProxy | undefined>
  private cache: { at: number; peers: Array<FleetResolvedInstance> } | undefined
  private inflight: Promise<Array<FleetResolvedInstance>> | undefined
  private readonly ttlMs: number
  private readonly now: () => number

  constructor(options: {
    staticRegistry?: FleetRegistry
    discover?: () => Promise<Array<FleetResolvedInstance>>
    discoverEgress?: () => Promise<FleetMeshProxy | undefined>
    ttlMs?: number
    now?: () => number
  } = {}) {
    this.staticRegistry = options.staticRegistry ?? new FleetRegistry()
    this.discover = options.discover ?? (() => readMeshPeers())
    this.discoverEgress = options.discoverEgress ?? (() => readMeshEgress())
    this.ttlMs = options.ttlMs ?? DISCOVERY_CACHE_TTL_MS
    this.now = options.now ?? (() => Date.now())
  }

  private async discoverCached(): Promise<Array<FleetResolvedInstance>> {
    const now = this.now()
    if (this.cache && now - this.cache.at < this.ttlMs) return this.cache.peers
    // Single-flight: a concurrent fan-out (await_turn resolves many instances)
    // shares one discovery read rather than racing N parallel reads/cache writes.
    if (this.inflight) return this.inflight
    this.inflight = (async () => {
      // Isolate the two reads: an egress-discovery failure must NEVER drop the
      // discovered peers (they stay visible with no proxy → the client fails
      // closed with an actionable notice), and vice versa.
      const [peersResult, egressResult] = await Promise.allSettled([this.discover(), this.discoverEgress()])
      const peers = peersResult.status === "fulfilled" ? peersResult.value : []
      const egress = egressResult.status === "fulfilled" ? egressResult.value : undefined
      // Attach the shared egress proxy to every mesh peer. A peer with no valid
      // egress keeps `meshProxy` undefined — the client then fails closed rather
      // than attempting a direct (unroutable) `.ts.net` fetch.
      const withEgress = egress === undefined
        ? peers
        : peers.map((peer) => (peer.auth.type === "mesh" ? { ...peer, meshProxy: egress } : peer))
      this.cache = { at: this.now(), peers: withEgress }
      return withEgress
    })().finally(() => {
      this.inflight = undefined
    })
    return this.inflight
  }

  /** Static∪discovered with static winning on id collision. */
  private async union(): Promise<Array<FleetResolvedInstance>> {
    const staticResolved = await this.staticRegistry.resolveAll()
    const staticIds = new Set(staticResolved.map((instance) => instance.id))
    const discovered = (await this.discoverCached()).filter((peer) => !staticIds.has(peer.id))
    return [...staticResolved, ...discovered]
  }

  async resolveInstance(arg?: string): Promise<FleetResolvedInstance> {
    return selectInstance(await this.union(), arg)
  }

  async listInstances(): Promise<Array<FleetInstanceInfo>> {
    const staticInfos = await this.staticRegistry.listInstances()
    const staticIds = new Set(staticInfos.map((info) => info.id))
    const discovered = (await this.discoverCached()).filter((peer) => !staticIds.has(peer.id))
    return [...staticInfos, ...discovered.map(toInfo)]
  }
}
