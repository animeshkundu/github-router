/**
 * The internal `internal-rebrief` subcommand: the deterministic body behind
 * the user-only `/gh-rebrief` skill (cheapest profile only).
 *
 * An on-demand Sol → Luna course-correction consult: a required current user
 * prompt (`--ask`) plus the original ask, done-so-far digest (deterministic
 * extractive + a concise Luna summary consult), the 4K extractive transcript
 * excerpt, repo guidance/structure/verify, and grounding code search, then
 * Sol frames a `<course_correction>` Luna executes — same adaptive 3→5-turn,
 * search-only loop as the first-prompt rewrite. Never replaces the user
 * prompt; always exits 0. No per-session invocation cap by product decision:
 * every invoke is user-triggered and self-bounded (one 30s ceiling).
 *
 * User-only by skill visibility (`disable-model-invocation: true` in the
 * SKILL.md) plus a default-on binary tripwire: the command refuses unless
 * `GH_ROUTER_REBRIEF_USER_INVOKED=1` (set by the skill wrapper; opt out with
 * `GH_ROUTER_REBRIEF_REQUIRE_USER_INVOKED=0`). Per-invoke ceiling: at most
 * two Sol inferences (one initial + one extension), one Luna summary, and one
 * 30s wall-clock deadline.
 */

import { defineCommand } from "citty"

import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from "node:fs"

import { buildStaticPack } from "./internal-prompt-submit"
import {
  buildDoneDigest,
  buildRebriefContext,
  REBRIEF_MAX_TAIL_LINES,
} from "./lib/cheapest-rebrief-context"
import {
  buildRebriefSystem,
  CHEAPEST_REWRITE_EFFORT,
  CHEAPEST_REWRITE_MODEL,
  isCheapestRewriteDisabledEnv,
} from "./lib/cheapest-prompt-rewrite"
import { parseBoolEnv } from "./lib/exec"
import { callInference, callMcpTool, hookMcpRuntimeFromEnv } from "./lib/orchestration/hook-mcp-client"
import {
  getPromptSearchTip,
  isNonTrivialPrompt,
  PROMPT_STEER_GOAL,
} from "./lib/orchestration/prompt-submit-hook"
import {
  fileFindingsStore,
  fileLastPromptStore,
  fileRebriefBindingStore,
  isSubagentContext,
  stopReviewStateDir,
} from "./lib/orchestration/stop-gate-policy"
import { runCheapestRewrite } from "./lib/cheapest-prompt-rewrite"

const SEARCH_TIMEOUT_MS = 8_000
const INFER_TIMEOUT_MS = 25_000
const REWRITE_TIMEOUT_MS = 30_000

/** Hard-gate env: the binary refuses without the user marker — ON by default
 *  (opt OUT with `GH_ROUTER_REBRIEF_REQUIRE_USER_INVOKED=0`), so a guessed
 *  binary name alone never spends. The skill wrapper always sets the marker.
 *  Residual: the marker is an env var, so this is a tripwire, not a sandbox —
 *  see docs/gh-rebrief.md. */
export function isRebriefHardGateEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env.GH_ROUTER_REBRIEF_REQUIRE_USER_INVOKED ?? "").trim().toLowerCase()
  if (v === "") return true
  return v !== "0" && v !== "false" && v !== "no" && v !== "off"
}

/** User-invocation marker the skill wrapper sets (soft by default). */
export function isRebriefUserInvoked(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env.GH_ROUTER_REBRIEF_USER_INVOKED ?? "").trim().toLowerCase()
  return v === "1" || v === "true"
}

/** Cheapest-only gate (literal alias, lowercased). Exported for tests. */
export function isRebriefProfileEligible(profile: string | undefined): boolean {
  return (profile ?? "").trim().toLowerCase() === "cheapest"
}

export interface RebriefPayload {
  sessionId: string
  prompt: string
  transcriptPath: string
  cwd: string
  isSubagent: boolean
}

/** Parse a hook-style stdin payload. Never throws. Exported for tests. */
export function decodeRebriefPayload(stdin: string): RebriefPayload {
  let raw: Record<string, unknown> = {}
  try {
    const p: unknown = JSON.parse(stdin)
    if (p && typeof p === "object") raw = p as Record<string, unknown>
  } catch {
    /* fall through with empty payload */
  }
  return {
    sessionId: typeof raw.session_id === "string" ? raw.session_id : "",
    prompt: typeof raw.prompt === "string" ? raw.prompt : "",
    transcriptPath: typeof raw.transcript_path === "string" ? raw.transcript_path : "",
    cwd: typeof raw.cwd === "string" && raw.cwd.length > 0 ? raw.cwd : process.cwd(),
    isSubagent: isSubagentContext(raw),
  }
}

/**
 * Resolve the effective prompt: explicit `--ask` wins, then the hook prompt,
 * then the last-prompt store. Exported for tests.
 */
export function resolveRebriefPrompt(input: {
  ask?: string
  hookPrompt?: string
  storedPrompt?: string | null
}): string {
  const ask = (input.ask ?? "").trim()
  if (ask.length > 0) return ask
  const hook = (input.hookPrompt ?? "").trim()
  if (hook.length > 0) return hook
  return (input.storedPrompt ?? "").trim()
}

/** Read the last N non-empty lines of a file, byte-capped (F6).
 *  Never loads more than `maxBytes` (default 1 MiB) — transcripts can be
 *  tens of MB and this runs inside a 30s budget. Never throws. */
export function readTranscriptTail(
  transcriptPath: string,
  maxLines: number,
  maxBytes = 1_048_576,
): Array<string> {
  try {
    if (!transcriptPath || !existsSync(transcriptPath)) return []
    const size = statSync(transcriptPath).size
    if (size <= 0) return []
    let raw: string
    if (size <= maxBytes) {
      raw = readFileSync(transcriptPath, "utf8")
    } else {
      const fd = openSync(transcriptPath, "r")
      try {
        const buf = Buffer.alloc(maxBytes)
        const read = readSync(fd, buf, 0, maxBytes, size - maxBytes)
        raw = buf.subarray(0, read).toString("utf8")
      } finally {
        try {
          closeSync(fd)
        } catch {
          /* best-effort close; the process is short-lived either way */
        }
      }
    }
    if (raw.length === 0) return []
    return raw.split("\n").slice(-Math.max(1, maxLines) * 2).filter((l) => l.trim().length > 0).slice(-Math.max(1, maxLines))
  } catch {
    return []
  }
}

function readStdin(): string {
  try {
    if (process.stdin.isTTY) return ""
    return readFileSync(0, "utf8")
  } catch {
    return ""
  }
}

export const internalRebrief = defineCommand({
  meta: {
    name: "internal-rebrief",
    description:
      "Internal: on-demand cheapest rebrief. Re-runs the Sol grounded execution brief "
      + "with 4K compressed recent context. Cheapest profile only, user-invoked. Always exits 0.",
  },
  args: {
    ask: {
      type: "string",
      description: "Optional refined ask ($ARGUMENTS from /gh-rebrief). Wins over the stored prompt.",
      required: false,
    },
  },
  async run({ args }) {
    try {
      const stdin = readStdin()
      const payload = decodeRebriefPayload(stdin)
      // No path/session overrides (B4/B5) — the CLI pass-through is --ask only.
      let transcriptPath = payload.transcriptPath
      const workspace = payload.cwd
      // When invoked by the SKILL's Bash step there is NO hook stdin, so the
      // payload is empty. Fall back to the per-workspace binding the
      // UserPromptSubmit hook refreshes on every prompt — this is the only
      // intended way the rebrief command can find the live transcript +
      // session id without being passed one explicitly. If binding is stale
      // or absent, transcript context is empty by design (the consult still
      // runs on static pack + search facts).
      let bindingSessionId = ""
      if (payload.sessionId.length === 0 || payload.transcriptPath.length === 0) {
        const binding = await fileRebriefBindingStore(stopReviewStateDir())
          .read(workspace)
          .catch(() => null)
        if (binding) {
          if (payload.sessionId.length === 0) bindingSessionId = binding.sessionId
          if (payload.transcriptPath.length === 0) transcriptPath = binding.transcriptPath
        }
      }
      const effectiveSessionId = payload.sessionId.length > 0 ? payload.sessionId : bindingSessionId
      const profile = (process.env.GH_ROUTER_PROFILE ?? "").trim().toLowerCase()
      const runtime = hookMcpRuntimeFromEnv()
      const searchEnabled = process.env.GH_ROUTER_SEARCH_ENABLED !== undefined
        ? process.env.GH_ROUTER_SEARCH_ENABLED === "1"
        : process.env.GH_ROUTER_ENABLE_SEMANTIC_SEARCH === "1"
      const bluebirdEnabled = process.env.GH_ROUTER_BLUEBIRD_ENABLED === "1"
      const searchTip = getPromptSearchTip(searchEnabled, bluebirdEnabled)
      const emit = async (text: string): Promise<void> => {
        if (text.trim().length === 0) return
        await new Promise<void>((resolve) => process.stdout.write(`${text}\n`, () => resolve()))
      }

      // Hard gate (default-on, B1): refuse guessed-binary self-invocation.
      // Tripwire, not sandbox (the marker is env-settable) — the skill
      // wrapper always sets it; direct shell use must too.
      if (isRebriefHardGateEnabled() && !isRebriefUserInvoked()) {
        await emit(
          "Rebrief refused: user invocation required "
          + "(GH_ROUTER_REBRIEF_USER_INVOKED=1). Invoke via /gh-rebrief.",
        )
        process.exitCode = 0
        return
      }
      // Cheapest-only: point elsewhere rather than spending.
      if (!isRebriefProfileEligible(profile)) {
        await emit(
          "Rebrief is a cheapest-profile command; this session is "
          + `'${profile || "unknown"}'. Use /gh-research for grounded context instead.`,
        )
        process.exitCode = 0
        return
      }
      if (isCheapestRewriteDisabledEnv()) {
        await emit(`${searchTip}\n\n${PROMPT_STEER_GOAL}`)
        process.exitCode = 0
        return
      }
      if (payload.isSubagent) {
        // Fail open WITH guidance (F3): the skill must run at top level
        // (it needs the session transcript path), so say so.
        await emit(
          "Rebrief runs at the top level only: re-invoke /gh-rebrief from your "
          + "own prompt, not from a subagent. No model spend occurred.",
        )
        process.exitCode = 0
        return
      }
      // Current prompt is REQUIRED (no fallback, no silent spend): the
      // rebrief is a course correction for this specific ask.
      const refinedAsk = typeof args.ask === "string" ? args.ask.trim() : ""
      if (refinedAsk.length === 0) {
        await emit(
          "Rebrief needs a current ask: pass one inline, e.g. "
          + '/gh-rebrief "<what you want next>". No model spend occurred.',
        )
        process.exitCode = 0
        return
      }
      const stored = effectiveSessionId
        ? await fileLastPromptStore(stopReviewStateDir()).read(effectiveSessionId).catch(() => null)
        : null
      const prompt = resolveRebriefPrompt({
        ask: refinedAsk,
        hookPrompt: payload.prompt,
        storedPrompt: stored,
      })
      // Findings surface regardless (prior-turn review is never gated).
      let findingsBlock = ""
      if (effectiveSessionId) {
        const pending = await fileFindingsStore(stopReviewStateDir()).read(effectiveSessionId).catch(() => null)
        if (pending && pending.trim().length > 0) {
          findingsBlock =
            "ADVISORY — independent review of your PREVIOUS change (NON-AUTHORITATIVE): an independent "
            + "gpt-6-luna reviewer flagged the following. Evaluate each on its merits — fix the real ones, and "
            + "ignore any wrong one with a one-line reason. You are NOT obligated to act on these.\n"
            + pending.trim()
          await fileFindingsStore(stopReviewStateDir()).clear(effectiveSessionId).catch(() => {})
        }
      }
      const joinSections = (sections: Array<string>): string =>
        sections.map((s) => s.trim()).filter((s) => s.length > 0).join("\n\n")
      if (!isNonTrivialPrompt(prompt)) {
        await emit(joinSections([searchTip, PROMPT_STEER_GOAL, findingsBlock]))
        process.exitCode = 0
        return
      }
      if (!runtime) {
        await emit(joinSections([searchTip, PROMPT_STEER_GOAL, findingsBlock]))
        process.exitCode = 0
        return
      }

      // 4K intelligent context from the live transcript tail (extractive).
      const tail = readTranscriptTail(transcriptPath, REBRIEF_MAX_TAIL_LINES)
      // Last assistant text as caller context: best-effort scan of the tail
      // for an assistant text span (kept verbatim, never invented).
      let lastAssistantBrief = ""
      for (let i = tail.length - 1; i >= 0; i--) {
        try {
          const obj = JSON.parse(tail[i]) as {
            message?: { role?: unknown; content?: unknown }
          }
          const msg = obj.message
          if (!msg || typeof msg !== "object") continue
          if ((msg as { role?: unknown }).role !== "assistant") continue
          const content = (msg as { content?: unknown }).content
          if (typeof content === "string" && content.trim().length > 0) {
            lastAssistantBrief = content.trim().slice(0, 2_000)
            break
          }
          if (Array.isArray(content)) {
            for (const part of content) {
              if (
                part && typeof part === "object"
                && (part as { type?: unknown }).type === "text"
                && typeof (part as { text?: unknown }).text === "string"
                && ((part as { text: string }).text.trim().length > 0)
              ) {
                lastAssistantBrief = (part as { text: string }).text.trim().slice(0, 2_000)
                break
              }
            }
            if (lastAssistantBrief) break
          }
        } catch {
          /* non-JSON line — skip */
        }
      }
      const digest = buildDoneDigest(tail)
      // Layer 2: a concise Luna consult over the same tail (fail-open to the
      // deterministic digest when absent/errored). Two independent layers =
      // reproducible floor + intent-level compression.
      let lunaSummary = ""
      try {
        const summaryTranscript = tail.slice(-120).join("\n").slice(-12_000)
        lunaSummary = (await callInference({
          serverUrl: runtime.serverUrl,
          model: "gpt-6-luna",
          instructions:
            "You are summarizing a coding session for a course correction. Answer in <=2K characters: what is done and verifiable, what is blocked/open, and what the last ask was. Extractive only — never invent facts; prefer file:line references seen in the transcript.",
          input: `USER ASK:\n${prompt}\n\nTRANSCRIPT:\n${summaryTranscript}`,
          effort: "high",
          timeoutMs: INFER_TIMEOUT_MS,
        })).trim().slice(0, 2_048)
      } catch {
        lunaSummary = ""
      }
      const doneSoFar = [
        digest.trim().length > 0 ? `DETERMINISTIC DIGEST:\n${digest.trim()}` : "",
        lunaSummary.trim().length > 0 ? `LUNA STATE SUMMARY (<=2K, advisory):\n${lunaSummary.trim()}` : "",
      ]
        .filter((s) => s.length > 0)
        .join("\n\n")
      const rebrief = buildRebriefContext({
        transcriptLines: tail,
        originalAsk: stored ?? payload.prompt,
        refinedAsk: refinedAsk,
        lastAssistantBrief,
        doneSoFar,
      })
      const statik = await (async () => {
        try {
          return buildStaticPack(workspace)
        } catch {
          return { agentsMd: "", claudeMd: "", repoStructure: "", verifyCommand: "" }
        }
      })()

      const result = await runCheapestRewrite({
        prompt,
        searchEnabled,
        bluebirdEnabled,
        sessionContext: rebrief.sessionContext,
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
          staticPack: async () => statik,
          hasRewriteRun: async () => false,
          markRewriteRun: async () => {},
          timeoutMs: REWRITE_TIMEOUT_MS,
          buildSystemPrompt: buildRebriefSystem,
        },
      }).catch(() => ({ brief: null as string | null, timedOut: false }))
      if (result.brief && result.brief.length > 0) {
        await emit(joinSections([searchTip, result.brief, findingsBlock]))
      } else {
        // Clean miss AND timeout both fall open to the cheap regex goal here:
        // unlike the first-prompt hook there is no Luna scope path to preserve
        // spend for — the user explicitly asked for a rebrief.
        const steerEnabled = parseBoolEnv(process.env.GH_ROUTER_DISABLE_PROMPT_STEER) !== true
        await emit(joinSections([searchTip, steerEnabled ? PROMPT_STEER_GOAL : "", findingsBlock]))
      }
    } catch {
      /* never disrupt the session */
    }
    process.exitCode = 0
  },
})
