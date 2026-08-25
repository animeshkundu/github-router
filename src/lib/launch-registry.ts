import { timingSafeEqual } from "node:crypto"
import { randomUUID } from "node:crypto"

import type { LaunchProfileId } from "./launch-profile"
import { state, type LaunchRegistryEntry } from "./state"

export type { LaunchRegistryEntry }

/**
 * Register a new authenticated launch (a `github-router claude` process, or
 * `serve`'s per-repo session) in the keyed registry. Returns the stored
 * entry, including the generated `launchId` when the caller didn't supply
 * one.
 *
 * Callers are expected to mint `nonce` and `secret` as independent random
 * tokens (see `src/claude.ts` / `src/lib/serve/enhancements.ts`) — this
 * function stores whatever it's given without generating credentials
 * itself, so a caller cannot accidentally rely on it for randomness.
 */
export function registerLaunch(params: {
  profileId: LaunchProfileId
  nonce: string
  secret: string
  allowedGroups?: ReadonlySet<string>
  allowedPersonas?: ReadonlySet<string>
  launchId?: string
}): LaunchRegistryEntry {
  const entry: LaunchRegistryEntry = {
    launchId: params.launchId ?? randomUUID(),
    nonce: params.nonce,
    secret: params.secret,
    profileId: params.profileId,
    allowedGroups: params.allowedGroups,
    allowedPersonas: params.allowedPersonas,
    createdAt: Date.now(),
  }
  state.launchRegistry.set(entry.launchId, entry)
  return entry
}

/** Remove one launch's entry. Idempotent — removing an already-removed or
 *  never-registered id is a no-op. Called from the launch's own cleanup
 *  path so a torn-down session's credentials stop authenticating. */
export function unregisterLaunch(launchId: string): void {
  state.launchRegistry.delete(launchId)
}

/** Test/shutdown helper: drop every registered launch. */
export function clearLaunchRegistry(): void {
  state.launchRegistry.clear()
}

/**
 * Constant-time string compare. Per-launch credentials are random tokens,
 * not secrets an attacker gets many guesses at over the network within one
 * process lifetime, so timing attacks aren't a realistic concern here — but
 * it costs nothing and matches the prior nonce-compare's posture.
 */
function constantTimeStringEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  try {
    return timingSafeEqual(Buffer.from(a), Buffer.from(b))
  } catch {
    return false
  }
}

/**
 * Find the launch whose `/mcp` bearer (`nonce`) matches. Linear scan over
 * `state.launchRegistry` — expected to hold a handful of entries at most
 * (one per concurrently running `claude`/`serve` session), so this is not a
 * hot-path concern. Returns undefined (never throws) when nothing matches,
 * including when the registry is empty (the "not enabled" case).
 */
export function findLaunchByNonce(nonce: string): LaunchRegistryEntry | undefined {
  for (const entry of state.launchRegistry.values()) {
    if (constantTimeStringEqual(entry.nonce, nonce)) return entry
  }
  return undefined
}

/** Find the launch whose `/v1/messages` identity-preflight bearer
 *  (`secret`) matches. Mirrors `findLaunchByNonce`. */
export function findLaunchBySecret(secret: string): LaunchRegistryEntry | undefined {
  for (const entry of state.launchRegistry.values()) {
    if (constantTimeStringEqual(entry.secret, secret)) return entry
  }
  return undefined
}

/** Look up a launch by its own opaque id (not a credential — used by
 *  cleanup paths that already hold the `LaunchRegistryEntry` they
 *  registered). */
export function getLaunchById(launchId: string): LaunchRegistryEntry | undefined {
  return state.launchRegistry.get(launchId)
}
