// observe.ts — natural-language page describer for the lead model.
//
// `browser_observe` is the lead-model's orientation tool: it returns
// a compact prose description of the current page state (forms,
// buttons, links, content sections) without leaking DOM details like
// refs, bboxes, or role/name dumps. The lead model uses this to know
// "where am I and what can I do here" before issuing intent via
// `browser_act`.
//
// Implementation: trim the snapshot to the bare essentials the
// describer needs (text + element role/name list), pass to the fast
// model via the same `callCompressor` path the other compound tools
// use (forced tool-calling, shared inflight-slot budget).
//
// Result shape mirrors what a screen-reader user gets verbally —
// short, focused, action-oriented. Lead model receives ~200-500
// tokens of prose, dramatically less than the multi-KB snapshot it
// would otherwise see via `browser_read_page`.

import { callCompressorPublic } from "./compressor"
import type { PageSnapshot } from "./snapshot-types"

export interface ObserveResult {
  description: string
  hasVisualSurfaces: boolean
  url?: string
  title?: string
}

const OBSERVE_SYSTEM = `You describe a web page for an AI assistant that cannot see the DOM.

Write 2-4 sentences focused on user-actionable elements (forms, buttons, links) and the page's purpose. If 'intent' is provided, focus the description on the region most relevant to that intent.

DO NOT mention DOM refs, selectors, bbox coordinates, or any internal identifiers. Plain prose only. Treat the reader as someone who will issue commands like "click the Sign In button" — describe what's there in terms they can act on.

Call the describe_page tool with your description.`

const OBSERVE_TOOL = {
  name: "describe_page",
  description: "Report the natural-language description of the page.",
  parameters: {
    type: "object",
    required: ["description"],
    additionalProperties: false,
    properties: {
      description: {
        type: "string",
        description: "2-4 sentence prose description of the visible page state.",
      },
    },
  },
}

/**
 * Produce a natural-language description of the current page state.
 * The lead model never sees the underlying snapshot.
 */
export async function observePage(
  snapshot: PageSnapshot,
  intent: string | undefined,
  signal?: AbortSignal,
): Promise<ObserveResult> {
  // Trim the snapshot to what the describer can reason about — text
  // body + element role/name list. Bbox / state flags / frame ids
  // would just inflate tokens without helping the prose output.
  const trimmedElements = snapshot.elements
    .filter((e) => e.name && e.name.length > 0)  // unnamed elements add no signal
    .slice(0, 80)
    .map((e) => ({ role: e.role, name: e.name }))
  const userPayload = JSON.stringify({
    intent: intent ?? "",
    url: snapshot.url ?? "",
    title: snapshot.title ?? "",
    visible_text: (snapshot.text ?? "").slice(0, 4000),
    actionable_elements: trimmedElements,
    has_visual_surfaces: Boolean(snapshot.visualSurfaces && snapshot.visualSurfaces.length > 0),
  })
  const raw = await callCompressorPublic(OBSERVE_SYSTEM, userPayload, OBSERVE_TOOL, signal)
  const description = (raw && typeof raw === "object"
    && typeof (raw as { description?: unknown }).description === "string")
    ? (raw as { description: string }).description
    : "Page contents could not be described."
  const out: ObserveResult = {
    description,
    hasVisualSurfaces: Boolean(snapshot.visualSurfaces && snapshot.visualSurfaces.length > 0),
  }
  if (snapshot.url) out.url = snapshot.url
  if (snapshot.title) out.title = snapshot.title
  return out
}
