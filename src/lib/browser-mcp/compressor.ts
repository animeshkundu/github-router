// compressor.ts — inner-LLM helpers that translate model intent into
// concrete browser actions, using a small fast hosted model (Gemini
// Flash class) routed through the existing Copilot client.
//
// The compressor sits between the lead model (Opus / Sonnet / GPT-5)
// and the browser tool primitives. Lead model issues natural-language
// intent ("click the submit button at the bottom of the login form")
// and the compressor maps that to a stable element ref from the
// snapshot the bridge already produced. This keeps the lead model out
// of element-enumeration work and cuts the click-then-read-page loop's
// token cost dramatically.
//
// Backend selection is catalog-time: at startup (and on catalog
// refresh) `pickBackendFromCatalog` walks a static fallback chain
// (Gemini Flash → GPT-5.4 mini → Claude Haiku 4.5) and picks the first
// entry present in `state.models` with `tool_calls` support. The
// picked id is stored in `selectedBackend` and reused for the lifetime
// of the proxy session.
//
// Concurrency: every compressor call acquires from the shared
// `MAX_INFLIGHT_TOOLS_CALL` budget (cap = 8), same pool as peer-MCP
// and worker tools. A wedged compressor can't starve operator traffic.
//
// All call helpers accept an `AbortSignal` for caller-driven cancel.

import consola from "consola"

import { acquireInFlightSlot } from "~/lib/mcp-inflight"
import { state } from "~/lib/state"
import {
  createChatCompletions,
  type ChatCompletionResponse,
  type ChatCompletionsPayload,
} from "~/services/copilot/create-chat-completions"
import type { Model } from "~/services/copilot/get-models"

/**
 * Static fallback chain. Order is preference: faster + multimodal +
 * cheaper at the top. All three support `tool_calls` and image input
 * (the latter is required for Phase D visual fallback).
 */
const COMPRESSOR_FALLBACK_CHAIN: ReadonlyArray<string> = [
  "gemini-3.5-flash",
  "gpt-5.4-mini",
  "claude-haiku-4-5",
]

let selectedBackend: string | undefined

/**
 * Walk the fallback chain against the live Copilot catalog. Returns
 * the first id present AND advertising `tool_calls` support, or
 * undefined when none match. Cached after first successful selection
 * so all compressor calls in a session hit the same backend; clear
 * the cache by calling `__resetCompressorBackendForTests`.
 */
export function pickBackendFromCatalog(): string | undefined {
  if (selectedBackend) return selectedBackend
  const models = state.models?.data
  if (!models) return undefined
  for (const candidate of COMPRESSOR_FALLBACK_CHAIN) {
    const found = models.find((m: Model) => m.id === candidate)
    if (!found) continue
    if (found.capabilities?.supports?.tool_calls !== true) continue
    selectedBackend = candidate
    consola.info(`[browser-mcp] compressor backend: ${candidate}`)
    return candidate
  }
  return undefined
}

/** @internal — tests reset the cached selection between cases. */
export function __resetCompressorBackendForTests(): void {
  selectedBackend = undefined
}

/**
 * True iff any compressor backend is available. Mirrors
 * `workerToolsEnabled()` / `standInToolEnabled()` — used by the
 * compound-tool capability gate so `browser_find` / `browser_act
 * (intent mode)` / `browser_extract` are dropped from `tools/list`
 * AND fail `tools/call` with -32601 when no backend is reachable.
 */
export function compressorAvailable(): boolean {
  return pickBackendFromCatalog() !== undefined
}

/**
 * One round-trip to the picked backend. Wraps slot acquisition,
 * payload assembly, and JSON-only result parsing. Throws on:
 * - no backend in catalog (caller should pre-check via the gate),
 * - slot saturation (returns null via slot — surfaces a clear retry signal),
 * - upstream rejection (surfaces the HTTPError from createChatCompletions),
 * - unparseable JSON in the reply.
 */
async function callCompressor(
  systemPrompt: string,
  userMessage: ChatCompletionsPayload["messages"][number]["content"],
  signal?: AbortSignal,
): Promise<unknown> {
  const model = pickBackendFromCatalog()
  if (!model) {
    throw new Error(
      `browser-mcp compressor: no backend available in catalog. Checked: ${COMPRESSOR_FALLBACK_CHAIN.join(", ")}`,
    )
  }
  const release = acquireInFlightSlot()
  if (!release) {
    throw new Error("browser-mcp compressor: inflight slot saturated (cap 8); try again shortly")
  }
  try {
    const payload: ChatCompletionsPayload = {
      model,
      stream: false,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMessage },
      ],
      response_format: { type: "json_object" },
    } as ChatCompletionsPayload
    const resp = (await createChatCompletions(payload, undefined, signal)) as ChatCompletionResponse
    const text = resp.choices?.[0]?.message?.content
    if (typeof text !== "string" || text.length === 0) {
      throw new Error("browser-mcp compressor: empty response from backend")
    }
    return JSON.parse(text)
  } finally {
    release()
  }
}

// ---------------------------------------------------------------------
// Public helpers
// ---------------------------------------------------------------------

export interface SnapshotElement {
  ref: string
  role: string
  name?: string
  bbox: [number, number, number, number]
}

export interface VisualSurface {
  ref: string
  kind: "canvas" | "svg"
  bbox: [number, number, number, number]
}

export interface PageSnapshot {
  mode?: "summary" | "full"
  text: string
  elements: ReadonlyArray<SnapshotElement>
  viewport: {
    width: number
    height: number
    devicePixelRatio: number
    scrollX: number
    scrollY: number
  }
  visualSurfaces?: ReadonlyArray<VisualSurface>
}

export interface PickedAction {
  ref: string
  action: "click" | "fill" | "type" | "select" | "scroll_into_view"
  value?: string
  confidence: number
}

const PICK_ELEMENT_SYSTEM = `You map a natural-language intent to ONE element from a browser page snapshot.

Snapshot elements look like: {ref: "e42", role: "button", name: "Sign in", bbox: [x,y,w,h]}.

Return JSON: {ref: string, action: "click"|"fill"|"type"|"select"|"scroll_into_view", value?: string, confidence: number from 0 to 1}.

Pick action by intent + element role:
- click for buttons, links, checkboxes, radios, switches
- fill for inputs / textareas when intent supplies a string value
- type for per-keystroke autocomplete inputs
- select for combobox / select
- scroll_into_view when the model wants to bring something on-screen

If no element matches with confidence ≥ 0.5, return {ref: "", action: "click", confidence: 0}.

Respond with ONLY the JSON object, no prose.`

/**
 * Pick a single element matching the natural-language intent. Used by
 * `browser_act` in intent mode. Returns a struct describing which ref
 * to act on, which action verb (`click` / `fill` / `type` / etc.), and
 * the compressor's confidence. When no element matches confidently the
 * returned `ref` is empty — caller should escalate to visual fallback
 * (when `visualSurfaces` is present) or surface the miss to the lead
 * model.
 */
export async function pickElement(
  snapshot: PageSnapshot,
  intent: string,
  signal?: AbortSignal,
): Promise<PickedAction> {
  // Trim snapshot elements to bare essentials before sending to the
  // backend. The bbox in the on-the-wire snapshot is for the lead
  // model's geometry; the compressor only needs ref/role/name.
  const trimmed = snapshot.elements.map((e) => ({
    ref: e.ref,
    role: e.role,
    name: e.name,
  }))
  const userPayload = JSON.stringify({
    intent,
    elements: trimmed,
    has_visual_surfaces: Boolean(snapshot.visualSurfaces && snapshot.visualSurfaces.length > 0),
  })
  const raw = await callCompressor(PICK_ELEMENT_SYSTEM, userPayload, signal)
  return normalizePickedAction(raw)
}

function normalizePickedAction(raw: unknown): PickedAction {
  if (!raw || typeof raw !== "object") {
    return { ref: "", action: "click", confidence: 0 }
  }
  const obj = raw as Record<string, unknown>
  const ref = typeof obj.ref === "string" ? obj.ref : ""
  const actionStr = typeof obj.action === "string" ? obj.action : "click"
  const validActions = ["click", "fill", "type", "select", "scroll_into_view"] as const
  const action = (validActions as ReadonlyArray<string>).includes(actionStr)
    ? (actionStr as PickedAction["action"])
    : "click"
  const value = typeof obj.value === "string" ? obj.value : undefined
  const confidence
    = typeof obj.confidence === "number"
      ? Math.max(0, Math.min(1, obj.confidence))
      : 0
  return value === undefined
    ? { ref, action, confidence }
    : { ref, action, value, confidence }
}

const FIND_ELEMENTS_SYSTEM = `You match a natural-language intent to elements from a browser page snapshot.

Snapshot elements look like: {ref: "e42", role: "button", name: "Sign in"}.

Return JSON: {matches: [{ref: string, reason: string}], up to 5 best matches ordered by relevance}.

Respond with ONLY the JSON object, no prose.`

export interface FindMatch {
  ref: string
  reason: string
}

/**
 * Return up to 5 candidate matches for an intent. Used by
 * `browser_find` — the lead model gets a small ranked list rather than
 * a full element dump. Empty array when nothing matches.
 */
export async function pickMatchingElements(
  snapshot: PageSnapshot,
  intent: string,
  signal?: AbortSignal,
): Promise<ReadonlyArray<FindMatch>> {
  const trimmed = snapshot.elements.map((e) => ({
    ref: e.ref,
    role: e.role,
    name: e.name,
  }))
  const userPayload = JSON.stringify({ intent, elements: trimmed })
  const raw = await callCompressor(FIND_ELEMENTS_SYSTEM, userPayload, signal)
  if (!raw || typeof raw !== "object") return []
  const matches = (raw as { matches?: unknown }).matches
  if (!Array.isArray(matches)) return []
  const out: Array<FindMatch> = []
  for (const m of matches.slice(0, 5)) {
    if (!m || typeof m !== "object") continue
    const ref = (m as { ref?: unknown }).ref
    const reason = (m as { reason?: unknown }).reason
    if (typeof ref === "string" && ref.length > 0) {
      out.push({ ref, reason: typeof reason === "string" ? reason : "" })
    }
  }
  return out
}

const EXTRACT_SYSTEM = `You extract structured data from a browser page snapshot into a JSON object matching the provided schema.

Use the snapshot's text + element list as your source. Be faithful to what's visible; do not invent values.

Return JSON matching the schema exactly. Respond with ONLY the JSON object, no prose.`

/**
 * Structured extraction. The schema is passed verbatim to the
 * backend (JSON schema string); the returned object is the parsed
 * JSON. Caller is responsible for validating against the schema if
 * they need stricter guarantees than the backend provides.
 */
export async function extractStructured(
  snapshot: PageSnapshot,
  schema: unknown,
  instruction: string,
  signal?: AbortSignal,
): Promise<unknown> {
  const userPayload = JSON.stringify({
    instruction,
    schema,
    snapshot: {
      text: snapshot.text,
      elements: snapshot.elements,
    },
  })
  return callCompressor(EXTRACT_SYSTEM, userPayload, signal)
}

const PICK_VISUAL_SYSTEM = `You're given a browser screenshot, a natural-language intent, and a list of canvas / svg regions in CSS-pixel coordinates.

Find the pixel coordinates in the screenshot where the intent points. Coordinates are CSS pixels (origin top-left of viewport).

Return JSON: {x: number, y: number, confidence: number from 0 to 1, reason: string}.

If no clear target is visible, return {x: 0, y: 0, confidence: 0, reason: "..."}.

Respond with ONLY the JSON object, no prose.`

export interface PickedVisual {
  x: number
  y: number
  confidence: number
  reason: string
}

/**
 * Visual fallback for Phase D — used when text-based `pickElement`
 * misses AND the snapshot reported `visualSurfaces` in the viewport
 * (a canvas / svg blackhole the a11y tree can't see into). Takes the
 * base64-encoded screenshot, the original intent, and the surfaces
 * list; returns CSS-pixel coordinates the caller dispatches to
 * `browser_mouse {x, y}`.
 */
export async function pickElementVisual(
  screenshotB64: string,
  contentType: string,
  intent: string,
  visualSurfaces: ReadonlyArray<VisualSurface>,
  signal?: AbortSignal,
): Promise<PickedVisual> {
  const userPayload = [
    {
      type: "text" as const,
      text: JSON.stringify({ intent, visual_surfaces: visualSurfaces }),
    },
    {
      type: "image_url" as const,
      image_url: { url: `data:${contentType};base64,${screenshotB64}` },
    },
  ]
  const raw = await callCompressor(PICK_VISUAL_SYSTEM, userPayload, signal)
  if (!raw || typeof raw !== "object") {
    return { x: 0, y: 0, confidence: 0, reason: "empty backend response" }
  }
  const obj = raw as Record<string, unknown>
  return {
    x: typeof obj.x === "number" ? Math.round(obj.x) : 0,
    y: typeof obj.y === "number" ? Math.round(obj.y) : 0,
    confidence: typeof obj.confidence === "number" ? Math.max(0, Math.min(1, obj.confidence)) : 0,
    reason: typeof obj.reason === "string" ? obj.reason : "",
  }
}
