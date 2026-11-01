/**
 * Whether this launch enables the `cloudagent` MCP group, and why.
 *
 * One switch. `--cloudagent` or `GH_ROUTER_ENABLE_CLOUDAGENT=1` turns the group
 * on, and so does the workspace's git remote being an Azure DevOps repository
 * when neither was given. That last path exists for the same reason the ADO,
 * Kusto and Bluebird groups have one: an ADO checkout is already proof the
 * operator works in the ecosystem, and a group nobody remembers to enable is a
 * group nobody uses.
 *
 * Discovery enables the WHOLE group, write tools included. That steps outside
 * the Azure surfaces' read-only discovery rule. It was originally read-only, on
 * the ground that a cloned repository's `origin` is attacker-controllable and
 * `create_job` spends real compute. Two things carry that risk now: the
 * operator's
 * `--no-cloudagent` / `GH_ROUTER_DISABLE_CLOUDAGENT`, which is the veto, and the
 * create tools' own descriptions, which tell the model to confirm with the user
 * before creating a job the user did not ask for. A half-enabled group was the
 * worse failure mode: a model that can see `list_jobs` and cannot see
 * `create_job` reads the gap as a bug and spends turns looking for the tool
 * that is missing.
 *
 * Kept in its own file rather than folded into `azure-mcp-flags.ts`: that file
 * owns three Azure surfaces with one shared discovery verdict and one banner,
 * and Cloud Agent is a separate service whose only overlap is the remote it
 * reads. The discovery probe itself is shared and memoized, so splitting the
 * rule costs no extra `git remote -v`.
 *
 * Precedence: explicit negative, then explicit positive, then discovery, then
 * off. The flag is TRI-STATE (`undefined` = absent, `true` = asked for,
 * `false` = explicitly refused) because an absent flag and `--no-cloudagent`
 * are different intentions, and "off unless discovered" can only be safe while
 * an operator can always say no.
 */

import { azureMcpsSuppressed } from "./azure-mcp-flags"
import { type AzureRepoInfo } from "./azure-repo"
import { type CloudAgentEnvironment, normalizeCloudAgentEnvironment } from "./cloudagent-client"

/** `GH_ROUTER_DISABLE_CLOUDAGENT=1` — opts out of the discovery-driven enable. */
export function cloudAgentSuppressed(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.GH_ROUTER_DISABLE_CLOUDAGENT?.trim().toLowerCase()
  if (!raw) return false
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on"
}

export interface CloudAgentInputs {
  /** `--cloudagent` / `--no-cloudagent`. `undefined` when the flag was absent. */
  cloudAgentFlag?: boolean | undefined
  /** `--cloudagent-env prod|ppe`, already falling back to `GH_ROUTER_CLOUDAGENT_ENV`. */
  cloudAgentEnvironment?: string | undefined
  env?: NodeJS.ProcessEnv
}

export interface CloudAgentFlags {
  /** All ten tools, read and write. */
  enabled: boolean
  environment: CloudAgentEnvironment
  /** True when `enabled` came from the git remote rather than from the operator. */
  discovered: boolean
  /** One line per surface that DISCOVERY turned on, for the launch banner. */
  reasons: Array<string>
}

/**
 * Tri-state intent for the whole group.
 *
 * An explicit CLI negative beats an env positive: the CLI is the more specific
 * and more recent statement of intent. `GH_ROUTER_DISABLE_CLOUDAGENT` is folded in
 * BEFORE the positive, so a disable can never be overridden by
 * `GH_ROUTER_ENABLE_CLOUDAGENT=1` left in a shell profile.
 */
function readIntent(inputs: CloudAgentInputs, env: NodeJS.ProcessEnv): boolean | undefined {
  if (inputs.cloudAgentFlag === false) return false
  if (cloudAgentSuppressed(env)) return false
  const raw = env.GH_ROUTER_ENABLE_CLOUDAGENT?.trim().toLowerCase()
  if (raw === "0" || raw === "off" || raw === "false" || raw === "no") return false
  if (inputs.cloudAgentFlag === true) return true
  if (raw === "1" || raw === "true" || raw === "yes" || raw === "on") return true
  return undefined
}

/**
 * Whether the git-remote read can change any outcome, consulted before
 * `discoverAzureRepo` so a launch that already knows its answer does not pay
 * for the probe.
 */
export function cloudAgentDiscoveryNeeded(inputs: CloudAgentInputs = {}): boolean {
  const env = inputs.env ?? process.env
  if (azureMcpsSuppressed(env)) return false
  return readIntent(inputs, env) === undefined
}

/**
 * Turn the flag, the environment and the discovered repository into the final
 * verdict.
 *
 * The environment is validated here even when the group is off, because a
 * malformed value is an operator typo and a launch that silently ignores it
 * would surface later as "the group is missing" or, worse, as a token minted
 * for the wrong audience. `normalizeCloudAgentEnvironment` throws with the two
 * accepted values named.
 */
export function resolveCloudAgentFlags(
  inputs: CloudAgentInputs,
  discovered: AzureRepoInfo | null,
): CloudAgentFlags {
  const env = inputs.env ?? process.env
  const environment = normalizeCloudAgentEnvironment(
    inputs.cloudAgentEnvironment?.trim() || env.GH_ROUTER_CLOUDAGENT_ENV?.trim() || "prod",
  )
  const intent = readIntent(inputs, env)
  const reasons: Array<string> = []

  let enabled = false
  let fromDiscovery = false
  if (intent === true) {
    enabled = true
  } else if (intent === undefined && !azureMcpsSuppressed(env) && discovered) {
    enabled = true
    fromDiscovery = true
    reasons.push(
      `Azure DevOps remote ${discovered.organization}/${discovered.project}/${discovered.repository}`,
    )
  }

  return {
    enabled,
    environment,
    discovered: fromDiscovery,
    reasons,
  }
}
