/**
 * octocode sidecar — public entry points (ColBERT replacement).
 *
 * `provisionAndIndexOctocode()` mirrors the old
 * `provisionAndIndexColbert()` call shape so launchers need a one-line
 * swap: fire-and-forget binary ensure, never throws.
 */

import consola from "consola";

import { parseBoolEnv } from "../exec";
import { state } from "../state";

import { ensureOctocode, octocodeArtifactsPresent } from "./binary";
import { ensureGlobalConfig } from "./config";

export {
  ensureOctocode,
  octocodeArtifactsPresent,
  octocodeBinaryPath,
} from "./binary";
export type { OctocodeBinaryResult, OctocodeBinaryStatus } from "./binary";
export {
  DEFAULT_CODE_EMBEDDING_MODEL,
  ensureGlobalConfig,
  globalConfigPath,
  mapEmbeddingModel,
  readGlobalConfig,
} from "./config";
export { detectLspForWorkspace } from "./lsp-detector";
export type { LspDetection } from "./lsp-detector";
export { ensureLspServers, ensureLspServersBackground } from "./lsp-installer";
export type { LspInstallResult } from "./lsp-installer";
export {
  OCTOCODE_TOOL_MAP,
  callOctocodePassthrough,
  isOctocodeTool,
  octocodeEmbeddings,
  octocodeSemanticSearch,
} from "./proxy";
export type {
  OctocodeEmbeddingResult,
  OctocodeSemanticHit,
  OctocodeSemanticResult,
  OctocodeToolName,
} from "./proxy";
export { canonicalDir, isServeMode, resolveWorkspace } from "./workspace-detector";
export {
  MAX_OCTOCODE_PROCESSES,
  HEALTH_CHECK_MS,
  callOctocodeTool,
  getOctocodeEntry,
  listOctocodeTools,
  octocodePoolSize,
  registerOctocodeExitHandlers,
  shutdownOctocodeAll,
} from "./workspace-manager";

/**
 * True when the operator opted in via `--search`
 * (`state.searchEnabled`) or `GH_ROUTER_ENABLE_SEMANTIC_SEARCH=1`.
 * Same flag shape as ColBERT so CLI/env stay compatible.
 */
export function octocodeSearchOptedIn(): boolean {
  if (parseBoolEnv(process.env.GH_ROUTER_DISABLE_SEMANTIC_SEARCH) === true) {
    return false;
  }
  return (
    state.searchEnabled === true ||
    process.env.GH_ROUTER_ENABLE_SEMANTIC_SEARCH === "1"
  );
}

export function octocodeSearchEnabled(): boolean {
  return octocodeSearchOptedIn() && octocodeArtifactsPresent();
}

let _started = false;

/** Fire-and-forget binary ensure + config. Never throws. */
export async function provisionAndIndexOctocode(): Promise<void> {
  if (!octocodeSearchOptedIn()) return;
  if (_started) return;
  _started = true;
  try {
    const res = await ensureOctocode();
    if (res.status !== "ready") {
      consola.debug(`octocode: provision not ready (${res.status}: ${res.reason ?? ""})`);
      return;
    }
    await ensureGlobalConfig().catch(() => {});
    // No eager indexing: octocode indexes lazily on first query per
    // workspace (its own debounced init), same as the old background-init
    // contract but without router-owned bookkeeping.
  } catch (err) {
    consola.debug("octocode: provision threw (swallowed):", err);
  }
}

/** Test-only: reset the once-guard. */
export function __resetOctocodeStartedForTests(): void {
  _started = false;
}
