// decompose.ts — split compound intents into atomic steps the matcher
// cascade can dispatch one-at-a-time. Pure string ops, no LLM.
//
// The lead model issues one `browser_act("log in with X/Y")` call;
// `decompose` turns that into:
//   [
//     { intent: "the email or username input", value: X },
//     { intent: "the password input",          value: Y },
//     { intent: "the Sign in button" },
//   ]
// Each atomic step goes through the deterministic matcher cascade
// (Phase 2). On any step's failure with compound length > 1, the
// browser_act handler escalates the WHOLE compound to the fast-model
// planner ONCE — bounding worst-case cost to one fast-model call
// regardless of step count.
//
// Recognized templates (case-insensitive, in priority order):
//   1. login:        log in [to <site>] with USER / PASS
//   2. search-click: search [for] X and click [the] first result
//   3. conjunction:  split on " and then ", " then ", " ; ", " , and "
//   4. fallback:     single free-form step (same as today's behavior)

export type AtomicKind = "free_intent"

export interface AtomicStep {
  /** Free-form intent string passed to the matcher cascade. */
  intent: string
  /** Optional value for fill / type / select actions. */
  value?: string
}

export interface DecomposeResult {
  /** Ordered atomic steps to dispatch sequentially. */
  steps: AtomicStep[]
  /** Which template matched (for telemetry / logging). */
  template: "login" | "search_click" | "conjunction" | "fallback"
  /** Canonical summary phrasing to return on full success. Falls
   * back to joined per-step summaries when undefined. */
  successSummary?: string
}

const LOGIN_RE = /^log[ -]?in (?:to .+? )?with\s+([^\s/]+)\s*\/\s*(.+?)\s*$/i
const SEARCH_CLICK_RE = /^search\s+(?:for\s+)?(.+?)\s+and\s+click\s+(?:the\s+)?first\s+result\s*$/i

const CONJUNCTION_SPLIT_RE = /\s*(?:\s+and\s+then\s+|\s+then\s+|\s*;\s*|\s*,\s+and\s+)\s*/i

/**
 * Decompose a natural-language intent into atomic steps.
 *
 * The fallback path returns a single-step `[{intent: rawIntent}]` —
 * `browser_act` behaves identically to today's single-step dispatch
 * when no template matches.
 */
export function decompose(intent: string, value?: string): DecomposeResult {
  const raw = String(intent ?? "").trim()
  if (!raw) {
    return { steps: [{ intent: "", ...(value !== undefined ? { value } : {}) }], template: "fallback" }
  }

  // 1. Login: "log in with USER / PASS"
  const loginMatch = LOGIN_RE.exec(raw)
  if (loginMatch) {
    const user = loginMatch[1].trim()
    const pass = loginMatch[2].trim()
    return {
      steps: [
        { intent: "the email or username input", value: user },
        { intent: "the password input", value: pass },
        { intent: "the Sign in or Log in button" },
      ],
      template: "login",
      successSummary: "logged in",
    }
  }

  // 2. Search and click: "search for X and click the first result"
  const searchMatch = SEARCH_CLICK_RE.exec(raw)
  if (searchMatch) {
    const query = searchMatch[1].trim()
    return {
      steps: [
        { intent: "the search input", value: query },
        { intent: "the search button or submit" },
        { intent: "the first search result" },
      ],
      template: "search_click",
      successSummary: `searched for "${query}" and opened first result`,
    }
  }

  // 3. Conjunction: " and then ", " then ", " ; ", " , and "
  if (CONJUNCTION_SPLIT_RE.test(raw)) {
    const parts = raw.split(CONJUNCTION_SPLIT_RE).map((p) => p.trim()).filter(Boolean)
    if (parts.length >= 2) {
      return {
        steps: parts.map((p, i) => {
          // Caller's explicit `value` arg attaches to the FIRST step
          // by convention (lead model usage: "fill X and click Y" with
          // value=X). Subsequent steps don't get a value.
          if (i === 0 && value !== undefined) return { intent: p, value }
          return { intent: p }
        }),
        template: "conjunction",
      }
    }
  }

  // 4. Fallback: single atomic step.
  return {
    steps: [{ intent: raw, ...(value !== undefined ? { value } : {}) }],
    template: "fallback",
  }
}
