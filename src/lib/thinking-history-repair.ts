import { createHash, randomBytes } from "node:crypto"

type AnyRecord = Record<string, unknown>

const THINKING_INTEGRITY_ERROR_RES = [
  /messages\.(\d+)\.content\.(\d+):\s*`thinking` or `redacted_thinking` blocks in the latest assistant message cannot be modified/,
  /messages\.(\d+)\.content\.(\d+):\s*Invalid `signature` in `thinking` block/,
] as const
const MAX_REMEMBERED_REPAIRS = 1000
const OMITTED_THINKING_PLACEHOLDER = "[prior reasoning omitted]"
const repairSalt = randomBytes(32)
const rememberedRepairs = new Set<string>()

export interface ThinkingHistoryRepair {
  body: string
  fingerprint: string
  messageIndex: number
  removedBlocks: number
}

/**
 * Why a repair could not be built. Every non-repair exit maps to exactly one of
 * these: a decline used to be a silent `undefined`, which is precisely why a
 * production incident of 44 rejections could not be explained after the fact.
 */
export type ThinkingRepairDeclineReason =
  | "error-not-recognized"
  | "message-index-invalid"
  | "body-not-json"
  | "no-messages-array"
  | "message-missing"
  | "message-not-assistant"
  | "content-not-array"
  | "no-signed-blocks"
  | "no-blocks-removed"
  | "ambiguous-index"

/**
 * Structural facts about the declined request. Deliberately carries no message,
 * thinking, signature, or tool content — only shapes and counts, so it is safe
 * to log verbatim.
 */
export interface ThinkingRepairDecline {
  reason: ThinkingRepairDeclineReason
  messageIndex?: number
  messageCount?: number
  roleAtIndex?: string
  blocksAtIndex?: number
  signedBlocksAtIndex?: number
  /**
   * Elements upstream would not count as conversation turns (any role that is
   * neither `user` nor `assistant`). Non-zero means this proxy's array and
   * upstream's are not indexed alike — the fact that made the original
   * `roleAtIndex=system` declines unexplainable from the log alone.
   */
  hoistedCount?: number
  /** Roles in order, e.g. `user,system,assistant`. Roles only, so log-safe. */
  roleSequence?: string
  /** Array index the hoist-adjusted fallback tried, when it ran. */
  mappedIndex?: number
}

export type ThinkingRepairOutcome =
  | { ok: true; repair: ThinkingHistoryRepair }
  | { ok: false; decline: ThinkingRepairDecline }

function declined(
  reason: ThinkingRepairDeclineReason,
  detail: Omit<ThinkingRepairDecline, "reason"> = {},
): ThinkingRepairOutcome {
  return { ok: false, decline: { reason, ...detail } }
}

/** Render a decline as a single log-safe `key=value` line. */
export function formatThinkingRepairDecline(
  decline: ThinkingRepairDecline,
): string {
  return Object.entries(decline)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(" ")
}

function isRecord(value: unknown): value is AnyRecord {
  return typeof value === "object" && value !== null
}

/** Count signed blocks without hashing — used only to explain a decline. */
function countSignedBlocks(content: Array<unknown>): number {
  return content.filter(
    (block) =>
      isRecord(block)
      && (block.type === "thinking" || block.type === "redacted_thinking"),
  ).length
}

function signedBlockFingerprint(
  _messageIndex: number,
  content: Array<unknown>,
): string | undefined {
  const hash = createHash("sha256")
  hash.update(repairSalt)
  let signedBlocks = 0
  for (let index = 0; index < content.length; index++) {
    const block = content[index]
    if (!isRecord(block)) continue
    if (block.type !== "thinking" && block.type !== "redacted_thinking") {
      continue
    }
    signedBlocks++
    hash.update(String(index))
    hash.update(String(block.type))
    if (typeof block.signature === "string") hash.update(block.signature)
    if (typeof block.data === "string") hash.update(block.data)
  }
  return signedBlocks > 0 ? hash.digest("hex") : undefined
}

function repairAtArrayIndex(
  parsed: AnyRecord,
  messageIndex: number,
): ThinkingRepairOutcome {
  if (!Array.isArray(parsed.messages)) {
    return declined("no-messages-array", { messageIndex })
  }
  const messages = [...parsed.messages]
  const detail = { messageIndex, messageCount: messages.length }
  const message = messages[messageIndex]
  if (!isRecord(message)) return declined("message-missing", detail)
  if (message.role !== "assistant") {
    return declined("message-not-assistant", {
      ...detail,
      roleAtIndex: typeof message.role === "string" ? message.role : "unknown",
    })
  }
  if (!Array.isArray(message.content)) {
    return declined("content-not-array", { ...detail, roleAtIndex: "assistant" })
  }
  const shape = {
    ...detail,
    roleAtIndex: "assistant",
    blocksAtIndex: message.content.length,
    signedBlocksAtIndex: countSignedBlocks(message.content),
  }

  const fingerprint = signedBlockFingerprint(messageIndex, message.content)
  if (!fingerprint) return declined("no-signed-blocks", shape)

  const repairedContent = message.content.filter(
    (block) =>
      !isRecord(block)
      || (block.type !== "thinking" && block.type !== "redacted_thinking"),
  )
  const removedBlocks = message.content.length - repairedContent.length
  if (removedBlocks === 0) return declined("no-blocks-removed", shape)
  // A turn that was ONLY thinking — the usual source is a turn interrupted
  // right after the thinking block — would be left with an empty `content`,
  // which Anthropic rejects, so stripping alone cannot recover it. Substitute a
  // neutral text block rather than deleting the message: keeping the turn in
  // place preserves user/assistant alternation and any tool_use/tool_result
  // pairing that spans it, both of which dropping the message would break.
  if (repairedContent.length === 0) {
    repairedContent.push({ type: "text", text: OMITTED_THINKING_PLACEHOLDER })
  }

  messages[messageIndex] = { ...message, content: repairedContent }
  parsed.messages = messages
  return {
    ok: true,
    repair: {
      body: JSON.stringify(parsed),
      fingerprint,
      messageIndex,
      removedBlocks,
    },
  }
}

/** Roles in order, for a decline log. Roles only, so it carries no content. */
function roleSequenceOf(messages: Array<unknown>): string {
  return messages
    .map((message) =>
      isRecord(message) && typeof message.role === "string"
        ? message.role
        : "unknown",
    )
    .join(",")
}

/** Elements upstream would not count as a conversation turn. */
function isHoistedElement(message: unknown): boolean {
  if (!isRecord(message)) return false
  return message.role !== "user" && message.role !== "assistant"
}

/**
 * Translate an upstream-reported message index into an index in THIS array,
 * skipping elements upstream would not have counted.
 *
 * Anthropic's Messages schema has no in-array `system` role, yet clients do
 * send one, and upstream evidently accepts it and drops it before validating —
 * which shifts every index after it. Returns undefined when nothing is hoisted
 * (the mapping would be the identity) or when the target does not exist.
 */
function hoistAdjustedIndex(
  messages: Array<unknown>,
  reportedIndex: number,
): number | undefined {
  let retained = 0
  for (let index = 0; index < messages.length; index++) {
    if (isHoistedElement(messages[index])) continue
    if (retained === reportedIndex) {
      return index === reportedIndex ? undefined : index
    }
    retained++
  }
  return undefined
}

/** True when `content[contentIndex]` is a signed thinking block. */
function hasSignedBlockAt(content: unknown, contentIndex: number): boolean {
  if (!Array.isArray(content)) return false
  const block = content[contentIndex]
  if (!isRecord(block)) return false
  return block.type === "thinking" || block.type === "redacted_thinking"
}

/**
 * Resolve the message upstream named, then repair it.
 *
 * DIRECT INDEX FIRST, hoist-adjusted index only as a fallback. The ordering is
 * the whole safety argument: every request that repairs correctly today takes
 * the direct path untouched, and the adjusted path runs only where the code
 * would otherwise have declined outright. Mapping first would REGRESS a working
 * case — with `[user, system, assistant]` and upstream naming `messages.2`, the
 * direct lookup repairs the assistant turn correctly while a retained-role
 * mapping yields only `[user, assistant]` and runs off the end.
 *
 * The fallback is self-validating rather than trusted: it is accepted only if
 * the block upstream actually named is a signed thinking block at the adjusted
 * position. If the index shift has some other cause, that check fails and the
 * original decline stands, so a wrong hypothesis fails closed instead of
 * stripping blocks from an innocent turn.
 */
/** True when `index` names an assistant carrying the block upstream reported. */
function namesReportedBlock(
  messages: Array<unknown>,
  index: number,
  contentIndex: number,
): boolean {
  const message = messages[index]
  if (!isRecord(message) || message.role !== "assistant") return false
  return hasSignedBlockAt(message.content, contentIndex)
}

/**
 * Resolve the message upstream named, then repair it.
 *
 * When nothing is hoisted, this array and upstream's are indexed alike, so the
 * reported index is used directly — the identity case, and the overwhelming
 * majority of traffic, whose behaviour is unchanged.
 *
 * When something IS hoisted, the two arrays provably disagree and the reported
 * index alone cannot say which turn was meant. Both the raw index and the
 * hoist-adjusted one can land on a signed assistant, and picking the raw one
 * blind would strip a healthy turn while leaving the corrupt one in place. So
 * the block index upstream reported is used as the tiebreak: whichever
 * candidate actually carries a signed block THERE is the one repaired. If both
 * do, the request is genuinely ambiguous and we decline — the client sees the
 * same 400 it would have seen anyway, with no innocent turn rewritten.
 */
function repairMessageAt(
  parsed: AnyRecord,
  messageIndex: number,
  contentIndex?: number,
): ThinkingRepairOutcome {
  if (!Array.isArray(parsed.messages)) {
    return repairAtArrayIndex(parsed, messageIndex)
  }
  const messages = parsed.messages
  const hoistedCount = messages.filter((m) => isHoistedElement(m)).length
  const mapped =
    hoistedCount === 0 ? undefined : hoistAdjustedIndex(messages, messageIndex)

  const annotate = (
    outcome: ThinkingRepairOutcome,
    extra: { mappedIndex?: number } = {},
  ): ThinkingRepairOutcome =>
    outcome.ok
      ? outcome
      : declined(outcome.decline.reason, {
        ...outcome.decline,
        hoistedCount,
        roleSequence: roleSequenceOf(messages),
        ...extra,
      })

  if (hoistedCount === 0 || contentIndex === undefined || mapped === undefined) {
    return annotate(repairAtArrayIndex(parsed, messageIndex))
  }

  const directNames = namesReportedBlock(messages, messageIndex, contentIndex)
  const mappedNames = namesReportedBlock(messages, mapped, contentIndex)

  if (directNames && mappedNames) {
    return declined("ambiguous-index", {
      messageIndex,
      messageCount: messages.length,
      hoistedCount,
      roleSequence: roleSequenceOf(messages),
      mappedIndex: mapped,
    })
  }
  if (mappedNames) return annotate(repairAtArrayIndex(parsed, mapped), {
    mappedIndex: mapped,
  })
  // Either the direct index is the right one, or neither candidate carries the
  // reported block and there is nothing to disambiguate with — in both cases
  // fall back to the pre-existing direct behaviour.
  return annotate(repairAtArrayIndex(parsed, messageIndex), {
    mappedIndex: mapped,
  })
}

/**
 * Build a one-shot repair only for Copilot's known signed-thinking integrity
 * rejections. The upstream error is the oracle: valid omitted-display thinking
 * also has an empty `thinking` string, so request shape alone cannot identify a
 * corrupt signature safely.
 *
 * Returns a discriminated outcome so a caller can report WHY a repair was not
 * applied; a silent decline is what made the original incident undiagnosable.
 */
export function repairRejectedThinkingHistory(
  rawBody: string,
  upstreamErrorText: string,
): ThinkingRepairOutcome {
  const match = THINKING_INTEGRITY_ERROR_RES
    .map((pattern) => pattern.exec(upstreamErrorText))
    .find((candidate): candidate is RegExpExecArray => candidate !== null)
  if (!match) return declined("error-not-recognized")
  const messageIndex = Number(match[1])
  if (!Number.isSafeInteger(messageIndex) || messageIndex < 0) {
    return declined("message-index-invalid", { messageIndex })
  }
  const parsedContentIndex = Number(match[2])
  const contentIndex =
    Number.isSafeInteger(parsedContentIndex) && parsedContentIndex >= 0
      ? parsedContentIndex
      : undefined

  let parsed: AnyRecord
  try {
    parsed = JSON.parse(rawBody) as AnyRecord
  } catch {
    return declined("body-not-json", { messageIndex })
  }
  return repairMessageAt(parsed, messageIndex, contentIndex)
}

/**
 * Reapply a repair already proven successful in this process. Only salted
 * digests are retained; no message, thinking, signature, or tool content is
 * stored.
 */
export function repairKnownThinkingHistory(
  rawBody: string,
): ThinkingHistoryRepair | undefined {
  if (rememberedRepairs.size === 0) return undefined
  let parsed: AnyRecord
  try {
    parsed = JSON.parse(rawBody) as AnyRecord
  } catch {
    return undefined
  }
  if (!Array.isArray(parsed.messages)) return undefined
  // Repair every remembered message, newest first. A match that turns out to be
  // unrepairable must not abort the scan: returning there would silently
  // suppress the repairs still pending on older messages. `repairMessageAt`
  // mutates `parsed`, so each pass builds on the last and the final result
  // carries the fully repaired body.
  let repaired: ThinkingHistoryRepair | undefined
  let totalRemovedBlocks = 0
  for (let index = parsed.messages.length - 1; index >= 0; index--) {
    const message = parsed.messages[index]
    if (!isRecord(message) || !Array.isArray(message.content)) continue
    const fingerprint = signedBlockFingerprint(index, message.content)
    if (!fingerprint || !rememberedRepairs.has(fingerprint)) continue
    // `index` came from this scan, so it is already an index into THIS array —
    // the upstream hoist adjustment must not run here or it would remap a
    // position that is by construction already correct.
    const attempt = repairAtArrayIndex(parsed, index)
    // A remembered message that cannot be repaired is not an error here — the
    // scan simply moves on. Declines matter only on the upstream-rejected path,
    // where the caller needs to explain the failure.
    if (!attempt.ok) continue
    totalRemovedBlocks += attempt.repair.removedBlocks
    repaired = { ...attempt.repair, removedBlocks: totalRemovedBlocks }
  }
  return repaired
}

export function rememberThinkingHistoryRepair(fingerprint: string): void {
  if (rememberedRepairs.has(fingerprint)) return
  if (rememberedRepairs.size >= MAX_REMEMBERED_REPAIRS) {
    const oldest = rememberedRepairs.values().next().value
    if (typeof oldest === "string") rememberedRepairs.delete(oldest)
  }
  rememberedRepairs.add(fingerprint)
}

export function __resetThinkingHistoryRepairsForTests(): void {
  rememberedRepairs.clear()
}
