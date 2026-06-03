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
 * One round-trip to the picked backend. Wraps slot acquisition, payload
 * assembly, and JSON parsing. Forces structured output via tool-calling:
 * each caller supplies a tool schema and we set `tool_choice` so the
 * model has to emit a tool call whose `arguments` field is a
 * shape-validated JSON string. This eliminates a whole class of bug
 * where models wrap their JSON in markdown code fences despite
 * `response_format: { type: "json_object" }`. As a belt-and-suspenders
 * fallback for backends that ignore `tool_choice`, we ALSO accept
 * free-form `message.content` and strip a leading / trailing ```` ``` ````
 * code fence before parsing.
 */
async function callCompressor(
  systemPrompt: string,
  userMessage: ChatCompletionsPayload["messages"][number]["content"],
  tool: { name: string; description: string; parameters: Record<string, unknown> },
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
      tools: [
        {
          type: "function",
          function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
          },
        },
      ],
      tool_choice: { type: "function", function: { name: tool.name } },
    } as ChatCompletionsPayload
    const resp = (await createChatCompletions(payload, undefined, signal)) as ChatCompletionResponse
    const choice = resp.choices?.[0]
    const msg = choice?.message as
      | {
          content?: string | null
          tool_calls?: Array<{ function?: { arguments?: string } }>
        }
      | undefined
    const toolArgs = msg?.tool_calls?.[0]?.function?.arguments
    if (typeof toolArgs === "string" && toolArgs.length > 0) {
      return JSON.parse(toolArgs)
    }
    // Fallback path: model ignored tool_choice and returned content
    // directly. Strip any markdown code fence wrapper before parsing.
    const text = typeof msg?.content === "string" ? msg.content : ""
    if (text.length === 0) {
      throw new Error("browser-mcp compressor: empty response from backend (no tool_calls and no content)")
    }
    return JSON.parse(stripCodeFence(text))
  } finally {
    release()
  }
}

/**
 * Strip a single leading / trailing ``` (or ```json) code fence from a
 * model's free-form text reply so JSON.parse works. Idempotent on
 * fence-free input. Defensive against the failure mode caught in PR #55
 * smoke-test: some models wrap JSON output in ```json ... ``` even
 * with response_format: { type: "json_object" } set.
 */
function stripCodeFence(text: string): string {
  const t = text.trim()
  // ```json\n...\n``` or ```\n...\n```
  const fenced = /^```(?:json)?\s*\n?([\s\S]*?)\n?```$/.exec(t)
  if (fenced) return fenced[1].trim()
  return t
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

/**
 * Pick a single element matching the natural-language intent. Used by
 * `browser_act` in intent mode. Internally delegates the matching step
 * to `pickMatchingElements` (the same picker `browser_find` uses) so
 * `find` and `act` can't disagree on the same intent, then infers the
 * action verb deterministically from the picked element's role and
 * whether the intent supplied a value. Single source of truth for
 * element matching.
 *
 * Returns ref="" + confidence=0 when no element matches — caller
 * should escalate to visual fallback (when `visualSurfaces` is
 * present) or surface the miss to the lead model.
 */
export async function pickElement(
  snapshot: PageSnapshot,
  intent: string,
  signal?: AbortSignal,
  value?: string,
): Promise<PickedAction> {
  const matches = await pickMatchingElements(snapshot, intent, signal)
  if (matches.length === 0) {
    return { ref: "", action: "click", confidence: 0 }
  }
  const top = matches[0]
  const el = snapshot.elements.find((e) => e.ref === top.ref)
  if (!el) {
    return { ref: "", action: "click", confidence: 0 }
  }
  const action = inferAction(el.role, intent, value)
  const out: PickedAction = { ref: top.ref, action, confidence: 0.8 }
  if (value !== undefined && (action === "fill" || action === "type" || action === "select")) {
    out.value = value
  }
  return out
}

/**
 * Deterministic action picker. Given an element role + the intent text
 * + an optional value, decide which primitive action to dispatch.
 * Pulled out of the compressor's responsibility so the compressor only
 * has to match elements (one prompt, one schema), and action selection
 * is a few small rules a future contributor can read at a glance.
 */
function inferAction(
  role: string,
  intent: string,
  value: string | undefined,
): PickedAction["action"] {
  const intentLower = intent.toLowerCase()
  const r = role.toLowerCase()
  if (/\bscroll\b/.test(intentLower) || /scroll[ -]?into[ -]?view/.test(intentLower)) {
    return "scroll_into_view"
  }
  if (r === "select" || r === "combobox") return "select"
  if (r === "textarea" || r === "input" || r === "textbox" || r === "searchbox" || r === "spinbutton") {
    // Per-keystroke 'type' only when the intent explicitly says so OR
    // there's no value provided (typing into a focused field for
    // search-as-you-type). Otherwise 'fill' is the default — faster
    // and works for React-controlled inputs.
    if (/\btype\b/.test(intentLower) && value !== undefined) return "type"
    return "fill"
  }
  return "click"
}

const FIND_ELEMENTS_SYSTEM = `You match a natural-language intent to elements from a browser page snapshot.

Snapshot elements look like: {ref: "e42", role: "button", name: "Sign in"}.

Call the find_elements tool with up to 5 best matches ordered by relevance.`

const FIND_ELEMENTS_TOOL = {
  name: "find_elements",
  description: "Report ranked element matches for the intent.",
  parameters: {
    type: "object",
    required: ["matches"],
    additionalProperties: false,
    properties: {
      matches: {
        type: "array",
        maxItems: 5,
        items: {
          type: "object",
          required: ["ref", "reason"],
          additionalProperties: false,
          properties: {
            ref: { type: "string" },
            reason: { type: "string" },
          },
        },
      },
    },
  },
}

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
  const raw = await callCompressor(FIND_ELEMENTS_SYSTEM, userPayload, FIND_ELEMENTS_TOOL, signal)
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

const EXTRACT_SYSTEM = `You extract structured data from a browser page snapshot into a JSON object matching the result schema you've been given.

Use the snapshot's text + element list as your source. Be faithful to what's visible; do not invent values.

Call the extract_result tool with your answer in the result field. The result field's schema is the caller's exact requested shape — fill it completely. If a field cannot be determined from the snapshot, omit it (when optional) or use a sensible empty value (when required).`

/**
 * Lightweight sanity check on a caller-supplied JSON Schema: the
 * schema must be a non-null object AND declare at least one of a
 * recognized `type` value, `properties`, `items`, `$ref`, or a
 * compound combinator (`oneOf` / `anyOf` / `allOf`). This catches the
 * two failure modes the prior smoke test surfaced — empty `{}` and
 * structurally-malformed schemas like `{type: "nonsense"}` — both of
 * which the permissive upstream silently accepts and the model then
 * fills with a useless primitive.
 *
 * Returns an error message string when the schema fails the check,
 * or undefined when the schema looks plausible.
 */
function validateExtractSchema(schema: unknown): string | undefined {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    return "schema must be a non-null JSON object"
  }
  const obj = schema as Record<string, unknown>
  const validTypes = new Set(["object", "array", "string", "number", "integer", "boolean", "null"])
  const hasValidType = typeof obj.type === "string" && validTypes.has(obj.type)
  const hasShape
    = "properties" in obj
      || "items" in obj
      || "$ref" in obj
      || "oneOf" in obj
      || "anyOf" in obj
      || "allOf" in obj
  if (!hasValidType && !hasShape) {
    return `schema must declare a recognized type (one of ${Array.from(validTypes).join(", ")}) OR have properties / items / $ref / oneOf / anyOf / allOf`
  }
  if ("type" in obj && !hasValidType) {
    return `schema 'type' field must be one of: ${Array.from(validTypes).join(", ")}`
  }
  return undefined
}

/**
 * Structured extraction. The caller's JSON schema is injected directly
 * into the extract_result tool's `result` parameter so the model's
 * tool-call mechanism enforces shape — the model can't satisfy the
 * call without producing data of the requested shape.
 *
 * Schema is pre-validated by `validateExtractSchema` — bad schemas
 * fail loud with a clear `SchemaValidationError` instead of slipping
 * through to the upstream (which is permissive enough to accept
 * garbage and let the model return a useless primitive).
 *
 * Post-validation: if the model's `result` ended up as a primitive
 * (string / number / boolean) when the schema declared object / array,
 * surface the shape mismatch — the model returned the wrong type and
 * the caller should know rather than receive a confusing value.
 */
export class SchemaValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "SchemaValidationError"
  }
}

export class ResultShapeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ResultShapeError"
  }
}

export async function extractStructured(
  snapshot: PageSnapshot,
  schema: unknown,
  instruction: string,
  signal?: AbortSignal,
): Promise<unknown> {
  const schemaError = validateExtractSchema(schema)
  if (schemaError) throw new SchemaValidationError(schemaError)
  const userPayload = JSON.stringify({
    instruction,
    snapshot: {
      text: snapshot.text,
      elements: snapshot.elements,
    },
  })
  const extractTool = {
    name: "extract_result",
    description: "Report the extracted object. The result field's schema is the caller's requested shape; fill it completely.",
    parameters: {
      type: "object",
      required: ["result"],
      additionalProperties: false,
      properties: {
        result: schema as Record<string, unknown>,
      },
    },
  }
  const raw = await callCompressor(EXTRACT_SYSTEM, userPayload, extractTool, signal)
  const unwrapped
    = raw && typeof raw === "object" && "result" in (raw as Record<string, unknown>)
      ? (raw as { result: unknown }).result
      : raw
  // Post-validate: declared type vs returned type. The pre-check guarantees
  // schema has a recognized type or a shape combinator at this point.
  const declaredType
    = (schema as { type?: unknown }).type as string | undefined
  if (declaredType === "object" && (typeof unwrapped !== "object" || unwrapped === null || Array.isArray(unwrapped))) {
    throw new ResultShapeError(`schema declared type "object" but model returned ${describeType(unwrapped)}`)
  }
  if (declaredType === "array" && !Array.isArray(unwrapped)) {
    throw new ResultShapeError(`schema declared type "array" but model returned ${describeType(unwrapped)}`)
  }
  return unwrapped
}

function describeType(v: unknown): string {
  if (v === null) return "null"
  if (Array.isArray(v)) return "array"
  return typeof v
}

const PICK_VISUAL_SYSTEM = `You're given a browser screenshot, a natural-language intent, and a list of canvas / svg regions in CSS-pixel coordinates.

Find the pixel coordinates in the screenshot where the intent points. Coordinates are CSS pixels (origin top-left of viewport).

Call the pick_visual tool with the coordinates. If no clear target is visible, call with x=0, y=0, confidence=0.`

const PICK_VISUAL_TOOL = {
  name: "pick_visual",
  description: "Report the pixel coordinates the intent points at.",
  parameters: {
    type: "object",
    required: ["x", "y", "confidence", "reason"],
    additionalProperties: false,
    properties: {
      x: { type: "number" },
      y: { type: "number" },
      confidence: { type: "number" },
      reason: { type: "string" },
    },
  },
}

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
  const raw = await callCompressor(PICK_VISUAL_SYSTEM, userPayload, PICK_VISUAL_TOOL, signal)
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
