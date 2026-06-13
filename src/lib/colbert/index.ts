/**
 * ColBERT semantic-search sidecar — public entry points.
 *
 * `provisionAndIndexColbert()` is the fire-and-forget call site the
 * `start` / `claude` / `codex` launchers invoke after `setupAndServe`
 * (mirroring `provisionToolbelt()` / `runSelfUpdate()`):
 *   1. Bail if opted out (`GH_ROUTER_DISABLE_SEMANTIC_SEARCH=1`).
 *   2. Register the exit handlers (tree-kill tracked colgrep children).
 *   3. Provision the binary/model/ORT under a lock + smoke test
 *      (best-effort, never throws to the launcher).
 *   4. If the launch cwd is a git repo and its index is absent/stale,
 *      kick a background `colgrep init` (non-blocking).
 *
 * On-demand indexing for non-cwd workspaces is handled inside the MCP
 * tool handler (`runSemanticSearch` kicks a debounced background init
 * for an unindexed workspace and reports `unavailable` meanwhile).
 */

import process from "node:process"

import consola from "consola"

import { parseBoolEnv } from "../exec"

import { gitState } from "./index-store"
import { registerColbertExitHandlers } from "./lifecycle"
import {
  colbertArtifactsPresent,
  colbertSmokeOk,
  provisionColbert,
} from "./provision"
import { kickBackgroundInit, startupKickAllowed } from "./runner"

/**
 * True unless the operator opted out via
 * `GH_ROUTER_DISABLE_SEMANTIC_SEARCH=1`. Semantic search is ON BY
 * DEFAULT (the proxy auto-provisions + background-indexes); the
 * capability gate additionally requires the artifacts to be present on
 * disk + smoke-passed, so in any environment where provisioning hasn't
 * completed the tool simply doesn't appear (no regression).
 */
export function semanticSearchOptedIn(): boolean {
  return parseBoolEnv(process.env.GH_ROUTER_DISABLE_SEMANTIC_SEARCH) !== true
}

/**
 * Availability predicate for ColBERT semantic search — the single
 * source of truth, living in this leaf module so callers that must not
 * import `mcp-capabilities` (notably the unified code-search helper)
 * can read it without closing an import cycle through `worker-agent`.
 *
 * True iff the operator hasn't opted out AND the colgrep binary + model
 * + ORT are provisioned on disk AND the post-provision smoke test
 * passed. `mcp-capabilities.semanticSearchEnabled()` delegates here.
 */
export function colbertSearchEnabled(): boolean {
  return (
    semanticSearchOptedIn() && colbertArtifactsPresent() && colbertSmokeOk()
  )
}

let _started = false

/**
 * Fire-and-forget provision + background-index. Never throws; safe to
 * `void`-call from a launcher right after the server is listening.
 * Idempotent within a proxy run (subsequent calls no-op).
 */
export async function provisionAndIndexColbert(opts: {
  cwd?: string
} = {}): Promise<void> {
  if (!semanticSearchOptedIn()) return
  if (_started) return
  _started = true

  // Wire the exit handlers up front so any colgrep child spawned during
  // provisioning (the smoke test) / indexing is reaped on shutdown.
  registerColbertExitHandlers()

  // Provision (binary/model/ORT + smoke). Best-effort.
  let provisioned = false
  try {
    const result = await provisionColbert()
    provisioned = result.status === "ready"
    if (result.status === "unsupported") {
      consola.debug("colbert: semantic search unsupported on this platform")
    } else if (result.status !== "ready") {
      consola.debug(`colbert: provision not ready (${result.status}: ${result.reason ?? ""})`)
    }
  } catch (err) {
    consola.debug("colbert: provision threw (swallowed):", err)
    return
  }
  if (!provisioned) return

  // Background-index the launch cwd if it's a git repo. Non-blocking.
  // Skip when the index is already in a capped/persistent failure state so a
  // restart loop doesn't re-burn a known-bad build (the per-query self-heal
  // still gives it its bounded retries).
  const cwd = opts.cwd ?? process.cwd()
  try {
    const g = await gitState(cwd)
    if (g.isRepo && (await startupKickAllowed(cwd))) {
      kickBackgroundInit(cwd)
    }
  } catch (err) {
    consola.debug("colbert: cwd git-detect skipped:", err)
  }
}

/** Test-only: reset the once-guard. */
export function __resetColbertStartedForTests(): void {
  _started = false
}

export { runSemanticSearch } from "./runner"
