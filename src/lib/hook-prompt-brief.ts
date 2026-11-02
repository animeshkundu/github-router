/**
 * Server-side prompt brief, for the Pi hook channel.
 *
 * The Claude Code `UserPromptSubmit` hook (`src/internal-prompt-submit.ts`)
 * runs in its OWN process, so it builds `PromptSubmitV2IO` and
 * `CheapestRewriteIO` itself and reaches the proxy's model + search surfaces
 * over loopback HTTP. The Pi extension cannot do any of that: it is a
 * generated STRING executed inside the Pi CLI, whose only imports are
 * `typebox` and `node:child_process`. So for Pi the SAME decision is produced
 * HERE, inside the proxy, behind a hook-nonce-authenticated MCP tool
 * (`prompt_brief`, group `search`) that the generated extension calls over the
 * channel it already speaks.
 *
 * What is shared, deliberately: `decidePromptSubmitV2` — the findings
 * surfacing, the search tip, the triviality gate, the one-shot Sol rewrite and
 * the Luna scope fallback are the hook's decision logic, not a Pi copy of it.
 * The store helpers (`fileFindingsStore` / `fileLastPromptStore` /
 * `fileRewriteFlagStore`) and the static pack are the same ones
 * `internal-prompt-submit` wires, so the two clients cannot drift. Only the IO
 * differs, because only the IO differs by process.
 *
 * What is NOT shared: the prose. The decision is identical, but its nouns are
 * not — Claude Code steers at `/gh-research` + `/gh-orchestrate` and names its
 * search tool `mcp__search__code`, while Pi has a `subagent` roster and
 * `gh-router-`-prefixed MCP keys. Those strings ride in as
 * `PromptProseOverrides`.
 *
 * `infer` / `inferSol` are INJECTED rather than imported. This module must not
 * import `~/routes/mcp/handler` (it is reached from `peer-mcp-personas`, which
 * that module imports), and the injection also keeps the suites free of any
 * Copilot mock.
 *
 * Fail-open by construction: any failure returns `""` and never throws. A brief
 * that cannot be produced must cost the caller nothing but latency — the same
 * posture the Claude hook takes.
 */

import type { CheapestRewriteIO } from "./cheapest-prompt-rewrite"
import { isCheapestRewriteDisabledEnv } from "./cheapest-prompt-rewrite"
import { parseBoolEnv } from "./exec"
import {
  decidePromptSubmitV2,
  type PromptProseOverrides,
  type PromptSubmitV2IO,
} from "./orchestration/prompt-submit-hook"
import {
  fileFindingsStore,
  fileLastPromptStore,
  fileRewriteFlagStore,
  stopReviewStateDir,
} from "./orchestration/stop-gate-policy"
import { buildStaticPack } from "./static-context-pack"
import { runUnifiedCodeSearch } from "./unified-code-search"

/**
 * Pi's native MCP servers are always `gh-router-`-prefixed
 * (`PI_MCP_SERVER_PREFIX`, so a user's own `search` entry can never shadow
 * one), which puts the search group under a different tool name than the bare
 * key Claude Code resolves.
 */
export const PI_PROMPT_SEARCH_TOOL = "mcp__gh-router-search__code"

/**
 * Model + effort for the scope inference. Deliberately the same pair the
 * Claude hook uses (`src/internal-prompt-submit.ts`), so one prompt gets one
 * quality of scope note regardless of client.
 */
export const PI_PROMPT_SCOPE_MODEL = "gpt-6-luna"
export const PI_PROMPT_SCOPE_EFFORT = "high" as const

/**
 * Fail-open goal, injected when the grounded note times out or misses. Pi has
 * no `/gh-research` or `/gh-orchestrate` skills, so this names what Pi actually
 * has: search-first, then the `subagent` roster.
 */
export const PI_PROMPT_STEER_GOAL =
  "GOAL (advisory): for a non-trivial task, FIRST saturate your understanding of the "
  + "code it touches — search before reading broadly, and verify the load-bearing "
  + "claims against the actual code — and do not plan or write code until that is "
  + "done. THEN, for an implementation or change task, delegate the separable pieces "
  + "through the `subagent` tool (Explore for recon, General-Purpose for scoped "
  + "implementation, reviewer for verification) instead of doing everything inline. "
  + "Skip both for a trivial ask; you may decline if they do not fit."

/** Large-task escalation sentence inside the scope note, in Pi's terms. */
export const PI_PROMPT_SCOPE_ADVICE =
  "Consider delegating: Explore first to saturate understanding, then General-Purpose for the implementation."

/** The prose set every Pi brief uses. One object so the three strings cannot
 *  drift apart across call sites. */
export const PI_PROMPT_PROSE: PromptProseOverrides = {
  searchToolName: PI_PROMPT_SEARCH_TOOL,
  fallbackGoal: PI_PROMPT_STEER_GOAL,
  scopeAdvice: PI_PROMPT_SCOPE_ADVICE,
}

/** One grounding search, rendered compactly. "" on any failure. */
async function searchText(
  query: string,
  mode: "lexical" | "semantic",
  workspace: string,
  signal?: AbortSignal,
): Promise<string> {
  try {
    const result = await runUnifiedCodeSearch(
      { query, workspace, mode, limit: 10, summary: false },
      signal,
    )
    return result.results
      .slice(0, 10)
      .map((hit) => `${hit.file}:${hit.line}\n${hit.snippet}`)
      .join("\n\n")
  } catch {
    return ""
  }
}

/**
 * Both signals abort the returned one, so a cancelled MCP request stops the
 * enrichment even though the orchestrator only knows about its own controller.
 */
function mergeSignals(
  a: AbortSignal | undefined,
  b: AbortSignal | undefined,
): AbortSignal | undefined {
  if (!a) return b
  if (!b) return a
  const controller = new AbortController()
  if (a.aborted || b.aborted) {
    controller.abort()
    return controller.signal
  }
  a.addEventListener("abort", () => controller.abort(), { once: true })
  b.addEventListener("abort", () => controller.abort(), { once: true })
  return controller.signal
}

export interface PiPromptBriefInput {
  /** The user prompt, verbatim. */
  prompt: string
  /** Pi session id. Keys the one-shot rewrite flag and the findings store. */
  sessionId: string
  /** Absolute workspace to search. Empty = no brief (nothing to ground in). */
  workspace: string
  /** Launch profile id; only the cheapest family enables the Sol rewrite. */
  profile: string
  searchEnabled: boolean
  bluebirdEnabled: boolean
  /** Test seam; defaults to the live `GH_ROUTER_DISABLE_PROMPT_STEER` opt-out. */
  steerEnabled?: boolean
  /** Test seam; defaults to the live `GH_ROUTER_DISABLE_CHEAPEST_REWRITE`. */
  rewriteDisabled?: boolean
  /** The MCP request's abort signal. */
  signal?: AbortSignal
  /** One non-streaming Luna scope inference. Injected to keep this module
   *  cycle-free (see the module header). */
  infer: (system: string, user: string, signal?: AbortSignal) => Promise<string>
  /** One non-streaming Sol rewrite call (cheapest family only). */
  inferSol: (system: string, user: string, signal?: AbortSignal) => Promise<string>
}

/**
 * Produce the advisory block for one Pi prompt. Returns `""` when there is
 * nothing to inject — an empty string is the ordinary answer (trivial prompt,
 * no findings, steer disabled) and is never an error.
 *
 * The Claude hook additionally resets the Stop-gate's per-prompt block budget
 * from `decision.resetSession`. Pi has no Stop gate, so that field is dropped
 * here rather than plumbed to a store nothing reads.
 */
export async function runPiPromptBrief(
  input: PiPromptBriefInput,
): Promise<string> {
  const workspace = input.workspace.trim()
  const sessionId = input.sessionId.trim()
  // No workspace means the grounding search would run against the proxy's cwd,
  // and no session id means the one-shot flag and the findings store have no
  // key. Both are refusals, not failures: inject nothing.
  if (workspace.length === 0 || sessionId.length === 0) return ""

  const steerEnabled =
    input.steerEnabled ??
    (parseBoolEnv(process.env.GH_ROUTER_DISABLE_PROMPT_STEER) !== true)
  const rewriteDisabled = input.rewriteDisabled ?? isCheapestRewriteDisabledEnv()

  const stateDir = stopReviewStateDir()
  const io: PromptSubmitV2IO = {
    searchCode: (query, mode, signal) =>
      searchText(query, mode, workspace, mergeSignals(signal, input.signal)),
    infer: (system, user, signal) =>
      input.infer(system, user, mergeSignals(signal, input.signal)),
    readFindings: (sid) => fileFindingsStore(stateDir).read(sid),
    clearFindings: (sid) => fileFindingsStore(stateDir).clear(sid),
    storePrompt: (sid, prompt) => fileLastPromptStore(stateDir).write(sid, prompt),
  }
  const rewrite: CheapestRewriteIO = {
    searchCode: (query, mode, signal) =>
      searchText(query, mode, workspace, mergeSignals(signal, input.signal)),
    inferSol: (system, user, signal) =>
      input.inferSol(system, user, mergeSignals(signal, input.signal)),
    staticPack: async () => buildStaticPack(workspace),
    hasRewriteRun: (sid) => fileRewriteFlagStore(stateDir).hasRun(sid),
    markRewriteRun: (sid) => fileRewriteFlagStore(stateDir).markRun(sid),
  }

  try {
    const decision = await decidePromptSubmitV2({
      stdin: JSON.stringify({ session_id: sessionId, prompt: input.prompt }),
      steerEnabled,
      io,
      searchEnabled: input.searchEnabled,
      bluebirdEnabled: input.bluebirdEnabled,
      profile: input.profile,
      rewriteDisabled,
      rewrite,
      prose: PI_PROMPT_PROSE,
    })
    return decision.inject.trim()
  } catch {
    // `decidePromptSubmitV2` already fails open internally; this is the belt
    // for anything outside its try (a throwing store read, say).
    return ""
  }
}
