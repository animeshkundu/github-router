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
import { PATHS } from "../paths"

import { gitState, readColbertMeta } from "./index-store"
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
  /**
   * Skip the startup background-index of the launch cwd. `github-router serve`
   * is a machine-wide control plane whose launch dir is usually NOT a repo the
   * user works on (e.g. `$HOME`), so warming it is wasted work; per-workspace
   * on-demand indexing (kicked by the first query for a given repo) covers real
   * searches. Provisioning (binary/model/ORT + smoke) still runs so on-demand
   * indexing works later.
   */
  skipCwdIndex?: boolean
} = {}): Promise<void> {
  if (!semanticSearchOptedIn()) return
  if (_started) return
  _started = true

  // Wire the exit handlers up front so any colgrep child spawned during
  // provisioning (the smoke test) / indexing is reaped on shutdown.
  registerColbertExitHandlers()

  // Provision (binary/model/ORT + smoke). Best-effort.
  let provisioned: boolean
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
  // still gives it its bounded retries). Also skipped entirely under `serve`
  // (see `skipCwdIndex`).
  if (opts.skipCwdIndex) return
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

/**
 * One-line operator warning when this workspace's semantic index is sitting in
 * a terminal `failed` state, or `null` when there is nothing to say.
 *
 * This exists because the failure mode that motivated it was SILENCE: semantic
 * search degraded to lexical on a real repo for an unknown period — possibly
 * weeks — and nobody noticed, because the only signals were a `notice` string
 * the model reads and a `consola.debug` the file logger drops. Neither reaches
 * a human. The launcher writes this to stderr next to the readiness line so a
 * degraded capability is visible at the moment the user starts a session.
 *
 * `logsToFile` says where the failure detail actually went. `claude` and
 * `codex` call `enableFileLogging()`, which redirects warnings to
 * ERROR_LOG_PATH; `start` does not, so its warnings stay on the terminal and
 * pointing at the file would send the operator to a stale or absent one.
 *
 * Deliberately advisory and best-effort: lexical search still works, so this
 * must never block or fail a launch.
 */
export async function colbertDegradedWarning(
  cwd?: string,
  opts: { logsToFile?: boolean } = {},
): Promise<string | null> {
  // Only the explicit opt-OUT suppresses this. Deliberately NOT gated on
  // `colbertSearchEnabled()`: that predicate is false whenever the artifacts
  // are missing or the smoke test failed, which is itself a degraded state
  // worth reporting. Gating on it would silence the warning in some of the
  // very cases it exists for. A workspace with no `failed` meta stays silent
  // regardless, so an un-provisioned machine is not spammed.
  if (!semanticSearchOptedIn()) return null
  try {
    // Resolve the cwd HERE rather than at the call sites: the launchers are
    // unit-tested against a mocked `node:process` that supplies only the
    // fields they use, and reading `process.cwd()` in three launchers would
    // make an advisory banner able to break a launch path.
    const target = cwd ?? process.cwd()
    const meta = await readColbertMeta(target)
    if (!meta || meta.status !== "failed") return null
    const cls = meta.failureClass ?? "error"
    const where =
      opts.logsToFile ? `See ${PATHS.ERROR_LOG_PATH}` : "See the proxy log output"
    // `stuck` is the one class with an operator-actionable knob: a genuinely
    // huge repo can trip the stall watchdog, and raising it is the remedy.
    const hint =
      cls === "stuck" ?
        " For a very large repo, raise GH_ROUTER_COLBERT_INIT_STALL_MS / GH_ROUTER_COLBERT_INIT_TIMEOUT_MS."
      : ""
    return (
      `Semantic search DEGRADED for this workspace (colbert: ${cls}) — `
      + `lexical code search still works. ${where}.${hint}`
    )
  } catch {
    return null
  }
}

export { runSemanticSearch } from "./runner"
