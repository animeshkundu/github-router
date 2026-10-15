/**
 * The `ado` MCP group: the tool surface Azure DevOps itself advertises.
 *
 * **Why this group is dynamic.** Every other group in `NON_PERSONA_MCP_TOOLS`
 * is a frozen array of hand-written entries, pinned at boot by
 * `assertMcpToolSurfaceConsistent()`. This one cannot be: the remote server
 * owns the tool set, it is large (20 tools under the curated toolsets, 31
 * without read-only, 43 with every toolset), and its names and descriptions
 * change on Microsoft's schedule. Freezing twenty entries would mean a
 * transcription that drifts silently and a proxy release for every upstream
 * rename. So `tools/list` is forwarded from the upstream `tools/list`,
 * filtered only by the two headers that already define the surface
 * (`X-MCP-Toolsets` and `X-MCP-Readonly`) — see `./ado-client` for the live
 * measurement that established those headers ARE the filter.
 *
 * What the static contract still guarantees, with the dynamic group folded in:
 *
 *   - **Name uniqueness.** `assertMcpToolSurfaceConsistent()` sees the static
 *     registry only, so the dynamic entries are checked against it here at
 *     snapshot time, and a collision drops the upstream tool with a warning
 *     rather than shadowing a proxy tool. A duplicate would be worse than a
 *     missing tool: the model would call one name and reach the other's code.
 *   - **Scope and capability symmetry.** Each dynamic entry carries
 *     `group: "ado"` and `capability: "ado"`, so the same `tools/list` filter
 *     and the same call-time gate apply to it as to any static tool.
 *   - **Read-only default.** The read-only subset is not computed here; it is
 *     whatever the server returned after being told `X-MCP-Readonly: true`.
 *
 * The snapshot is taken ONCE at launch, awaited before the child process
 * starts, because `toolEntries()` is synchronous and cannot fetch. A failure
 * disables the group with an actionable warning rather than leaving an empty
 * group advertised — a server that lists zero tools is indistinguishable from
 * a broken one, and neither is worth the bytes.
 */

import consola from "consola"

import { AdoMcpClient, getAdoToken, type AdoToolDescriptor } from "./ado-client"
import { NON_PERSONA_MCP_TOOLS, type NonPersonaMcpTool } from "./peer-mcp-personas"
import { sanitizeRemoteDetail } from "./remote-mcp-client"
import { state } from "./state"

/** Bound on the launch-time `initialize` + `tools/list` round trip. */
const PROVISION_TIMEOUT_MS = 20_000

const ADO_GROUP = "ado" as const

let client: AdoMcpClient | null = null
let inflight: Promise<AdoMcpClient> | null = null
let snapshot: Array<NonPersonaMcpTool> = []

/** Test seam: drop the memoized client and the tool snapshot. */
export function resetAdoToolsForTesting(): void {
  client = null
  inflight = null
  snapshot = []
}

/**
 * Test seam: install a snapshot without a live upstream.
 *
 * The handler-level suites need an `ado` surface to scope and gate, and the
 * only other way to get one is a mocked fetch round trip through the real
 * client — which would test the client a second time and the handler not at
 * all. `buildAdoToolEntries` is exercised directly in `tests/ado-client`.
 */
export function __setAdoToolSnapshotForTests(entries: Array<NonPersonaMcpTool>): void {
  snapshot = entries
}

/** Close the upstream session. Best-effort; safe when nothing was created. */
export async function disposeAdoClients(): Promise<void> {
  const current = client
  client = null
  snapshot = []
  if (current) await current.dispose().catch(() => {})
}

/**
 * The one process-lifetime ADO client, constructed from `state`. Single-flight
 * so concurrent first calls cannot mint two clients (and two `az` tokens).
 */
async function ensureAdoClient(): Promise<AdoMcpClient> {
  if (client) return client
  const existing = inflight
  if (existing) return existing
  const promise = (async (): Promise<AdoMcpClient> => {
    const organization = state.adoOrganization
    if (!organization) {
      throw new Error(
        "No Azure DevOps organization is configured. Launch with `--ado-org <org>` or run inside a checkout whose git remotes point at Azure DevOps.",
      )
    }
    const token = await getAdoToken()
    const created = new AdoMcpClient({
      organization,
      readOnly: state.adoReadOnly,
      toolsets: state.adoToolsets.length > 0 ? state.adoToolsets : undefined,
      token,
    })
    await created.initialize()
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

/**
 * Resolve the ADO tool surface and snapshot it for this process.
 *
 * Called from `setupAndServe` before the child spawns. Never throws: the
 * launch is not the right place to fail over a network dependency. On failure
 * the group is turned OFF, because an `ado` server that advertises no tools is
 * worse than an absent one — the model would see the group, find nothing
 * usable in it, and have no way to tell whether the group or its own query was
 * wrong.
 */
export async function provisionAdoTools(): Promise<
  { ok: true; toolCount: number } | { ok: false; reason: string }
> {
  if (!state.adoEnabled) return { ok: false, reason: "ado group is not enabled" }
  const timer = new AbortController()
  const handle = setTimeout(
    () => timer.abort(new Error("Azure DevOps MCP provisioning timed out")),
    PROVISION_TIMEOUT_MS,
  )
  handle.unref?.()
  try {
    const created = await ensureAdoClient()
    if (timer.signal.aborted) throw new Error("Azure DevOps MCP provisioning timed out")
    snapshot = buildAdoToolEntries(created.listAdoTools())
    if (snapshot.length === 0) {
      throw new Error("Azure DevOps advertised no tools for the selected toolsets")
    }
    return { ok: true, toolCount: snapshot.length }
  } catch (err) {
    const reason = sanitizeRemoteDetail(err)
    state.adoEnabled = false
    await disposeAdoClients()
    consola.warn(
      `Azure DevOps MCP group disabled: ${reason} `
      + "Verify `az login` targets the tenant that owns this organization, then relaunch.",
    )
    return { ok: false, reason }
  } finally {
    clearTimeout(handle)
  }
}

/**
 * Map the upstream descriptors onto the proxy's non-persona tool shape.
 *
 * Exported for tests, which feed recorded fixtures through it to pin the
 * filtering and the collision behaviour without a live endpoint.
 */
export function buildAdoToolEntries(
  tools: ReadonlyArray<AdoToolDescriptor>,
): Array<NonPersonaMcpTool> {
  // Two sets, not one: the warning is the ONLY signal an operator gets about a
  // dropped tool, and "the proxy already serves a tool by that name" is false
  // for an intra-upstream duplicate. Keeping them separate is what makes the
  // message name the actual cause.
  const proxyOwned = new Set(NON_PERSONA_MCP_TOOLS.map((tool) => tool.toolNameHttp))
  const seen = new Set<string>()
  const entries: Array<NonPersonaMcpTool> = []
  for (const tool of tools) {
    const name = tool.name?.trim()
    if (!name) continue
    if (proxyOwned.has(name)) {
      consola.warn(
        `Azure DevOps tool "${name}" was dropped: the proxy already serves a tool by that name.`,
      )
      continue
    }
    if (seen.has(name)) continue
    seen.add(name)
    entries.push({
      toolNameHttp: name,
      group: ADO_GROUP,
      capability: "ado",
      description: tool.description || `Azure DevOps tool ${name}.`,
      inputSchema: tool.inputSchema,
      async handler(args, signal) {
        const active = await ensureAdoClient()
        const result = await active.callAdoTool(name, args, signal)
        return result.isError === true
          ? { content: result.content, isError: true }
          : { content: result.content }
      },
    })
  }
  return entries
}

/**
 * The ADO tools for THIS process, or an empty array when the group is off or
 * its snapshot never landed. Read by `tools/list` and `tools/call` through one
 * accessor in the handler so the two surfaces cannot disagree about which
 * tools exist.
 */
export function adoMcpToolEntries(): ReadonlyArray<NonPersonaMcpTool> {
  if (!state.adoEnabled) return []
  return snapshot
}
