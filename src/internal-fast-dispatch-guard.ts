/**
 * Internal PreToolUse guard for the `-m fast` native Task/Agent ACL.
 *
 * The policy is intentionally pure and compiled into this hook. This entrypoint
 * only performs synchronous stdin I/O, emits Claude Code's deny envelope, and
 * exits naturally so Windows libuv teardown is not raced by process.exit().
 */

import { defineCommand } from "citty"
import { readFileSync } from "node:fs"

import {
  decideFastDispatchGuard,
  fastDispatchDenyOutput,
} from "./lib/fast-dispatch-acl"
import { buildSelfCommand, type SelfInvocation } from "./lib/hook-launcher/self-invocation"

function readStdinSync(): string {
  try {
    if (process.stdin.isTTY) return ""
    return readFileSync(0, "utf8")
  } catch {
    return ""
  }
}

export const internalFastDispatchGuard = defineCommand({
  meta: {
    name: "internal-fast-dispatch-guard",
    description:
      "Internal: PreToolUse guard enforcing the fast-profile native Task/Agent ACL.",
  },
  run() {
    const decision = decideFastDispatchGuard(readStdinSync())
    if (!decision.allowed && decision.reason) {
      process.stdout.write(fastDispatchDenyOutput(decision.reason))
    }
    // Natural exit is required on Windows. Claude Code consumes the JSON
    // permission decision; an exit code is not used to deny this hook.
    process.exitCode = 0
  },
})

/** Build the persisted command for the fast-profile PreToolUse hook. */
export function buildFastDispatchGuardHookCommand(invocation: SelfInvocation): string {
  return buildSelfCommand(invocation, "internal-fast-dispatch-guard")
}
