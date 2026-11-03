/**
 * Fixed identities for the literal `github-router claude -m cheaplocal` profile.
 *
 * `cheaplocal` is `cheapest` with its two consultants moved off Copilot: the
 * Advisor and the Oracle are served by the local Anthropic-Messages endpoint
 * (the same one `-m local` / `-m local2` point their main loop at) instead of a
 * Copilot model.
 *
 * Everything else is inherited verbatim from `CHEAPEST_PROFILE_CONTRACT`:
 * the `gpt-6-luna`/max lead, the Luna natives, the bare-slug 200K window, the
 * curated 24K Advisor digest, the Oracle-only peer set, the three-agent surface
 * and the delegation graph.
 *
 * Nothing in this file may characterize the local model. The endpoint is the
 * only fact the profile carries about it, so no name, window, effort, price or
 * speed claim is made anywhere: the contract names a bare SLUG (`opus`) and a
 * transport, and prose that reaches the model describes the consultants by
 * transport ("the local model"), never by identity.
 *
 * Derived by spread rather than copied, so a field added to the cheapest family
 * later is inherited here automatically and the declared deltas below are the
 * only lines that can drift.
 */

import {
  CHEAPEST_PROFILE_ADVISOR_CONTEXT_TOKENS,
  CHEAPEST_PROFILE_ADVISOR_TRANSCRIPT_TOKENS_DEFAULT,
  CHEAPEST_PROFILE_ADVISOR_TRANSCRIPT_TOKENS_MAX,
  CHEAPEST_PROFILE_ADVISOR_TRANSCRIPT_TOKENS_MIN,
  CHEAPEST_PROFILE_CONTRACT,
  CHEAPEST_PROFILE_DELEGATION_GRAPH,
  CHEAPEST_PROFILE_LEAD_CONTEXT_TOKENS,
  CHEAPEST_PROFILE_LEAD_EFFORT,
  CHEAPEST_PROFILE_MODELS,
  CHEAPEST_PROFILE_NATIVE_AGENT_NAMES,
  CHEAPEST_PROFILE_NATIVE_EFFORTS,
  CHEAPEST_PROFILE_ORACLE_EFFORT,
  CHEAPEST_PROFILE_SUBAGENT_CONTEXT_TOKENS,
  CHEAPEST_PROFILE_SYNTHESIZED_PEERS,
  type CheapestProfileNativeAgentName,
} from "./cheapest-profile-contract"

/**
 * The one model id this profile sends to the local endpoint.
 *
 * Bare, like the `-m local` lead: the profile assumes nothing about which model
 * answers, and the endpoint maps the id itself. It is deliberately the SAME id
 * for the Advisor and the Oracle because a second spelling would imply a
 * distinction the profile cannot observe.
 */
export const CHEAPLOCAL_CONSULT_MODEL = "opus" as const

/**
 * The Copilot model the prompt-rewrite hooks run on. Under `cheaplocal` the
 * consultants are local, but the rewrite is a Copilot dispatch and must stay
 * inside the profile's `{sol, luna}` egress ceiling, so it keeps the base
 * family's Sol rather than following `advisorModel` to the local slug.
 */
export const CHEAPLOCAL_PROFILE_REWRITE_MODEL = "gpt-5.6-sol" as const

export const CHEAPLOCAL_PROFILE_MODELS = Object.freeze({
  ...CHEAPEST_PROFILE_MODELS,
  advisor: CHEAPLOCAL_CONSULT_MODEL,
  oracle: CHEAPLOCAL_CONSULT_MODEL,
} as const)

export const CHEAPLOCAL_PROFILE_NATIVE_AGENT_NAMES =
  CHEAPEST_PROFILE_NATIVE_AGENT_NAMES

export type CheaplocalProfileNativeAgentName = CheapestProfileNativeAgentName

export const CHEAPLOCAL_PROFILE_NATIVE_MODELS: Readonly<
  Record<CheaplocalProfileNativeAgentName, string>
> = Object.freeze({
  Explore: CHEAPLOCAL_PROFILE_MODELS.explore,
  "General-Purpose": CHEAPLOCAL_PROFILE_MODELS["General-Purpose"],
  reviewer: CHEAPLOCAL_PROFILE_MODELS.reviewer,
})

export const CHEAPLOCAL_PROFILE_NATIVE_EFFORTS = CHEAPEST_PROFILE_NATIVE_EFFORTS

export const CHEAPLOCAL_PROFILE_LEAD_CONTEXT_TOKENS =
  CHEAPEST_PROFILE_LEAD_CONTEXT_TOKENS
export const CHEAPLOCAL_PROFILE_SUBAGENT_CONTEXT_TOKENS =
  CHEAPEST_PROFILE_SUBAGENT_CONTEXT_TOKENS
export const CHEAPLOCAL_PROFILE_LEAD_EFFORT = CHEAPEST_PROFILE_LEAD_EFFORT

export const CHEAPLOCAL_PROFILE_ADVISOR_MODEL =
  CHEAPLOCAL_PROFILE_MODELS.advisor
/**
 * Client-visible Advisor identity. A LABEL, not the model that answers: the
 * wire id sent to the endpoint is `CHEAPLOCAL_CONSULT_MODEL`, and nothing in
 * this profile can observe which model receives it.
 *
 * It is deliberately not a model id at all, for two reasons. First, naming a
 * model here would make the client UI claim that model is consulting, which the
 * profile cannot know. Second, Claude Code resolves a RECOGNIZED model alias
 * through its own registry before putting the value in the native Advisor
 * tool's `model` field: `--advisor opus` arrives at the proxy as
 * `claude-opus-5.5`, so an alias can never be a stable pin for the strict
 * client-drift check. `local` is not a model alias, so it passes through
 * verbatim.
 */
export const CHEAPLOCAL_PROFILE_ADVISOR_CLIENT_MODEL = "local" as const
export const CHEAPLOCAL_PROFILE_ADVISOR_CONTEXT_TOKENS =
  CHEAPEST_PROFILE_ADVISOR_CONTEXT_TOKENS
export const CHEAPLOCAL_PROFILE_ADVISOR_TRANSCRIPT_TOKENS_DEFAULT =
  CHEAPEST_PROFILE_ADVISOR_TRANSCRIPT_TOKENS_DEFAULT
export const CHEAPLOCAL_PROFILE_ADVISOR_TRANSCRIPT_TOKENS_MIN =
  CHEAPEST_PROFILE_ADVISOR_TRANSCRIPT_TOKENS_MIN
export const CHEAPLOCAL_PROFILE_ADVISOR_TRANSCRIPT_TOKENS_MAX =
  CHEAPEST_PROFILE_ADVISOR_TRANSCRIPT_TOKENS_MAX

/**
 * The declared effort is inherited but never transmitted: a local call carries
 * no `thinking` and no `output_config`, so the field exists only so the family
 * contract stays a complete object.
 */
export const CHEAPLOCAL_PROFILE_ADVISOR_EFFORT =
  CHEAPEST_PROFILE_CONTRACT.advisorEffort

export const CHEAPLOCAL_PROFILE_ORACLE_MODEL = CHEAPLOCAL_PROFILE_MODELS.oracle
export const CHEAPLOCAL_PROFILE_ORACLE_EFFORT =
  CHEAPEST_PROFILE_ORACLE_EFFORT

export const CHEAPLOCAL_PROFILE_SYNTHESIZED_PEERS =
  CHEAPEST_PROFILE_SYNTHESIZED_PEERS
export type CheaplocalProfileSynthesizedPeer =
  (typeof CHEAPLOCAL_PROFILE_SYNTHESIZED_PEERS)[number]

export const CHEAPLOCAL_PROFILE_DELEGATION_GRAPH =
  CHEAPEST_PROFILE_DELEGATION_GRAPH

/** The `-m cheaplocal` aggregate: the base contract with the two consultants
 *  pointed at the local endpoint. */
export const CHEAPLOCAL_PROFILE_CONTRACT = Object.freeze({
  ...CHEAPEST_PROFILE_CONTRACT,
  models: CHEAPLOCAL_PROFILE_MODELS,
  nativeModels: CHEAPLOCAL_PROFILE_NATIVE_MODELS,
  advisorModel: CHEAPLOCAL_PROFILE_ADVISOR_MODEL,
  advisorClientModel: CHEAPLOCAL_PROFILE_ADVISOR_CLIENT_MODEL,
  advisorEffort: CHEAPLOCAL_PROFILE_ADVISOR_EFFORT,
  oracleModel: CHEAPLOCAL_PROFILE_ORACLE_MODEL,
  rewriteModel: CHEAPLOCAL_PROFILE_REWRITE_MODEL,
  consultTransport: "local" as const,
})

export type CheaplocalProfileContract = typeof CHEAPLOCAL_PROFILE_CONTRACT

/**
 * Where the profile's two consultants are served. Every consumer branches on
 * this value rather than on the profile id, so a future local-consult variant
 * inherits the wiring instead of needing a parallel branch in each site.
 */
export type ConsultTransport =
  (typeof CHEAPEST_PROFILE_CONTRACT)["consultTransport"] | "local"
