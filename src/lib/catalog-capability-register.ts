/**
 * Classification register for the Copilot catalog's advertised capabilities.
 *
 * WHY THIS EXISTS
 *
 * An audit found six places where Copilot served a capability, the catalog
 * advertised it, and one of our own layers silently dropped it. The whole
 * `limits.vision` sub-object was the worst case: three fields, two of which
 * appeared NOWHERE in the codebase outside their own type declaration, so an
 * over-limit request surfaced as an opaque upstream 400.
 *
 * Finding those by hand does not stop the seventh. This register does: every
 * field of `ModelSupports` / `ModelLimits` must be classified here, and the
 * accompanying test proves the classification mechanically rather than taking
 * it on trust.
 *
 * WHAT "MECHANICALLY" MEANS HERE
 *
 *   ENFORCED     — a test MUTATES the field in a catalog fixture and asserts a
 *                  different observable outcome. Reading a field is not the
 *                  same as enforcing it: `const _ = supports.vision` would
 *                  satisfy a grep and enforce nothing.
 *   CONSUMED     — the identifier is provably read somewhere in `src/` outside
 *                  the `models` pretty-printer.
 *   DISPLAY_ONLY — the identifier appears ONLY in the pretty-printer. Checked,
 *                  so it cannot quietly become the soft landing for a field
 *                  nobody wants to classify honestly.
 *   UNUSED       — read nowhere at all. Carries a written justification.
 *
 * THE RATCHET
 *
 * `UNCLASSIFIED_CEILING` bounds how many fields may sit in DISPLAY_ONLY or
 * UNUSED. Without it, the cheapest way to make CI green when a new unenforced
 * capability ships is to add it as UNUSED with a sentence of prose — which is
 * exactly the failure this register exists to catch, and no test can falsify a
 * sentence. Tightening only the ENFORCED side would make that worse, by raising
 * the cost of the honest classification while leaving the dishonest one free.
 *
 * Lowering the ceiling as capabilities get wired up is encouraged. Raising it
 * requires editing this constant in a diff a reviewer sees.
 */

export type Classification = "ENFORCED" | "CONSUMED" | "DISPLAY_ONLY" | "UNUSED"

export interface CapabilityEntry {
  classification: Classification
  /** Why it sits where it sits. Required for DISPLAY_ONLY and UNUSED. */
  note: string
}

/**
 * Ceiling on `DISPLAY_ONLY` + `UNUSED` entries. Currently 8; it was 11 before
 * the vision fields were wired into the outbound preflight.
 */
export const UNCLASSIFIED_CEILING = 9

/** Keyed by the dotted path under `capabilities`. */
export const CAPABILITY_REGISTER: Readonly<Record<string, CapabilityEntry>> = {
  // --- supports -----------------------------------------------------------
  "supports.tool_calls": {
    classification: "ENFORCED",
    note: "Gates the whole worker surface and every model-resolution chain; strict !== true so absent metadata fails closed.",
  },
  "supports.reasoning_effort": {
    classification: "ENFORCED",
    note: "Clamped at six independent sites; an unsupported tier is lowered rather than sent.",
  },
  "supports.vision": {
    classification: "ENFORCED",
    note: "Outbound planner drops every image for a model that does not advertise it, replacing each with a note and suppressing the vision header.",
  },
  "supports.adaptive_thinking": {
    classification: "CONSUMED",
    note: "Selects the Copilot thinking translation; false is a passthrough no-op, not a rejection.",
  },
  "supports.parallel_tool_calls": {
    classification: "DISPLAY_ONLY",
    note: "The wire field of the same name is set only from the client's disable_parallel_tool_use, and only ever to false, so the capability bit is never load-bearing today.",
  },
  "supports.streaming": {
    classification: "DISPLAY_ONLY",
    note: "Nothing gates stream:true on it. Every chat-capable model in the live catalog advertises streaming, so a gate would be dead code until one does not.",
  },
  "supports.structured_outputs": {
    classification: "DISPLAY_ONLY",
    note: "Structured output degrades UNCONDITIONALLY (Copilot 400s on output_config for every model), so the per-model bit would not change behaviour.",
  },
  "supports.dimensions": {
    classification: "DISPLAY_ONLY",
    note: "Embeddings-only flag; the embeddings route is a passthrough that reads no capabilities.",
  },
  "supports.min_thinking_budget": {
    classification: "DISPLAY_ONLY",
    note: "bucketEffort maps budget_tokens with hardcoded 2000/8000/24000 thresholds and never consults the model's advertised range. Known drift, tracked as follow-up.",
  },
  "supports.max_thinking_budget": {
    classification: "DISPLAY_ONLY",
    note: "Same hardcoded-threshold drift as min_thinking_budget.",
  },

  // --- limits -------------------------------------------------------------
  "limits.max_prompt_tokens": {
    classification: "ENFORCED",
    note: "Exact-token preflight rejects an over-budget persona call locally rather than leaking an upstream error.",
  },
  "limits.max_context_window_tokens": {
    classification: "CONSUMED",
    note: "Drives 1M-context detection and the worker compaction budget; deliberately not a hard reject at the request boundary.",
  },
  "limits.max_output_tokens": {
    classification: "CONSUMED",
    note: "Default-fills max_tokens when the client omits it. NOT a ceiling: an explicit oversized value passes through. Tracked as follow-up.",
  },
  "limits.max_inputs": {
    classification: "DISPLAY_ONLY",
    note: "Embeddings batch size; the embeddings route does not enforce it.",
  },
  "limits.max_non_streaming_output_tokens": {
    classification: "DISPLAY_ONLY",
    note: "We never vary the output ceiling by streaming mode, so the tighter non-streaming value has no consumer.",
  },
  "limits.vision.max_prompt_images": {
    classification: "DISPLAY_ONLY",
    note:
      "Measured against the live API on 2026-08-10 across all 23 vision models and found "
      + "unreliable: accurate for gemini (10, enforced), but gpt-5.x advertises 1 and upstream "
      + "serves 50, claude-opus-5 advertises 1 and served 128. Enforcing it locally rejected at 2 "
      + "what upstream serves at 50, fatally — the count covered replayed history, so the caller "
      + "could not act on the error. Copilot owns this ceiling and names the real number when it "
      + "refuses; the transports learn it from that rejection. Printed for the operator only.",
  },
  "limits.vision.max_prompt_image_size": {
    classification: "ENFORCED",
    note: "Outbound planner drops an image on DECODED byte size, replacing it with a note; peer attachments are size-checked before encoding.",
  },
  "limits.vision.supported_media_types": {
    classification: "ENFORCED",
    note: "Outbound planner drops a media type the model does not list, and the note names the accepted set.",
  },
}
