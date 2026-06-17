/**
 * The internal `internal-prompt-submit` subcommand: the executable a spawned
 * Claude Code session's `UserPromptSubmit` hook invokes (registered into the
 * mirrored settings.json by the launcher). It serves the front-end of the
 * floor-raising surface on one event: it resets the Stop-gate's per-session
 * block budget (making `maxBlocks` per-prompt) and, for a non-trivial prompt,
 * prints an advisory GOAL directive to stdout (which Claude Code adds to the
 * model's context).
 *
 * ALWAYS exits 0 (never blocks the prompt): the goal steer is additive context,
 * and a UserPromptSubmit hook that exit-2'd would refuse the user's prompt. All
 * decision logic is pure (`decidePromptSubmit`); this wrapper does stdin + the
 * budget reset IO + stdout.
 */

import { defineCommand } from "citty"

import { tmpdir } from "node:os"
import path from "node:path"

import { parseBoolEnv } from "./lib/exec"
import { fileBlockBudget } from "./lib/orchestration/stop-gate-hook"
import { decidePromptSubmit } from "./lib/orchestration/prompt-submit-hook"

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  try {
    for await (const c of process.stdin) chunks.push(c as Buffer)
  } catch {
    /* no stdin -> empty; decidePromptSubmit tolerates it */
  }
  return Buffer.concat(chunks).toString("utf8")
}

export const internalPromptSubmit = defineCommand({
  meta: {
    name: "internal-prompt-submit",
    description:
      "Internal: the UserPromptSubmit hook. Resets the Stop-gate per-prompt block "
      + "budget and injects an advisory goal directive for non-trivial prompts. Always exit 0.",
  },
  async run() {
    try {
      const stdin = await readStdin()
      const decision = decidePromptSubmit({
        stdin,
        steerEnabled: parseBoolEnv(process.env.GH_ROUTER_DISABLE_PROMPT_STEER) !== true,
      })
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
