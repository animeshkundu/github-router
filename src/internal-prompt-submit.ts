/**
 * The internal `internal-prompt-submit` subcommand: the executable a spawned
 * Claude Code session's `UserPromptSubmit` hook invokes (registered into the
 * mirrored settings.json by the launcher). It serves the front-end of the
 * floor-raising surface on one event:
 *   1. resets the Stop-gate's per-session block budget (making `maxBlocks`
 *      per-prompt);
 *   2. stashes the prompt + surfaces the prior turn's advisory review findings;
 *   3. for a non-trivial prompt, injects a GROUNDED, user-derived scope/goal
 *      note (one gpt-5.5 call over the prompt + a parallel lexical+semantic code
 *      search) — or, when the proxy URL/nonce isn't wired or anything errors,
 *      falls open to the v1 regex goal.
 *
 * ALWAYS exits 0 (never blocks the prompt): the steer is additive context, and a
 * UserPromptSubmit hook that exit-2'd would refuse the user's prompt. The pure
 * v1 path (`decidePromptSubmit`) is the fail-open fallback; V2
 * (`decidePromptSubmitV2`) layers the grounded enrichment on top via injected IO.
 */

import { defineCommand } from "citty"

import { tmpdir } from "node:os"
import path from "node:path"

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
  stopReviewStateDir,
} from "./lib/orchestration/stop-gate-policy"

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  try {
    for await (const c of process.stdin) chunks.push(c as Buffer)
  } catch {
    /* no stdin -> empty; the decision fns tolerate it */
  }
  return Buffer.concat(chunks).toString("utf8")
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
      const stdin = await readStdin()
      const steerEnabled = parseBoolEnv(process.env.GH_ROUTER_DISABLE_PROMPT_STEER) !== true
      const runtime = hookMcpRuntimeFromEnv()

      let decision: PromptSubmitDecision
      if (runtime) {
        const workspace = workspaceFromStdin(stdin)
        decision = await decidePromptSubmitV2({
          stdin,
          steerEnabled,
          io: {
            searchCode: async (query, mode) => {
              const r = await callMcpTool({
                runtime,
                group: "search",
                tool: "code",
                args: { query, workspace, mode, limit: 10, summary: false },
                timeoutMs: SEARCH_TIMEOUT_MS,
              })
              return r.isError ? "" : r.text
            },
            infer: (system, user) =>
              callInference({
                serverUrl: runtime.serverUrl,
                model: "gpt-5.5",
                instructions: system,
                input: user,
                effort: "low",
                timeoutMs: INFER_TIMEOUT_MS,
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
    process.exit(0)
  },
})
