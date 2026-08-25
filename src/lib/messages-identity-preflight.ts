import type { Context } from "hono"

import { findLaunchBySecret } from "./launch-registry"
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
  if (!header) {
    // Unbound BYO traffic. Not an error — this is the separately-identified
    // route every `start`/`codex` client (and any raw API caller) has always
    // taken, and it stays exactly as permissive as before this preflight
    // existed.
    return { ok: true }
  }
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

/**
 * Anthropic-shaped rejection for a failed identity preflight. 403, never
 * 401 — see the no-401 invariant note on `runMessagesIdentityPreflight`.
 */
export function identityPreflightErrorResponse(c: Context, reason: string): Response {
  return c.json(
    {
      type: "error",
      error: {
        type: "permission_error",
        message: `/v1/messages identity preflight rejected: ${reason}`,
      },
    },
    403,
  )
}
