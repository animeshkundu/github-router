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
  args: {
    reviewerModel: {
      type: "string",
      description: "Catalog-resolved Max reviewer model for this launch.",
    },
    reviewerEffort: {
      type: "string",
      description: "Fixed Max reviewer effort for this launch.",
    },
  },
  run({ args }) {
    const reviewerEffort = args.reviewerEffort === "max"
      ? "max"
      : args.reviewerEffort === "xhigh"
        ? "xhigh"
        : "high"
    const decision = decideMaxDispatchGuard(readStdinSync(), {
      reviewerModel: args.reviewerModel,
      reviewerEffort,
    })
    if (!decision.allowed && decision.reason) {
      process.stdout.write(maxDispatchDenyOutput(decision.reason))
    } else if (decision.verdict === "allow" && decision.updatedInput) {
      process.stdout.write(maxDispatchAllowOutput(decision.updatedInput))
    }
    process.exitCode = 0
  },
})

export function buildMaxDispatchGuardHookCommand(
  invocation: SelfInvocation,
  opts: { reviewerModel?: string; reviewerEffort?: "high" | "xhigh" | "max" } = {},
): string {
  const flags: string[] = []
  if (opts.reviewerModel) flags.push(`--reviewerModel "${opts.reviewerModel}"`)
  if (opts.reviewerEffort) flags.push(`--reviewerEffort ${opts.reviewerEffort}`)
  return buildSelfCommand(
    invocation,
    ["internal-max-dispatch-guard", ...flags].join(" "),
  )
}
