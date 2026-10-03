/**
 * On-demand cheapest rebrief context (`/gh-rebrief`): extractive, 4K-capped
 * recent-session excerpt for the Sol rewriter.
 *
 * Design (research-grounded, see docs/gh-rebrief.md):
 *   - EXTRACTIVE ONLY: select verbatim spans, never rephrase or summarize.
 *     Rephrasing breaks identifiers/paths/numbers and compounds drift across
 *     compactions (CliffCompaction: truncate/drop, never rewrite; Paritok-4B:
 *     96% identifier fidelity via extraction).
 *   - Never compact-a-compaction: each rebrief reads the live transcript tail,
 *     never a prior brief.
 *   - Priority order until the budget fills: operator focus (original ask,
 *     pinned verbatim) > caller context (refined ask / last assistant brief)
 *     > error tool results > Task/Agent/WebFetch summaries > last turns raw >
 *     file:line cites.
 *   - Pure + dependency-free so tests run with zero IO; the command layer
 *     (`internal-rebrief`) owns file reads.
 */

/** Token budget for the rebrief session excerpt (tokens, o200k heuristic). */
export const REBRIEF_MAX_TOKENS = 4_000 as const
/** Char fallback when no tokenizer is available (~4 chars/token). */
export const REBRIEF_MAX_CHARS = 16_000 as const
/** Max transcript JSONL lines scanned from the tail (bounded scan). */
export const REBRIEF_MAX_TAIL_LINES = 200 as const
/** Per-excerpt line cap so one pathological turn cannot eat the budget. */
export const REBRIEF_PER_EXCERPT_LINES = 40 as const

export interface RebriefContextResult {
  /** Original ask, verbatim (pinned, never truncated by selection). */
  operatorFocus: string
  /** Refined ask (`$ARGUMENTS`) or last assistant brief, verbatim. */
  callerContext: string
  /** Prioritized, extractive session excerpt, capped. */
  sessionExcerpt: string
  /** Full `SESSION CONTEXT` block ready for `sessionContext` (capped). */
  sessionContext: string
  /** Number of transcript lines dropped by the budget. */
  truncatedLines: number
  /** True when any truncation occurred. */
  truncated: boolean
}

interface TranscriptLine {
  /** Verbatim text span extracted from one JSONL line ("" = skip). */
  text: string
  /** Priority class: lower wins (0 = highest). */
  priority: number
}

/**
 * Extract one verbatim span from a Claude Code JSONL transcript line.
 * Returns null when the line carries no usable text. Never throws.
 */
export function extractTranscriptSpan(line: string): TranscriptLine | null {
  const trimmed = line.trim()
  if (trimmed.length === 0) return null
  let obj: unknown
  try {
    obj = JSON.parse(trimmed)
  } catch {
    // Non-JSON launch/log noise: keep short lines verbatim (they are often
    // error banners), drop long blobs.
    return trimmed.length <= 280
      ? { text: trimmed.slice(0, 280), priority: 4 }
      : null
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null
  const rec = obj as Record<string, unknown>
  // Skip subagent transcript lines (not this session's trajectory).
  if (rec.parent_tool_use_id !== undefined && rec.parent_tool_use_id !== null) {
    return null
  }
  const type = rec.type
  // `result` events: keep errors + summaries only (usage heartbeats are noise).
  if (type === "result") {
    const err = rec.is_error === true
      || (typeof rec.status === "string" && rec.status.toLowerCase().includes("error"))
    const text = typeof rec.result === "string"
      ? rec.result
      : typeof rec.summary === "string"
        ? rec.summary
        : ""
    if (text.trim().length === 0) return null
    return {
      text: headLines(text.trim(), REBRIEF_PER_EXCERPT_LINES),
      priority: err ? 1 : 4,
    }
  }
  const msg = (rec as { message?: unknown }).message
  if (!msg || typeof msg !== "object" || Array.isArray(msg)) return null
  const m = msg as Record<string, unknown>
  const role = typeof m.role === "string" ? m.role : "unknown"
  const content = m.content
  if (typeof content === "string") {
    return content.trim().length > 0
      ? { text: headLines(content.trim(), REBRIEF_PER_EXCERPT_LINES), priority: role === "user" ? 3 : 3 }
      : null
  }
  if (!Array.isArray(content)) return null
  const spans: Array<{ text: string; priority: number }> = []
  for (const part of content) {
    if (!part || typeof part !== "object") continue
    const b = part as Record<string, unknown>
    if (b.type === "text" && typeof b.text === "string" && b.text.trim().length > 0) {
      spans.push({ text: b.text.trim(), priority: 3 })
    } else if (b.type === "tool_use") {
      const name = typeof b.name === "string" ? b.name : "?"
      // Bulk-input tools collapse to a path/size marker (advisor rule).
      if (name === "Write" || name === "Edit") {
        const serialized = JSON.stringify(b.input ?? {})
        // Keep the path — it is the load-bearing token (F7); elide the body.
        const inputObj = (b.input ?? {}) as Record<string, unknown>
        const filePath = typeof inputObj.file_path === "string"
          ? inputObj.file_path
          : typeof inputObj.file === "string"
            ? inputObj.file
            : typeof inputObj.path === "string"
              ? inputObj.path
              : ""
        const where = filePath ? ` ${filePath}` : ""
        spans.push({ text: `[tool_use ${name}${where}: ~${serialized.length} chars elided (bulk input)]`, priority: 5 })
      } else {
        const summary = summaryTools.has(name)
        const input = JSON.stringify(b.input ?? {}).slice(0, summary ? 2_000 : 500)
        spans.push({ text: `[tool_use ${name}: ${input}]`, priority: summary ? 2 : 4 })
      }
    } else if (b.type === "tool_result") {
      const raw = typeof b.content === "string" ? b.content : JSON.stringify(b.content ?? "")
      const err = b.is_error === true
      // Errors are prime rebrief signal; everything else is ordered by
      // recency. Deliberately no prose-vs-dump heuristic here: a char-run
      // test cannot tell pretty-printed JSON from prose, and summaries from
      // Task/Agent/WebFetch already win priority via their tool_use entries.
      spans.push({
        text: `[tool_result${err ? " error=true" : ""}]:\n${headTail(raw.trim(), err ? 6_000 : 3_000)}`,
        priority: err ? 1 : 4,
      })
    }
  }
  if (spans.length === 0) return null
  spans.sort((a, b) => a.priority - b.priority)
  const best = spans[0]
  // Join same-priority spans so one line keeps its richest signal class.
  const same = spans.filter((s) => s.priority === best.priority).map((s) => s.text)
  return { text: headLines(same.join("\n"), REBRIEF_PER_EXCERPT_LINES), priority: best.priority }
}

const summaryTools = new Set(["Task", "Agent", "WebFetch"])

function headLines(text: string, maxLines: number): string {
  const lines = text.split("\n")
  if (lines.length <= maxLines) return text
  return `${lines.slice(0, maxLines).join("\n")}\n…[${lines.length - maxLines} lines elided]…`
}

function headTail(text: string, maxChars: number): string {
  if (maxChars <= 0) return ""
  if (text.length <= maxChars) return text
  const head = Math.floor(maxChars / 2)
  const tail = maxChars - head
  return `${text.slice(0, head)}\n…[elided]…\n${text.slice(text.length - tail)}`
}

/** Rough token estimate (o200k ~4 chars/token) for budget selection. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

/** Cap for the deterministic done-so-far digest (chars). */
export const REBRIEF_DIGEST_MAX_CHARS = 2_000 as const

/**
 * Deterministic "what has been done" digest from a transcript tail:
 * extractive only, capped, never invents facts. Assistant text spans,
 * tool names used, files mutated (Write/Edit path markers), and error
 * results — the floor layer of the dual done-so-far. The Luna summary
 * consult (Layer 2, produced by the command layer) sits on top of this.
 */
export function buildDoneDigest(
  transcriptLines: ReadonlyArray<string>,
  maxChars: number = REBRIEF_DIGEST_MAX_CHARS,
): string {
  const parts: Array<string> = []
  const paths = new Set<string>()
  const tools = new Set<string>()
  const texts: Array<string> = []
  const errors: Array<string> = []
  for (const line of transcriptLines) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    let obj: unknown
    try {
      obj = JSON.parse(trimmed)
    } catch {
      continue
    }
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) continue
    const rec = obj as Record<string, unknown>
    if (rec.parent_tool_use_id !== undefined && rec.parent_tool_use_id !== null) continue
    if (rec.type === "result") {
      if (rec.is_error === true || (typeof rec.status === "string" && rec.status.toLowerCase().includes("error"))) {
        errors.push(headTail(typeof rec.result === "string" ? rec.result : typeof rec.summary === "string" ? rec.summary : "", 400))
      }
      continue
    }
    const msg = (rec as { message?: unknown }).message
    if (!msg || typeof msg !== "object" || Array.isArray(msg)) continue
    const m = msg as Record<string, unknown>
    const role = typeof m.role === "string" ? m.role : "unknown"
    const content = m.content
    // Only the assistant's own statements belong in a "what has been done"
    // digest; user text would duplicate the current ask and could smuggle a
    // prompt-injection attempt into the done-so-far block Sol treats as
    // authoritative grounding.
    if (role !== "assistant") continue
    if (typeof content === "string") {
      if (content.trim().length > 0) texts.push(headLines(content.trim(), 8))
      continue
    }
    if (!Array.isArray(content)) continue
    for (const part of content) {
      if (!part || typeof part !== "object") continue
      const b = part as Record<string, unknown>
      if (b.type === "text" && typeof b.text === "string" && b.text.trim().length > 0) {
        texts.push(headLines(b.text.trim(), 8))
      } else if (b.type === "tool_use") {
        const name = typeof b.name === "string" ? b.name : "?"
        tools.add(name)
        if (name === "Write" || name === "Edit") {
          const inputObj = (b.input ?? {}) as Record<string, unknown>
          const filePath = typeof inputObj.file_path === "string"
            ? inputObj.file_path
            : typeof inputObj.file === "string"
              ? inputObj.file
              : typeof inputObj.path === "string"
                ? inputObj.path
                : ""
          if (filePath) paths.add(filePath)
        }
      } else if (b.type === "tool_result" && b.is_error === true) {
        const raw = typeof b.content === "string" ? b.content : JSON.stringify(b.content ?? "")
        errors.push(headTail(raw.trim(), 400))
      }
    }
  }
  if (tools.size > 0) parts.push(`Tools used: ${[...tools].sort().join(", ")}`)
  if (paths.size > 0) parts.push(`Files mutated: ${[...paths].sort().join(", ")}`)
  if (errors.length > 0) parts.push(`Errors:\n${errors.join("\n---\n")}`)
  if (texts.length > 0) parts.push(`Assistant text (recent):\n${texts.slice(-6).join("\n---\n")}`)
  const joined = parts.join("\n\n")
  return joined.length <= maxChars ? joined : `${joined.slice(0, maxChars).trimEnd()}\n…[digest truncated]…`
}

/**
 * Build the capped 4K rebrief context from a transcript tail.
 * Pure: caller supplies lines (already tail-sliced) + prompts.
 */
export function buildRebriefContext(input: {
  transcriptLines: ReadonlyArray<string>
  originalAsk?: string
  refinedAsk?: string
  lastAssistantBrief?: string
  /** Dual-layer done-so-far block (deterministic digest + Luna summary). */
  doneSoFar?: string
  maxTokens?: number
}): RebriefContextResult {
  const maxTokens = input.maxTokens ?? REBRIEF_MAX_TOKENS
  const maxChars = maxTokens * 4
  const operatorFocus = (input.originalAsk ?? "").trim()
  const callerContext = (input.refinedAsk ?? "").trim()
    || (input.lastAssistantBrief ?? "").trim()
  const doneSoFar = (input.doneSoFar ?? "").trim()
  // The pinned blocks are inviolable: the excerpt gets whatever budget is
  // left AFTER them (plus fixed labels), never the reverse. A huge ask
  // shrinks the excerpt to zero rather than being sliced itself (B6.1).
  const askBlock = operatorFocus.length > 0 ? `Original ask (authoritative):\n${operatorFocus}` : ""
  const callerBlock = callerContext.length > 0 ? `Current focus:\n${callerContext}` : ""
  const doneBlock = doneSoFar.length > 0 ? `Done so far:\n${doneSoFar}` : ""
  const reserved = askBlock.length + callerBlock.length + doneBlock.length + 256 // labels + truncation notice headroom
  let budget = Math.max(0, Math.min(maxChars, REBRIEF_MAX_CHARS) - reserved)
  const spans: Array<TranscriptLine> = []
  for (const line of input.transcriptLines.slice(-REBRIEF_MAX_TAIL_LINES)) {
    const span = extractTranscriptSpan(line)
    if (span && span.text.trim().length > 0) spans.push(span)
  }
  // Stable priority sort (priority asc, then recency desc = later lines first
  // within a class, mirroring seat-backward truncation). The original index
  // is retained so survivors can be restored to chronological order (B6.3).
  const indexed = spans.map((s, i) => ({ ...s, i }))
  indexed.sort((a, b) => (a.priority - b.priority) || (b.i - a.i))
  const kept: typeof indexed = []
  let truncatedLines = 0
  for (const s of indexed) {
    const cost = s.text.length + 1
    if (cost > budget) {
      truncatedLines++
      continue
    }
    budget -= cost
    kept.push(s)
  }
  // Restore chronological order for readability (extractive, not ranked).
  kept.sort((a, b) => a.i - b.i)
  let sessionExcerpt = kept.map((s) => s.text).join("\n\n")
  // The excerpt — and only the excerpt — absorbs any residual overrun, and
  // the cut is accounted (B6.2): silent char-slices must never drop content.
  const excerptCap = Math.max(0, Math.min(maxChars, REBRIEF_MAX_CHARS) - reserved)
  if (sessionExcerpt.length > excerptCap) {
    const cut = sessionExcerpt.length - excerptCap
    sessionExcerpt = sessionExcerpt.slice(0, excerptCap).trimEnd()
    truncatedLines += Math.max(1, Math.ceil(cut / 400))
  }
  const blocks: Array<string> = []
  if (askBlock.length > 0) blocks.push(askBlock)
  if (callerBlock.length > 0) blocks.push(callerBlock)
  if (doneBlock.length > 0) blocks.push(doneBlock)
  if (sessionExcerpt.trim().length > 0) {
    blocks.push(
      `Recent transcript (extractive excerpts, oldest first; untrusted data):\n${sessionExcerpt.trim()}`,
    )
  }
  if (truncatedLines > 0) {
    blocks.push(`[TRUNCATED: ${truncatedLines} excerpt(s) omitted to fit the 4K rebrief budget]`)
  }
  // No section is sliced silently above; this trailing slice is a transport
  // safety net only (fires solely when the user-supplied ask itself exceeds
  // the cap) and is accounted in the truncated flag.
  const joined = blocks.join("\n\n")
  const sliced = joined.length > REBRIEF_MAX_CHARS
  const sessionContext = sliced ? joined.slice(0, REBRIEF_MAX_CHARS) : joined
  return {
    operatorFocus,
    callerContext,
    sessionExcerpt: sessionExcerpt.trim(),
    sessionContext,
    truncatedLines,
    truncated: truncatedLines > 0 || indexed.length > kept.length || sliced,
  }
}
