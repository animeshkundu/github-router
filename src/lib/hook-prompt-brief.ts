/**
 * Server-side cheapest-profile prompt brief, for the hook channel.
 *
 * The Claude Code `UserPromptSubmit` hook (`src/internal-prompt-submit.ts`)
 * runs in its OWN process, so it builds `CheapestRewriteIO` itself and reaches
 * the proxy's model + search surfaces over loopback HTTP. The Pi extension
 * cannot do any of that: it is a generated STRING executed inside the Pi CLI,
 * whose only imports are `typebox` and `node:child_process`. So for Pi the
 * same brief is produced HERE, inside the proxy, behind a hook-nonce-
 * authenticated MCP tool (`prompt_brief`, group `search`) that the generated
 * extension calls over the channel it already speaks.
 *
 * What is shared, deliberately: `runCheapestRewrite` and every constant it
 * needs (`isCheapestRewriteEligible`, `resolveRewriteTurnBudget`, the caps,
 * `wrapLunaBrief`, the `DEEP_GROUNDING_FLAG` / `NEED_MORE:` protocol) come from
 * `./cheapest-prompt-rewrite`, and the static context pack comes from
 * `./static-context-pack`. Nothing about the rewrite itself is reimplemented
 * here — only the IO, because only the IO differs by process.
 *
 * `infer` is INJECTED rather than imported. This module must not import
 * `~/routes/mcp/handler` (it is reached from `peer-mcp-personas`, which that
 * module imports), and the injection also keeps the suites free of any Copilot
 * mock. The handler supplies `dispatchModelCall` through a dynamic import.
 *
 * Fail-open by construction: every miss returns `{brief: null}` with a reason
 * and never throws. A brief that cannot be produced must cost the caller
 * nothing but latency — the same posture the Claude hook takes.
 */

import type { CheapestRewriteIO } from "./cheapest-prompt-rewrite"
import {
  isCheapestRewriteDisabledEnv,
  isCheapestRewriteEligible,
  runCheapestRewrite,
} from "./cheapest-prompt-rewrite"
import { isNonTrivialPrompt } from "./orchestration/prompt-submit-hook"
import { fileRewriteFlagStore, stopReviewStateDir } from "./orchestration/stop-gate-policy"
import { buildStaticPack } from "./static-context-pack"
import { runUnifiedCodeSearch } from "./unified-code-search"

/** Why no brief was produced. Diagnostic only — never surfaced to the model. */
export type HookPromptBriefReason =
  | "ok"
  | "disabled"
  | "not-eligible"
  | "already-run"
  | "no-workspace"
  | "no-session"
  | "timed-out"
  | "miss"

export interface HookPromptBriefResult {
  /** The wrapped, additive brief; null on any decline or miss. */
  brief: string | null
  reason: HookPromptBriefReason
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
 * Produce the cheapest-profile brief for one prompt.
 *
 * `profile` is the launch profile id; only the cheapest family
 * (`cheapest`/`cheapest2`) is eligible, matching
 * the Claude hook exactly (the launcher exports `GH_ROUTER_PROFILE` into the
 * hook process there, and the launch registry carries it here). The one-shot
 * flag is keyed on `sessionId` and marked on ATTEMPT, so a session that spends
 * the rewrite and misses does not retry on every later prompt.
 */
export async function runHookPromptBrief(input: {
  prompt: string
  sessionId: string
  workspace: string
  profile: string
  searchEnabled: boolean
  bluebirdEnabled: boolean
  /** Test seam; defaults to the live env opt-out. */
  steerEnabled?: boolean
  rewriteDisabled?: boolean
  signal?: AbortSignal
  /** One non-streaming model call. Injected to keep this module cycle-free. */
  infer: (system: string, user: string, signal?: AbortSignal) => Promise<string>
}): Promise<HookPromptBriefResult> {
  const steerEnabled = input.steerEnabled ?? true
  const rewriteDisabled = input.rewriteDisabled ?? isCheapestRewriteDisabledEnv()

  if (rewriteDisabled) return { brief: null, reason: "disabled" }
  if (
    !isCheapestRewriteEligible({
      profile: input.profile,
      promptIsNonTrivial: isNonTrivialPrompt(input.prompt),
      steerEnabled,
      rewriteDisabled,
    })
  ) {
    return { brief: null, reason: "not-eligible" }
  }
  const workspace = input.workspace.trim()
  if (workspace.length === 0) return { brief: null, reason: "no-workspace" }
  const sessionId = input.sessionId.trim()
  if (sessionId.length === 0) return { brief: null, reason: "no-session" }

  const flags = fileRewriteFlagStore(stopReviewStateDir())
  try {
    if (await flags.hasRun(sessionId)) return { brief: null, reason: "already-run" }
  } catch {
    // An unreadable flag store must not disable the feature; the worst case is
    // one extra rewrite, and the rewrite is bounded and one call deep.
  }
  try {
    await flags.markRun(sessionId)
  } catch {
    /* best-effort: see above */
  }

  const io: CheapestRewriteIO = {
    searchCode: (query, mode, signal) => searchText(query, mode, workspace, signal),
    inferSol: (system, user, signal) => input.infer(system, user, signal),
    staticPack: async () => buildStaticPack(workspace),
    hasRewriteRun: () => flags.hasRun(sessionId),
    markRewriteRun: () => flags.markRun(sessionId),
  }

  const { brief, timedOut } = await runCheapestRewrite({
    prompt: input.prompt,
    searchEnabled: input.searchEnabled,
    bluebirdEnabled: input.bluebirdEnabled,
    io,
  })
  if (brief && brief.trim().length > 0) return { brief, reason: "ok" }
  return { brief: null, reason: timedOut ? "timed-out" : "miss" }
}
