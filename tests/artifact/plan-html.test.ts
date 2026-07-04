import { describe, expect, test } from "bun:test"

import { parseExitPlanPayload } from "../../src/internal-artifact-open"
import { renderInteractivePlanHtml, renderMarkdownBody, renderPlanHtml } from "../../src/lib/artifact/plan-html"

describe("parseExitPlanPayload", () => {
  test("extracts planFilePath + plan from the ExitPlanMode tool_input", () => {
    const raw = JSON.stringify({ tool_name: "ExitPlanMode", tool_input: { planFilePath: "/a/b.md", plan: "# hi" } })
    expect(parseExitPlanPayload(raw)).toEqual({ planFilePath: "/a/b.md", planMarkdown: "# hi" })
  })

  test("content-only payload (no planFilePath) still yields the markdown", () => {
    const raw = JSON.stringify({ tool_input: { plan: "only content" } })
    expect(parseExitPlanPayload(raw)).toEqual({ planMarkdown: "only content" })
  })

  test("ignores blank/whitespace fields and malformed json", () => {
    expect(parseExitPlanPayload(JSON.stringify({ tool_input: { planFilePath: "  ", plan: "" } }))).toEqual({})
    expect(parseExitPlanPayload("not json")).toEqual({})
    expect(parseExitPlanPayload("{}")).toEqual({})
  })
})

describe("renderMarkdownBody", () => {
  test("renders headings, lists, and GFM tables", () => {
    const body = renderMarkdownBody("# Title\n\n- a\n- b\n\n| x | y |\n|---|---|\n| 1 | 2 |\n")
    expect(body).toContain("<h1")
    expect(body).toContain("<li>a</li>")
    expect(body).toContain("<table")
    expect(body).toContain("<td>1</td>")
  })

  test("tags the first block with its 1-based source line", () => {
    expect(renderMarkdownBody("# First\n")).toContain('<h1 data-source-line="1"')
    const body = renderMarkdownBody("intro\n\n## Second\n")
    expect(body).toContain('<p data-source-line="1"')
    expect(body).toContain('<h2 data-source-line="3"')
  })

  test("escapes raw HTML (no live script can read the asset token)", () => {
    const body = renderMarkdownBody("text\n\n<script>alert(1)</script>\n")
    expect(body).not.toContain("<script>alert")
    expect(body).toContain("&lt;script&gt;")
  })

  test("neutralises script-bearing link/image URLs", () => {
    const body = renderMarkdownBody("[x](javascript:alert(1)) and [y](VBScript:foo) and [z](data:text/html,evil)")
    expect(body).not.toContain("javascript:")
    expect(body).not.toContain("vbscript:")
    expect(body.toLowerCase()).not.toContain("data:text/html")
    expect(body).toContain('href="#"')
    // A normal link is preserved.
    expect(renderMarkdownBody("[ok](https://example.com)")).toContain('href="https://example.com"')
  })

  test("neutralises entity-obfuscated schemes (browser decodes href entities)", () => {
    for (const href of ["javascript&colon;alert(1)", "j&#97;vascript:alert(1)", "&#106;avascript:alert(1)"]) {
      const body = renderMarkdownBody(`[x](${href})`)
      expect(body).toContain('href="#"')
    }
    // SVG data URIs (can script) are blocked even for images; raster is allowed.
    expect(renderMarkdownBody("![a](data:image/svg+xml,<svg/onload=alert(1)>)")).toContain('src="#"')
    expect(renderMarkdownBody("![a](data:image/png;base64,iVBOR)")).toContain("data:image/png")
  })
})

describe("renderPlanHtml", () => {
  test("produces a self-contained document with an escaped title", () => {
    const doc = renderPlanHtml("# Plan body", "My <Plan>")
    expect(doc.startsWith("<!doctype html>")).toBe(true)
    expect(doc).toContain("<title>My &lt;Plan&gt;</title>")
    expect(doc).toContain("<main>")
    expect(doc).toContain("Plan body")
  })
})

describe("renderInteractivePlanHtml (data-aod-* vocab)", () => {
  test("choose-one emits immediate-fire buttons with action/group/id/value; no submit", () => {
    const html = renderInteractivePlanHtml({
      blocks: [{
        kind: "choose-one",
        group: "decision-1",
        prompt: "Which auth?",
        options: [
          { elementId: "opt-jwt", label: "JWT", value: "jwt" },
          { elementId: "opt-session", label: "Session", value: "session" },
        ],
      }],
    })
    expect(html).toContain('class="aod-group aod-choose-one"')
    expect(html).toContain('data-aod-action="choose"')
    expect(html).toContain('data-aod-group="decision-1"')
    expect(html).toContain('data-aod-id="opt-jwt"')
    expect(html).toContain('data-aod-value="jwt"')
    expect(html).toContain(">JWT</button>")
    // Immediate-fire: no submit button in a choose-one.
    expect(html).not.toContain('data-aod-action="submit"')
  })

  test("multi-select emits check toggles sharing a group + a submit button with that group", () => {
    const html = renderInteractivePlanHtml({
      blocks: [{
        kind: "multi-select",
        group: "opts",
        prompt: "Pick features",
        submitLabel: "Apply",
        options: [
          { elementId: "f-a", label: "Feature A", value: "a" },
          { elementId: "f-b", label: "Feature B", value: "b" },
        ],
      }],
    })
    expect(html).toContain('class="aod-group aod-multi-select"')
    expect(html).toContain('type="checkbox"')
    expect(html).toContain('data-aod-action="check"')
    // Both checkboxes AND the submit carry the SAME data-aod-group so the SDK can
    // collect the group's selection on submit.
    const groupCount = (html.match(/data-aod-group="opts"/g) ?? []).length
    expect(groupCount).toBeGreaterThanOrEqual(3) // container + 2 checkboxes + submit
    expect(html).toContain('data-aod-action="submit"')
    expect(html).toContain('data-aod-id="opts-submit"')
    expect(html).toContain(">Apply</button>")
  })

  test("steps emit li.aod-step with data-aod-id, data-source-line, and per-step action buttons", () => {
    const html = renderInteractivePlanHtml({
      blocks: [{
        kind: "steps",
        steps: [{
          elementId: "plan-step-3",
          label: "Migrate the token store",
          sourceLine: 14,
          actions: [
            { action: "approve", label: "Approve" },
            { action: "skip", label: "Skip" },
          ],
        }],
      }],
    })
    expect(html).toContain('class="aod-step"')
    expect(html).toContain('data-aod-id="plan-step-3"')
    expect(html).toContain('data-source-line="14"')
    expect(html).toContain('data-aod-action="approve"')
    expect(html).toContain('data-aod-action="skip"')
  })

  test("attribute values and labels are HTML-escaped (no breakout / live markup)", () => {
    const html = renderInteractivePlanHtml({
      blocks: [{
        kind: "choose-one",
        group: 'g"onmouseover=alert(1)',
        options: [{ elementId: "x", label: "<script>alert(1)</script>", value: 'v"q' }],
      }],
    })
    // No raw double-quote breakout in the group attribute.
    expect(html).not.toContain('data-aod-group="g"onmouseover')
    expect(html).toContain("&quot;")
    // Label is escaped to text, never live markup.
    expect(html).not.toContain("<script>alert(1)</script>")
    expect(html).toContain("&lt;script&gt;")
  })

  test("optional prose markdown is rendered with the same escaping + URL neutralization", () => {
    const html = renderInteractivePlanHtml({
      markdown: "# Plan\n\n[x](javascript:alert(1))\n",
      blocks: [{ kind: "choose-one", group: "g", options: [{ elementId: "a", label: "A" }] }],
    })
    expect(html).toContain("<h1")
    expect(html).not.toContain("javascript:")
    expect(html).toContain('href="#"')
    // Interactive style block is present.
    expect(html).toContain(".aod-group")
  })

  test("produces a self-contained document", () => {
    const html = renderInteractivePlanHtml({ blocks: [] }, "My Plan")
    expect(html.startsWith("<!doctype html>")).toBe(true)
    expect(html).toContain("<title>My Plan</title>")
    expect(html).toContain("<main>")
  })
})

describe("renderPlanHtml stays static (no interactive markup)", () => {
  test("static render emits no data-aod-* attributes", () => {
    const doc = renderPlanHtml("# Plan\n\n- a\n- b\n")
    expect(doc).not.toContain("data-aod-")
    expect(doc).not.toContain("aod-group")
  })
})
