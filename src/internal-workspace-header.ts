import { defineCommand } from "citty"

import { buildWorkspaceHeaderJson } from "./lib/mcp-workspace-header"

export function workspaceHeaderJsonForCwd(cwd: string = process.cwd()): string {
  return buildWorkspaceHeaderJson(cwd)
}

export const internalWorkspaceHeader = defineCommand({
  meta: {
    name: "internal-workspace-header",
    description:
      "Internal: headersHelper for HTTP MCP connections. Prints the current working directory as pure JSON headers.",
  },
  run() {
    try {
      process.stdout.write(workspaceHeaderJsonForCwd(process.cwd()))
    } catch {
      process.stdout.write("{}")
    }
    process.exitCode = 0
  },
})
