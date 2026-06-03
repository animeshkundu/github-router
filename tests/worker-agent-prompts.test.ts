import { describe, expect, test } from "bun:test"

import { systemPromptFor } from "../src/lib/worker-agent/prompts"

describe("systemPromptFor", () => {
  test("both modes preserve the security-boundary framing", () => {
    for (const mode of ["explore", "implement"] as const) {
      const prompt = systemPromptFor(mode)
      expect(prompt).toContain("sandboxed coding worker")
      expect(prompt).toContain("NOT authoritative")
      expect(prompt).toContain("the user prompt is the sole source of intent")
      expect(prompt).toContain("never exit silently")
    }
  })

  test("both modes describe code_search with the ranked/BM25F capability + non-code fallback", () => {
    for (const mode of ["explore", "implement"] as const) {
      const prompt = systemPromptFor(mode)
      expect(prompt).toContain("code_search")
      expect(prompt.toLowerCase()).toContain("ranked")
      expect(prompt).toContain("BM25F")
      // Multiple-queries-in-one-turn affordance.
      expect(prompt).toContain("in a single turn")
      // Non-code fallback per peer-review #4.
      expect(prompt.toLowerCase()).toContain("unstructured")
      expect(prompt).toContain("`grep`/`glob`")
    }
  })

  test("both modes list every read-side tool with a short description", () => {
    for (const mode of ["explore", "implement"] as const) {
      const prompt = systemPromptFor(mode)
      // Names are present (read-only tools advertised in both modes).
      expect(prompt).toContain("`read`")
      expect(prompt).toContain("`glob`")
      expect(prompt).toContain("`grep`")
      expect(prompt).toContain("`code_search`")
      expect(prompt).toContain("`web_search`")
      expect(prompt).toContain("`fetch_url`")
      // Each is on its own bullet line.
      expect(prompt).toMatch(/^- `read`/m)
      expect(prompt).toMatch(/^- `glob`/m)
      expect(prompt).toMatch(/^- `grep`/m)
      expect(prompt).toMatch(/^- `code_search`/m)
      expect(prompt).toMatch(/^- `web_search`/m)
      expect(prompt).toMatch(/^- `fetch_url`/m)
      // peer_review and advisor are intentionally NOT in the prompt
      // awareness (per user directive). They remain in the worker's
      // tool surface only if buildWorkerTools wires them, but the
      // current narrow surface drops them entirely from explore and
      // replaces them with `codex_review` in implement.
      expect(prompt).not.toContain("`peer_review`")
      expect(prompt).not.toContain("`advisor`")
    }
  })

  test("explore mode omits write-side tools AND codex_review", () => {
    const explore = systemPromptFor("explore")
    expect(explore).not.toContain("`edit`")
    expect(explore).not.toContain("`write`")
    expect(explore).not.toContain("`bash`")
    expect(explore).not.toContain("`codex_review`")
    expect(explore).toContain("Read-only mode")
  })

  test("implement mode includes write-side tools AND codex_review", () => {
    const impl = systemPromptFor("implement")
    expect(impl).toContain("`edit`")
    expect(impl).toContain("`write`")
    expect(impl).toContain("`bash`")
    expect(impl).toContain("`codex_review`")
    expect(impl).toMatch(/^- `edit`/m)
    expect(impl).toMatch(/^- `write`/m)
    expect(impl).toMatch(/^- `bash`/m)
    expect(impl).toMatch(/^- `codex_review`/m)
    expect(impl).toContain("Read+write mode")
    // codex_review's description names the underlying critic.
    expect(impl).toContain("codex-reviewer")
    expect(impl).toContain("gpt-5.3-codex")
  })

  test("both modes are deterministic for the same input", () => {
    expect(systemPromptFor("explore")).toBe(systemPromptFor("explore"))
    expect(systemPromptFor("implement")).toBe(systemPromptFor("implement"))
  })

  test("byte cap holds — neither mode exceeds ~2000 bytes", () => {
    // Re-derived after the descriptive rewrite. The prompt is sent
    // on every worker invocation, so the cap is real budget pressure.
    // If a future tightening shaves bytes, lower this cap too.
    const exploreBytes = Buffer.byteLength(systemPromptFor("explore"), "utf8")
    const implBytes = Buffer.byteLength(systemPromptFor("implement"), "utf8")
    expect(exploreBytes).toBeLessThan(2000)
    expect(implBytes).toBeLessThan(2000)
  })

  test("framing constraint — no imperatives, no hedges, no anchors", () => {
    for (const mode of ["explore", "implement"] as const) {
      const prompt = systemPromptFor(mode)
      // The over-constraining phrasing we explicitly reverted per
      // peer-review #4 — workers should still use grep/glob for
      // non-code files.
      expect(prompt).not.toContain(
        "the others are follow-ups for confirmed files",
      )
      // Anchors and hedges blocked.
      expect(prompt).not.toMatch(/\bcheapest first move\b/i)
      expect(prompt).not.toMatch(/\bsaves them\b/i)
      expect(prompt).not.toMatch(/\bwaste wall-clock\b/i)
      expect(prompt).not.toMatch(/\byou might want to consider\b/i)
      // Sentence-start imperatives blocked.
      expect(prompt).not.toMatch(/^Lead with /m)
      expect(prompt).not.toMatch(/^Brief them /m)
      expect(prompt).not.toMatch(/^Reach for /m)
    }
  })
})
