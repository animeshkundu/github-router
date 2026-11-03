import type { Context } from "hono"

import { findLaunchBySecret, LAUNCH_BOUND_TOKEN_PREFIX } from "./launch-registry"
import type { LaunchRegistryEntry } from "./state"

/**
 * `/v1/messages` identity-preflight bearer, distinct from the `/mcp` nonce
 * (`Authorization` header). Delivered to the spawned Claude Code process via
 * `ANTHROPIC_CUSTOM_HEADERS` (an Anthropic SDK env var already carried
 * through `getClaudeCodeEnvVars`), so it rides on EVERY `/v1/messages`
 * request the client sends — main-loop turns, subagents, hooks calling the
 * loopback endpoint directly, all of it.
 *
 * A raw BYO client (`start`/`codex`, or any script hitting `/v1/messages`
 * directly) never sets this header, and that is intentional: header
 * PRESENCE is what marks a request as asserting a bound-launch identity.
 * Absence is not a downgrade from some previously-enforced state — it is
 * today's status quo for every `/v1/messages` caller, preserved exactly.
 * Only a request that DOES present the header is held to it: if a matching
 * registry entry can't be found for it (wrong value, launch already torn
 * down, a claude session that raced this header against a proxy restart),
 * that specific request fails closed.
 */
export const LAUNCH_SECRET_HEADER = "X-GH-Router-Launch-Secret"

export type MessagesIdentityPreflightResult =
  | { ok: true; launch?: LaunchRegistryEntry }
  | { ok: false; reason: string }

/**
 * Validate the launch-secret header BEFORE any body consumer runs (i.e.
 * before `c.req.text()`/`c.req.json()` — this function only reads a
 * header). Callers running this must NOT surface a bare 401 on the
 * `/v1/messages` boundary: this route observes the same no-401 invariant
 * `forwardError` enforces for upstream failures (Claude Code's reactive
 * refresh path fires on ANY 401 and would try to use the synthetic
 * refresh token, breaking the session). Use `identityPreflightErrorResponse`
 * below, which answers 403, to reject a failed preflight.
 */
export function runMessagesIdentityPreflight(c: Context): MessagesIdentityPreflightResult {
  const header = c.req.header(LAUNCH_SECRET_HEADER)
  if (header) {
    const launch = findLaunchBySecret(header)
    if (!launch) {
      return {
        ok: false,
        reason:
          "X-GH-Router-Launch-Secret header did not match any registered launch "
          + "(the launch may have been restarted, or the header was tampered with)",
      }
    }
    return { ok: true, launch }
  }

  // The header is the normal channel. A teammate spawned by the agent-teams
  // primitive cannot send it (its env allowlist drops ANTHROPIC_CUSTOM_HEADERS),
  // so the local-family launch also mirrors its secret into the per-launch
  // synthetic credential, which the teammate reads and sends as this bearer.
  // See `writeLaunchBoundSyntheticCredential` in paths.ts.
  const bearerSecret = launchSecretFromBearer(c.req.header("authorization"))
  if (bearerSecret === undefined) {
    // Unbound BYO traffic. Not an error — this is the separately-identified
    // route every `start`/`codex` client (and any raw API caller) has always
    // taken, and it stays exactly as permissive as before this preflight
    // existed. The shared `github-router-synthetic` token lands here too, so
    // non-local launches keep their traffic unbound exactly as before.
    return { ok: true }
  }
  const launch = bearerSecret ? findLaunchBySecret(bearerSecret) : undefined
  if (!launch) {
    return {
      ok: false,
      reason:
        `Authorization bearer carried a ${LAUNCH_BOUND_TOKEN_PREFIX} launch token that did not match any `
        + "registered launch (the launch may have been restarted, or the token was tampered with)",
    }
  }
  return { ok: true, launch }
}

/**
 * Pull the launch secret out of an `Authorization: Bearer` value.
 *
 * Returns `undefined` for anything that does not assert a launch identity:
 * a missing header, another scheme, or the shared `github-router-synthetic`
 * token. Returns an empty string for a prefixed but empty token, which the
 * caller treats as a failed match rather than as unbound traffic — a request
 * that says "I am this launch" and names nobody is never silently downgraded
 * to BYO.
 */
function launchSecretFromBearer(authorization: string | undefined): string | undefined {
  if (!authorization) return undefined
  const match = /^Bearer\s+(.+)$/i.exec(authorization.trim())
  if (!match) return undefined
  const token = match[1].trim()
  if (!token.startsWith(LAUNCH_BOUND_TOKEN_PREFIX)) return undefined
  return token.slice(LAUNCH_BOUND_TOKEN_PREFIX.length)
}

/**
 * Anthropic-shaped rejection for a failed identity preflight. 403, never
 * 401 — see the no-401 invariant note on `runMessagesIdentityPreflight`.
 */
export function identityPreflightErrorResponse(
  c: Context,
  reason: string,
  path = "/v1/messages",
): Response {
  return c.json(
    {
      type: "error",
      error: {
        type: "permission_error",
        message: `${path} identity preflight rejected: ${reason}`,
      },
    },
    403,
  )
}
