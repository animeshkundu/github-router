/**
 * `az account get-access-token` plumbing shared by every router-owned Azure
 * client (Bluebird, Azure DevOps MCP, Kusto).
 *
 * The functions here throw a plain `Error` carrying an already-sanitized,
 * credential-free detail; each caller wraps it in its own error class so a
 * failure is attributed to the service that asked for the token. Nothing here
 * ever logs, returns, or embeds the token in a message.
 */

import { resolveExecutable, runCommandCapture } from "./exec"
import { sanitizeRemoteDetail, waitForSignal } from "./remote-mcp-client"

/** Azure CLI invocation budget: a hung `az` must not wedge a tool call. */
const AZ_TIMEOUT_MS = 20_000
const AZ_MAX_STDOUT_BYTES = 1024 * 1024

export interface AzCliToken {
  token: string
  /**
   * Epoch milliseconds at which the token stops working, when the installed
   * `az` reports it. `null` means "unknown" and callers must decide their own
   * refresh policy rather than treating it as expired.
   */
  expiresAtMs: number | null
}

/** Refresh this far ahead of the reported expiry. */
export const AZ_TOKEN_REFRESH_MARGIN_MS = 5 * 60_000

/**
 * Parse the `expires_on` / `expiresOn` fields of `az account get-access-token
 * --output json`. `expires_on` (epoch seconds) is present on modern az; the
 * older `expiresOn` string is local-time-without-zone, so it is only a
 * fallback and is parsed as local time. An unparseable value yields `null`,
 * never a fabricated deadline — a wrong deadline in either direction is worse
 * than none (too late sends a dead token, too early mints tokens in a loop).
 */
function parseAzExpiry(payload: Record<string, unknown>): number | null {
  const epoch = payload.expires_on
  if (typeof epoch === "number" && Number.isFinite(epoch) && epoch > 0) {
    // Some az versions report milliseconds; normalize by magnitude.
    const ms = epoch > 1e11 ? epoch : epoch * 1000
    if (ms > Date.now() - 86_400_000) return ms
  }
  if (typeof epoch === "string" && /^\d+$/.test(epoch.trim())) {
    const n = Number(epoch.trim())
    const ms = n > 1e11 ? n : n * 1000
    if (Number.isFinite(ms) && ms > Date.now() - 86_400_000) return ms
  }
  const text = payload.expiresOn
  if (typeof text === "string") {
    const parsed = Date.parse(text)
    if (Number.isFinite(parsed)) return parsed
  }
  return null
}

/**
 * Acquire an access token for `resource` through Azure CLI. `withExpiry` asks
 * for the JSON envelope so the caller can cache against a real deadline; the
 * default keeps the minimal `--query accessToken --output tsv` invocation.
 */
export async function runAzCliAccessToken(
  resource: string,
  opts: { signal?: AbortSignal; withExpiry?: boolean } = {},
): Promise<AzCliToken> {
  const { signal } = opts
  const executable = resolveExecutable("az")
  if (!executable) {
    throw new Error("Azure CLI executable `az` was not found on PATH.")
  }
  const args = ["account", "get-access-token", "--resource", resource]
  if (opts.withExpiry) {
    args.push("--output", "json")
  } else {
    args.push("--query", "accessToken", "--output", "tsv")
  }
  const result = await runCommandCapture(
    [executable, ...args],
    {
      timeoutMs: AZ_TIMEOUT_MS,
      maxStdoutBytes: AZ_MAX_STDOUT_BYTES,
      ...(signal ? { signal } : {}),
    },
  )
  if (result.timedOut) throw new Error("timed out")
  if (result.code !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim()
    throw new Error(`exited with code ${result.code ?? "unknown"}${detail ? `: ${detail.slice(0, 500)}` : ""}`)
  }
  const stdout = result.stdout.trim()
  if (!opts.withExpiry) {
    if (!stdout) throw new Error("az returned an empty access token")
    return { token: stdout, expiresAtMs: null }
  }
  let payload: unknown
  try {
    payload = JSON.parse(stdout)
  } catch {
    throw new Error("az returned an unparseable access-token response")
  }
  if (typeof payload !== "object" || payload === null) {
    throw new Error("az returned an unparseable access-token response")
  }
  const record = payload as Record<string, unknown>
  const token = typeof record.accessToken === "string" ? record.accessToken.trim() : ""
  if (!token) throw new Error("az returned an empty access token")
  return { token, expiresAtMs: parseAzExpiry(record) }
}

/**
 * Process-lifetime access-token cache keyed by resource (Kusto keys on the
 * cluster URI, which is its audience).
 *
 * Two properties matter and both are load-bearing:
 *
 *   - **Single-flight refresh.** Concurrent callers that see the same expired
 *     entry await ONE `az` invocation. Without this, a burst of tool calls
 *     spawns a burst of `az` processes, each of which is a `.cmd` shim on
 *     Windows.
 *   - **Never cache an unknown deadline.** When `az` does not report an expiry
 *     the token is used but not cached, because a cache entry with no deadline
 *     can only be either immortal (serving a dead token) or arbitrary (minting
 *     in a loop).
 */
export class AzCliAccessTokenCache {
  private readonly entries = new Map<string, { token: string; expiresAtMs: number }>()
  private readonly flights = new Map<string, Promise<string>>()
  private readonly marginMs: number

  constructor(marginMs: number = AZ_TOKEN_REFRESH_MARGIN_MS) {
    this.marginMs = marginMs
  }

  /** Cached-or-fresh token for `resource`. */
  async get(resource: string, signal?: AbortSignal): Promise<string> {
    const cached = this.entries.get(resource)
    if (cached && cached.expiresAtMs - this.marginMs > Date.now()) return cached.token

    const existing = this.flights.get(resource)
    if (existing) return waitForSignal(existing, signal)

    const flight = (async (): Promise<string> => {
      const { token, expiresAtMs } = await runAzCliAccessToken(resource, { withExpiry: true })
      if (expiresAtMs !== null) this.entries.set(resource, { token, expiresAtMs })
      return token
    })()
    this.flights.set(resource, flight)
    const tracked = flight.finally(() => {
      if (this.flights.get(resource) === tracked) this.flights.delete(resource)
    })
    return waitForSignal(tracked, signal)
  }

  /** Drop a cached token so the next `get` re-mints (used on a 401). */
  invalidate(resource: string): void {
    this.entries.delete(resource)
  }

  clear(): void {
    this.entries.clear()
  }
}

/** Standard wrapping of an `az` failure into a caller-owned error class. */
export function describeAzFailure(label: string, err: unknown): string {
  return `${label} token acquisition failed (${sanitizeRemoteDetail(err)}). Run \`az login\` and retry.`
}
