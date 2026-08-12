import { buildSelfCommand, type SelfInvocation } from "./hook-launcher/self-invocation"

/** Header the per-session MCP headersHelper emits, carrying the calling Claude
 *  session's working directory. The /mcp handler uses it as the default
 *  `workspace` for repo-scoped tools so a machine-wide `serve` targets the
 *  active repo, not the proxy launch cwd. */
export const MCP_WORKSPACE_HEADER = "X-GH-Workspace"

/** stdout JSON the headersHelper prints; Claude merges it into the connection
 *  headers. `cwd` is the helper's own process cwd = the session's project dir. */
export function buildWorkspaceHeaderJson(cwd: string): string {
  return JSON.stringify({ [MCP_WORKSPACE_HEADER]: cwd })
}

/** Command string Claude runs as the headersHelper. */
export function buildWorkspaceHeaderHelperCommand(invocation: SelfInvocation): string {
  return buildSelfCommand(invocation, "internal-workspace-header")
}
