/**
 * The two request-shaping numbers every local consult shares.
 *
 * A leaf module on purpose: the profile contracts need the effort value to
 * declare it, and `local-egress.ts` needs it to send it, but the contracts must
 * not import the egress module — that module imports `profile-family`, which
 * imports the contracts, so the dependency would close a cycle. The egress
 * module re-exports both, so existing call sites and tests are unchanged.
 */

/**
 * Output cap for a local consultant turn (Advisor and Oracle).
 *
 * One number for both, and deliberately a small one: a consultant answers a
 * single question, and every larger value would be a claim about how much room
 * the model behind the endpoint has. The Copilot paths keep their own
 * catalog-derived budgets; this is only ever the catalog-less fallback, so a
 * launch whose consultants left Copilot is no worse off than the branch that
 * existed before it.
 */
export const LOCAL_CONSULT_MAX_OUTPUT_TOKENS = 4096

/**
 * Reasoning effort requested on every local consultant turn.
 *
 * This is the operator's setting, not an observation about the endpoint.
 * `output_config.effort` is the same Anthropic field Claude Code sends on its
 * own requests, and `max` is its top rung. No catalog lookup and no clamp
 * apply, because the profile has no reasoning ladder to clamp against and a
 * guessed rung would be an assumption. An endpoint that rejects the field fails
 * the consult visibly; the proxy does not quietly retry with a different body.
 *
 * The profile contracts declare this same value as their `oracleEffort`, so the
 * wire, the Oracle descriptor and the Pi agent frontmatter describe one consult
 * rather than three.
 */
export const LOCAL_CONSULT_EFFORT = "max" as const
