/**
 * The internal `internal-prompt-submit` subcommand: the executable a spawned
 * Claude Code session's `UserPromptSubmit` hook invokes (registered into the
 * mirrored settings.json by the launcher). It serves the front-end of the
 * floor-raising surface on one event:
 *   1. resets the Stop-gate's per-session block budget (making `maxBlocks`
 *      per-prompt);
 *   2. stashes the prompt + surfaces the prior turn's advisory review findings;
 *   3. for a non-trivial prompt, injects a GROUNDED, user-derived scope/goal
 *      note (one gpt-6-luna call at high effort over the prompt + grounding
 *      code search — local ColBERT when --search is on, Bluebird when
 *      --bluebird is on, lexical-only otherwise) — or, when the proxy URL/nonce
 *      isn't wired or anything errors,
 *      falls open to the v1 regex goal.
 *   4. on a cheapest-profile launch only, tries FIRST a Sol (gpt-5.6-sol,
 *      medium) rewrite of the prompt into a short structured LUNA BRIEF over
 *      the prompt + AGENTS.md/CLAUDE.md + repo structure + grounding search
 *      (adaptive 3 turns, up to 5 on Sol's deep-grounding flag) — additive,
 *      never replacing the user prompt — and falls back to (3) on any miss.
 *      One-shot per session (first non-trivial prompt only, marked on
 *      attempt even if Sol fails open). Opt out with
 *      GH_ROUTER_DISABLE_CHEAPEST_REWRITE=1.
 *
 * ALWAYS exits 0 (never blocks the prompt): the steer is additive context, and a
 * UserPromptSubmit hook that exit-2'd would refuse the user's prompt. The pure
 * v1 path (`decidePromptSubmit`) is the fail-open fallback; V2
 * (`decidePromptSubmitV2`) layers the grounded enrichment on top via injected IO.
 */

import { defineCommand } from "citty"

import { readdirSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import {
  CHEAPEST_REWRITE_EFFORT,
  CHEAPEST_REWRITE_GUIDANCE_CAP,
  CHEAPEST_REWRITE_MODEL,
  CHEAPEST_REWRITE_STRUCTURE_CAP,
  isCheapestRewriteDisabledEnv,
} from "./lib/cheapest-prompt-rewrite"
import { parseBoolEnv } from "./lib/exec"
import { callInference, callMcpTool, hookMcpRuntimeFromEnv } from "./lib/orchestration/hook-mcp-client"
import { fileBlockBudget } from "./lib/orchestration/stop-gate-hook"
import {
  decidePromptSubmit,
  decidePromptSubmitV2,
  type PromptSubmitDecision,
} from "./lib/orchestration/prompt-submit-hook"
import {
  fileFindingsStore,
  fileLastPromptStore,
  fileRewriteFlagStore,
  stopReviewStateDir,
} from "./lib/orchestration/stop-gate-policy"

/**
 * Read the hook payload from stdin SYNCHRONOUSLY (`readFileSync(0)`). An async
 * stdin read leaves an in-flight libuv FS request that, on Windows, races the
 * process teardown and trips a `uv_async_send` assertion; a synchronous read has
 * no such handle. Hooks always receive piped/redirected stdin, so this never
 * blocks (guarded against an interactive TTY, and any error -> "").
 */
function readStdin(): string {
  try {
    if (process.stdin.isTTY) return ""
    return readFileSync(0, "utf8")
  } catch {
    return ""
  }
}

/** Parse the session cwd from the payload — the workspace the grounding search
 *  runs in. Falls back to the process cwd. */
function workspaceFromStdin(stdin: string): string {
  try {
    const p: unknown = JSON.parse(stdin)
    if (p && typeof p === "object") {
      const cwd = (p as { cwd?: unknown }).cwd
      if (typeof cwd === "string" && cwd.length > 0) return cwd
    }
  } catch {
    /* fall through */
  }
  return process.cwd()
}

/** Per-call timeout for the grounding search (short — it must not stall the prompt). */
const SEARCH_TIMEOUT_MS = 8_000
/** Per-call timeout for the single scope/goal inference. */
const INFER_TIMEOUT_MS = 18_000
/**
 * Overall budget for the cheapest Sol rewrite (search + Sol, 3 turns default
 * with one adaptive extension to 5). Kept under the 45s host hook timeout
 * even when the Luna fallback enrichment runs afterwards (≈18s + ≈22s).
 */
const REWRITE_TIMEOUT_MS = 18_000

/** Read a text file best-effort, capped; missing/unreadable -> "". */
function readCappedFile(absPath: string, cap: number): string {
  try {
    return readFileSync(absPath, "utf8").slice(0, cap)
  } catch {
    return ""
  }
}

/**
 * Static repo context for the cheapest rewrite: AGENTS.md (preferred) +
 * CLAUDE.md fallback + top-level structure + package.json scripts snippet.
 * All synchronous (tiny reads) and capped; missing files yield "".
 */
export function buildStaticPack(workspace: string): { agentsMd: string; claudeMd: string; repoStructure: string } {
  const agentsMd = readCappedFile(path.join(workspace, "AGENTS.md"), CHEAPEST_REWRITE_GUIDANCE_CAP)
  const claudeMd = agentsMd.length > 0
    ? ""
    : readCappedFile(path.join(workspace, "CLAUDE.md"), CHEAPEST_REWRITE_GUIDANCE_CAP)
  let listing: string
  try {
    const entries = readdirSync(workspace, { withFileTypes: true })
      .slice(0, 60)
      .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
    listing = entries.join(", ")
  } catch {
    listing = ""
  }
  let pkgSnippet: string
  try {
    const raw = readFileSync(path.join(workspace, "package.json"), "utf8")
    const pkg = JSON.parse(raw) as { scripts?: Record<string, string>; dependencies?: Record<string, string> }
    const scripts = pkg.scripts ? Object.keys(pkg.scripts).slice(0, 20).join(", ") : ""
    const deps = pkg.dependencies ? Object.keys(pkg.dependencies).slice(0, 20).join(", ") : ""
    pkgSnippet = `scripts: [${scripts}] deps: [${deps}]`
  } catch {
    pkgSnippet = ""
  }
  const repoStructure = [`top-level: ${listing}`, pkgSnippet]
    .filter((s) => s.trim().length > 0 && s !== "top-level: ")
    .join("\n")
    .slice(0, CHEAPEST_REWRITE_STRUCTURE_CAP)
  return { agentsMd, claudeMd, repoStructure }
}

export const internalPromptSubmit = defineCommand({
  meta: {
    name: "internal-prompt-submit",
    description:
      "Internal: the UserPromptSubmit hook. Resets the Stop-gate per-prompt block "
      + "budget, surfaces prior-turn review findings, and injects a grounded advisory goal "
      + "for non-trivial prompts. Always exit 0.",
  },
  async run() {
    try {
      const stdin = readStdin()
      const steerEnabled = parseBoolEnv(process.env.GH_ROUTER_DISABLE_PROMPT_STEER) !== true
      // Search capability for tip/enrichment text. The launcher exports
      // GH_ROUTER_SEARCH_ENABLED ("1"/"0") from its resolved
      // `state.searchEnabled` before spawning the session, so this
      // short-lived hook process inherits the launch's capability even when
      // the opt-in came from the `--search` CLI flag (which otherwise would
      // not survive the process boundary). Falls back to the raw opt-in env
      // for standalone invocations.
      const searchEnabled = process.env.GH_ROUTER_SEARCH_ENABLED !== undefined
        ? process.env.GH_ROUTER_SEARCH_ENABLED === "1"
        : process.env.GH_ROUTER_ENABLE_SEMANTIC_SEARCH === "1"
      const bluebirdEnabled = process.env.GH_ROUTER_BLUEBIRD_ENABLED === "1"
      const runtime = hookMcpRuntimeFromEnv()

      let decision: PromptSubmitDecision
      if (runtime) {
        const workspace = workspaceFromStdin(stdin)
        // Cheapest-only Sol rewrite identity: the launcher exports
        // GH_ROUTER_PROFILE; only the literal "cheapest" alias enables the
        // rewrite branch (checked again inside decidePromptSubmitV2).
        const profile = (process.env.GH_ROUTER_PROFILE ?? "").trim().toLowerCase()
        const rewriteDisabled = isCheapestRewriteDisabledEnv()
        decision = await decidePromptSubmitV2({
          stdin,
          steerEnabled,
          searchEnabled,
          bluebirdEnabled,
          profile,
          rewriteDisabled,
          rewrite: {
            searchCode: async (query, mode, signal) => {
              const r = await callMcpTool({
                runtime,
                group: "search",
                tool: "code",
                args: { query, workspace, mode, limit: 10, summary: false },
                timeoutMs: SEARCH_TIMEOUT_MS,
                signal,
              })
              return r.isError ? "" : r.text
            },
            inferSol: (system, user, signal) =>
              callInference({
                serverUrl: runtime.serverUrl,
                model: CHEAPEST_REWRITE_MODEL,
                instructions: system,
                input: user,
                effort: CHEAPEST_REWRITE_EFFORT,
                timeoutMs: INFER_TIMEOUT_MS,
                signal,
              }),
            // Lazy: fs reads run only when the cheapest branch actually fires.
            staticPack: async () => buildStaticPack(workspace),
            // Session-keyed one-shot flag: first non-trivial prompt per
            // session spends the rewrite; later prompts use the Luna path.
            hasRewriteRun: (sid) => fileRewriteFlagStore(stopReviewStateDir()).hasRun(sid),
            markRewriteRun: (sid) => fileRewriteFlagStore(stopReviewStateDir()).markRun(sid),
            timeoutMs: REWRITE_TIMEOUT_MS,
          },
          io: {
            searchCode: async (query, mode, signal) => {
              const r = await callMcpTool({
                runtime,
                group: "search",
                tool: "code",
                args: { query, workspace, mode, limit: 10, summary: false },
                timeoutMs: SEARCH_TIMEOUT_MS,
                signal,
              })
              return r.isError ? "" : r.text
            },
            infer: (system, user, signal) =>
              callInference({
                serverUrl: runtime.serverUrl,
                model: "gpt-6-luna",
                instructions: system,
                input: user,
                effort: "high",
                timeoutMs: INFER_TIMEOUT_MS,
                signal,
              }),
            readFindings: (sid) => fileFindingsStore(stopReviewStateDir()).read(sid),
            clearFindings: (sid) => fileFindingsStore(stopReviewStateDir()).clear(sid),
            storePrompt: (sid, prompt) => fileLastPromptStore(stopReviewStateDir()).write(sid, prompt),
          },
        })
      } else {
        // Proxy URL/nonce not wired -> the LLM layer is off; use the pure v1 path.
        decision = decidePromptSubmit({ stdin, steerEnabled })
      }

      if (decision.resetSession) {
        // Same budget store the Stop hook uses, so a new prompt clears its count.
        await fileBlockBudget(path.join(tmpdir(), "gh-router-stopgate"))
          .reset(decision.resetSession)
          .catch(() => {})
      }
      if (decision.inject.length > 0) {
        await new Promise<void>((resolve) => process.stdout.write(`${decision.inject}\n`, () => resolve()))
      }
    } catch {
      /* never let the front-end hook disrupt a prompt */
    }
    // Natural exit (exit code 0): a hard process.exit() races libuv stdio teardown
    // on Windows. No handles are kept alive once the (aborted) enrichment settles,
    // so returning lets the process exit cleanly with code 0.
    process.exitCode = 0
  },
})
