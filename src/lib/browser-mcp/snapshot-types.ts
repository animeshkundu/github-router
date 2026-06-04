// snapshot-types.ts — shared contract for the browser MCP snapshot
// pipeline. Extracted from compressor.ts so the deterministic matcher
// cascade can import these without dragging in the inner-LLM module
// (which would create a circular dependency once the cascade is wired
// in as the pre-compressor fallback).
//
// The schema is the SINGLE SOURCE OF TRUTH for what the extension
// produces, what the matcher consumes, and what the observe / extract
// helpers read. Adding a field here is a contract change — update
// every consumer in the same commit.
//
// Compatibility with the pre-deterministic-refactor shape (PR #55):
// every new field is OPTIONAL. The extension can still emit the
// trimmed legacy shape and downstream code continues to function;
// the new fields light up additional matcher layers as they become
// available.

/**
 * One interactive element discovered in the page. The fields beyond
 * `ref`/`role`/`name`/`bbox` are populated only when the extraction
 * pipeline can supply them (CDP a11y tree path fills more than the
 * legacy DOM-walker path).
 */
export interface SnapshotElement {
  /** Stable identifier, persisted as `data-gh-router-ref` on the DOM
   * node. Survives across snapshots of the same document. */
  ref: string

  /** ARIA role. Platform-computed when available (CDP a11y tree);
   * falls back to the lowercased HTML tag. */
  role: string

  /** Accessible name (≤200 chars). Computed by the platform from
   * aria-label / aria-labelledby / `<label for>` / placeholder /
   * textContent in the order the platform prefers. Omitted when
   * empty so the wire shape stays small. */
  name?: string

  /** aria-describedby content (≤200 chars). Used by the matcher
   * cascade to disambiguate elements with identical names. */
  description?: string

  /** Current input / range / combobox value (≤200 chars). */
  value?: string

  /** Lowercased HTML tag name. Fallback discriminator when role
   * collapses to "generic" on div-soup pages. */
  tag?: string

  /** State flags. Present only when true; absence means "false /
   * default". The cascade uses these for tie-breaking (a disabled
   * candidate is dropped for click intents, etc.). */
  disabled?: true
  focused?: true
  /** Tri-state for indeterminate checkboxes. */
  checked?: boolean | "mixed"
  expanded?: boolean
  selected?: true
  pressed?: boolean
  /** aria-hidden or computed not-visible. Distinct from `disabled`. */
  hidden?: true
  required?: true
  readonly?: true
  invalid?: true | "spelling" | "grammar"
  editable?: true

  /** Heading depth, treeitem level. */
  level?: number

  /** Range / progress endpoints. */
  valuemin?: number
  valuemax?: number
  valuetext?: string

  /** Input-shaped element extras. Only populated for role-textbox /
   * searchbox / spinbutton / combobox or `<input>` / `<textarea>`
   * elements. */
  inputType?: string
  placeholder?: string
  autocomplete?: string

  /** Bounding box in CSS pixels, top-frame coordinate space. For
   * elements inside cross-origin iframes the bbox is transformed
   * through the iframe's own offset so coords are always usable
   * by `browser_mouse` / `browser_screenshot` without further math. */
  bbox: [x: number, y: number, w: number, h: number]

  /** Owning frame id. For the top frame this matches the page's main
   * frameId; for iframes it identifies the child frame so the
   * dispatcher can target `chrome.scripting.executeScript`'s
   * `target.frameIds`. Optional for backward compatibility with the
   * legacy single-frame extraction path. */
  frameId?: string

  /** True when the element lives inside any iframe (not the top
   * frame). Cheap pre-check before the matcher consults `frameId`. */
  isInIframe?: true

  /** Refs of containing landmark / region ancestors (≤4 deep).
   * Examples: dialog, region, navigation, main, form, search. Lets
   * the matcher disambiguate "Submit in the form labeled X" vs
   * "Submit in the form labeled Y" without re-walking the tree. */
  landmarks?: ReadonlyArray<string>

  /** Raw attribute extras that the matcher cascade's L5 testid +
   * aria-label layer + L7 semantic-id heuristic consume. Limited
   * to the handful that signal author intent (not a full attribute
   * dump). Omitted when none of the listed attrs are present.
   *
   * - `testid`: data-testid / data-test-id / data-test / data-qa
   * - `id`: HTML id attribute
   * - `name_attr`: HTML name attribute (form fields)
   * - `aria_label`: aria-label string when set
   */
  attrs?: {
    testid?: string
    id?: string
    name_attr?: string
    aria_label?: string
  }
}

/**
 * A canvas / svg region of non-trivial size in the viewport. Signals
 * that text-only matching may miss and the visual fallback path
 * (`pickElementVisual`) is the right escalation when intent points
 * into this region.
 */
export interface VisualSurface {
  ref: string
  kind: "canvas" | "svg"
  bbox: [x: number, y: number, w: number, h: number]
  /** Owning frame id (same semantics as `SnapshotElement.frameId`). */
  frameId?: string
}

/**
 * Reason fields populated when the extraction pipeline had to drop
 * data to honor caps. Consumers can react (matcher can prompt for a
 * narrower intent; observe can mention "page is large, only the
 * visible region was summarized").
 */
export interface SnapshotTruncation {
  /** True iff the element list hit ELEMENT_CAP and additional
   * interactive elements exist on the page. */
  elements: boolean
  /** True iff the text body hit TEXT_CAP. */
  text: boolean
  /** Count of frames where AX-tree extraction failed (cross-origin
   * policy, detached frame, OOPIF crash). 0 means full coverage. */
  framesSkipped: number
}

/**
 * The full snapshot envelope returned by `browser_read_page` and
 * consumed by every higher-altitude tool (`browser_find`, `act`,
 * `extract`, `observe`).
 */
export interface PageSnapshot {
  /** Extraction mode hint — currently `summary` (viewport-filtered)
   * or `full` (page-wide). The cascade behaves identically; the
   * difference is which elements made the cut. */
  mode?: "summary" | "full"

  /** Tab id this snapshot was captured from. Optional for backward
   * compatibility — the extension is expected to populate this going
   * forward so the matcher can attribute escalations to a tab in
   * audit logs. */
  tabId?: number

  /** Top-frame URL at capture time. Optional for backward compat;
   * populated by the CDP path going forward. */
  url?: string

  /** Top-frame title at capture time. Surfaced by `observe` so the
   * lead model knows what page it's looking at without re-querying. */
  title?: string

  /** Date.now() at end of capture. Lets the matcher detect a
   * suspiciously-old cached snapshot before acting on it. */
  capturedAt?: number

  /** Top-frame viewport metadata. Coordinate space for every bbox
   * in `elements` and `visualSurfaces`. */
  viewport: {
    width: number
    height: number
    devicePixelRatio: number
    scrollX: number
    scrollY: number
  }

  /** Viewport-visible text body (summary) or full `innerText` (full).
   * Cap is enforced by the extractor; `truncated.text` flags
   * truncation. */
  text: string

  /** Interactive elements found in the page. Order is "document
   * order within each frame, top frame first, then DFS." The matcher
   * relies on this ordering for spatial-ordinal layer (L6: "the
   * third card"). */
  elements: ReadonlyArray<SnapshotElement>

  /** Canvas / svg regions worth surfacing — only present when at
   * least one qualifies (omitted entirely otherwise to keep small
   * pages small). */
  visualSurfaces?: ReadonlyArray<VisualSurface>

  /** Cap-hit indicators. Optional for backward compat; consumers
   * should treat missing as "no truncation observed." */
  truncated?: SnapshotTruncation
}
