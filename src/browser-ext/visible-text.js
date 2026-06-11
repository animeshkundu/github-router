// visible-text.js — the canonical visible-text walk shared by both snapshot
// extractors.
//
// It runs in TWO execution contexts:
//   1. Serialized via Function.prototype.toString() into a CDP
//      `Runtime.evaluate` expression (snapshot-cdp.js, the primary path) and
//      run PER FRAME, including same-process child frames the old top-frame-
//      only evaluate missed.
//   2. Mirrored inline inside the legacy `executeScript({func})` extractor
//      (background.js). `chrome.scripting.executeScript` serializes ONLY the
//      given function and drops its module closure, so that copy cannot
//      `import` this one — it is kept in sync by hand (see the comment there).
//
// Why a TreeWalker join instead of `element.innerText`: `innerText` glues
// adjacent inline siblings with no separator — `<span>Item-757</span>` +
// `<span>ITM_a209f4</span>` collapses to the unreadable "Item-757ITM_a209f4".
// Walking text nodes and joining with "\n" keeps distinct fields separable for
// the model.
//
// Authored in plain ES5 (no arrow / spread / optional-chaining / template
// literals) so its `.toString()` source is self-contained and survives
// bundling intact for in-page injection — a transpiler helper reference in the
// emitted source would break the serialized expression. For the same reason
// the function closes over NOTHING from module scope (constants are inlined):
// `.toString()` captures only the function body, not module-level bindings.

/**
 * Collect viewport- or render-visible text from `root`, joining text nodes
 * with "\n" and capping the result at `cap` UTF-16 code units.
 *
 * `mode` selects the per-node visibility gate:
 *   - "viewport"  : keep nodes whose parent rect intersects the frame's
 *                   viewport (what a user sees without scrolling). Needs a
 *                   live `window` + layout.
 *   - "rendered"  : keep nodes whose parent has >=1 client rect (i.e. not
 *                   display:none / detached); off-screen content IS kept.
 *                   Used by the "full" snapshot mode.
 *   - anything else (e.g. "none"): no visibility gate — keep every non-
 *                   script/style text node. Used by unit tests so the walk is
 *                   exercisable without a layout engine.
 *
 * Pure and dependency-free. `script` / `style` / `noscript` text is always
 * dropped. Returns "" for a missing root / document.
 */
export function collectVisibleText(root, cap, mode) {
  if (!root) return ""
  var doc = root.ownerDocument || (typeof document !== "undefined" ? document : null)
  if (!doc || typeof doc.createTreeWalker !== "function") return ""
  var tw = doc.createTreeWalker(root, 4) // NodeFilter.SHOW_TEXT — inlined (see header)
  var out = []
  var total = 0
  var n
  while ((n = tw.nextNode())) {
    var p = n.parentElement
    if (!p) continue
    var tag = p.tagName ? String(p.tagName).toLowerCase() : ""
    if (tag === "script" || tag === "style" || tag === "noscript") continue
    if (mode === "viewport") {
      var r = p.getBoundingClientRect()
      if (!(r.bottom > 0 && r.right > 0 && r.top < window.innerHeight && r.left < window.innerWidth)) {
        continue
      }
    } else if (mode === "rendered") {
      // display:none / detached parents report zero client rects; off-screen
      // (scrolled-out) parents still report rects, so full mode keeps them.
      // NB: `visibility:hidden` text IS kept (it retains layout boxes) — this
      // matches the "viewport" path's getBoundingClientRect behavior; excluding
      // it would need a per-node getComputedStyle (style-recalc cost) and would
      // diverge the two extractors.
      if (p.getClientRects().length === 0) continue
    }
    var s = (n.textContent || "").replace(/\s+/g, " ").trim()
    if (!s) continue
    if (total + s.length + 1 > cap) {
      out.push(s.slice(0, Math.max(0, cap - total)))
      break
    }
    out.push(s)
    total += s.length + 1
  }
  return out.join("\n")
}

/**
 * Build the in-page `Runtime.evaluate` expression that runs
 * `collectVisibleText` against the frame's document. Self-contained: the
 * function source is inlined via `.toString()` so it needs nothing from the
 * page or this module at eval time. `cap` is coerced to a number and `mode`
 * is JSON-encoded so the generated source is always a well-formed literal
 * (callers pass constants today; this keeps it injection-safe regardless).
 */
export function buildVisibleTextExpr(mode, cap) {
  return (
    "(" +
    collectVisibleText.toString() +
    ")(document.body||document.documentElement," +
    Number(cap) +
    "," +
    JSON.stringify(String(mode)) +
    ")"
  )
}
