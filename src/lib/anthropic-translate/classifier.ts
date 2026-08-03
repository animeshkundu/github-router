/**
 * Routing classifier for `POST /v1/messages`.
 *
 * Claude Code speaks the Anthropic Messages wire format. Copilot only serves
 * Claude models on its native `/v1/messages` endpoint; a gpt/gemini request
 * sent there 400s. This classifier decides, from the RESOLVED model id and its
 * catalog metadata, whether a request stays on the native passthrough
 * (`createMessages`) or is diverted to the translation shim.
 *
 * Non-regression is the whole point — every Claude model (opus / sonnet / haiku /
 * any `claude-*` or Anthropic-vendored id) MUST return "claude-passthrough" so
 * its bytes reach `createMessages` unchanged — even if future catalog metadata
 * were to (wrongly) advertise a `/responses` endpoint for it. The Claude check
 * is therefore keyed off identity (id / vendor / family), NOT the endpoint.
 *
 * Non-Claude models are diverted to the translation shim by the endpoint the
 * catalog says they serve: `/responses` models (gpt-5.5, gpt-5.3-codex, …) take
 * the Responses path (`responses-shim`), `/chat/completions` models (gemini,
 * and any chat-default model) take the chat path (`chat-shim`). The decision is
 * derived from `pickEndpoint` (catalog `supported_endpoints`), never a
 * hardcoded slug list, so it generalizes. Copilot only serves Claude models on
 * its native `/v1/messages`, so diverting every non-Claude model to a shim is
 * correct — a non-Claude request sent to `/v1/messages` would 400.
 */

import { pickEndpoint } from "~/services/copilot/endpoint"
import type { Model } from "~/services/copilot/get-models"

export type MessagesRoute = "claude-passthrough" | "responses-shim" | "chat-shim"

/**
 * Match "claude"/"anthropic" as a delimiter-bounded segment anywhere in a model
 * id: at the start, or after a `/ _ . : -` path/version delimiter, and followed
 * by end-of-string, another such delimiter, or a digit. This catches catalog
 * aliases like `github/claude-3-7-sonnet` or `anthropic/…` whose vendor is
 * "github" and whose family is empty — where the token only surfaces mid-id —
 * while NOT firing on incidental substrings like `notclaude`. Deliberately
 * over-inclusive at the boundaries: we fail CLOSED toward Claude (→ passthrough)
 * so a real Claude model can never be diverted to the non-Claude shim.
 */
const CLAUDE_ID_RE = /(^|[/_.:-])(claude|anthropic)(?=$|[/_.:-]|\d)/i

/**
 * True when the target is a Claude / Anthropic model. Matches on any of:
 * catalog vendor containing "anthropic", capability family containing "claude",
 * or a Claude/anthropic path-segment (see `CLAUDE_ID_RE`) in ANY id we hold —
 * the resolved id (`modelId`), the pre-resolution request id (`originalModelId`),
 * or the catalog entry's own id (`model.id`). Conservative by design: when in
 * doubt it returns true so a Claude request can never be diverted to the shim.
 */
export function isClaudeModel(
  modelId: string | undefined,
  model?: Model,
  originalModelId?: string,
): boolean {
  if (model) {
    const vendor = model.vendor?.toLowerCase() ?? ""
    if (vendor.includes("anthropic")) return true
    const family = model.capabilities?.family?.toLowerCase() ?? ""
    if (family.includes("claude")) return true
  }
  return [modelId, originalModelId, model?.id].some(
    (id) => typeof id === "string" && CLAUDE_ID_RE.test(id),
  )
}

/**
 * Decide the route for a resolved model id + its catalog entry.
 *
 * - No model id, or a Claude model → "claude-passthrough" (existing behaviour).
 * - A non-Claude model whose catalog endpoint is `/responses` → "responses-shim".
 * - A non-Claude model whose catalog endpoint is `/chat/completions` (gemini and
 *   any chat-default model) → "chat-shim".
 * - A non-Claude model absent from the catalog (so we can't confirm an endpoint)
 *   → "claude-passthrough" (unchanged; we don't divert what we can't classify).
 * - A non-Claude model that IS in the catalog and serves NEITHER of the two shim
 *   endpoints (`pickEndpoint` → undefined) → "claude-passthrough" as well.
 *
 * Those last two land on the same route but are NOT the same answer, and the
 * coincidence is deliberate rather than a collapsed default (contrast
 * `resolveEndpointForModelId`, whose callers must tell them apart because
 * guessing there produces an opaque upstream 400). Here neither shim is even a
 * candidate: a shim can only speak `/responses` or `/chat/completions`, so
 * diverting a model that serves neither would 400 just as surely. Passthrough
 * is the better default because it is sometimes RIGHT — a non-Claude catalog
 * model advertising `/v1/messages` is served by exactly the endpoint
 * passthrough uses. It also preserves this module's fail-CLOSED-toward-Claude
 * invariant: an unclassifiable model is never diverted.
 *
 * KNOWN GAP (audited, deliberately not fixed here): a non-Claude model serving
 * only something we cannot speak at all (say `/embeddings`) also lands on
 * passthrough and will still 400 upstream — `logEndpointMismatch(modelId,
 * "/v1/messages")` logs it at the passthrough seam, but no local error is
 * raised. Closing that needs a change in `src/routes/messages/handler.ts`,
 * which this seam does not own. It is strictly narrower than the defect fixed
 * in `resolveEndpointForModelId`: no such model is reachable as a Claude Code
 * `/v1/messages` target today, whereas the plan worker's `claude-opus-5`
 * default is.
 *
 * `originalModelId` is the optional pre-resolution request id; when supplied it
 * is checked for Claude-likeness alongside the resolved id so an alias that
 * resolves to a non-Claude-looking id can't slip past.
 */
export function classifyMessagesRoute(
  modelId: string | undefined,
  model?: Model,
  originalModelId?: string,
): MessagesRoute {
  if (!modelId) return "claude-passthrough"
  if (isClaudeModel(modelId, model, originalModelId)) return "claude-passthrough"
  if (!model) return "claude-passthrough"
  const endpoint = pickEndpoint(model)
  if (endpoint === "responses") return "responses-shim"
  if (endpoint === "chat") return "chat-shim"
  return "claude-passthrough"
}
