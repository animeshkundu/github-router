import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

export interface FleetInstanceConfig {
  id: string
  label: string
  url: string
  token: string
  default?: boolean
  allowExec?: boolean
  /**
   * VS Code Dev Tunnel id (e.g. `aiordie-myhost-gh` or `aiordie-myhost-gh.usw2`)
   * for a PRIVATE tunnel. When set, github-router auto-mints + auto-refreshes a
   * `connect`-scoped Dev Tunnel access token via the `devtunnel` CLI and sends it
   * as `X-Tunnel-Authorization`. Obtain it from `devtunnel list` on the host — it
   * is the tunnel NAME, NOT the public URL subdomain. A credential precursor: kept
   * out of `FleetInstanceInfo` / `list_instances` and never logged.
   */
  tunnelId?: string
  /**
   * Static (manually-pasted) Dev Tunnel `connect` access token for a private
   * tunnel. Used only when `tunnelId` is absent. Dev Tunnel tokens are 24h and
   * not refreshable, so this goes stale daily — prefer `tunnelId` (auto-refresh)
   * or an anonymous tunnel. A credential: kept out of `FleetInstanceInfo` and logs.
   */
  tunnelToken?: string
  /**
   * Disable TLS certificate verification for THIS instance's requests only
   * (sends `tls: { rejectUnauthorized: false }` on each fetch). Intended for a
   * direct-HTTPS ai-or-die instance that serves a SELF-SIGNED cert (e.g.
   * `ai-or-die --https` on loopback or the LAN) — the FleetClient otherwise
   * rejects it with `self signed certificate`. Tunnel instances never need this
   * (`*.devtunnels.ms` presents a valid public cert).
   *
   * SECURITY: this disables both chain AND hostname verification for this one
   * instance, so a MITM on the path could impersonate the host and capture the
   * Bearer. Safe on loopback; a deliberate trade-off on a trusted LAN. The
   * origin-pinning + `redirect:"error"` credential boundaries still hold — only
   * cert verification is relaxed. Off (verification on) unless explicitly `true`.
   */
  insecureTLS?: boolean
}

export interface FleetRegistryConfig {
  instances?: ReadonlyArray<FleetInstanceConfig>
}

/**
 * Explicit, discriminated auth for a resolved instance. A static `fleet.json`
 * instance is `{ type: "bearer", token }`; a mesh-discovered peer is
 * `{ type: "mesh" }` (no token — the peer's OWN sidecar injects the bearer on
 * the tailnet->loopback hop, gated by the `tag:aiordie` ACL). Token-less is an
 * EXPLICIT type, never "token happens to be empty", so a typoed/blank static
 * token can never silently degrade into an unauthenticated request.
 */
export type FleetAuth = { type: "bearer"; token: string } | { type: "mesh" }

export interface FleetResolvedInstance {
  id: string
  label: string
  url: string
  /**
   * Bearer token for `type:"bearer"` instances; `""` for mesh peers. Retained
   * (alongside `auth`) so the client-cache key and existing readers keep working;
   * the AUTHORITATIVE auth decision is `auth`, not this field.
   */
  token: string
  auth: FleetAuth
  default?: boolean
  allowExec?: boolean
  tunnelId?: string
  tunnelToken?: string
  insecureTLS?: boolean
}

export interface FleetInstanceInfo {
  id: string
  label: string
  url: string
  default?: boolean
  allowExec?: boolean
  // NO-LEAK INVARIANT: this is the shape `listInstances()` returns to the model.
  // `token`, `tunnelToken`, and `tunnelId` are credentials / credential precursors
  // and are deliberately omitted — never add them here.
}

export type FleetRegistryErrorCode =
  | "AMBIGUOUS_LABEL"
  | "INSTANCE_REQUIRED"
  | "INSTANCE_NOT_FOUND"
  | "INVALID_CONFIG"

export class FleetRegistryError extends Error {
  code: FleetRegistryErrorCode

  constructor(code: FleetRegistryErrorCode, message: string) {
    super(message)
    this.name = "FleetRegistryError"
    this.code = code
  }
}

export type FleetRegistryLoader = () => Promise<FleetRegistryConfig> | FleetRegistryConfig

export interface FleetRegistryOptions {
  config?: FleetRegistryConfig
  loadConfig?: FleetRegistryLoader
  configPath?: string
}

export function defaultFleetConfigPath(): string {
  return process.env.GH_ROUTER_FLEET_CONFIG
    || path.join(os.homedir(), ".local", "share", "github-router", "fleet.json")
}

export async function loadFleetRegistryConfig(configPath = defaultFleetConfigPath()): Promise<FleetRegistryConfig> {
  let stat: Awaited<ReturnType<typeof fs.stat>>
  try {
    stat = await fs.stat(configPath)
  } catch (err) {
    if (isNodeErrorCode(err, "ENOENT")) return { instances: [] }
    throw err
  }

  if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) {
    console.warn(
      `[fleet] Registry file ${configPath} is group/other-readable; it contains bearer / tunnel credentials. `
        + "Consider chmod 600.",
    )
  }

  const raw = await fs.readFile(configPath, "utf8")
  if (raw.trim() === "") return { instances: [] }
  const parsed = JSON.parse(raw) as unknown
  if (!isObject(parsed)) {
    throw new FleetRegistryError("INVALID_CONFIG", "fleet registry must be a JSON object")
  }
  const instances = (parsed as { instances?: unknown }).instances
  if (instances === undefined) return { instances: [] }
  if (!Array.isArray(instances)) {
    throw new FleetRegistryError("INVALID_CONFIG", "fleet registry instances must be an array")
  }
  return { instances: instances.map(parseInstance) }
}

export class FleetRegistry {
  private readonly loader: FleetRegistryLoader
  private loaded: Promise<ReadonlyArray<FleetInstanceConfig>> | undefined

  constructor(options: FleetRegistryOptions = {}) {
    if (options.config !== undefined) {
      const config = options.config
      this.loader = () => config
    } else if (options.loadConfig !== undefined) {
      this.loader = options.loadConfig
    } else {
      const configPath = options.configPath
      this.loader = () => loadFleetRegistryConfig(configPath)
    }
  }

  async resolveInstance(arg?: string): Promise<FleetResolvedInstance> {
    const resolved = (await this.instancesWithTokens()).map(resolvedInstance)
    return selectInstance(resolved, arg)
  }

  /** All static instances, fully resolved (with tokens). Used to build the merged static∪discovered set. */
  async resolveAll(): Promise<Array<FleetResolvedInstance>> {
    return (await this.instancesWithTokens()).map(resolvedInstance)
  }

  async listInstances(): Promise<Array<FleetInstanceInfo>> {
    const instances = await this.instancesWithTokens()
    return instances.map((instance) => ({
      id: instance.id,
      label: instance.label,
      url: instance.url,
      default: instance.default,
      allowExec: instance.allowExec,
    }))
  }

  private instancesWithTokens(): Promise<ReadonlyArray<FleetInstanceConfig>> {
    if (!this.loaded) {
      this.loaded = Promise.resolve(this.loader()).then((config) => normalizeConfig(config))
    }
    return this.loaded
  }
}

/**
 * Pure instance selection over an already-resolved set: id (exact) → label
 * (case-insensitive, ambiguity-checked) → default → single. Shared by the static
 * registry and the merged static∪discovered registry so both apply identical
 * matching + error semantics.
 */
export function selectInstance(
  instances: ReadonlyArray<FleetResolvedInstance>,
  arg?: string,
): FleetResolvedInstance {
  const wanted = typeof arg === "string" ? arg.trim() : ""

  if (wanted) {
    const byId = instances.find((instance) => instance.id === wanted)
    if (byId) return byId

    const labelMatches = instances.filter(
      (instance) => instance.label.toLocaleLowerCase() === wanted.toLocaleLowerCase(),
    )
    if (labelMatches.length > 1) {
      throw new FleetRegistryError(
        "AMBIGUOUS_LABEL",
        `fleet instance label ${JSON.stringify(wanted)} matches ${labelMatches.length} instances; use an id`,
      )
    }
    if (labelMatches.length === 1) return labelMatches[0]!

    throw new FleetRegistryError(
      "INSTANCE_NOT_FOUND",
      `fleet instance ${JSON.stringify(wanted)} was not found`,
    )
  }

  const defaultInstance = instances.find((instance) => instance.default === true)
  if (defaultInstance) return defaultInstance
  if (instances.length === 1) return instances[0]!

  throw new FleetRegistryError(
    "INSTANCE_REQUIRED",
    instances.length === 0
      ? "fleet instance is required; registry is empty"
      : "fleet instance is required; specify an instance id or label",
  )
}

function normalizeConfig(config: FleetRegistryConfig): ReadonlyArray<FleetInstanceConfig> {
  if (!isObject(config)) {
    throw new FleetRegistryError("INVALID_CONFIG", "fleet registry config must be an object")
  }
  const instances = config.instances ?? []
  if (!Array.isArray(instances)) {
    throw new FleetRegistryError("INVALID_CONFIG", "fleet registry instances must be an array")
  }
  return instances.map(parseInstance)
}

function parseInstance(raw: unknown): FleetInstanceConfig {
  if (!isObject(raw)) {
    throw new FleetRegistryError("INVALID_CONFIG", "fleet registry instance must be an object")
  }
  const instance = raw as Record<string, unknown>
  const id = instance.id
  const label = instance.label
  const url = instance.url
  const token = instance.token
  if (typeof id !== "string" || id.trim() === "") {
    throw new FleetRegistryError("INVALID_CONFIG", "fleet registry instance id must be a non-empty string")
  }
  if (typeof label !== "string" || label.trim() === "") {
    throw new FleetRegistryError("INVALID_CONFIG", `fleet registry instance ${id} label must be a non-empty string`)
  }
  if (typeof url !== "string" || url.trim() === "") {
    throw new FleetRegistryError("INVALID_CONFIG", `fleet registry instance ${id} url must be a non-empty string`)
  }
  const trimmedUrl = url.trim()
  let parsedUrl: URL
  try {
    parsedUrl = new URL(trimmedUrl)
  } catch {
    throw invalidInstanceUrlError(id)
  }
  if (!isAllowedInstanceUrl(parsedUrl)) {
    throw invalidInstanceUrlError(id)
  }
  assertDevTunnelUrlShape(id, parsedUrl)
  // Reject embedded credentials in the URL — a `https://user:pass@host` form
  // would (a) be a credential sink in the registry/url and (b) muddy the
  // origin-pinning that scopes the tunnel auth header. The bearer/tunnel token
  // are the auth mechanisms, never URL userinfo.
  if (parsedUrl.username !== "" || parsedUrl.password !== "") {
    throw new FleetRegistryError(
      "INVALID_CONFIG",
      `fleet registry instance ${id} url must not contain embedded credentials (userinfo)`,
    )
  }
  if (typeof token !== "string" || token === "") {
    throw new FleetRegistryError("INVALID_CONFIG", `fleet registry instance ${id} token must be a non-empty string`)
  }

  const tunnelId = parseTunnelId(id, instance.tunnelId)
  const tunnelToken = parseTunnelToken(id, instance.tunnelToken)
  const insecureTLS = parseInsecureTLS(id, instance.insecureTLS)
  if (insecureTLS) {
    // insecureTLS exists ONLY to reach a direct-HTTPS self-signed instance on the
    // local machine / trusted LAN. Reject every other shape rather than silently
    // honoring it, since each only weakens security:
    // - an http url has no TLS to relax;
    // - a Dev Tunnel (tunnelId/tunnelToken, or a *.devtunnels.ms host) already gets
    //   a VALID public cert from the relay;
    // - any other PUBLIC/routable host would have verification disabled on a
    //   public-internet hop, exposing the bearer to a MITM.
    if (parsedUrl.protocol !== "https:") {
      throw new FleetRegistryError(
        "INVALID_CONFIG",
        `fleet registry instance ${id} insecureTLS only applies to an https url (an http url has no TLS to relax)`,
      )
    }
    if (tunnelId !== undefined || tunnelToken !== undefined) {
      throw new FleetRegistryError(
        "INVALID_CONFIG",
        `fleet registry instance ${id} insecureTLS must not be combined with a Dev Tunnel (tunnelId/tunnelToken); `
          + "the relay presents a valid public cert, so disabling verification only exposes the bearer/tunnel token to MITM",
      )
    }
    if (!isLocalNetworkHost(parsedUrl.hostname)) {
      const devtunnel = DEVTUNNEL_HOST_RE.test(parsedUrl.hostname)
      throw new FleetRegistryError(
        "INVALID_CONFIG",
        devtunnel
          ? `fleet registry instance ${id} insecureTLS must not be set on a Dev Tunnel host; *.devtunnels.ms presents a valid public cert`
          : `fleet registry instance ${id} insecureTLS is only allowed for a local-network host `
            + `(loopback, a private/LAN IP, or a .local name); refusing to disable TLS verification for public host ${parsedUrl.hostname}`,
      )
    }
  }

  return {
    id: id.trim(),
    label: label.trim(),
    url: trimmedUrl,
    token,
    default: instance.default === true ? true : undefined,
    allowExec: instance.allowExec === true ? true : undefined,
    tunnelId,
    tunnelToken,
    insecureTLS,
  }
}

// Dev Tunnel id charset: must START with an alphanumeric (a leading `-` would be
// parsed as a flag by the `devtunnel` CLI — flag-injection guard) and contain
// only `[A-Za-z0-9._-]` (the `.` admits the `name.cluster` form). No whitespace,
// no shell metacharacters, no `%`.
const TUNNEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

function parseTunnelId(id: string, raw: unknown): string | undefined {
  if (raw === undefined) return undefined
  if (typeof raw !== "string" || !TUNNEL_ID_RE.test(raw.trim())) {
    throw new FleetRegistryError(
      "INVALID_CONFIG",
      `fleet registry instance ${id} tunnelId must match ${TUNNEL_ID_RE.source} (a devtunnel tunnel name from \`devtunnel list\`)`,
    )
  }
  return raw.trim()
}

function parseTunnelToken(id: string, raw: unknown): string | undefined {
  if (raw === undefined) return undefined
  if (typeof raw !== "string") {
    throw new FleetRegistryError("INVALID_CONFIG", `fleet registry instance ${id} tunnelToken must be a string`)
  }
  // Normalize human paste forms: surrounding quotes, a leading
  // `X-Tunnel-Authorization:` header label, and the `tunnel ` scheme prefix.
  let t = raw.trim()
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    t = t.slice(1, -1).trim()
  }
  t = t.replace(/^X-Tunnel-Authorization:\s*/i, "").replace(/^tunnel\s+/i, "").trim()
  // The value rides in an HTTP header, so a CR/LF/control char would be a header
  // injection vector; a single-line non-empty token is required.
  if (t === "" || /\s/.test(t)) {
    throw new FleetRegistryError(
      "INVALID_CONFIG",
      `fleet registry instance ${id} tunnelToken must be a non-empty single-line token`,
    )
  }
  return t
}

function parseInsecureTLS(id: string, raw: unknown): boolean | undefined {
  if (raw === undefined) return undefined
  // A security flag must not be silently coerced: a `"true"` string or `1` is a
  // misconfiguration the user expects to ENABLE the relax, so reject loudly
  // rather than fail closed and leave them staring at a `self signed certificate`.
  if (typeof raw !== "boolean") {
    throw new FleetRegistryError(
      "INVALID_CONFIG",
      `fleet registry instance ${id} insecureTLS must be a boolean`,
    )
  }
  return raw === true ? true : undefined
}

function invalidInstanceUrlError(id: string): FleetRegistryError {
  return new FleetRegistryError(
    "INVALID_CONFIG",
    `${id.trim()} url must be https (or http://localhost for local testing)`,
  )
}

function isAllowedInstanceUrl(url: URL): boolean {
  if (url.protocol === "https:") return true
  if (url.protocol !== "http:") return false
  return url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]"
}

// insecureTLS is scoped to local-network targets ONLY. A host qualifies when it is
// loopback, an RFC1918 / link-local IPv4, a loopback / link-local / ULA IPv6, or an
// mDNS `.local` name. Everything else (public FQDNs, public IPs, Dev Tunnel relays)
// is rejected so TLS verification is never disabled on a routable internet hop.
// NB: 100.64.0.0/10 (CGNAT, e.g. Tailscale) is intentionally NOT treated as local —
// add it explicitly if you ever front instances over a CGNAT overlay.
function isLocalNetworkHost(hostnameRaw: string): boolean {
  const host = hostnameRaw.replace(/^\[/, "").replace(/\]$/, "").toLowerCase()
  if (host === "localhost") return true
  if (host.endsWith(".local")) return true

  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (v4) {
    const octets = [Number(v4[1]), Number(v4[2]), Number(v4[3]), Number(v4[4])]
    if (octets.some((o) => o > 255)) return false
    const a = octets[0]!
    const b = octets[1]!
    if (a === 127) return true // 127.0.0.0/8 loopback
    if (a === 10) return true // 10.0.0.0/8
    if (a === 172 && b >= 16 && b <= 31) return true // 172.16.0.0/12
    if (a === 192 && b === 168) return true // 192.168.0.0/16
    if (a === 169 && b === 254) return true // 169.254.0.0/16 link-local
    return false
  }

  if (host.includes(":")) { // IPv6 literal
    if (host === "::1") return true // loopback
    if (/^fe[89ab]/.test(host)) return true // fe80::/10 link-local
    if (/^f[cd]/.test(host)) return true // fc00::/7 ULA
    return false
  }

  return false // bare or public hostname / FQDN
}

// F5: scope this check STRICTLY to Dev Tunnel relay hosts. Other domains
// (localhost, raw IPs, generic https://host:port) are unaffected.
const DEVTUNNEL_HOST_RE = /(?:^|\.)devtunnels\.ms$|(?:^|\.)tunnels\.api\.visualstudio\.com$/i

// F5: the canonical Dev Tunnel forwarded-port host fuses the port into the
// hostname with a hyphen: `<id>-<port>.<cluster>.devtunnels.ms`. The common
// mistake is `<id>.<cluster>.devtunnels.ms:<port>` — a bare tunnel id host plus
// an explicit `:port`. That addresses the tunnel-management endpoint, not the
// forwarded service, and silently 302s. `URL.port` is empty for a default port
// (`:443` on https), so an explicit non-default port on a Dev Tunnel host is
// unambiguously the wrong shape.
function assertDevTunnelUrlShape(id: string, url: URL): void {
  if (!DEVTUNNEL_HOST_RE.test(url.hostname)) return
  if (url.port === "") return
  const firstDot = url.hostname.indexOf(".")
  const firstLabel = firstDot < 0 ? url.hostname : url.hostname.slice(0, firstDot)
  const rest = firstDot < 0 ? "" : url.hostname.slice(firstDot + 1)
  const corrected = rest === ""
    ? `https://${firstLabel}-${url.port}.devtunnels.ms`
    : `https://${firstLabel}-${url.port}.${rest}`
  throw new FleetRegistryError(
    "INVALID_CONFIG",
    `${id.trim()} url ${url.href} uses the wrong Dev Tunnel form: the forwarded port must be fused into the `
      + `hostname, not given as a :port suffix. Use ${corrected} instead `
      + "(the bare `<id>.<cluster>.devtunnels.ms:<port>` host addresses the tunnel-management endpoint, not the relayed service).",
  )
}

function resolvedInstance(instance: FleetInstanceConfig): FleetResolvedInstance {
  return {
    id: instance.id,
    label: instance.label,
    url: instance.url,
    token: instance.token,
    auth: { type: "bearer", token: instance.token },
    default: instance.default,
    allowExec: instance.allowExec,
    tunnelId: instance.tunnelId,
    tunnelToken: instance.tunnelToken,
    insecureTLS: instance.insecureTLS,
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isNodeErrorCode(err: unknown, code: string): boolean {
  return isObject(err) && err.code === code
}
