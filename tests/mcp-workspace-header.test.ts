import { describe, expect, test } from "bun:test"

import { workspaceHeaderJsonForCwd } from "../src/internal-workspace-header"
import {
  buildWorkspaceHeaderHelperCommand,
  buildWorkspaceHeaderJson,
  MCP_WORKSPACE_HEADER,
} from "../src/lib/mcp-workspace-header"

describe("mcp workspace header helper", () => {
  test("buildWorkspaceHeaderJson emits the header JSON", () => {
    expect(buildWorkspaceHeaderJson("/x")).toBe('{"X-GH-Workspace":"/x"}')
  })

  test("command builder quotes exec and script paths", () => {
    expect(
      buildWorkspaceHeaderHelperCommand("/usr/bin/node", "/app/dist/main.js"),
    ).toBe('"/usr/bin/node" "/app/dist/main.js" internal-workspace-header')
  })

  test("command builder collapses to exec-only for packaged builds", () => {
    expect(buildWorkspaceHeaderHelperCommand("/opt/github-router", "/opt/github-router"))
      .toBe('"/opt/github-router" internal-workspace-header')
    expect(buildWorkspaceHeaderHelperCommand("/opt/github-router", undefined))
      .toBe('"/opt/github-router" internal-workspace-header')
  })

  test("internal workspace header command core prints cwd as valid JSON", () => {
    const parsed = JSON.parse(workspaceHeaderJsonForCwd(process.cwd())) as Record<string, string>
    expect(parsed[MCP_WORKSPACE_HEADER]).toBe(process.cwd())
  })
})
