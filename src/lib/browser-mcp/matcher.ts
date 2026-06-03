// matcher.ts — deterministic intent-to-element resolver (Phase 2 of the
// browser MCP refactor).
//
// Replaces the unconditional fast-model call in `pickElement` /
// `pickMatchingElements` with an 8-layer cascade that tries strict
// matches first (role + exact name = L0) and degrades to fuzzy / spatial
// / heuristic layers (L7). Fast model is invoked only when the cascade
// returns 0 candidates or N > 1 ambiguous candidates — the user
// constraint "no false positives, no failure ballooning" is enforced
// by the disambiguation tie-breakers (multi-candidate within 0.10 of
// each other → escalate).
//
// Pure sync, no I/O, no imports from compressor.ts (would create a
// cycle once compressor delegates to the cascade as its pre-LLM path).
// The cascade reads the snapshot shape from snapshot-types.ts directly.
//
// Layer summary (full design in plans/for-browse-mcp-and-idempotent-thimble.md):
//   L0  role + exact accessible name           score 1.00
//   L1  label association for form controls    score 0.95
//   L2  placeholder exact / contains           score 0.85 / 0.75
//   L3  accessible-name fuzzy whole-word       score 0.70
//   L4  visible text content match             score 0.65
//   L5  data-testid / id / name token match    score 0.90
//   L6  spatial ordinal ("the third card")     score 0.80
//   L7  heuristic semantic ("email field")     score 0.55

import type { PageSnapshot, SnapshotElement } from "./snapshot-types"
import type { ParsedIntent } from "./parse-intent"

export type CascadeAction
  = "click" | "fill" | "type" | "select" | "scroll_into_view"

export interface ResolveResult {
  /** Resolved ref, or empty string when escalating. */
  ref: string
  /** Action verb deterministically inferred from element role + intent. */
  action: CascadeAction
  /** Value for fill/type/select; undefined for click/scroll_into_view. */
  value?: string
  /** 0..1 — 1.0 is L0-exact, 0.55 is L7-heuristic, 0 is escalate. */
  confidence: number
  /** Which layer produced the result, or "escalate" when no layer
   * produced an unambiguous winner. Caller (compressor.ts) reads this
   * to decide whether to dispatch directly or call the fast model. */
  source: "L0" | "L1" | "L2" | "L3" | "L4" | "L5" | "L6" | "L7" | "escalate"
  /** Short human-readable reason for logs / debugging. */
  reason: string
  /** When source === "escalate", a pre-filtered top-K shortlist that
   * the caller hands to the fast model instead of the full snapshot.
   * Each entry includes the layer that surfaced it for telemetry. */
  candidates?: ReadonlyArray<{ ref: string, score: number, layer: string }>
}

interface Candidate {
  el: SnapshotElement
  score: number
  layer: ResolveResult["source"]
  reason: string
}

// ---------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------

/**
 * Resolve an intent to an action. Synchronous, no I/O, <5ms expected
 * on a 200-element snapshot.
 *
 * Returns `{source: "escalate"}` when no layer produced a single
 * confident candidate. Caller is expected to invoke the fast-model
 * fallback path with the returned `candidates` shortlist (smaller
 * than the full snapshot, so fast-model token cost drops 3-5×).
 */
export function deterministicResolve(
  snapshot: PageSnapshot,
  parsed: ParsedIntent,
  value?: string,
): ResolveResult {
  const v = value ?? parsed.valueFromIntent
  const allCandidates: Candidate[] = []

  // Try layers in order. Each layer can short-circuit if it finds a
  // single clear winner above its score floor; otherwise we accumulate
  // candidates for the escalation shortlist.
  for (const layer of LAYERS) {
    const found = layer.run(snapshot, parsed, v)
    if (found.length === 0) continue
    allCandidates.push(...found)
    // Apply tie-breakers and pick the winner for this layer.
    const winners = applyTieBreakers(found, parsed)
    const top = winners[0]
    if (!top) continue
    const runnerUp = winners[1]
    const hasClearWinner
      = top.score >= layer.floor
      && (!runnerUp || top.score - runnerUp.score >= 0.15)
    if (hasClearWinner) {
      const action = inferActionLocal(top.el.role, parsed, v)
      return {
        ref: top.el.ref,
        action,
        ...(needsValue(action) && v !== undefined ? { value: v } : {}),
        confidence: top.score,
        source: layer.name,
        reason: top.reason,
      }
    }
    // Multi-candidate ambiguity within this layer → don't escalate
    // yet; let later layers also try. Their results may disambiguate.
  }

  // No layer produced a clear winner. Escalate with a top-K shortlist.
  const shortlist = dedupeAndRank(allCandidates).slice(0, 8)
  return {
    ref: "",
    action: parsed.verb ?? "click",
    ...(v !== undefined ? { value: v } : {}),
    confidence: 0,
    source: "escalate",
    reason: shortlist.length === 0
      ? "no candidates from any cascade layer"
      : `${shortlist.length} ambiguous candidates`,
    candidates: shortlist.map((c) => ({
      ref: c.el.ref,
      score: c.score,
      layer: c.layer,
    })),
  }
}

// ---------------------------------------------------------------------
// Tie-breakers + dedup
// ---------------------------------------------------------------------

function applyTieBreakers(
  cands: Candidate[],
  parsed: ParsedIntent,
): Candidate[] {
  const verb = parsed.verb ?? "click"
  const dropDisabled = verb === "click" || verb === "fill" || verb === "type" || verb === "select"
  const filtered = cands.filter((c) => {
    if (c.el.hidden) return false
    if (c.el.bbox && (c.el.bbox[2] < 4 || c.el.bbox[3] < 4)) return false
    if (dropDisabled && c.el.disabled) return false
    return true
  })
  // Multiply scores by viewport-proximity / role-specificity weights.
  return filtered
    .map((c) => ({ ...c, score: c.score * weight(c, verb) }))
    .sort((a, b) => b.score - a.score)
}

function weight(c: Candidate, verb: string): number {
  let w = 1.0
  const bbox = c.el.bbox
  if (bbox) {
    const inViewport = bbox[0] >= 0 && bbox[1] >= 0
    if (!inViewport) w *= 0.92
  }
  if (c.el.isInIframe) w *= 0.95
  // Role specificity for click intents: button > link > menuitem > generic.
  if (verb === "click") {
    const r = (c.el.role || "").toLowerCase()
    if (r === "button") w *= 1.0
    else if (r === "link" || r === "a") w *= 0.98
    else if (r === "menuitem") w *= 0.96
    else if (r === "generic" || r === "div" || r === "span") w *= 0.90
  }
  return Math.min(1.0, w)
}

function dedupeAndRank(cands: Candidate[]): Candidate[] {
  const byRef = new Map<string, Candidate>()
  for (const c of cands) {
    const existing = byRef.get(c.el.ref)
    if (!existing || existing.score < c.score) byRef.set(c.el.ref, c)
  }
  return [...byRef.values()].sort((a, b) => b.score - a.score)
}

// ---------------------------------------------------------------------
// Action inference (mirrors compressor's inferAction; duplicated here
// to avoid a backward-import cycle. Stays trivial; if it grows beyond
// a few lines, extract to a shared utility.)
// ---------------------------------------------------------------------

function inferActionLocal(
  role: string,
  parsed: ParsedIntent,
  value: string | undefined,
): CascadeAction {
  if (parsed.verb === "scroll_into_view") return "scroll_into_view"
  const intentLower = parsed.rawTarget.toLowerCase()
  if (/\bscroll\b/.test(intentLower)) return "scroll_into_view"
  const r = (role || "").toLowerCase()
  if (r === "select" || r === "combobox") return "select"
  if (r === "textarea" || r === "input" || r === "textbox"
    || r === "searchbox" || r === "spinbutton") {
    if (parsed.verb === "type") return "type"
    if (parsed.verb === "fill") return "fill"
    return value !== undefined ? "fill" : "click"
  }
  return parsed.verb ?? "click"
}

function needsValue(action: CascadeAction): boolean {
  return action === "fill" || action === "type" || action === "select"
}

// ---------------------------------------------------------------------
// Helpers for layer predicates
// ---------------------------------------------------------------------

function nameOf(el: SnapshotElement): string {
  return (el.name ?? "").trim()
}

function nameLowerOf(el: SnapshotElement): string {
  return nameOf(el).toLowerCase()
}

function isClickableRole(role: string): boolean {
  const r = role.toLowerCase()
  return r === "button" || r === "link" || r === "a"
    || r === "menuitem" || r === "tab" || r === "checkbox"
    || r === "radio" || r === "switch" || r === "option"
    || r === "treeitem"
}

function isInputRole(role: string): boolean {
  const r = role.toLowerCase()
  return r === "textbox" || r === "input" || r === "textarea"
    || r === "searchbox" || r === "spinbutton" || r === "combobox"
    || r === "select" || r === "checkbox" || r === "radio"
}

function verbCompatible(role: string, verb: ParsedIntent["verb"]): boolean {
  if (!verb || verb === "click") return isClickableRole(role) || isInputRole(role)
  if (verb === "fill" || verb === "type" || verb === "select") return isInputRole(role)
  return true
}

function wholeWordContains(haystack: string, needle: string): boolean {
  if (!haystack || !needle) return false
  const re = new RegExp(`\\b${needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i")
  return re.test(haystack)
}

// ---------------------------------------------------------------------
// Layers
// ---------------------------------------------------------------------

interface Layer {
  name: ResolveResult["source"]
  floor: number
  run: (snapshot: PageSnapshot, parsed: ParsedIntent, value: string | undefined) => Candidate[]
}

// L0: role + exact accessible name. Mirrors Playwright getByRole({name, exact}).
const L0: Layer = {
  name: "L0",
  floor: 0.95,
  run: (snapshot, parsed) => {
    const target = parsed.quotedName ?? parsed.normTarget
    if (!target) return []
    const out: Candidate[] = []
    for (const el of snapshot.elements) {
      if (!verbCompatible(el.role, parsed.verb)) continue
      const nm = nameLowerOf(el)
      if (!nm) continue
      const tgt = target.toLowerCase()
      if (nm === tgt) {
        out.push({ el, score: 1.0, layer: "L0", reason: `L0 exact name "${el.name}"` })
      }
    }
    return out
  },
}

// L1: form input by associated label text.
const L1: Layer = {
  name: "L1",
  floor: 0.90,
  run: (snapshot, parsed) => {
    if (parsed.verb && parsed.verb !== "fill" && parsed.verb !== "type" && parsed.verb !== "select") return []
    const target = parsed.fieldHint ?? parsed.normTarget
    if (!target) return []
    const tgt = target.toLowerCase()
    const out: Candidate[] = []
    for (const el of snapshot.elements) {
      if (!isInputRole(el.role)) continue
      const nm = nameLowerOf(el)
      // The snapshot's `name` field is the platform-computed accessible
      // name; for form controls that includes the associated label
      // text. Exact match → L1. Endsuffix "*" or "(required)" forgiven.
      if (nm === tgt
        || nm === `${tgt} *`
        || nm === `${tgt} (required)`
        || (nm.endsWith(tgt) && /^[\s*()required:_-]+/.test(nm.slice(0, nm.length - tgt.length)))) {
        out.push({ el, score: 0.95, layer: "L1", reason: `L1 label "${el.name}"` })
      }
    }
    return out
  },
}

// L2: placeholder exact (0.85), then contains (0.75).
const L2: Layer = {
  name: "L2",
  floor: 0.70,
  run: (snapshot, parsed) => {
    const target = parsed.fieldHint ?? parsed.normTarget
    if (!target) return []
    const tgt = target.toLowerCase()
    const out: Candidate[] = []
    for (const el of snapshot.elements) {
      if (!isInputRole(el.role)) continue
      const ph = (el.placeholder ?? "").toLowerCase()
      if (!ph) continue
      if (ph === tgt) {
        out.push({ el, score: 0.85, layer: "L2", reason: `L2 placeholder exact "${el.placeholder}"` })
      } else if (wholeWordContains(ph, tgt)) {
        out.push({ el, score: 0.75, layer: "L2", reason: `L2 placeholder contains "${tgt}"` })
      }
    }
    return out
  },
}

// L3: accessible-name fuzzy whole-word substring.
const L3: Layer = {
  name: "L3",
  floor: 0.65,
  run: (snapshot, parsed) => {
    const target = parsed.normTarget
    if (!target) return []
    const out: Candidate[] = []
    for (const el of snapshot.elements) {
      if (!verbCompatible(el.role, parsed.verb)) continue
      const nm = nameOf(el)
      if (!nm) continue
      if (!wholeWordContains(nm, target)) continue
      // Prefer names where the match covers most of the string (the
      // name is mostly the target, not just contains it incidentally).
      const coverage = target.length / nm.length
      const score = coverage >= 0.8 ? 0.72 : 0.68
      out.push({ el, score, layer: "L3", reason: `L3 fuzzy name "${nm}"` })
    }
    return out
  },
}

// L4: visible text content match (for interactive-text roles where
// name was empty or generic).
const L4: Layer = {
  name: "L4",
  floor: 0.60,
  run: (snapshot, parsed) => {
    const target = parsed.normTarget
    if (!target) return []
    const out: Candidate[] = []
    for (const el of snapshot.elements) {
      if (!isClickableRole(el.role)) continue
      // Use `value` as a fallback when `name` is empty (some buttons
      // have only a `value` attribute, e.g. `<input type=submit value=Go>`).
      const text = (el.value ?? "").toLowerCase().trim()
      if (!text) continue
      const tgt = target.toLowerCase()
      if (text === tgt) {
        out.push({ el, score: 0.65, layer: "L4", reason: `L4 text exact "${el.value}"` })
      } else if (wholeWordContains(text, tgt)) {
        out.push({ el, score: 0.60, layer: "L4", reason: `L4 text contains "${tgt}"` })
      }
    }
    return out
  },
}

// L5: data-testid / id / name token match (when intent looks like a
// token: single short kebab/snake/camel identifier).
const L5: Layer = {
  name: "L5",
  floor: 0.85,
  run: (_snapshot, parsed) => {
    const target = parsed.normTarget
    if (!target) return []
    if (!/^[a-z][a-z0-9_-]{2,}$/i.test(target)) return []
    // The PR #55 snapshot shape doesn't surface raw id/testid/name —
    // that lives in Phase 1b-CDP. For now, the only signal is the
    // ref itself (which is data-gh-router-ref, not user-set). Layer
    // is a no-op against legacy snapshots; lights up automatically
    // once snapshot.elements gains attrs.
    return []
  },
}

// L6: spatial / ordinal ("the third card").
const L6: Layer = {
  name: "L6",
  floor: 0.75,
  run: (snapshot, parsed) => {
    if (!parsed.ordinal) return []
    const { n, kind } = parsed.ordinal
    // Bucket elements by role-or-tag matching the kind hint (when
    // present). Without a kind hint, pick the largest visible role
    // group as a fallback heuristic.
    const candidates = snapshot.elements.filter((el) => {
      if (!kind) return true
      const role = el.role.toLowerCase()
      return role === kind
        || role === `${kind}s`
        || (el.tag ?? "").toLowerCase() === kind
    })
    if (candidates.length < Math.abs(n)) return []
    // Sort by visual position: row-bucket on y, then x within row.
    const sorted = [...candidates].sort((a, b) => {
      const ay = Math.floor(a.bbox[1] / 24)
      const by = Math.floor(b.bbox[1] / 24)
      if (ay !== by) return ay - by
      return a.bbox[0] - b.bbox[0]
    })
    const idx = n === -1 ? sorted.length - 1 : n - 1
    if (idx < 0 || idx >= sorted.length) return []
    const picked = sorted[idx]
    return [{
      el: picked,
      score: 0.80,
      layer: "L6",
      reason: `L6 ordinal pick #${n} of ${sorted.length} ${kind ?? "elements"}`,
    }]
  },
}

// L7: heuristic semantic match for common field hints.
const L7: Layer = {
  name: "L7",
  floor: 0.50,
  run: (snapshot, parsed) => {
    const hint = parsed.fieldHint ?? parsed.normTarget
    if (!hint) return []
    const h = hint.toLowerCase()
    const out: Candidate[] = []
    const inputRolePred = (el: SnapshotElement) => isInputRole(el.role)
    if (h === "email") {
      for (const el of snapshot.elements) {
        if (el.inputType === "email"
          || (inputRolePred(el) && (
            wholeWordContains(el.placeholder ?? "", "email")
            || wholeWordContains(el.name ?? "", "email")
          ))) {
          out.push({ el, score: 0.55, layer: "L7", reason: "L7 email heuristic" })
        }
      }
    } else if (h === "password") {
      for (const el of snapshot.elements) {
        if (el.inputType === "password"
          || (inputRolePred(el) && wholeWordContains(el.name ?? "", "password"))) {
          out.push({ el, score: 0.55, layer: "L7", reason: "L7 password heuristic" })
        }
      }
    } else if (h === "search") {
      for (const el of snapshot.elements) {
        if (el.role === "searchbox"
          || el.inputType === "search"
          || (inputRolePred(el) && wholeWordContains(el.name ?? "", "search"))) {
          out.push({ el, score: 0.55, layer: "L7", reason: "L7 search heuristic" })
        }
      }
    } else if (h === "phone" || h === "tel") {
      for (const el of snapshot.elements) {
        if (el.inputType === "tel"
          || (inputRolePred(el) && wholeWordContains(el.name ?? "", "phone"))) {
          out.push({ el, score: 0.55, layer: "L7", reason: "L7 phone heuristic" })
        }
      }
    } else if (h === "submit" || h === "sign in" || h === "signin"
      || h === "log in" || h === "login") {
      const sumRe = /^(submit|send|continue|next|save|sign[\s-]?in|sign[\s-]?up|log[\s-]?in)$/i
      for (const el of snapshot.elements) {
        if (el.role === "button" && sumRe.test(el.name ?? "")) {
          out.push({ el, score: 0.55, layer: "L7", reason: "L7 submit heuristic" })
        }
      }
    } else if (h === "username" || h === "user") {
      for (const el of snapshot.elements) {
        if (inputRolePred(el)
          && (wholeWordContains(el.name ?? "", "user")
            || wholeWordContains(el.name ?? "", "login")
            || wholeWordContains(el.name ?? "", "account"))) {
          out.push({ el, score: 0.55, layer: "L7", reason: "L7 username heuristic" })
        }
      }
    }
    return out
  },
}

const LAYERS: ReadonlyArray<Layer> = [L0, L1, L2, L3, L4, L5, L6, L7]
