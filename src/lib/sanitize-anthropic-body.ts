/**
 * Inbound /v1/messages body sanitizer.
 *
 * Today this only handles ADVISOR-related corruption — the
 * proxy-generated `server_tool_use{name:"advisor"}` and paired
 * `advisor_tool_result` blocks may travel through Claude Code's
 * persisted conversation state with a malformed `id`/`tool_use_id`
 * (e.g., a leftover `toolu_*` value from before the round-5 fix).
 * Every replay of that history through `/v1/messages` would 400 at
 * Copilot's spec validator without rewriting them on inbound. This
 * module performs the rewrite.
 *
 * **Out of scope** (deliberate, per gemini-critic round 6 — the "ID
 * round-trip trap"): generic `tool_use.id` and `tool_result.tool_use_id`
 * are stateful references between requests; rewriting them statelessly
 * would break Claude Code's client-side tool tracker. Only advisor
 * blocks are touched here, because both sides of an advisor pair
 * (`server_tool_use` + `advisor_tool_result`) are proxy-generated and
 * round-trip together in the same request body — so a per-request
 * deterministic transformation preserves pairing without cross-request
 * state.
 *
 * **Round-7 holistic fix**: Copilot rejects `server_tool_use{name:
 * "advisor"}` outright (spec validator says only `web_search`,
 * `tool_search_tool_regex`, `tool_search_tool_bm25` are allowed), so
 * fixing the id format alone isn't enough. The sanitizer also
 * **translates** historical advisor pairs to the
 * `tool_use{__anthropic_advisor}` + `tool_result` shape Copilot
 * accepts (per user direction "Option C"). Multi-turn split is
 * required because `tool_result` must appear in a `user` role per
 * Anthropic spec. The `__anthropic_advisor` tool definition is
 * re-injected into `tools[]` so the `tool_use.name` reference
 * resolves.
 */
import {
  ADVISOR_INTERNAL_TOOL_NAME,
  ADVISOR_TOOL_INSTRUCTIONS,
} from "~/services/advisor/advisor"

type AnyRecord = Record<string, unknown>

/**
 * Convert a `srvtoolu_*` id to the matching `toolu_*` id used in the
 * Copilot-replay shape (`tool_use.id` must match `^toolu_*$`). For
 * any other input shape, fall back to a synthesized `toolu_advisor_N`
 * id.
 */
function toCopilotToolUseId(srvId: string, fallbackIndex: number): string {
  if (srvId.startsWith("srvtoolu_")) {
    const suffix = srvId.slice("srvtoolu_".length)
    if (/^[a-zA-Z0-9_]+$/.test(suffix)) return `toolu_${suffix}`
  }
  return `toolu_advisor_${fallbackIndex}`
}

/**
 * Fast-path detector: returns true if the raw body has any chance of
 * needing sanitization. Avoids a full JSON parse for the common case
 * where the body is already spec-compliant.
 *
 * Looks for either an Anthropic-native advisor typed tool entry, or
 * any advisor-related block type that would need rewriting/
 * translating.
 */
function bodyMightNeedSanitize(rawBody: string): boolean {
  return (
    rawBody.includes('"server_tool_use"')
    || rawBody.includes('"advisor_tool_result"')
    || /"type":"advisor_\d+"/.test(rawBody)
  )
}

/**
 * Translate one assistant turn's content array, splitting at advisor
 * pairs into the multi-message structure Copilot accepts.
 *
 * Input shape (Claude Code stores everything in one assistant turn):
 *   [text*, server_tool_use{advisor}, advisor_tool_result, text*, ...]
 *
 * Output: array of {role, content[]} message objects, alternating
 * assistant→user→assistant for each advisor pair encountered.
 */
function splitAssistantTurnAtAdvisorPairs(
  originalContent: Array<unknown>,
  syntheticIndexRef: { value: number },
): { messages: Array<AnyRecord>; translated: boolean } {
  const messages: Array<AnyRecord> = []
  let currentAssistantContent: Array<unknown> = []
  let translated = false
  // Walk linearly. When we see `server_tool_use{name:"advisor"}`,
  // expect the very next block to be `advisor_tool_result`. Translate
  // both, split into assistant→user→[continued assistant].
  let i = 0
  while (i < originalContent.length) {
    const block = originalContent[i]
    const b = (typeof block === "object" && block !== null) ? (block as AnyRecord) : null

    if (
      b
      && b.type === "server_tool_use"
      && b.name === ADVISOR_INTERNAL_TOOL_NAME.replace(/^__anthropic_/, "") // "advisor"
    ) {
      const stuId = typeof b.id === "string" ? b.id : ""
      // The next block should be the paired advisor_tool_result.
      const nextBlock = originalContent[i + 1]
      const next =
        typeof nextBlock === "object" && nextBlock !== null
          ? (nextBlock as AnyRecord)
          : null

      // Synthesize a Copilot-shape toolu_* id for the translated pair.
      // Prefer to derive from the existing id (preserves any
      // identifying suffix); if malformed, fall back to a synthesized
      // advisor_N id. Then both blocks of the pair get the SAME id.
      const copilotId = stuId.startsWith("srvtoolu_")
        ? toCopilotToolUseId(stuId, syntheticIndexRef.value++)
        : stuId.startsWith("toolu_") && /^toolu_[a-zA-Z0-9_]+$/.test(stuId)
          ? stuId
          : `toolu_advisor_${syntheticIndexRef.value++}`

      // Emit the assistant turn so far + the translated tool_use.
      currentAssistantContent.push({
        type: "tool_use",
        id: copilotId,
        name: ADVISOR_INTERNAL_TOOL_NAME,
        input: {},
      })
      messages.push({ role: "assistant", content: currentAssistantContent })
      translated = true

      // Translate the paired advisor_tool_result → tool_result in a
      // new user turn.
      let resultText = ""
      if (next && next.type === "advisor_tool_result") {
        const c = next.content
        if (typeof c === "string") {
          resultText = c
        } else if (typeof c === "object" && c !== null) {
          const txt = (c as AnyRecord).text
          if (typeof txt === "string") resultText = txt
        }
        i += 2 // consume both blocks
      } else {
        // No paired result block — synthesize an empty result so
        // Copilot's tool-use/tool-result pairing stays consistent.
        resultText = "[Advisor result missing in conversation history.]"
        i += 1
      }
      messages.push({
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: copilotId,
            content: resultText,
          },
        ],
      })

      // Start a fresh assistant content array for any blocks after
      // the advisor pair.
      currentAssistantContent = []
      continue
    }

    if (b && b.type === "advisor_tool_result") {
      // Stray advisor_tool_result without a preceding server_tool_use.
      // Drop it — sending it to Copilot would 400. Loss is minor:
      // this only happens if Claude Code's history is corrupt.
      translated = true
      i += 1
      continue
    }

    // Pass-through any other block.
    currentAssistantContent.push(block)
    i += 1
  }

  // Flush any trailing assistant content as a final message.
  if (currentAssistantContent.length > 0) {
    messages.push({ role: "assistant", content: currentAssistantContent })
  }
  // If we never split (no advisor blocks), return the original as one
  // message so the caller can detect "no change" and short-circuit.
  if (!translated) {
    return {
      messages: [{ role: "assistant", content: originalContent }],
      translated: false,
    }
  }
  return { messages, translated: true }
}

export function sanitizeAnthropicBody(rawBody: string): string {
  if (!bodyMightNeedSanitize(rawBody)) return rawBody

  let parsed: AnyRecord
  try {
    parsed = JSON.parse(rawBody) as AnyRecord
  } catch {
    return rawBody
  }

  let mutated = false

  // 1. Strip Anthropic-native `advisor_*` typed tools from `tools[]`.
  //    Copilot 400s on the unknown tool type. Always-strip (vs only
  //    when ADVISOR is enabled per `injectAdvisorTool`) covers the case
  //    where Claude Code injects the typed tool independently of the
  //    beta header.
  if (Array.isArray(parsed.tools)) {
    const tools = parsed.tools as Array<unknown>
    const before = tools.length
    const filtered = tools.filter((t) => {
      if (typeof t !== "object" || t === null) return true
      const type = (t as AnyRecord).type
      return typeof type !== "string" || !type.startsWith("advisor_")
    })
    if (filtered.length !== before) {
      parsed.tools = filtered
      mutated = true
    }
  }

  // 2. Walk messages[] and translate any assistant turns that contain
  //    advisor blocks (server_tool_use{name:"advisor"} +
  //    advisor_tool_result). Per user direction round-7 "Option C":
  //    rewrite to the tool_use{__anthropic_advisor} + tool_result
  //    shape Copilot accepts, splitting into multi-turn assistant→
  //    user→assistant as needed (Anthropic spec requires tool_result
  //    in user role).
  if (Array.isArray(parsed.messages)) {
    const original = parsed.messages as Array<unknown>
    const rebuilt: Array<unknown> = []
    let anyTranslated = false
    const syntheticIndexRef = { value: 0 }
    for (const msg of original) {
      if (
        typeof msg !== "object"
        || msg === null
        || (msg as AnyRecord).role !== "assistant"
      ) {
        rebuilt.push(msg)
        continue
      }
      const content = (msg as AnyRecord).content
      if (!Array.isArray(content)) {
        rebuilt.push(msg)
        continue
      }
      // Quick check: does this assistant turn contain any advisor
      // blocks? If not, pass through unchanged.
      const hasAdvisorBlocks = content.some((b) => {
        if (typeof b !== "object" || b === null) return false
        const type = (b as AnyRecord).type
        const name = (b as AnyRecord).name
        return (
          (type === "server_tool_use" && name === "advisor")
          || type === "advisor_tool_result"
        )
      })
      if (!hasAdvisorBlocks) {
        rebuilt.push(msg)
        continue
      }
      const { messages: split, translated } = splitAssistantTurnAtAdvisorPairs(
        content as Array<unknown>,
        syntheticIndexRef,
      )
      if (translated) {
        anyTranslated = true
        for (const m of split) rebuilt.push(m)
      } else {
        rebuilt.push(msg)
      }
    }
    if (anyTranslated) {
      parsed.messages = rebuilt
      mutated = true
      // Re-inject __anthropic_advisor tool definition into tools[]
      // so the translated tool_use.name resolves at Copilot's
      // validator. Idempotent: skip if already present.
      const existingTools = Array.isArray(parsed.tools)
        ? (parsed.tools as Array<unknown>)
        : []
      const alreadyInjected = existingTools.some((t) => {
        if (typeof t !== "object" || t === null) return false
        return (t as AnyRecord).name === ADVISOR_INTERNAL_TOOL_NAME
      })
      if (!alreadyInjected) {
        parsed.tools = [
          ...existingTools,
          {
            name: ADVISOR_INTERNAL_TOOL_NAME,
            description: ADVISOR_TOOL_INSTRUCTIONS,
            input_schema: {
              type: "object",
              properties: {},
              required: [],
            },
          },
        ]
      }
    }
  }

  if (!mutated) return rawBody
  return JSON.stringify(parsed)
}

