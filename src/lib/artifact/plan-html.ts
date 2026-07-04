/**
 * Render a plan's markdown into a self-contained, styled HTML document for the
 * ai-or-die Artifact panel. HTML is the canonical review artifact (lavish's
 * model); converting here means the hands-off auto-open shows a formatted,
 * annotatable page instead of raw markdown.
 *
 * Security: the iframe ai-or-die serves this into runs with
 * `allow-scripts allow-same-origin`, so a `<script>` smuggled into the plan
 * markdown could read the per-session asset token. Two defenses:
 *   1. marked is configured to ESCAPE raw HTML tokens (render as visible text).
 *   2. `link`/`image` hrefs with script-bearing schemes (javascript:, vbscript:,
 *      non-image data:) are neutralised before rendering.
 * No separate sanitizer/dep needed.
 */
import { Marked } from "marked"

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

/** Decode the HTML character references a browser would resolve in an attribute
 *  value, so an entity-obfuscated scheme (`javascript&colon;`, `j&#97;vascript:`)
 *  cannot slip past the scheme check below. Numeric refs cover any letter; the
 *  small named map covers the scheme-relevant punctuation. */
const NAMED_REFS: Record<string, string> = {
  colon: ":", tab: "\t", newline: "\n", sol: "/", semi: ";", amp: "&", lpar: "(", rpar: ")",
}
function decodeEntities(s: string): string {
  return s.replace(/&(#[xX][0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);?/g, (m, body: string) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X"
        ? Number.parseInt(body.slice(2), 16)
        : Number.parseInt(body.slice(1), 10)
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m
    }
    return NAMED_REFS[body.toLowerCase()] ?? m
  })
}

/** Block script-bearing URL schemes (defense-in-depth on top of HTML escaping). */
function isDangerousUrl(url: string, isImage: boolean): boolean {
  // Decode entities first (a browser resolves them in href), then drop ASCII
  // control chars + spaces (code <= 0x20) a browser ignores inside a scheme.
  const v = Array.from(decodeEntities(url)).filter((c) => c.charCodeAt(0) > 0x20).join("").toLowerCase()
  if (v.startsWith("javascript:") || v.startsWith("vbscript:")) return true
  if (v.startsWith("data:")) {
    // Allow only raster image data URIs (and only for <img>); SVG can script.
    return !(isImage && v.startsWith("data:image/") && !v.startsWith("data:image/svg"))
  }
  return false
}

/** A marked instance that escapes raw HTML (raw markup never becomes live). */
function makeMarked(): Marked {
  const m = new Marked({ gfm: true, breaks: false })
  m.use({
    renderer: {
      // Raw HTML in the source is rendered as escaped text, never live markup.
      html(token: unknown): string {
        const text = typeof token === "string" ? token : ((token as { text?: string }).text ?? "")
        return escapeHtml(text)
      },
    },
  })
  return m
}

interface MdToken {
  type?: string
  href?: string
  tokens?: MdToken[]
  items?: MdToken[]
  header?: Array<{ tokens?: MdToken[] }>
  rows?: Array<Array<{ tokens?: MdToken[] }>>
}

/**
 * Recursively neutralise script-bearing link/image hrefs in the lexed token tree.
 * Done as an explicit walk (not marked's `walkTokens` hook) because we render via
 * the low-level `lexer`+`parser` split, which does not run registered walkTokens.
 */
function neutralizeUrls(tokens: MdToken[]): void {
  for (const t of tokens) {
    if ((t.type === "link" || t.type === "image") && typeof t.href === "string") {
      if (isDangerousUrl(t.href, t.type === "image")) t.href = "#"
    }
    if (t.tokens) neutralizeUrls(t.tokens)
    if (t.items) neutralizeUrls(t.items)
    if (t.header) for (const cell of t.header) if (cell.tokens) neutralizeUrls(cell.tokens)
    if (t.rows) for (const row of t.rows) for (const cell of row) if (cell.tokens) neutralizeUrls(cell.tokens)
  }
}

/** Add `data-source-line="N"` to the first opening tag of a rendered block. */
function tagSourceLine(html: string, line: number): string {
  return html.replace(/^(\s*)<([a-zA-Z][\w-]*)/, `$1<$2 data-source-line="${line}"`)
}

/**
 * Render markdown to inner HTML, tagging each top-level block with its 1-based
 * source line so an annotation in the panel can map back to a plan line.
 */
export function renderMarkdownBody(source: string): string {
  const m = makeMarked()
  let tokens: Array<{ raw?: string }>
  try {
    tokens = m.lexer(source) as Array<{ raw?: string }>
  } catch {
    // Lexing should not fail, but never throw out of the hook path.
    return `<pre>${escapeHtml(source)}</pre>`
  }
  neutralizeUrls(tokens as MdToken[])
  let line = 1
  let out = ""
  for (const tok of tokens) {
    let html = ""
    try {
      html = m.parser([tok] as Parameters<typeof m.parser>[0])
    } catch {
      html = ""
    }
    if (html.trim()) out += tagSourceLine(html, line)
    line += (tok.raw?.match(/\n/g)?.length ?? 0)
  }
  return out || `<pre>${escapeHtml(source)}</pre>`
}

/**
 * Wrap rendered markdown in a complete, self-contained HTML document with
 * readable typography (works even before ai-or-die injects its annotation SDK).
 */
export function renderPlanHtml(source: string, title = "Plan"): string {
  return wrapArtifactDocument(renderMarkdownBody(source), title)
}

const BASE_STYLE = `  :root {
    --bg: #0f1115; --fg: #f7f3ea; --muted: #aeb6c6; --border: #2a2f3a;
    --accent: #f4c95d; --code-bg: #171a21;
    --serif: 'Iowan Old Style', Georgia, 'Times New Roman', serif;
    --sans: ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif;
    --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; background: var(--bg); color: var(--fg); }
  body { font-family: var(--serif); font-size: 16px; line-height: 1.6;
    padding: 32px clamp(16px, 5vw, 56px); }
  main { max-width: 78ch; margin: 0 auto; }
  h1, h2, h3, h4 { font-family: var(--sans); line-height: 1.25; margin: 1.6em 0 0.5em; }
  h1 { font-size: 1.9em; } h2 { font-size: 1.45em; padding-bottom: 0.2em;
    border-bottom: 1px solid var(--border); } h3 { font-size: 1.2em; }
  p, li { color: var(--fg); }
  a { color: var(--accent); }
  code { font-family: var(--mono); font-size: 0.9em; background: var(--code-bg);
    padding: 0.12em 0.35em; border-radius: 5px; }
  pre { background: var(--code-bg); border: 1px solid var(--border); border-radius: 8px;
    padding: 12px 14px; overflow: auto; }
  pre code { background: none; padding: 0; }
  blockquote { margin: 1em 0; padding: 0.2em 1em; border-left: 3px solid var(--accent);
    color: var(--muted); }
  table { border-collapse: collapse; width: 100%; margin: 1em 0; font-family: var(--sans);
    font-size: 0.95em; }
  th, td { border: 1px solid var(--border); padding: 6px 10px; text-align: left; }
  th { background: var(--code-bg); }
  hr { border: 0; border-top: 1px solid var(--border); margin: 1.5em 0; }
  ul, ol { padding-left: 1.4em; }`

const INTERACTIVE_STYLE = `
  .aod-group { margin: 1.4em 0; padding: 14px 16px; border: 1px solid var(--border);
    border-radius: 10px; background: var(--code-bg); }
  .aod-prompt { font-family: var(--sans); font-weight: 600; margin: 0 0 0.6em; }
  .aod-options { display: flex; flex-wrap: wrap; gap: 8px; }
  .aod-multi-select .aod-options { flex-direction: column; gap: 6px; }
  .aod-action, .aod-submit { font-family: var(--sans); font-size: 0.95em; font-weight: 600;
    cursor: pointer; border: 1px solid var(--border); border-radius: 8px;
    padding: 8px 12px; background: var(--bg); color: var(--fg); }
  .aod-action:hover, .aod-submit:hover { border-color: var(--accent); }
  .aod-submit { margin-top: 10px; background: var(--accent); color: #17130a; border-color: var(--accent); }
  .aod-check { display: flex; align-items: center; gap: 8px; font-family: var(--sans); cursor: pointer; }
  .aod-steps { list-style: decimal; }
  .aod-step { margin: 0.5em 0; }
  .aod-step-actions { display: inline-flex; gap: 6px; margin-left: 8px; }`

/**
 * Wrap rendered inner HTML in the self-contained document shell. `extraStyle` is
 * appended to the inline stylesheet so the interactive variant can add its own
 * rules without a second `<style>` block. Static callers pass "" (default), so
 * the static document is byte-identical to the pre-refactor output.
 */
function wrapArtifactDocument(body: string, title: string, extraStyle = ""): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
${BASE_STYLE}${extraStyle}
</style>
</head>
<body>
<main>
${body}
</main>
</body>
</html>
`
}

/* -------------------------------------------------------------------------- */
/* Interactive artifacts (contract v2.2 §4: declarative data-aod-* vocab)      */
/* -------------------------------------------------------------------------- */

export interface InteractiveOption {
  /** Stable id echoed back as `elementId` in the action event. Required. */
  elementId: string
  /** Human-visible label. */
  label: string
  /** Optional value echoed as `data-aod-value` (checkbox submits use "true"/"false"). */
  value?: string
}

/** One immediate-fire choice group: each option posts an action the instant it is clicked. */
export interface ChooseOneBlock {
  kind: "choose-one"
  /** `data-aod-group` shared by the options (marks them as one decision). */
  group: string
  prompt?: string
  /** `data-aod-action` verb for every option (default "choose"). */
  action?: string
  options: InteractiveOption[]
}

/** A multi-select group: checkbox toggles plus one submit that carries {group, selected}. */
export interface MultiSelectBlock {
  kind: "multi-select"
  group: string
  prompt?: string
  submitLabel?: string
  submitElementId?: string
  options: InteractiveOption[]
}

export interface StepAction {
  /** `data-aod-action` verb (e.g. "approve", "skip"). */
  action: string
  label: string
  value?: string
}

export interface StepItem {
  /** Stable `data-aod-id` echoed as `elementId`. */
  elementId: string
  label: string
  sourceLine?: number
  actions: StepAction[]
}

/** An ordered list of plan steps, each with its own inline action buttons. */
export interface StepsBlock {
  kind: "steps"
  steps: StepItem[]
}

export type InteractiveBlock = ChooseOneBlock | MultiSelectBlock | StepsBlock

export interface InteractivePlanModel {
  /** Optional prose rendered above the interactive blocks (same escaping as static). */
  markdown?: string
  blocks: InteractiveBlock[]
}

/** Build a ` data-x="y"` attribute string, dropping undefined values, all escaped. */
function dataAttrs(pairs: Array<[string, string | undefined]>): string {
  let out = ""
  for (const [name, value] of pairs) {
    if (value === undefined) continue
    out += ` ${name}="${escapeHtml(value)}"`
  }
  return out
}

function renderChooseOne(block: ChooseOneBlock): string {
  const action = block.action && block.action.trim() ? block.action : "choose"
  const prompt = block.prompt ? `<p class="aod-prompt">${escapeHtml(block.prompt)}</p>` : ""
  const options = block.options
    .filter((o) => o.elementId.trim() !== "")
    .map((o) => {
      const attrs = dataAttrs([
        ["data-aod-action", action],
        ["data-aod-group", block.group],
        ["data-aod-id", o.elementId],
        ["data-aod-value", o.value],
      ])
      return `<button type="button" class="aod-action"${attrs}>${escapeHtml(o.label)}</button>`
    })
    .join("\n")
  return `<div class="aod-group aod-choose-one"${dataAttrs([["data-aod-group", block.group]])}>
${prompt}<div class="aod-options">
${options}
</div>
</div>`
}

function renderMultiSelect(block: MultiSelectBlock): string {
  const prompt = block.prompt ? `<p class="aod-prompt">${escapeHtml(block.prompt)}</p>` : ""
  const options = block.options
    .filter((o) => o.elementId.trim() !== "")
    .map((o) => {
      const attrs = dataAttrs([
        ["data-aod-action", "check"],
        ["data-aod-group", block.group],
        ["data-aod-id", o.elementId],
        ["data-aod-value", o.value],
      ])
      return `<label class="aod-check"><input type="checkbox"${attrs}> <span>${escapeHtml(o.label)}</span></label>`
    })
    .join("\n")
  const submitId = block.submitElementId && block.submitElementId.trim()
    ? block.submitElementId
    : `${block.group}-submit`
  const submitAttrs = dataAttrs([
    ["data-aod-action", "submit"],
    ["data-aod-group", block.group],
    ["data-aod-id", submitId],
  ])
  const submitLabel = block.submitLabel && block.submitLabel.trim() ? block.submitLabel : "Submit"
  return `<div class="aod-group aod-multi-select"${dataAttrs([["data-aod-group", block.group]])}>
${prompt}<div class="aod-options">
${options}
</div>
<button type="button" class="aod-submit"${submitAttrs}>${escapeHtml(submitLabel)}</button>
</div>`
}

function renderSteps(block: StepsBlock): string {
  const items = block.steps
    .filter((s) => s.elementId.trim() !== "")
    .map((s) => {
      const liAttrs = dataAttrs([
        ["data-aod-id", s.elementId],
        ["data-source-line", s.sourceLine === undefined ? undefined : String(s.sourceLine)],
      ])
      const actions = s.actions
        .map((a) => {
          const attrs = dataAttrs([
            ["data-aod-action", a.action],
            ["data-aod-id", s.elementId],
            ["data-aod-value", a.value],
          ])
          return `<button type="button" class="aod-action"${attrs}>${escapeHtml(a.label)}</button>`
        })
        .join("")
      return `<li class="aod-step"${liAttrs}><span class="aod-step-label">${escapeHtml(s.label)}</span><span class="aod-step-actions">${actions}</span></li>`
    })
    .join("\n")
  return `<ol class="aod-steps">
${items}
</ol>`
}

function renderInteractiveBlock(block: InteractiveBlock): string {
  switch (block.kind) {
    case "choose-one":
      return renderChooseOne(block)
    case "multi-select":
      return renderMultiSelect(block)
    case "steps":
      return renderSteps(block)
    default:
      return ""
  }
}

/**
 * Render a typed interactive plan model into a self-contained HTML document that
 * carries the declarative `data-aod-*` action vocabulary the ai-or-die panel SDK
 * wires (contract v2.2 §4). Optional prose (`markdown`) is rendered with the SAME
 * escaping + dangerous-URL neutralization as the static path; all control
 * attributes and labels are HTML-escaped, so no author string can break out of an
 * attribute or inject live markup.
 */
export function renderInteractivePlanHtml(model: InteractivePlanModel, title = "Plan"): string {
  const prose = model.markdown && model.markdown.trim() ? renderMarkdownBody(model.markdown) : ""
  const blocks = model.blocks.map(renderInteractiveBlock).filter((h) => h.trim() !== "").join("\n")
  const body = [prose, blocks].filter((s) => s.trim() !== "").join("\n")
  return wrapArtifactDocument(body || `<pre>${escapeHtml(JSON.stringify(model))}</pre>`, title, INTERACTIVE_STYLE)
}
