/**
 * Local-model egress for the `-m local` / `-m local2` launch profiles, and for
 * the `-m cheaplocal` consultants.
 *
 * The only fact these profiles are allowed to know about the endpoint is its
 * base URL. Nothing here probes, sniffs, or branches on what is serving it,
 * and nothing issues a request: a wrong port surfaces as the upstream failure
 * the client already reports, never as a second failure channel invented by
 * the proxy.
 */

import type { Context } from "hono"
import consola from "consola"

import { isCheaplocalProfile, isLocalFamily } from "~/lib/profile-family"
import { state } from "~/lib/state"
import {
  createMessages,
  type LocalMessagesEgress,
} from "~/services/copilot/create-messages"

export const LOCAL_DEFAULT_PORT = 11111
export const LOCAL_DEFAULT_BASE_URL = `https://localhost:${LOCAL_DEFAULT_PORT}/v1`

/**
 * Output cap for a local consultant turn (Advisor and Oracle).
 *
 * One number for both, and deliberately a small one: a consultant answers a
 * single question, and every larger value would be a claim about how much room
 * the model behind the endpoint has. The Copilot paths keep their own
 * catalog-derived budgets; this is only ever the catalog-less fallback, so a
 * launch whose consultants left Copilot is no worse off than the branch that
 * existed before it.
 */
export const LOCAL_CONSULT_MAX_OUTPUT_TOKENS = 4096

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
  // The egress appends its own path (`<base>/messages`), so a query or
  // fragment does not survive as one: `<base>?x=1` becomes
  // `/v1?x=1/messages`, whose path is `/v1` and whose query is `x=1/messages`.
  // That is a silent 404 several seconds into the session, which is exactly
  // the failure this module exists to move to launch time.
  if (parsed.search.length > 0 || parsed.hash.length > 0) {
    throw new Error(
      `${source} must not carry a query or fragment (got "${trimmed}")`,
    )
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
  // Presence is what the flag parser reports, not emptiness: a valueless
  // `--localport` arrives as `""`, and treating that as "not passed" would
  // silently fall back to the default endpoint with no diagnostic at all.
  const baseProvided = override.baseUrl !== undefined
  const portProvided = override.port !== undefined

  if (!baseProvided && !portProvided) {
    cliOverride = undefined
    warnedInert = false
    return
  }

  if (baseProvided && portProvided) {
    throw new Error(
      "--localurl and --localport cannot be combined; pass one endpoint spelling",
    )
  }

  // "Inert on every other profile" is the documented contract, so this
  // returns BEFORE validation. Validating first meant a typo in a flag we had
  // just called ignored could still fail the launch, and stored an override
  // the warning said was being discarded.
  //
  // `cheaplocal` is not a local-family member (its lead and natives stay on
  // Copilot) but its Advisor and Oracle DO use this endpoint, so the flags are
  // live for it.
  if (
    override.profileId !== undefined
    && !isLocalFamily(override.profileId)
    && !isCheaplocalProfile(override.profileId)
  ) {
    if (!warnedInert) {
      warnedInert = true
      consola.warn(
        `--localurl/--localport only apply to the local and cheaplocal launch profiles (profile: ${override.profileId}); ignoring`,
      )
    }
    cliOverride = undefined
    return
  }

  if (override.baseUrl !== undefined) {
    cliOverride = { baseUrl: normalizeBaseUrl(override.baseUrl, "--localurl") }
    return
  }
  cliOverride = { port: parseLocalPort(String(override.port), "--localport") }
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

/**
 * One non-streaming consultant turn against the local endpoint.
 *
 * This is the whole wire contract the `cheaplocal` Advisor and Oracle share:
 * a bare model id, a system prompt, one user message, and an output cap. It is
 * deliberately the smallest Anthropic body that can carry the request — no
 * `thinking`, no `output_config`, no `cache_control`, no catalog lookup, and no
 * `stream` flag. Every one of those would be a claim about a model the proxy
 * has never been told anything about, and a server that does not implement one
 * of them fails the whole consult.
 *
 * `maxTokens` is a caller decision rather than a constant here so the two
 * consultants can keep their own budgets; both pass the catalog-less fallback,
 * because a number read off a Copilot entry is exactly the assumption this
 * profile refuses to make.
 *
 * The response is parsed for Anthropic `text` blocks. Callers own retry
 * policy: `createMessages` itself has no local retry, and the two consultant
 * paths wrap this in `withTransientRetry` the same way the Copilot branches do.
 */
export async function sendLocalMessages(req: {
  egress: LocalMessagesEgress
  model: string
  system: string
  userText: string
  maxTokens: number
  signal?: AbortSignal
}): Promise<string> {
  const body = JSON.stringify({
    model: req.model,
    max_tokens: req.maxTokens,
    system: req.system,
    messages: [{ role: "user", content: req.userText }],
  })
  const response = await createMessages(body, {}, req.signal, false, req.egress)
  const json = (await response.json()) as { content?: unknown }
  const blocks = Array.isArray(json.content) ? json.content : []
  const texts: Array<string> = []
  for (const block of blocks) {
    if (typeof block !== "object" || block === null) continue
    const b = block as { type?: unknown; text?: unknown }
    if (b.type === "text" && typeof b.text === "string" && b.text.length > 0) {
      texts.push(b.text)
    }
  }
  const text = texts.join("\n\n")
  if (text.length === 0) {
    throw new Error(`Local model returned empty response (model: ${req.model})`)
  }
  return text
}
