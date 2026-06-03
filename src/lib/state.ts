import { randomBytes, randomUUID } from "node:crypto"

import type { ModelsResponse } from "~/services/copilot/get-models"

export interface State {
  githubToken?: string
  copilotToken?: string

  accountType: string
  copilotApiUrl?: string
  models?: ModelsResponse
  vsCodeVersion?: string
  copilotVersion?: string

  manualApprove: boolean
  rateLimitWait: boolean
  showToken: boolean
  extendedBetas: boolean

  /**
   * Opt-in flag for the browser-control MCP tools (`browser_*`). Set by
   * `setupAndServe` from the `--browse` CLI flag or
   * `GH_ROUTER_ENABLE_BROWSE=1` env var. When false, all `browser_*`
   * tools are dropped from `tools/list` AND `tools/call` returns
   * -32601 — same defense-in-depth pattern as `workerToolsEnabled()` /
   * `standInToolEnabled()`. See `browserToolsEnabled()` in
   * `src/routes/mcp/handler.ts`.
   */
  browseEnabled: boolean

  /**
   * When true, --power-browse was passed (or GH_ROUTER_ENABLE_POWER_BROWSE=1
   * is set). Exposes the FULL browser MCP surface (~18 tools) on /mcp,
   * including the L0/L1 primitives that hand DOM details (refs,
   * bboxes, role/name dumps) to the lead model. Default --browse mode
   * exposes only the 6 lead-model tools (act, observe, extract,
   * navigate, screenshot, open_tab). Always implies browseEnabled.
   */
  powerBrowseEnabled: boolean

  // Rate limiting configuration
  rateLimitSeconds?: number
  lastRequestTimestamp?: number

  // Persistent session identifiers to match VS Code fingerprint
  sessionId: string
  machineId: string

  /**
   * Per-launch nonce for the loopback `/mcp` endpoint. Set by the
   * `claude` subcommand after `setupAndServe` and before spawning
   * Claude Code; the spawned MCP client reads it from the
   * `--mcp-config` tempfile and presents it as `Authorization: Bearer`.
   * When unset, `/mcp` rejects all requests — closes the
   * loopback-no-auth gap (DNS rebinding, malicious browser-ext
   * native messaging, sibling-process probe).
   */
  peerMcpNonce?: string
}

export const state: State = {
  accountType: "enterprise",
  manualApprove: false,
  rateLimitWait: false,
  showToken: false,
  extendedBetas: false,
  browseEnabled: false,
  powerBrowseEnabled: false,
  sessionId: randomUUID(),
  machineId: randomBytes(32).toString("hex"),
}
