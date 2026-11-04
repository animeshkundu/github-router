/**
 * The `workiq` MCP group: Microsoft 365 research through the hosted Work IQ
 * service.
 *
 * Same dynamic-surface pattern as `./ado-tools`: the remote server owns the
 * tool set, so `tools/list` is forwarded from the upstream `tools/list`
 * instead of a frozen transcription that would drift silently. Two differences
 * are deliberate:
 *
 *   - **Read-only is enforced HERE, not by a header.** The Work IQ server
 *     advertises all twelve tools to every caller; its four mutating tools
 *     (`create_entity`, `update_entity`, `delete_entity`, `do_action`) are
 *     removed from the snapshot unless `--workiq-write` was passed. `call`-time
 *     enforcement comes for free because a tool absent from the snapshot is
 *     absent from `tools/call` too.
 *   - **An unknown name is a signal.** The read allow-list is keyed to the
 *     documented names, so a name outside both sets means the service shipped
 *     something new. It is dropped with a warning that names `--workiq-write`,
 *     which exposes whatever the live server actually advertises.
 *   - **One name is renamed on the way out.** See {@link WORKIQ_TOOL_ALIASES}.
 *
 * The snapshot is taken ONCE at launch, awaited before the child process
 * starts, because the handler's tool accessor is synchronous. A failed
 * provision turns the group OFF with an actionable warning rather than leaving
 * an empty group advertised.
 */

import consola from "consola"

import { proxyOwnedMcpToolNames, type NonPersonaMcpTool } from "./peer-mcp-personas"
import { sanitizeRemoteDetail } from "./remote-mcp-client"
import { relaySafeText } from "./worker-agent/relay-cap"
import { state } from "./state"
import { WorkiqMcpClient, type WorkiqToolDescriptor } from "./workiq/client"
import { WORKIQ_READ_TOOLS, WORKIQ_WRITE_TOOLS } from "./workiq/constants"
import { AUTH_REMEDY, WorkiqAuthError, ensureWorkiqToken } from "./workiq/token"

/** Bound on the launch-time `initialize` + `tools/list` round trip. */
const PROVISION_TIMEOUT_MS = 20_000

const WORKIQ_GROUP = "workiq" as const

/**
 * Upstream name → MCP-facing name. Only the exposed name changes; the handler
 * keeps calling the wire name.
 *
 * `list_agents` is the one collision: the `cloudagent` group already serves a
 * tool by that name, and `proxyOwnedMcpToolNames()` reserves it whether or not
 * that group is enabled in this process. On the canonical Azure DevOps setup,
 * where cloudagent auto-enables, an unrenamed `list_agents` would silently drop
 * one of the eight read tools on every launch. Renaming on the way out is the
 * same decoupling the browser tools use, and it is safe because dispatch keys
 * on `group`, not on the upstream name.
 */
export const WORKIQ_TOOL_ALIASES: ReadonlyMap<string, string> = new Map([
  ["list_agents", "agents"],
])

let client: WorkiqMcpClient | null = null
let inflight: Promise<WorkiqMcpClient> | null = null
let snapshot: Array<NonPersonaMcpTool> = []

/** Test seam: drop the memoized client and the tool snapshot. */
export function resetWorkiqToolsForTesting(): void {
  client = null
  inflight = null
  snapshot = []
}

/** Test seam: install a snapshot without a live upstream. */
export function __setWorkiqToolSnapshotForTests(entries: Array<NonPersonaMcpTool>): void {
  snapshot = entries
}

/** Close the upstream session. Best-effort; safe when nothing was created. */
export async function disposeWorkiqClients(): Promise<void> {
  const current = client
  client = null
  snapshot = []
  if (current) await current.dispose().catch(() => {})
}

/**
 * The one process-lifetime Work IQ client. Single-flight, like `ensureAdoClient`,
 * for the same reason: concurrent first calls must not each start an
 * `initialize` handshake (and, worse, each trigger a token refresh, which
 * ROTATES the refresh token).
 *
 * `signal` bounds construction only. Once the client is memoized every later
 * caller returns immediately, so a request-end abort cannot tear down a client
 * other calls are using.
 */
async function ensureWorkiqClient(signal?: AbortSignal): Promise<WorkiqMcpClient> {
  if (client) return client
  const existing = inflight
  if (existing) return existing
  const promise = (async (): Promise<WorkiqMcpClient> => {
    const token = await ensureWorkiqToken({ ...(signal ? { signal } : {}) })
    const created = new WorkiqMcpClient({ token })
    await created.initialize(signal)
    client = created
    return created
  })()
  inflight = promise
  try {
    return await promise
  } finally {
    if (inflight === promise) inflight = null
  }
}

/** The remedy a failed provision should print, or undefined for a network error. */
function remedyFor(err: unknown): string | undefined {
  if (err instanceof WorkiqAuthError) return err.remedy
  const detail = sanitizeRemoteDetail(err)
  return /401|403|unauthori[sz]ed|forbidden|token/i.test(detail) ? AUTH_REMEDY : undefined
}

/**
 * Fold the remedy into the message a TOOL CALL surfaces.
 *
 * The MCP boundary forwards only `err.message` to the model, so a
 * `WorkiqAuthError` whose `remedy` stays a separate property reaches the caller
 * as "No Work IQ login found at <path>." with nothing to act on. Provisioning
 * prints the remedy itself; the call path has to put it in the message.
 */
function withCallTimeRemedy(err: unknown): unknown {
  if (!(err instanceof Error)) return err
  const remedy = remedyFor(err)
  if (!remedy || err.message.includes(remedy)) return err
  const surfaced = new Error(`${err.message} ${remedy}`, { cause: err })
  surfaced.name = err.name
  return surfaced
}

/**
 * Resolve the Work IQ tool surface and snapshot it for this process.
 *
 * Called from `setupAndServe` before the child spawns. Never throws: the launch
 * is not the right place to fail over a network or consent dependency. On
 * failure the group is turned OFF, because a `workiq` server that advertises no
 * tools is worse than an absent one.
 */
export async function provisionWorkiqTools(): Promise<
  { ok: true; toolCount: number } | { ok: false; reason: string }
> {
  if (!state.workiqEnabled) return { ok: false, reason: "workiq group is not enabled" }
  const timer = new AbortController()
  const handle = setTimeout(
    () => timer.abort(new Error("Work IQ MCP provisioning timed out")),
    PROVISION_TIMEOUT_MS,
  )
  handle.unref?.()
  try {
    const created = await ensureWorkiqClient(timer.signal)
    if (timer.signal.aborted) throw new Error("Work IQ MCP provisioning timed out")
    snapshot = buildWorkiqToolEntries(created.listWorkiqTools(), {
      write: state.workiqWriteEnabled,
    })
    if (snapshot.length === 0) {
      throw new Error("Work IQ advertised no usable tools")
    }
    return { ok: true, toolCount: snapshot.length }
  } catch (err) {
    const reason = sanitizeRemoteDetail(err)
    state.workiqEnabled = false
    await disposeWorkiqClients()
    const remedy = remedyFor(err)
    consola.warn(
      `Work IQ MCP group disabled: ${reason}`
      + (remedy ? ` ${remedy}` : " Check the network path to workiq.svc.cloud.microsoft, then relaunch."),
    )
    return { ok: false, reason }
  } finally {
    clearTimeout(handle)
  }
}

export interface BuildWorkiqToolEntriesOptions {
  /**
   * Pass every upstream tool through. False keeps only `WORKIQ_READ_TOOLS`,
   * which is the default surface.
   */
  write: boolean
}

/**
 * Map the upstream descriptors onto the proxy's non-persona tool shape.
 *
 * Exported for tests, which feed recorded fixtures through it to pin the
 * read-only filter, the unknown-name warning, and the collision behaviour
 * without a live endpoint.
 */
export function buildWorkiqToolEntries(
  tools: ReadonlyArray<WorkiqToolDescriptor>,
  opts: BuildWorkiqToolEntriesOptions,
): Array<NonPersonaMcpTool> {
  const proxyOwned = proxyOwnedMcpToolNames()
  const seen = new Set<string>()
  const entries: Array<NonPersonaMcpTool> = []
  for (const tool of tools) {
    const wireName = tool.name?.trim()
    if (!wireName) continue
    if (!opts.write && !WORKIQ_READ_TOOLS.has(wireName)) {
      // A mutating tool is the expected, silent case. Anything else means the
      // service shipped a tool this proxy has never seen, and the operator
      // needs to know the read surface may be narrower than the live one.
      if (!WORKIQ_WRITE_TOOLS.has(wireName)) {
        consola.warn(
          `Work IQ tool "${wireName}" was dropped because it is not on the read-only allow-list. `
            + "Relaunch with --workiq-write to expose the full live surface.",
        )
      }
      continue
    }
    const exposedName = WORKIQ_TOOL_ALIASES.get(wireName) ?? wireName
    if (proxyOwned.has(exposedName)) {
      consola.warn(
        `Work IQ tool "${wireName}"${exposedName === wireName ? "" : ` (exposed as "${exposedName}")`}`
          + " was dropped: the proxy already serves a tool by that name.",
      )
      continue
    }
    if (seen.has(exposedName)) continue
    seen.add(exposedName)
    entries.push({
      toolNameHttp: exposedName,
      group: WORKIQ_GROUP,
      capability: "workiq",
      description: tool.description || `Work IQ tool ${wireName}.`,
      inputSchema: tool.inputSchema,
      async handler(args, signal) {
        try {
          const active = await ensureWorkiqClient(signal)
          const result = await active.callWorkiqTool(wireName, args, signal)
          // Relay-safe at the boundary, matching ADO: a result over the cap
          // spills IN FULL to a file with a bounded preview and that path,
          // instead of being clipped here or by Claude Code's MCP result cap.
          const text = await relaySafeText(result.content.map((block) => block.text).join(""))
          return { content: [{ type: "text", text }] }
        } catch (err) {
          // Never swallow a caller abort: only auth failures get the remedy.
          if (signal?.aborted) throw err
          throw withCallTimeRemedy(err)
        }
      },
    })
  }
  return entries
}

/**
 * The Work IQ tools for THIS process, or an empty array when the group is off
 * or its snapshot never landed.
 */
export function workiqMcpToolEntries(): ReadonlyArray<NonPersonaMcpTool> {
  if (!state.workiqEnabled) return []
  return snapshot
}
