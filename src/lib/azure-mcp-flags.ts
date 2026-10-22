/**
 * Which Azure-backed MCP surfaces this launch enables, and why.
 *
 * Three surfaces share one discovery signal: the workspace's git remotes. A
 * checkout whose `origin` is an Azure DevOps repository turns Bluebird code
 * search, the Azure DevOps MCP group and the Kusto group on by default. The rule
 * exists because that remote is already proof this is an Azure workspace, and
 * the alternative — an opt-in flag every session — meant nobody enabled them.
 *
 * Kusto joined that rule later, when the cluster became a per-call argument.
 * What kept it out before was that a git remote carries no cluster identity, so
 * a discovery-enabled group would have advertised five tools that could not
 * answer anything. With the cluster named per call, the same remote that says
 * "this is an Azure workspace" is enough to offer the tool, and the operator
 * still owns the only thing that bounds what it can read: their own identity in
 * the cluster. See `resolveAzureMcpFlags` for where the three surfaces'
 * precedence tables and one banner live.
 *
 * **The trust question is answered, not ignored.** A cloned repository's
 * `origin` is attacker-controllable, so with this rule opening someone else's
 * repo would silently provision three credentialed network clients. Four
 * properties bound that:
 *
 *   1. Auto-enable can never produce a WRITE surface. `--ado-write` is a flag
 *      only; nothing discovered from a remote clears `X-MCP-Readonly`.
 *   2. Every surface is suppressible individually (`--no-bluebird`,
 *      `--no-ado`, `--no-kusto`, or the `GH_ROUTER_DISABLE_*` env vars) and
 *      wholesale (`GH_ROUTER_AZURE_MCPS=off`), and an explicit negative always
 *      beats an explicit positive.
 *   3. The launch banner names both the enabled set and, per surface, the CAUSE
 *      that enabled it, so a session that suddenly carries three more servers is
 *      explainable rather than mysterious — and so a surface turned on by a
 *      flag is never miscredited to a remote.
 *   4. Kusto is the one surface whose requests extend past the repository, so
 *      its cluster is never discovered: discovery may turn the GROUP on, and a
 *      call names the cluster it reads. A per-call hostname is checked only for
 *      a standalone `kusto` DNS label, with any suffix. That is not an ownership
 *      allowlist: the selected host receives the Azure bearer token, so callers
 *      must choose a trusted host. RBAC governs data access at a genuine Kusto
 *      service; it does not protect the token from an untrusted endpoint.
 *
 * This is a deliberate difference from the deny-by-default
 * `GH_ROUTER_FM_SCAFFOLD_REPOS` precedent: that allowlist guards a tool that
 * creates branches and opens pull requests, whereas this only turns on
 * read-only lookups.
 *
 * The three input flags are TRI-STATE (`undefined` = absent, `true` = asked
 * for, `false` = explicitly refused), because an absent flag and `--no-x` are
 * different intentions and the `default: false` boolean convention erases the
 * difference. Read-only-by-default discovery is only safe while an operator
 * can always say no.
 */

import { ADO_DEFAULT_TOOLSETS, normalizeAdoToolsets } from "./ado-client"
import { getAzureRepoFromGit, type AzureRepoInfo } from "./azure-repo"
import { normalizeKustoClusterUri } from "./kusto-client"

/** Injection seam for the git read, so unit tests never touch real remotes. */
export type AzureRepoProbe = (
  workspace: string,
  signal?: AbortSignal,
) => Promise<AzureRepoInfo | null>

/**
 * The production probe. `getAzureRepoFromGit` THROWS on every non-Azure
 * workspace (no Azure remote, conflicting origins, ambiguous remotes) and on
 * any git failure — correct for a caller asking a question about a specific
 * workspace, wrong for a launch step whose only job is to decide whether to
 * turn some tools on. Every failure resolves to "not an Azure workspace", and
 * a launch is never failed by discovery.
 */
export async function gitAzureRepoProbe(
  workspace: string,
  signal?: AbortSignal,
): Promise<AzureRepoInfo | null> {
  try {
    return await getAzureRepoFromGit(workspace, signal)
  } catch {
    return null
  }
}

/** `GH_ROUTER_AZURE_MCPS=off` — the wholesale kill switch for auto-enable. */
export function azureMcpsSuppressed(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.GH_ROUTER_AZURE_MCPS?.trim().toLowerCase()
  if (!raw) return false
  return raw === "0" || raw === "off" || raw === "false" || raw === "no"
}

/**
 * Tri-state of a capability from its CLI flag and env equivalent.
 *
 * An explicit CLI negative always wins, including over an env positive: the
 * CLI is the more specific and more recent statement of intent. `envKey` is
 * consulted only when the CLI was silent.
 */
function triState(
  explicit: boolean | undefined,
  envKey: string,
  env: NodeJS.ProcessEnv,
): boolean | undefined {
  if (explicit === false) return false
  const envRaw = env[envKey]?.trim().toLowerCase()
  if (envRaw === "0" || envRaw === "off" || envRaw === "false" || envRaw === "no") return false
  if (explicit === true) return true
  if (envRaw === "1") return true
  return undefined
}

export interface AzureMcpInputs {
  /** `--bluebird` / `--no-bluebird`. `undefined` when the flag was absent. */
  bluebirdFlag?: boolean | undefined
  /** `--ado` / `--no-ado`. */
  adoFlag?: boolean | undefined
  /** `--kusto` / `--no-kusto`. */
  kustoFlag?: boolean | undefined
  /** `--ado-org`, already falling back to `GH_ROUTER_ADO_ORG`. */
  adoOrganization?: string | undefined
  /** `--ado-toolsets <csv>`, already falling back to `GH_ROUTER_ADO_TOOLSETS`. */
  adoToolsets?: string | undefined
  /** `--ado-all-toolsets` / `GH_ROUTER_ADO_ALL_TOOLSETS=1`. */
  adoAllToolsets?: boolean | undefined
  /** `--kusto-cluster`, already falling back to `GH_ROUTER_KUSTO_CLUSTER`. */
  kustoCluster?: string | undefined
  /** `--kusto-database`, already falling back to `GH_ROUTER_KUSTO_DATABASE`. */
  kustoDatabase?: string | undefined
  env?: NodeJS.ProcessEnv
}

export interface AzureMcpFlags {
  bluebird: boolean
  ado: boolean
  kusto: boolean
  /** Resolved Azure DevOps organization, or null when the group is off. */
  adoOrganization: string | null
  /** Resolved Azure DevOps toolset selection, or null when the group is off. */
  adoToolsets: Array<string> | null
  kustoCluster: string | null
  kustoDatabase: string | null
  /**
   * One line per surface that DISCOVERY (rather than a flag) turned on,
   * suitable for the launch banner. Empty when nothing was auto-enabled.
   */
  reasons: Array<string>
  /**
   * A surface the operator asked for that cannot work, with the reason. The
   * launch proceeds; the banner is where this becomes visible, because a
   * silently-absent tool is indistinguishable from a bug.
   */
  warnings: Array<string>
}

/** Resolved per-capability intent, before the discovered repo is consulted. */
interface Intent {
  bluebird: boolean | undefined
  ado: boolean | undefined
  kusto: boolean | undefined
  adoOrganization: string | null
  adoToolsets: string | null
  adoAllToolsets: boolean
  kustoCluster: string | null
  kustoDatabase: string | null
}

function readIntent(inputs: AzureMcpInputs): Intent {
  const env = inputs.env ?? process.env
  // `GH_ROUTER_ENABLE_BLUEBIRD` is deliberately absent from this table: the
  // existing `resolveSearchFlags` already folds it into the positive flag it
  // hands over, so reading it twice would be two sources for one bit.
  return {
    bluebird: inputs.bluebirdFlag,
    ado: triState(inputs.adoFlag, "GH_ROUTER_ENABLE_ADO", env),
    kusto: triState(inputs.kustoFlag, "GH_ROUTER_ENABLE_KUSTO", env),
    adoOrganization: inputs.adoOrganization?.trim() || env.GH_ROUTER_ADO_ORG?.trim() || null,
    adoToolsets: inputs.adoToolsets?.trim() || env.GH_ROUTER_ADO_TOOLSETS?.trim() || null,
    adoAllToolsets: inputs.adoAllToolsets === true || env.GH_ROUTER_ADO_ALL_TOOLSETS === "1",
    kustoCluster: inputs.kustoCluster?.trim() || env.GH_ROUTER_KUSTO_CLUSTER?.trim() || null,
    kustoDatabase: inputs.kustoDatabase?.trim() || env.GH_ROUTER_KUSTO_DATABASE?.trim() || null,
  }
}

/**
 * Whether the git-remote read can change any outcome. Consulted before
 * `discoverAzureRepo` so a launch where every surface is already decided does
 * not pay for a `git remote -v` process — the probe must not become an
 * unconditional pre-listen spawn on every launch.
 *
 * All three surfaces can be decided BY discovery, so each one keeps the probe
 * alive while its outcome is open. The cost of getting this wrong is a surface
 * that silently never appears; the cost of erring the other way is one bounded
 * `git remote -v` in a launch where it changed nothing, so the test is per
 * surface and only skips the spawn when every answer is already fixed.
 */
export function azureDiscoveryNeeded(inputs: AzureMcpInputs): boolean {
  if (azureMcpsSuppressed(inputs.env ?? process.env)) return false
  const intent = readIntent(inputs)
  // Bluebird's outcome is undecided unless a flag already fixed it.
  if (intent.bluebird === undefined) return true
  // ADO's outcome is undecided unless a flag fixed it or a scope was named.
  if (intent.ado === undefined && !intent.adoOrganization) return true
  // Kusto's outcome is undecided unless a flag or a cluster already fixed it.
  // A named cluster settles it on its own, because discovery can only ever turn
  // the group ON: there is nothing left for the probe to decide.
  return intent.kusto === undefined && !intent.kustoCluster
}

/**
 * Turn resolved intent plus the discovered repository into the final flags.
 *
 * Precedence per capability: explicit negative → explicit positive →
 * discovery → off. For Kusto the positive step has two forms, a flag or a named
 * cluster, and the discovery step now exists: an Azure DevOps remote is what
 * offers the group. Naming a scope on the command line (`--ado-org`,
 * `--kusto-cluster`) is itself a positive statement of intent, because nobody
 * supplies an endpoint they do not want used — but a scope is no longer
 * REQUIRED, since the cluster is selectable per call and discovery supplies
 * none.
 */
export function resolveAzureMcpFlags(
  inputs: AzureMcpInputs,
  discovered: AzureRepoInfo | null,
): AzureMcpFlags {
  const env = inputs.env ?? process.env
  const suppressAll = azureMcpsSuppressed(env)
  const intent = readIntent(inputs)

  const reasons: Array<string> = []
  const warnings: Array<string> = []
  const origin = discovered
    ? `${discovered.organization}/${discovered.project}/${discovered.repository}`
    : null

  // --- Bluebird. Its scope comes from the repository, so discovery is the
  // only automatic path that can satisfy it.
  let bluebird = false
  if (!suppressAll && intent.bluebird !== false) {
    if (intent.bluebird === true) {
      if (discovered) bluebird = true
      else warnings.push("bluebird: requested but no Azure DevOps git remote was found")
    } else if (discovered) {
      bluebird = true
      reasons.push(`bluebird: Azure DevOps remote ${origin}`)
    }
  }

  // --- Azure DevOps MCP. Either scope source is enough.
  const adoOrg = intent.adoOrganization ?? discovered?.organization ?? null
  let ado = false
  if (!suppressAll && intent.ado !== false) {
    if (intent.ado === true && !adoOrg) {
      warnings.push("ado: requested but no organization (--ado-org) and no Azure DevOps git remote")
    } else if (adoOrg) {
      if (intent.ado === true || intent.adoOrganization) ado = true
      else {
        ado = true
        reasons.push(`ado: Azure DevOps remote ${origin}`)
      }
    }
  }

  // --- Kusto. A flag, a named cluster, or the discovered remote turns it on;
  // the cluster is only a default and discovery never supplies one.
  let kusto = false
  if (!suppressAll && intent.kusto !== false) {
    if (intent.kustoCluster) {
      // Validated here, once, at the point the value enters the process. The
      // client normalizes again on every request, but by then a typo would
      // have advertised five tools whose calls fall back to a host nothing can
      // reach, and the operator would have no signal: a malformed host throws
      // here, with the expectation named, in the same style as an unknown ADO
      // toolset.
      normalizeKustoClusterUri(intent.kustoCluster)
      kusto = true
    } else if (intent.kusto === true) {
      // On, with no default host: every call must name its own cluster. Naming
      // a scope is a positive statement of intent, and so is the flag, so this
      // no longer needs a cluster to be useful.
      kusto = true
    } else if (discovered) {
      // The remote is the cause here and is named as such. Both arms above are
      // operator statements, so neither pushes a reason: a banner whose whole
      // purpose is explainability must not credit a remote with a decision the
      // operator made.
      kusto = true
      reasons.push(`kusto: Azure DevOps remote ${origin}`)
    }
  }

  return {
    bluebird,
    ado,
    kusto,
    adoOrganization: ado ? adoOrg : null,
    adoToolsets: ado ? resolveAdoToolsets(intent) : null,
    kustoCluster: kusto ? intent.kustoCluster : null,
    kustoDatabase: kusto ? intent.kustoDatabase : null,
    reasons,
    warnings,
  }
}

/**
 * Toolset selection: `--ado-all-toolsets` sends no header, an explicit list is
 * validated against the documented values, and the curated default covers the
 * repository loop. An invalid value throws rather than degrading to the
 * default — a typo that silently widened or narrowed the surface is worse than
 * a failed launch.
 */
function resolveAdoToolsets(intent: Intent): Array<string> {
  if (intent.adoAllToolsets) return ["all"]
  if (!intent.adoToolsets) return [...ADO_DEFAULT_TOOLSETS]
  return normalizeAdoToolsets(intent.adoToolsets)
}

// --- Discovery memoization -------------------------------------------------

let discoveryPromise: Promise<AzureRepoInfo | null> | null = null

/**
 * The workspace's Azure DevOps repository, resolved at most once per process.
 *
 * Memoized because up to two capabilities consume the same answer and a second
 * `git remote -v` spawn would buy nothing. A FAILED probe is memoized too: the
 * failure is a property of the workspace, and retrying it per consumer would
 * multiply the spawn the memoization exists to avoid.
 */
export function discoverAzureRepo(opts: {
  workspace?: string
  probe?: AzureRepoProbe
  timeoutMs?: number
  signal?: AbortSignal
} = {}): Promise<AzureRepoInfo | null> {
  if (discoveryPromise) return discoveryPromise
  const workspace = opts.workspace ?? process.cwd()
  const probe = opts.probe ?? gitAzureRepoProbe
  const timeoutMs = opts.timeoutMs ?? 5_000

  discoveryPromise = (async () => {
    const timer = new AbortController()
    const handle = setTimeout(
      () => timer.abort(new Error("Azure repository discovery timed out")),
      timeoutMs,
    )
    handle.unref?.()
    const onOuterAbort = () => timer.abort(opts.signal?.reason ?? new Error("aborted"))
    if (opts.signal?.aborted) onOuterAbort()
    else opts.signal?.addEventListener("abort", onOuterAbort, { once: true })
    try {
      return await probe(workspace, timer.signal)
    } catch {
      // The production probe cannot throw, but an injected one might.
      // Discovery never fails a launch.
      return null
    } finally {
      clearTimeout(handle)
      opts.signal?.removeEventListener("abort", onOuterAbort)
    }
  })()
  return discoveryPromise
}

/** Test seam: forget the memoized probe so the next call re-runs it. */
export function resetAzureDiscoveryForTesting(): void {
  discoveryPromise = null
}
