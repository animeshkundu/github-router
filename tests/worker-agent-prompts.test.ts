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
      expect(prompt).toContain("`toolbelt`")
      // Each is on its own bullet line.
      expect(prompt).toMatch(/^- `read`/m)
      expect(prompt).toMatch(/^- `glob`/m)
      expect(prompt).toMatch(/^- `grep`/m)
      expect(prompt).toMatch(/^- `code_search`/m)
      expect(prompt).toMatch(/^- `web_search`/m)
      expect(prompt).toMatch(/^- `fetch_url`/m)
      // `advisor` and `update_plan` ARE now wired into every mode (advisor
      // is the worker's consultation path; update_plan its planning tool).
      // `peer_review` stays out (peer critics aren't part of the surface).
      expect(prompt).toContain("`advisor`")
      expect(prompt).toContain("`update_plan`")
      expect(prompt).toMatch(/^- `advisor`/m)
      expect(prompt).toMatch(/^- `update_plan`/m)
      expect(prompt).not.toContain("`peer_review`")
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

  test("review mode: reviewer role-frame + read-only tools, no write tools", () => {
    const review = systemPromptFor("review")
    // Security boundary still present.
    expect(review).toContain("sandboxed coding worker")
    // Reviewer ROLE frame (what it's for) — not prescriptive step-advice.
    expect(review.toLowerCase()).toContain("reviewing code for correctness")
    expect(review.toLowerCase()).toContain("verify")
    expect(review).toContain("severity")
    expect(review).toContain("file:line")
    // Same read-only surface as explore.
    expect(review).toContain("Read-only mode")
    expect(review).toContain("`read`")
    expect(review).toContain("`code_search`")
    // No write tools.
    expect(review).not.toContain("`edit`")
    expect(review).not.toContain("`write`")
    expect(review).not.toContain("`bash`")
    expect(review).not.toContain("`codex_review`")
  })

  test("both modes are deterministic for the same input", () => {
    expect(systemPromptFor("explore")).toBe(systemPromptFor("explore"))
    expect(systemPromptFor("implement")).toBe(systemPromptFor("implement"))
    expect(systemPromptFor("review")).toBe(systemPromptFor("review"))
  })

  test("byte cap holds — no mode exceeds ~2000 bytes", () => {
    // Re-derived after the descriptive rewrite. The prompt is sent
    // on every worker invocation, so the cap is real budget pressure.
    // If a future tightening shaves bytes, lower this cap too. `review`
    // is the LARGEST mode (reviewer role frame + the full read-only tool
    // list), so it's the one closest to the cap — assert it explicitly.
    const exploreBytes = Buffer.byteLength(systemPromptFor("explore"), "utf8")
    const reviewBytes = Buffer.byteLength(systemPromptFor("review"), "utf8")
    const implBytes = Buffer.byteLength(systemPromptFor("implement"), "utf8")
    expect(exploreBytes).toBeLessThan(2000)
    expect(reviewBytes).toBeLessThan(2000)
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
