/**
 * Local-model egress for the `-m local` / `-m local2` launch profiles.
 *
 * The only fact these profiles are allowed to know about the endpoint is its
 * base URL. Nothing here probes, sniffs, or branches on what is serving it,
 * and nothing issues a request: a wrong port surfaces as the upstream failure
 * the client already reports, never as a second failure channel invented by
 * the proxy.
 */

import type { Context } from "hono"
import consola from "consola"

import { isLocalFamily } from "~/lib/profile-family"
import { state } from "~/lib/state"

export const LOCAL_DEFAULT_PORT = 11111
export const LOCAL_DEFAULT_BASE_URL = `https://localhost:${LOCAL_DEFAULT_PORT}/v1`

export interface LocalEgressOverride {
  /** `--localurl` — full base URL, including the `/v1` prefix. */
  baseUrl?: string
  /** `--localport` — replaces the port of the resolved base URL. */
  port?: number | string
  /** Launch profile, used only to warn when the flags are inert. */
  profileId?: string
}

interface ResolvedOverride {
  baseUrl?: string
  port?: number
}

let cliOverride: ResolvedOverride | undefined
let warnedInert = false

function trimTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, "")
}

/**
 * Validate an absolute http(s) base URL and normalize it to the form the
 * egress concatenates (`<base>/messages`). A bare origin gains the documented
 * `/v1` prefix so `--localurl http://localhost:11111` and
 * `--localurl http://localhost:11111/v1` mean the same thing.
 */
function normalizeBaseUrl(raw: string, source: string): string {
  const trimmed = raw.trim()
  if (trimmed.length === 0) {
    throw new Error(`${source} must not be empty`)
  }
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    throw new Error(`${source} must be an absolute http(s) URL (got "${trimmed}")`)
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`${source} must be an http(s) URL (got "${parsed.protocol}")`)
  }
  if (parsed.pathname === "/" || parsed.pathname === "") {
    parsed.pathname = "/v1"
  }
  return trimTrailingSlashes(parsed.toString())
}

function parseLocalPort(raw: string, source: string): number {
  const trimmed = raw.trim()
  if (!/^\d+$/.test(trimmed)) {
    throw new Error(`${source} must be an integer port (got "${trimmed}")`)
  }
  const port = Number(trimmed)
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`${source} must be between 1 and 65535 (got "${trimmed}")`)
  }
  return port
}

function withPort(baseUrl: string, port: number): string {
  const parsed = new URL(baseUrl)
  parsed.port = String(port)
  return trimTrailingSlashes(parsed.toString())
}

/**
 * Resolve the local upstream base URL.
 *
 * Precedence, highest first:
 *   1. `--localurl`          (full base URL)
 *   2. `--localport`         (port of the base URL resolved below)
 *   3. `GH_ROUTER_LOCAL_BASE_URL`
 *   4. `GH_ROUTER_LOCAL_PORT`
 *   5. `https://localhost:11111/v1`
 *
 * The default scheme is `https` because that is the only endpoint measured.
 * A plain-HTTP server needs an explicit `--localurl http://...`; inferring the
 * scheme from the port number would be exactly the guess this profile refuses
 * to make.
 */
export function localBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  if (cliOverride?.baseUrl !== undefined) {
    return cliOverride.baseUrl
  }
  const envBaseRaw = (env.GH_ROUTER_LOCAL_BASE_URL ?? "").trim()
  const base =
    envBaseRaw.length > 0
      ? normalizeBaseUrl(envBaseRaw, "GH_ROUTER_LOCAL_BASE_URL")
      : LOCAL_DEFAULT_BASE_URL
  if (cliOverride?.port !== undefined) {
    return withPort(base, cliOverride.port)
  }
  const envPortRaw = (env.GH_ROUTER_LOCAL_PORT ?? "").trim()
  if (envPortRaw.length > 0) {
    return withPort(base, parseLocalPort(envPortRaw, "GH_ROUTER_LOCAL_PORT"))
  }
  return base
}

/**
 * Apply the CLI-level endpoint override. Called once per launch, before
 * `setupAndServe` starts accepting requests. Passing an empty object clears
 * any previous override.
 *
 * Deliberately does NOT write `process.env`: the child environment is
 * filtered and rebuilt, so a module-level value is the only surface that
 * cannot be reinterpreted by something else downstream.
 */
export function configureLocalEgress(override: LocalEgressOverride): void {
  const baseUrlRaw = (override.baseUrl ?? "").trim()
  const portRaw = override.port === undefined ? "" : String(override.port).trim()
  const hasBase = baseUrlRaw.length > 0
  const hasPort = portRaw.length > 0

  if (hasBase && hasPort) {
    throw new Error(
      "--localurl and --localport cannot be combined; pass one endpoint spelling",
    )
  }

  if (hasBase || hasPort) {
    if (!warnedInert && override.profileId !== undefined && !isLocalFamily(override.profileId)) {
      warnedInert = true
      consola.warn(
        `--localurl/--localport only apply to the local launch profiles (profile: ${override.profileId}); ignoring`,
      )
    }
    cliOverride = undefined
    if (hasBase) {
      cliOverride = { baseUrl: normalizeBaseUrl(baseUrlRaw, "--localurl") }
      return
    }
    cliOverride = { port: parseLocalPort(portRaw, "--localport") }
    return
  }

  cliOverride = undefined
}

/**
 * The session id sent upstream on the local path.
 *
 * `x-claude-code-session-id` is what the local server requires (a request
 * without it is a 400). It must stay stable per conversation, so the client's
 * own value always wins and the process-level id is only a fallback for a
 * caller that sent none. Never synthesize a fresh value per request: the
 * header exists for prompt-cache routing, and a random value defeats it.
 */
export function localSessionId(c: Context): string {
  const incoming = c.req.header("x-claude-code-session-id")?.trim()
  if (incoming !== undefined && incoming.length > 0) {
    return incoming
  }
  return state.sessionId
}
