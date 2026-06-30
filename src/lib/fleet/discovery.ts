import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import {
  type FleetInstanceInfo,
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

/**
 * Registry that merges a static `fleet.json` registry with mesh discovery. Static
 * ALWAYS wins on an id collision (a discovered peer sharing a static id is dropped
 * — never overwrites a configured instance, never merges auth across sources).
 * Discovery is cached briefly so a fan-out doesn't re-read the file per call, and a
 * failed discovery read leaves the static set untouched.
 */
export class MergedFleetRegistry {
  private readonly staticRegistry: FleetRegistry
  private readonly discover: () => Promise<Array<FleetResolvedInstance>>
  private cache: { at: number; peers: Array<FleetResolvedInstance> } | undefined
  private inflight: Promise<Array<FleetResolvedInstance>> | undefined
  private readonly ttlMs: number
  private readonly now: () => number

  constructor(options: {
    staticRegistry?: FleetRegistry
    discover?: () => Promise<Array<FleetResolvedInstance>>
    ttlMs?: number
    now?: () => number
  } = {}) {
    this.staticRegistry = options.staticRegistry ?? new FleetRegistry()
    this.discover = options.discover ?? (() => readMeshPeers())
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
      let peers: Array<FleetResolvedInstance>
      try {
        peers = await this.discover()
      } catch {
        peers = []
      }
      this.cache = { at: this.now(), peers }
      return peers
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
