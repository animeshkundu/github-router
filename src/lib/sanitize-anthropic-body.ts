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
import { HTTPError } from "~/lib/error"

type AnyRecord = Record<string, unknown>

/**
 * Convert a `srvtoolu_*` id to the matching `toolu_*` id used in the
 * Copilot-replay shape (`tool_use.id` must match `^toolu_*$`). For
 * any other input shape, fall back to a synthesized `toolu_advisor_N`
 * id.
 */
function toCopilotToolUseId(srvId: string): string | undefined {
  if (srvId.startsWith("srvtoolu_")) {
    const suffix = srvId.slice("srvtoolu_".length)
    if (/^[a-zA-Z0-9_]+$/.test(suffix)) return `toolu_${suffix}`
  }
  if (/^toolu_[a-zA-Z0-9_]+$/.test(srvId)) return srvId
  return undefined
}

function invalidAdvisorHistory(message: string): never {
  throw new HTTPError(
    "Invalid advisor history",
    Response.json(
      {
        type: "error",
        error: {
          type: "invalid_request_error",
          message: `Invalid advisor history: ${message}`,
        },
      },
      { status: 400 },
    ),
  )
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
 * Translate one client-visible assistant turn into the internal messages
 * Copilot originally saw. Parallel advisor calls are replayed as one assistant
 * turn followed by one user turn containing every matching result. Sequential
 * advisor groups remain separate assistant/user pairs. When a client tool and
 * advisor coexist, the advisor results and the client's following tool results
 * are merged into the one immediate user message required by Anthropic.
 */
function splitAssistantTurnAtAdvisorPairs(
  originalMessage: AnyRecord,
  originalContent: Array<unknown>,
  followingMessage: unknown,
): {
  messages: Array<AnyRecord>
  translated: boolean
  consumedFollowingMessage: boolean
} {
  const messages: Array<AnyRecord> = []
  let currentAssistantContent: Array<unknown> = []
  let translated = false
  let emittedFirstAssistant = false

  const pushAssistant = (): void => {
    if (currentAssistantContent.length === 0) {
      invalidAdvisorHistory("advisor pair has no assistant content")
    }
    messages.push(
      emittedFirstAssistant
        ? { role: "assistant", content: currentAssistantContent }
        : { ...originalMessage, content: currentAssistantContent },
    )
    emittedFirstAssistant = true
  }

  let i = 0
  while (i < originalContent.length) {
    const block = originalContent[i]
    const b = (typeof block === "object" && block !== null) ? (block as AnyRecord) : null
    const isAdvisorUse =
      b?.type === "server_tool_use"
      && b.name === ADVISOR_INTERNAL_TOOL_NAME.replace(/^__anthropic_/, "")

    if (isAdvisorUse) {
      const uses: Array<{ serverId: string; copilotId: string }> = []
      const results = new Map<string, string>()
      let readingResults = false

      while (i < originalContent.length) {
        const candidate = originalContent[i]
        const record =
          typeof candidate === "object" && candidate !== null
            ? (candidate as AnyRecord)
            : null
        const candidateIsAdvisorUse =
          record?.type === "server_tool_use"
          && record.name === ADVISOR_INTERNAL_TOOL_NAME.replace(/^__anthropic_/, "")

        if (candidateIsAdvisorUse) {
          if (readingResults) {
            if (results.size === uses.length) break
            invalidAdvisorHistory("advisor blocks overlap or are ambiguously nested")
          }
          const serverId = typeof record.id === "string" ? record.id : ""
          const copilotId = toCopilotToolUseId(serverId)
          if (!copilotId) {
            invalidAdvisorHistory("advisor server_tool_use id is not round-trippable")
          }
          if (uses.some((use) => use.serverId === serverId)) {
            invalidAdvisorHistory("duplicate advisor server_tool_use id")
          }
          uses.push({ serverId, copilotId })
          currentAssistantContent.push({
            type: "tool_use",
            id: copilotId,
            name: ADVISOR_INTERNAL_TOOL_NAME,
            input: {},
          })
          i++
          continue
        }

        if (record?.type === "advisor_tool_result") {
          readingResults = true
          const serverId =
            typeof record.tool_use_id === "string" ? record.tool_use_id : ""
          if (!uses.some((use) => use.serverId === serverId)) {
            invalidAdvisorHistory("advisor_tool_result has no matching advisor server_tool_use")
          }
          if (results.has(serverId)) {
            invalidAdvisorHistory("duplicate advisor_tool_result")
          }
          const resultContent = record.content
          let resultText: string | undefined
          if (typeof resultContent === "string") {
            resultText = resultContent
          } else if (typeof resultContent === "object" && resultContent !== null) {
            const text = (resultContent as AnyRecord).text
            if (typeof text === "string") resultText = text
          }
          if (resultText === undefined) {
            invalidAdvisorHistory("advisor_tool_result has no replayable text")
          }
          results.set(serverId, resultText)
          i++
          continue
        }

        if (readingResults) {
          if (results.size !== uses.length) {
            invalidAdvisorHistory(
              "advisor server_tool_use has no matching advisor_tool_result in the same assistant turn",
            )
          }
          break
        }

        // Client tools and other assistant blocks emitted between parallel
        // advisor calls and their result phase belong to this assistant turn.
        currentAssistantContent.push(candidate)
        i++
      }

      if (results.size !== uses.length) {
        invalidAdvisorHistory(
          "advisor server_tool_use has no matching advisor_tool_result in the same assistant turn",
        )
      }

      const ordinaryToolIds = currentAssistantContent
        .filter(
          (entry): entry is AnyRecord =>
            typeof entry === "object"
            && entry !== null
            && (entry as AnyRecord).type === "tool_use"
            && (entry as AnyRecord).name !== ADVISOR_INTERNAL_TOOL_NAME,
        )
        .map((entry) => entry.id)
      if (ordinaryToolIds.some((id) => typeof id !== "string" || id.length === 0)) {
        invalidAdvisorHistory("client tool_use has no matchable id")
      }

      pushAssistant()
      translated = true
      const advisorResults = uses.map((use) => ({
        type: "tool_result",
        tool_use_id: use.copilotId,
        content: results.get(use.serverId)!,
      }))

      if (ordinaryToolIds.length > 0) {
        if (i < originalContent.length) {
          invalidAdvisorHistory(
            "assistant continuation followed an unresolved client tool in an advisor turn",
          )
        }
        if (
          typeof followingMessage !== "object"
          || followingMessage === null
          || (followingMessage as AnyRecord).role !== "user"
          || !Array.isArray((followingMessage as AnyRecord).content)
        ) {
          invalidAdvisorHistory(
            "mixed advisor/client-tool turn has no immediate user tool results",
          )
        }
        const following = followingMessage as AnyRecord
        const followingContent = following.content as Array<unknown>
        let sawNonResult = false
        const resultIds: Array<string> = []
        for (const entry of followingContent) {
          const record =
            typeof entry === "object" && entry !== null
              ? (entry as AnyRecord)
              : null
          if (record?.type === "tool_result") {
            if (sawNonResult) {
              invalidAdvisorHistory("tool_result appears after user text/content")
            }
            if (typeof record.tool_use_id !== "string") {
              invalidAdvisorHistory("tool_result has no matchable tool_use_id")
            }
            resultIds.push(record.tool_use_id)
          } else {
            sawNonResult = true
          }
        }
        const expected = [...ordinaryToolIds].sort()
        const actual = [...resultIds].sort()
        if (
          expected.length !== actual.length
          || expected.some((id, index) => id !== actual[index])
        ) {
          invalidAdvisorHistory(
            "mixed advisor/client-tool turn does not have exactly one result for every client tool",
          )
        }
        messages.push({
          ...following,
          content: [...advisorResults, ...followingContent],
        })
        return {
          messages,
          translated: true,
          consumedFollowingMessage: true,
        }
      }

      messages.push({ role: "user", content: advisorResults })
      currentAssistantContent = []
      continue
    }

    if (b?.type === "advisor_tool_result") {
      invalidAdvisorHistory(
        "advisor_tool_result has no immediately preceding advisor server_tool_use",
      )
    }

    currentAssistantContent.push(block)
    i++
  }

  if (currentAssistantContent.length > 0) {
    messages.push({ role: "assistant", content: currentAssistantContent })
  }
  if (!translated) {
    return {
      messages: [originalMessage],
      translated: false,
      consumedFollowingMessage: false,
    }
  }
  return {
    messages,
    translated: true,
    consumedFollowingMessage: false,
  }
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
    for (let messageIndex = 0; messageIndex < original.length; messageIndex++) {
      const msg = original[messageIndex]
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
      const {
        messages: split,
        translated,
        consumedFollowingMessage,
      } = splitAssistantTurnAtAdvisorPairs(
        msg as AnyRecord,
        content as Array<unknown>,
        original[messageIndex + 1],
      )
      if (translated) {
        anyTranslated = true
        for (const m of split) rebuilt.push(m)
        if (consumedFollowingMessage) messageIndex++
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
