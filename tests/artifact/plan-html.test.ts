import { describe, expect, test } from "bun:test"

import { parseExitPlanPayload } from "../../src/internal-artifact-open"
import { renderMarkdownBody, renderPlanHtml } from "../../src/lib/artifact/plan-html"

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
