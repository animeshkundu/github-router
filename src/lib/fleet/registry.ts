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
}

export interface FleetRegistryConfig {
  instances?: ReadonlyArray<FleetInstanceConfig>
}

export interface FleetResolvedInstance {
  id: string
  label: string
  url: string
  token: string
  allowExec?: boolean
  tunnelId?: string
  tunnelToken?: string
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
    const instances = await this.instancesWithTokens()
    const wanted = typeof arg === "string" ? arg.trim() : ""

    if (wanted) {
      const byId = instances.find((instance) => instance.id === wanted)
      if (byId) return resolvedInstance(byId)

      const labelMatches = instances.filter(
        (instance) => instance.label.toLocaleLowerCase() === wanted.toLocaleLowerCase(),
      )
      if (labelMatches.length > 1) {
        throw new FleetRegistryError(
          "AMBIGUOUS_LABEL",
          `fleet instance label ${JSON.stringify(wanted)} matches ${labelMatches.length} instances; use an id`,
        )
      }
      if (labelMatches.length === 1) return resolvedInstance(labelMatches[0]!)

      throw new FleetRegistryError(
        "INSTANCE_NOT_FOUND",
        `fleet instance ${JSON.stringify(wanted)} was not found`,
      )
    }

    const defaultInstance = instances.find((instance) => instance.default === true)
    if (defaultInstance) return resolvedInstance(defaultInstance)
    if (instances.length === 1) return resolvedInstance(instances[0]!)

    throw new FleetRegistryError(
      "INSTANCE_REQUIRED",
      instances.length === 0
        ? "fleet instance is required; registry is empty"
        : "fleet instance is required; specify an instance id or label",
    )
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

  return {
    id: id.trim(),
    label: label.trim(),
    url: trimmedUrl,
    token,
    default: instance.default === true ? true : undefined,
    allowExec: instance.allowExec === true ? true : undefined,
    tunnelId,
    tunnelToken,
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

function resolvedInstance(instance: FleetInstanceConfig): FleetResolvedInstance {
  return {
    id: instance.id,
    label: instance.label,
    url: instance.url,
    token: instance.token,
    allowExec: instance.allowExec,
    tunnelId: instance.tunnelId,
    tunnelToken: instance.tunnelToken,
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isNodeErrorCode(err: unknown, code: string): boolean {
  return isObject(err) && err.code === code
}
