// parse-intent.ts — tiny regex grammar that splits a natural-language
// intent into (verb, target, value, ordinal, quoted-name, field-hint)
// parts the deterministic matcher cascade keys on. Pure string ops,
// no LLM, ~30 lines of regex.
//
// Wrong parses fall through harmlessly: the matcher cascade tries L0
// through L7 in order, and any layer that finds no candidates simply
// hands off to the next. A misparse just means a less-targeted match
// attempt; it does NOT cause false-positive dispatches.
//
// Grammar (applied in order on the trimmed input):
//   1. verb-strip       — lifts click/fill/type/etc tokens off the front
//   2. value-extract    — captures `with <X>` / `to <X>` / `= <X>` tails
//   3. quoted-name      — captures `"<X>"` / `'<X>'` / TitleCase phrases
//   4. ordinal          — captures `first|second|...|nth <kind>`
//   5. field-hint       — captures `<noun> field|input|button|...`
//   6. normalize        — strip articles, collapse whitespace, lowercase

const VERB_RE = /^\s*(click|press|tap|fill|enter|type|select|choose|scroll(?:[ -]?into[ -]?view)?|toggle|check|uncheck|open|focus|hover)\s+/i

const VALUE_RE = /\s+(?:with|to|=)\s+(.+?)\s*$/i

const QUOTED_RE = /["'`]([^"'`]+)["'`]/

const TITLE_CASE_RE = /\b([A-Z][\w]*(?:\s+[A-Z\d][\w]*){0,3})\b/

const ORDINAL_WORDS = {
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5,
  sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10,
  last: -1,
}
const ORDINAL_WORD_RE = /\b(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|last)\s+(\w+)/i
const ORDINAL_NUM_RE = /\b(\d+)(?:st|nd|rd|th)?\s+(\w+)/i

const FIELD_HINT_KINDS = [
  "field", "input", "textbox", "box", "search",
  "dropdown", "select", "menu",
  "button", "link", "tab", "checkbox", "radio", "switch",
]
const FIELD_HINT_RE = new RegExp(
  `\\b(\\w+)\\s+(?:${FIELD_HINT_KINDS.join("|")})\\b`,
  "i",
)

const ARTICLES_RE = /\b(the|a|an|this|that)\b/gi

export interface ParsedIntent {
  /** Mapped verb when extractable; matcher's L0/L1 filter their
   * role-compat check against this. */
  verb?: "click" | "fill" | "type" | "select" | "scroll_into_view"

  /** Original intent text after a leading-verb strip (so the
   * downstream parsers see "submit button" not "click submit
   * button"). */
  rawTarget: string

  /** Normalized target: lowercased, articles stripped, trailing kind
   * nouns stripped (so "the third submit button" → "submit"). */
  normTarget: string

  /** Quoted name extracted from the intent — exact-match candidates
   * the L0 layer keys on. */
  quotedName?: string

  /** Field hint noun ("email", "password", "search") extracted from
   * "<noun> field|input|button". Drives L2 placeholder match and L7
   * heuristic semantic match. */
  fieldHint?: string

  /** Ordinal selector ("the third card" → {n:3, kind:"card"}). When
   * present, the L6 spatial layer runs. */
  ordinal?: { n: number, kind?: string }

  /** Value tail captured from "fill X with Y" / "set X to Y". The
   * caller's explicit `value` arg takes precedence, but if absent
   * the matcher falls back to this. */
  valueFromIntent?: string
}

/**
 * Parse a natural-language intent into structured parts.
 *
 * Returns a fully-formed `ParsedIntent` even for unparseable inputs
 * (rawTarget = the trimmed intent, normTarget = its lowercased
 * normalization, every other field undefined). The matcher cascade
 * handles "I don't know what to do" by falling through layer-by-
 * layer until L7 or escalate; an unparseable intent simply has
 * less signal for the layers to key on.
 */
export function parseIntent(intent: string): ParsedIntent {
  const original = String(intent ?? "").trim()
  let work = original

  // 1. Verb strip — produces a cleaner target for downstream parsers.
  let verb: ParsedIntent["verb"] | undefined
  const verbMatch = VERB_RE.exec(work)
  if (verbMatch) {
    verb = mapVerb(verbMatch[1])
    work = work.slice(verbMatch[0].length)
  }

  // 2. Value extraction — pulls `with X` / `to X` tail.
  let valueFromIntent: string | undefined
  const valueMatch = VALUE_RE.exec(work)
  if (valueMatch) {
    valueFromIntent = valueMatch[1].trim()
    work = work.slice(0, valueMatch.index).trim()
  }

  // 3. Quoted name — prefer explicit quotes; fall back to TitleCase
  // phrase of ≤4 words as a "this looks like a button label" signal.
  let quotedName: string | undefined
  const quotedMatch = QUOTED_RE.exec(work)
  if (quotedMatch) {
    quotedName = quotedMatch[1].trim()
  } else {
    const titleMatch = TITLE_CASE_RE.exec(work)
    if (titleMatch) quotedName = titleMatch[1].trim()
  }

  // 4. Ordinal — word form ("the third button") and numeric ("3rd").
  let ordinal: { n: number, kind?: string } | undefined
  const ordWordMatch = ORDINAL_WORD_RE.exec(work)
  if (ordWordMatch) {
    const n = ORDINAL_WORDS[ordWordMatch[1].toLowerCase() as keyof typeof ORDINAL_WORDS]
    if (typeof n === "number") ordinal = { n, kind: ordWordMatch[2].toLowerCase() }
  } else {
    const ordNumMatch = ORDINAL_NUM_RE.exec(work)
    if (ordNumMatch) {
      ordinal = { n: Number.parseInt(ordNumMatch[1], 10), kind: ordNumMatch[2].toLowerCase() }
    }
  }

  // 5. Field hint — extracts "<noun> field|input|button|..."
  let fieldHint: string | undefined
  const fieldMatch = FIELD_HINT_RE.exec(work)
  if (fieldMatch) fieldHint = fieldMatch[1].toLowerCase()

  // 6. Normalize: lowercase, strip articles, strip trailing kind
  // nouns, collapse whitespace.
  const rawTarget = work.trim()
  let normTarget = rawTarget.toLowerCase()
    .replace(ARTICLES_RE, "")
    .replace(/\s+/g, " ")
    .trim()
  // Strip trailing kind nouns ("submit button" → "submit") for L0/L3
  // exact-and-fuzzy name matches.
  for (const kind of FIELD_HINT_KINDS) {
    const tail = new RegExp(`\\s+${kind}$`, "i")
    if (tail.test(normTarget)) {
      normTarget = normTarget.replace(tail, "").trim()
      break
    }
  }
  // Also strip leading ordinal words from normTarget so "third card"
  // → "card" (L6 uses the ordinal kind separately).
  if (ordinal) {
    normTarget = normTarget.replace(/^(\d+(?:st|nd|rd|th)?|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|last)\s+/i, "").trim()
  }

  const out: ParsedIntent = { rawTarget, normTarget }
  if (verb) out.verb = verb
  if (quotedName) out.quotedName = quotedName
  if (fieldHint) out.fieldHint = fieldHint
  if (ordinal) out.ordinal = ordinal
  if (valueFromIntent !== undefined) out.valueFromIntent = valueFromIntent
  return out
}

function mapVerb(raw: string): ParsedIntent["verb"] | undefined {
  const v = raw.toLowerCase()
  if (v === "click" || v === "press" || v === "tap" || v === "toggle"
    || v === "check" || v === "uncheck" || v === "open") {
    return "click"
  }
  if (v === "fill" || v === "enter") return "fill"
  if (v === "type") return "type"
  if (v === "select" || v === "choose") return "select"
  if (v === "scroll" || v === "scrollintoview" || v === "scroll into view"
    || v === "scroll-into-view") {
    return "scroll_into_view"
  }
  if (v === "hover" || v === "focus") return undefined  // not yet in vocabulary
  return undefined
}
