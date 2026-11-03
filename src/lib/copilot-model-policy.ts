/**
 * Which Copilot models a running proxy is allowed to bill.
 *
 * A `-m local` / `-m local2` launch exists so that the agent's work runs on the
 * operator's own inference endpoint. The profiles keep the whole Claude Code
 * surface (native subagents, agent-team teammates, every CLI feature) but every
 * one of those turns must land on that endpoint, not on Copilot.
 *
 * Prompting cannot enforce that. A teammate's model is whatever its frontmatter
 * or the client's tier picker says, and a runtime `/model` switch can name any
 * catalog id. So the restriction lives here, at the Copilot egress: the three
 * functions that talk to Copilot (`createResponses`, `createChatCompletions`,
 * and the non-local branch of `createMessages`/`countTokens`) consult
 * `assertCopilotModelAllowed` before they build a request. Everything that can
 * reach Copilot funnels through them — the `/v1/*` routes, the peer personas,
 * `stand_in`, the orchestration tools, and the Pi worker runtime (whose
 * `stream-fn` imports the same services).
 *
 * `local` allows no Copilot model inference at all. `local2` allows the two
 * families its Advisor and Oracle use, `sol` and `luna`. The non-model Copilot
 * services are untouched: `web` search goes through Copilot's MCP endpoint with
 * the GitHub PAT, and the browser tools drive a local extension. The one
 * model-backed exception is the browser compressor, which `local` keeps so the
 * compound browse tools can answer at all; see `CopilotEgressSurface`.
 */

import { isLocalFamily, type LocalProfileId } from "./profile-family"
import { state } from "./state"

export type CopilotModelPolicy =
  | { kind: "unrestricted" }
  | { kind: "forbidden"; profileId: LocalProfileId }
  | {
    kind: "families"
    profileId: LocalProfileId
    /** Lowercased trailing tier token of a Copilot model id (`sol`, `luna`). */
    families: ReadonlySet<string>
  }

/**
 * The hardcoded Copilot allow-list for `-m local2`: the Advisor and the Oracle
 * both run on `gpt-6.1-sol`, and `luna` is admitted so the worker tools and the
 * Pi runtime have a cheap tier to fall back to. Anything else a teammate or a
 * `/model` switch names is refused.
 */
export const LOCAL2_COPILOT_MODEL_FAMILIES: ReadonlySet<string> = new Set(["sol", "luna"])

/** The policy a launch profile imposes on Copilot egress. Every profile other
 *  than the local pair is unrestricted. */
export function copilotModelPolicyForProfile(profileId: string | null | undefined): CopilotModelPolicy {
  if (profileId === "local") return { kind: "forbidden", profileId }
  if (profileId === "local2") {
    return { kind: "families", profileId, families: LOCAL2_COPILOT_MODEL_FAMILIES }
  }
  return { kind: "unrestricted" }
}

/**
 * The policy in force for this process.
 *
 * Derived from the live launch registry rather than a mutable global: the
 * proxy and the `claude` launch that fronts it share a process, so the
 * registered launches ARE the set of sessions whose traffic can arrive here.
 * Requests that never passed the identity preflight (a BYO client pointed at
 * `github-router start`) still funnel through the same egress, which is why
 * this is process-wide rather than per-request.
 *
 * Most restrictive wins: if a `local` launch is registered at the same time as
 * a `local2` one, Copilot inference is forbidden outright. Registering both in
 * one process is not a supported arrangement, and resolving the ambiguity
 * toward the stricter profile is the fail-closed direction.
 */
export function activeCopilotModelPolicy(): CopilotModelPolicy {
  let active: CopilotModelPolicy = { kind: "unrestricted" }
  for (const entry of state.launchRegistry.values()) {
    const policy = copilotModelPolicyForProfile(entry.profileId)
    if (policy.kind === "forbidden") return policy
    if (policy.kind === "families") active = policy
  }
  return active
}

/** The local-family profile this process is serving, if any. Used by the
 *  `/v1/messages` routes to send traffic that carries no launch identity to
 *  the local endpoint rather than to Copilot. */
export function activeLocalLaunchProfile(): LocalProfileId | undefined {
  const policy = activeCopilotModelPolicy()
  return policy.kind === "unrestricted" ? undefined : policy.profileId
}

/**
 * Effective local profile for one request.
 *
 * A bound identity wins: a request authenticated as `local`/`local2` is local,
 * and one authenticated as any other profile keeps that profile's behaviour
 * even when a local launch shares the process. Only an identity-less request
 * falls back to the process-wide answer, which is the case `-m local` needs:
 * a spawned teammate that lost its launch header still has to reach the local
 * endpoint instead of being answered by Copilot.
 */
export function effectiveLocalProfile(
  boundProfileId: string | null | undefined,
): LocalProfileId | undefined {
  if (isLocalFamily(boundProfileId)) return boundProfileId
  if (boundProfileId !== undefined && boundProfileId !== null) return undefined
  return activeLocalLaunchProfile()
}

/**
 * The family token of a Copilot model id: the trailing dash-separated segment,
 * lowercased, after removing a `[1m]` accounting suffix and any `-1m` sibling
 * marker. `gpt-6.1-sol` → `sol`, `gpt-6-luna` → `luna`,
 * `gemini-3.1-pro-preview` → `preview`, `claude-opus-5.5` → `5.5`.
 *
 * Matching on the tier token rather than a prefix keeps the allow-list honest:
 * `gpt-5.6-sol`, `gpt-6-sol` and `gpt-6.1-sol` are one family, while
 * `gpt-6-sol-like` is not silently admitted.
 */
export function copilotModelFamily(modelId: string): string {
  const withoutSuffix = modelId.trim().replace(/\[[^\]]*\]$/, "").replace(/-1m$/i, "")
  const parts = withoutSuffix.split("-")
  return (parts.at(-1) ?? "").toLowerCase()
}

/**
 * The one non-agent surface `-m local` carves out of the ban.
 *
 * The browser tools drive a local extension, but the compound ones (`find`,
 * `act`, `observe`, `extract`) hand page content to a Copilot model and ask for
 * a structured result. Without the carve-out those tools would be listed on a
 * `local` launch and then refuse every call, which is a worse outcome than the
 * model call itself: the surface would advertise a capability it cannot serve.
 * The carve-out is deliberately a named surface rather than an unconditional
 * bypass, so any future caller has to state that it is the browser surface.
 *
 * `local2`'s family ceiling still applies here: a browse call may only name a
 * model in `LOCAL2_COPILOT_MODEL_FAMILIES`, which is why the compressor picks
 * its backend against the active policy.
 */
export type CopilotEgressSurface = "browse"

/** Whether `modelId` may be sent to Copilot under `policy`. */
export function isCopilotModelAllowedUnder(
  policy: CopilotModelPolicy,
  modelId: string,
  surface?: CopilotEgressSurface,
): boolean {
  if (policy.kind === "unrestricted") return true
  if (policy.kind === "forbidden") return surface === "browse"
  return policy.families.has(copilotModelFamily(modelId))
}

/** Whether `modelId` may be sent to Copilot in this process right now. */
export function isCopilotModelAllowed(modelId: string, surface?: CopilotEgressSurface): boolean {
  return isCopilotModelAllowedUnder(activeCopilotModelPolicy(), modelId, surface)
}

/** Raised when a request names a Copilot model the active policy refuses.
 *  Carries `model` and the active policy so a caller can turn it into an
 *  actionable `isError` rather than a bare 500. */
export class CopilotModelRestrictedError extends Error {
  readonly model: string
  readonly policy: CopilotModelPolicy

  constructor(model: string, policy: CopilotModelPolicy) {
    const source = policy.kind === "unrestricted" ? "the active policy" : `the \`-m ${policy.profileId}\` profile`
    const allowed = policy.kind === "families"
      ? ` Only ${[...policy.families].sort().join(", ")} families are allowed.`
      : " No Copilot model inference is allowed for this profile."
    super(
      `Model ${model} cannot be used: ${source} does not permit it on Copilot.${allowed}`
        + (policy.kind === "forbidden"
          ? " Run the work on the local endpoint instead, or relaunch as `-m local2` to allow the Advisor and Oracle families."
          : ""),
    )
    this.name = "CopilotModelRestrictedError"
    this.model = model
    this.policy = policy
  }
}

/** Throw unless `modelId` is permitted. Called at every Copilot egress. */
export function assertCopilotModelAllowed(modelId: string, surface?: CopilotEgressSurface): void {
  const policy = activeCopilotModelPolicy()
  if (!isCopilotModelAllowedUnder(policy, modelId, surface)) {
    throw new CopilotModelRestrictedError(modelId, policy)
  }
}

/**
 * Same guard for callers that hold a serialized request body rather than a
 * resolved model id (`createMessages` / `countTokens` take the body as a
 * string). Parsing is deferred behind the policy check so the common
 * unrestricted path pays one registry scan and no JSON work.
 *
 * A restrictive policy fails closed on an unparseable body: there is no model
 * to inspect, so there is no basis for letting the request through.
 */
export function assertCopilotMessagesBodyAllowed(body: string): void {
  if (activeCopilotModelPolicy().kind === "unrestricted") return
  let model: string | undefined
  try {
    const parsed: unknown = JSON.parse(body)
    if (parsed && typeof parsed === "object" && "model" in parsed) {
      const raw = (parsed as { model?: unknown }).model
      if (typeof raw === "string") model = raw
    }
  } catch {
    model = undefined
  }
  if (model === undefined) {
    throw new CopilotModelRestrictedError("<unparseable body>", activeCopilotModelPolicy())
  }
  assertCopilotModelAllowed(model)
}
