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
 * `local` allows no Copilot model inference on an agent turn at all. `local2`
 * allows the two families `sol` and `luna`. The non-model Copilot services are
 * untouched: `web` search goes through Copilot's MCP endpoint with the GitHub
 * PAT, and the browser tools drive a local extension.
 *
 * `cheaplocal` is the mirror image: its lead and every native stay on Copilot,
 * and only its Advisor and Oracle leave. It therefore caps Copilot egress to the
 * same two families without being a local launch: `activeLocalLaunchProfile`
 * ignores it, because returning it would send the whole main loop to the local
 * endpoint.
 *
 * The one model-backed exception is the browser page compressor, which runs on
 * both profiles so the compound browse tools can answer at all. It is exempt
 * from the profile ceiling entirely and bounded by its own fixed chain instead;
 * see `CopilotEgressSurface`.
 */

import { isLocalFamily, type LocalProfileId } from "./profile-family"
import { state } from "./state"

/** The profiles that cap which Copilot model families may be billed.
 *  `cheaplocal` is not a local-family member (its lead and natives stay on
 *  Copilot) but its two consultants leave, so it carries the same ceiling. */
export type CopilotFamilyCeilingProfileId = LocalProfileId | "cheaplocal"

export type CopilotModelPolicy =
  | { kind: "unrestricted" }
  | { kind: "forbidden"; profileId: LocalProfileId }
  | {
    kind: "families"
    profileId: CopilotFamilyCeilingProfileId
    /** Lowercased trailing tier token of a Copilot model id (`sol`, `luna`). */
    families: ReadonlySet<string>
  }

/**
 * The hardcoded Copilot allow-list for `-m local2`: the Advisor and the Oracle
 * both run on `gpt-6.1-sol`, and `luna` is the cheap tier of the same declared
 * ceiling. Anything else a teammate or a `/model` switch names is refused.
 *
 * `luna`'s one Copilot consumer on this profile is the browser page
 * compressor, whose fixed chain falls back to `gpt-6-luna` when
 * `gpt-5.4-mini` is absent from the catalog. That surface is exempt from the
 * ceiling, so the entry is not what admits it; it keeps the two lists agreeing
 * if the exemption ever narrows. No other local surface selects Luna: no local
 * launch publishes the `workers` group. The ceiling stays an operator
 * decision, so moving it later is a policy change rather than a code change.
 *
 * `cheaplocal` shares the set for the same reason: its lead and natives are
 * Luna, its Copilot rewrite is Sol, and its consultants are not Copilot calls
 * at all.
 */
export const LOCAL2_COPILOT_MODEL_FAMILIES: ReadonlySet<string> = new Set(["sol", "luna"])

/** The policy a launch profile imposes on Copilot egress. Every profile other
 *  than the local pair and `cheaplocal` is unrestricted. */
export function copilotModelPolicyForProfile(profileId: string | null | undefined): CopilotModelPolicy {
  if (profileId === "local") return { kind: "forbidden", profileId }
  if (profileId === "local2" || profileId === "cheaplocal") {
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
 *  the local endpoint rather than to Copilot.
 *
 *  A restricted policy is not enough: `cheaplocal` caps Copilot egress to the
 *  same families as `local2` while keeping its whole main loop on Copilot.
 *  Returning it here would route that loop to the local endpoint, so only an
 *  actual local-family id answers. */
export function activeLocalLaunchProfile(): LocalProfileId | undefined {
  const policy = activeCopilotModelPolicy()
  if (policy.kind === "unrestricted") return undefined
  if (policy.kind === "forbidden") return policy.profileId
  return isLocalFamily(policy.profileId) ? policy.profileId : undefined
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
 * The one non-agent surface carved out of the profile policy entirely.
 *
 * The browser tools drive a local extension, but the compound ones (`find`,
 * `act`, `observe`, `extract`) hand page content to a Copilot model and ask for
 * a structured result. Without the carve-out those tools would be listed on a
 * `local` launch and then refuse every call, which is a worse outcome than the
 * model call itself: the surface would advertise a capability it cannot serve.
 *
 * The exemption is complete, not a narrowing of the ban: a browse call may name
 * any model in the compressor's own chain, on `local` and `local2` alike. Two
 * reasons. The chain is fixed and short (see `COMPRESSOR_FALLBACK_CHAIN`), so
 * the blast radius is a single cheap model rather than "whatever a teammate
 * names"; and binding the page compressor to a per-profile ceiling made the
 * backend depend on which launch happened to be registered, which is not a
 * property the browser surface should have. This is deliberately a named
 * surface rather than an unconditional bypass, so any future caller has to
 * state that it is the browser surface.
 */
export type CopilotEgressSurface = "browse"

/** Whether `modelId` may be sent to Copilot under `policy`. */
export function isCopilotModelAllowedUnder(
  policy: CopilotModelPolicy,
  modelId: string,
  surface?: CopilotEgressSurface,
): boolean {
  if (surface === "browse") return true
  if (policy.kind === "unrestricted") return true
  if (policy.kind === "forbidden") return false
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
