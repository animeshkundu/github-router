import consola from "consola"
import { createHash } from "node:crypto"

import { GITHUB_API_BASE_URL, githubHeaders } from "~/lib/api-config"
import { HTTPError } from "~/lib/error"
import { state } from "~/lib/state"
import { fetchWithTransientRetry } from "~/lib/upstream-retry"

/**
 * Allowlist of hosts the router will trust as the Copilot API base URL.
 * Anything else returned in `endpoints.api` (e.g. via a tampered or
 * misconfigured token-exchange response) is rejected — otherwise a
 * malicious value would receive the long-lived GitHub PAT we send to
 * `/mcp` for web search (see `src/services/copilot/web-search.ts`).
 */
const COPILOT_HOST_ALLOWLIST = [
  "api.githubcopilot.com",
  "api.individual.githubcopilot.com",
  "api.business.githubcopilot.com",
  "api.enterprise.githubcopilot.com",
]

/**
 * True iff `rawUrl` is an HTTPS URL whose host is a trusted Copilot API host.
 * Exported so every path that sends a long-lived token to a discovered
 * Copilot host (web search, first-mate CAPI session logs) shares one allowlist.
 */
export function isAllowedCopilotHost(rawUrl: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch {
    return false
  }
  if (parsed.protocol !== "https:") return false
  return COPILOT_HOST_ALLOWLIST.includes(parsed.hostname)
}

/**
 * Short, non-reversible identifier for a credential, safe to log.
 *
 * During the 2026-08-08 incident the logs could not answer the one question
 * that mattered: was the process holding a stale credential, or was the
 * credential on disk itself dead? The operator re-authenticated at 13:53 and
 * the proxy kept failing, and nothing recorded whether those were the same
 * secret. A truncated SHA-256 makes two credentials comparable across log
 * lines without ever printing one. 8 hex chars is ample to distinguish the
 * handful of credentials a machine sees, and far too short to attack.
 */
export function credentialFingerprint(token: string | undefined): string {
  if (!token) return "none"
  return createHash("sha256").update(token).digest("hex").slice(0, 8)
}

/** How a failed token exchange should be treated. */
export type TokenExchangeFailureKind =
  /** The credential itself was rejected. Only a human can fix this. */
  | "credential_rejected"
  /** The entitlement lapsed; the credential is fine. Different remedy. */
  | "entitlement_lapsed"
  /** Anything else — rate limits, 5xx, transport. Retrying may work. */
  | "transient"

/**
 * A failed `/copilot_internal/v2/token` exchange, carrying enough to diagnose
 * it after the fact.
 *
 * The predecessor threw `HTTPError("Failed to get Copilot token", response)`
 * and every catch logged only `.message`, so status and body were dropped —
 * which is why the incident is unattributable.
 */
export class CopilotTokenExchangeError extends HTTPError {
  readonly kind: TokenExchangeFailureKind
  readonly status: number
  /** Fingerprint of the credential that was rejected, never the credential. */
  readonly credential: string

  constructor(opts: {
    kind: TokenExchangeFailureKind
    status: number
    credential: string
    detail: string
    response: Response
  }) {
    super(
      `Failed to get Copilot token: HTTP ${opts.status} (${opts.kind}, credential ${opts.credential})${
        opts.detail ? ` — ${opts.detail}` : ""
      }`,
      opts.response,
    )
    this.kind = opts.kind
    this.status = opts.status
    this.credential = opts.credential
  }
}

/** Upper bound on how much of an error body we quote into a log line. */
const ERROR_BODY_SNIPPET_CHARS = 300

/**
 * `notification_id` values that mean "the credential is valid but the
 * entitlement is not". These need a different remedy than a bad credential:
 * telling someone whose subscription lapsed to re-authenticate sends them
 * around a loop that cannot help.
 */
const ENTITLEMENT_NOTIFICATIONS = new Set([
  "access_revoked",
  "subscription_ended",
  "no_copilot_access",
])

/**
 * Classify a non-OK exchange response.
 *
 * Deliberately asymmetric: only a 401, or a 403 that NAMES an entitlement
 * problem, is treated as terminal. A bare 403 stays transient because GitHub
 * returns 403 for primary rate limits (`x-ratelimit-remaining: 0`) and
 * secondary abuse limits — telling a user with a perfectly good credential to
 * re-authenticate because they were briefly rate-limited would be a worse
 * failure than the one being fixed. The costs are not symmetric: calling a
 * terminal failure transient wastes some retries, while calling a transient
 * failure terminal kills a working session.
 */
function classifyExchangeFailure(
  status: number,
  body: string,
): TokenExchangeFailureKind {
  if (status === 401) return "credential_rejected"
  if (status === 403) {
    let notificationId: unknown
    try {
      const parsed = JSON.parse(body) as Record<string, unknown>
      notificationId =
        parsed.notification_id
        ?? (parsed.error as Record<string, unknown> | undefined)?.notification_id
    } catch {
      // Not JSON: a rate-limit body, an HTML error page. Transient.
    }
    if (
      typeof notificationId === "string"
      && ENTITLEMENT_NOTIFICATIONS.has(notificationId)
    ) {
      return "entitlement_lapsed"
    }
  }
  return "transient"
}

/**
 * Exchange the GitHub credential for a short-lived Copilot token.
 *
 * `credentialOverride` lets a caller try a candidate credential WITHOUT
 * publishing it to the process-global `state` first. That matters because
 * `state` is shared by every concurrent request: installing an unvalidated
 * credential globally, even briefly, would make unrelated in-flight requests
 * send it and 401 while a perfectly good credential was still in hand.
 */
export const getCopilotToken = async (credentialOverride?: string) => {
  const credentialInUse = credentialOverride ?? state.githubToken
  const credential = credentialFingerprint(credentialInUse)
  // A shallow view over the real state: everything else (editor version,
  // plugin version) still comes from the live object, only the credential is
  // substituted, and nothing is mutated.
  const authState =
    credentialOverride === undefined
      ? state
      : { ...state, githubToken: credentialOverride }

  // GitHub PAT → Copilot token exchange. A transient 429/5xx/network blip
  // here aborts launch (and the interval-driven refresh that keeps the
  // session alive), so retry the transient class with bounded backoff. NO
  // 401-refresh compose: this call IS the token source, and a 401 means a
  // bad/expired GitHub PAT — deterministic, fail fast (retrying would burn
  // budget against a credential that can't recover without re-auth).
  const response = await fetchWithTransientRetry(
    () =>
      fetch(`${GITHUB_API_BASE_URL}/copilot_internal/v2/token`, {
        headers: githubHeaders(authState),
      }),
    { label: "/copilot_internal/v2/token" },
  )

  if (!response.ok) {
    // Read the body BEFORE throwing. The predecessor discarded it, so every
    // occurrence of this failure was unattributable after the fact.
    //
    // Read the ORIGINAL rather than a clone: a clone leaves the original body
    // unconsumed, and since the only consumer downstream is a `.message` log,
    // that stream — and its socket — would stay pinned open. The body we need
    // is captured into `detail` here, so nothing downstream has to re-read it.
    let body: string
    try {
      body = await response.text()
    } catch {
      body = "(could not read error body)"
    }
    const kind = classifyExchangeFailure(response.status, body)
    throw new CopilotTokenExchangeError({
      kind,
      status: response.status,
      credential,
      detail: body.slice(0, ERROR_BODY_SNIPPET_CHARS).replaceAll(/\s+/g, " ").trim(),
      // The original body is now consumed, so hand the error a fresh Response
      // carrying the same bytes. `HTTPError.response` stays readable for any
      // future consumer, without leaving an unconsumed stream behind.
      response: new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      }),
    })
  }

  const data = (await response.json()) as GetCopilotTokenResponse

  // Use the API base URL from the token response if available, matching
  // how VS Code determines the CAPI endpoint dynamically — but only when
  // it points at a github-controlled host (see allowlist above).
  // We deliberately do NOT clobber an existing `state.copilotApiUrl` in
  // the disallowed branch: when the user sets `COPILOT_API_URL` themselves
  // (e.g. for local testing or a CI mock), that's an explicit opt-in and
  // a different threat model than a tampered token-exchange response.
  // Allowlist-failing token-response values are simply ignored.
  if (data.endpoints?.api) {
    if (isAllowedCopilotHost(data.endpoints.api)) {
      state.copilotApiUrl = data.endpoints.api
    } else {
      consola.warn(
        `Refusing to honor Copilot API endpoint "${data.endpoints.api}" from ` +
        `the token-exchange response — not in allowlist ` +
        `(${COPILOT_HOST_ALLOWLIST.join(", ")}). ` +
        (state.copilotApiUrl
          ? `Keeping existing override "${state.copilotApiUrl}".`
          : `Falling back to the default api.githubcopilot.com.`),
      )
    }
  }

  return data
}

interface GetCopilotTokenResponse {
  expires_at: number
  refresh_in: number
  token: string
  endpoints?: {
    api?: string
    proxy?: string
    telemetry?: string
    "origin-tracker"?: string
  }
}
