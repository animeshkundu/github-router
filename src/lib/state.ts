import { randomBytes, randomUUID } from "node:crypto"
import { realpathSync } from "node:fs"

import type { ModelsResponse } from "~/services/copilot/get-models"

export interface State {
  githubToken?: string
  copilotToken?: string

  accountType: string
  copilotApiUrl?: string
  models?: ModelsResponse
  vsCodeVersion?: string
  copilotVersion?: string

  manualApprove: boolean
  rateLimitWait: boolean
  showToken: boolean
  extendedBetas: boolean

  // Rate limiting configuration
  rateLimitSeconds?: number
  lastRequestTimestamp?: number

  // Persistent session identifiers to match VS Code fingerprint
  sessionId: string
  machineId: string

  /**
   * Per-launch nonce for the loopback `/mcp` endpoint. Set by the
   * `claude` subcommand after `setupAndServe` and before spawning
   * Claude Code; the spawned MCP client reads it from the
   * `--mcp-config` tempfile and presents it as `Authorization: Bearer`.
   * When unset, `/mcp` rejects all requests — closes the
   * loopback-no-auth gap (DNS rebinding, malicious browser-ext
   * native messaging, sibling-process probe).
   */
  peerMcpNonce?: string

  /**
   * Canonicalized roots that `code_search` will allow as `workspace`
   * arguments. Captured once at process start so the user-launch cwd
   * is fixed for the proxy lifetime even if something later chdirs.
   *
   * Composition (computed once, at module init below):
   *   - The proxy's `process.cwd()` at module load, canonicalized via
   *     `realpathSync`. This is the user's project directory when
   *     they launched `github-router claude`.
   *   - Any roots in `GH_ROUTER_CODE_SEARCH_ROOTS` (JSON array of
   *     absolute paths). JSON form avoids the Windows-vs-POSIX
   *     `path.delimiter` ambiguity.
   *
   * `.gh-router-searchable` marker-file probing happens per-call in
   * `code-search.ts` (a marker added after proxy start should be
   * honored without restart).
   */
  codeSearchRoots: ReadonlyArray<string>
}

/**
 * Compute the startup allow-set roots. Pure function; runs once at
 * module init. Errors during realpath are swallowed (the proxy must
 * not fail to start because of a code_search config edge case) — the
 * affected root is simply omitted.
 */
function computeStartupRoots(): ReadonlyArray<string> {
  const roots: Array<string> = []

  try {
    roots.push(realpathSync(process.cwd()))
  } catch {
    // cwd unreachable (deleted, perm-stripped) — skip. code_search
    // requests will fall back to explicit env / marker roots, or
    // reject if none.
  }

  const envRaw = process.env.GH_ROUTER_CODE_SEARCH_ROOTS
  if (envRaw && envRaw.length > 0) {
    try {
      const parsed = JSON.parse(envRaw) as unknown
      if (Array.isArray(parsed)) {
        for (const entry of parsed) {
          if (typeof entry !== "string" || entry.length === 0) continue
          try {
            roots.push(realpathSync(entry))
          } catch {
            // Invalid path in the env array — skip silently. The
            // user's intent here is "expand the allow-set"; a typo
            // shouldn't prevent the proxy from starting.
          }
        }
      }
    } catch {
      // GH_ROUTER_CODE_SEARCH_ROOTS wasn't valid JSON. Don't crash.
    }
  }

  // De-dup while preserving insertion order (cwd first).
  return Object.freeze([...new Set(roots)])
}

export const state: State = {
  accountType: "enterprise",
  manualApprove: false,
  rateLimitWait: false,
  showToken: false,
  extendedBetas: false,
  sessionId: randomUUID(),
  machineId: randomBytes(32).toString("hex"),
  codeSearchRoots: computeStartupRoots(),
}
