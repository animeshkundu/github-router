import { defineCommand } from "citty"
import { readFileSync } from "node:fs"

import {
  decideMaxDispatchGuard,
  maxDispatchAllowOutput,
  maxDispatchDenyOutput,
} from "./lib/max-dispatch-acl"
import { buildSelfCommand, type SelfInvocation } from "./lib/hook-launcher/self-invocation"

function readStdinSync(): string {
  try {
    if (process.stdin.isTTY) return ""
    return readFileSync(0, "utf8")
  } catch {
    return ""
  }
}

export const internalMaxDispatchGuard = defineCommand({
  meta: {
    name: "internal-max-dispatch-guard",
    description: "Internal: PreToolUse guard enforcing the max-profile native Task/Agent policy.",
  },
  run() {
    const decision = decideMaxDispatchGuard(readStdinSync())
    if (!decision.allowed && decision.reason) {
      process.stdout.write(maxDispatchDenyOutput(decision.reason))
    } else if (decision.verdict === "allow" && decision.updatedInput) {
      process.stdout.write(maxDispatchAllowOutput(decision.updatedInput))
    }
    process.exitCode = 0
  },
})

export function buildMaxDispatchGuardHookCommand(invocation: SelfInvocation): string {
  return buildSelfCommand(invocation, "internal-max-dispatch-guard")
}
