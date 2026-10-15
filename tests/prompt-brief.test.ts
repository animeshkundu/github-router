/**
 * `runHookPromptBrief` is the server-side half of the Pi cheapest-profile
 * prompt brief. The Pi extension is a generated STRING with no import surface,
 * so it cannot reach `runCheapestRewrite`; the proxy runs it and hands the
 * brief back over the authenticated `/mcp/search` hook channel. These tests pin
 * the contract that channel depends on:
 *
 *   - eligibility is the SAME predicate the Claude hook uses (profile
 *     "cheapest" + a non-trivial prompt + not opted out), so the two front-ends
 *     cannot disagree about when a rewrite is allowed to spend;
 *   - a decline is `{brief: null}` with a reason, never a throw, and never a
 *     model call — a hook that threw would break the user's prompt;
 *   - the one-shot flag is keyed on the session id and marked on ATTEMPT, so a
 *     long session spends the rewrite once even when the rewrite misses;
 *   - the brief arrives wrapped by `wrapLunaBrief` (the additive, advisory form
 *     the model is trained against), not as raw model output.
 *
 * `infer` is injected, which is why this file mocks no HTTP at all: the
 * Copilot call is the caller's business, and a mock here would only prove the
 * mock works. The grounding search runs for real against a temp directory, so
 * the empty-result path is exercised as it actually behaves.
 */

import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { runHookPromptBrief } from "~/lib/hook-prompt-brief"

const WORK = mkdtempSync(join(tmpdir(), "gh-router-prompt-brief-"))
writeFileSync(
  join(WORK, "widget.ts"),
  "export function renderWidget(): string {\n  return \"widget\"\n}\n",
)

afterAll(() => {
  rmSync(WORK, { recursive: true, force: true })
})

const SUBSTANTIVE =
  "implement a widget caching layer across the render module and its tests"

/** A fresh session id per test: the one-shot flag is a file keyed on it. */
const freshSession = () => `sess-${Math.random().toString(36).slice(2)}-${Date.now()}`

interface InferCalls {
  count: number
  lastSystem: string
  lastUser: string
}

function recordingInfer(reply: string): InferCalls & { infer: (s: string, u: string) => Promise<string> } {
  const state = {
    count: 0,
    lastSystem: "",
    lastUser: "",
    infer: async (system: string, user: string) => {
      state.count++
      state.lastSystem = system
      state.lastUser = user
      return reply
    },
  }
  return state as InferCalls & { infer: (s: string, u: string) => Promise<string> }
}

const base = {
  prompt: SUBSTANTIVE,
  workspace: WORK,
  profile: "cheapest",
  searchEnabled: false,
  bluebirdEnabled: false,
}

describe("runHookPromptBrief eligibility", () => {
  test("a non-cheapest profile declines without spending a model call", async () => {
    const rec = recordingInfer("SHOULD NOT BE USED")
    const result = await runHookPromptBrief({
      ...base,
      sessionId: freshSession(),
      profile: "standard",
      infer: rec.infer,
    })
    expect(result.brief).toBeNull()
    expect(result.reason).toBe("not-eligible")
    expect(rec.count).toBe(0)
  })

  test("a trivial prompt declines on the cheapest profile too", async () => {
    const rec = recordingInfer("SHOULD NOT BE USED")
    const result = await runHookPromptBrief({
      ...base,
      prompt: "hi",
      sessionId: freshSession(),
      infer: rec.infer,
    })
    expect(result.brief).toBeNull()
    expect(result.reason).toBe("not-eligible")
    expect(rec.count).toBe(0)
  })

  test("the env opt-out wins over an otherwise-eligible prompt", async () => {
    const rec = recordingInfer("SHOULD NOT BE USED")
    const result = await runHookPromptBrief({
      ...base,
      sessionId: freshSession(),
      rewriteDisabled: true,
      infer: rec.infer,
    })
    expect(result.reason).toBe("disabled")
    expect(rec.count).toBe(0)
  })

  test("an empty workspace declines rather than searching the proxy's cwd", async () => {
    const rec = recordingInfer("SHOULD NOT BE USED")
    const result = await runHookPromptBrief({
      ...base,
      workspace: "   ",
      sessionId: freshSession(),
      infer: rec.infer,
    })
    expect(result.reason).toBe("no-workspace")
    expect(rec.count).toBe(0)
  })

  test("a missing session id declines: without one the one-shot flag cannot hold", async () => {
    const rec = recordingInfer("SHOULD NOT BE USED")
    const result = await runHookPromptBrief({
      ...base,
      sessionId: "",
      infer: rec.infer,
    })
    expect(result.reason).toBe("no-session")
    expect(rec.count).toBe(0)
  })
})

describe("runHookPromptBrief rewrite", () => {
  test("returns the brief wrapped as an advisory EXECUTION BRIEF", async () => {
    const rec = recordingInfer("1. Read the module\n2. Add a cache")
    const result = await runHookPromptBrief({
      ...base,
      sessionId: freshSession(),
      infer: rec.infer,
    })
    expect(result.reason).toBe("ok")
    expect(result.brief).toContain("EXECUTION BRIEF")
    expect(result.brief).toContain("Add a cache")
    // The wrapper is what makes the brief additive: it names the user's request
    // as authoritative so the model does not treat a stale brief as an order.
    expect(result.brief).toContain("user's request remains authoritative")
    expect(rec.count).toBe(1)
    // The grounded user turn must carry the prompt AND the repo context pack —
    // a brief produced without them is the un-grounded Luna path this replaces.
    expect(rec.lastUser).toContain("widget caching layer")
    expect(rec.lastUser).toContain("USER REQUEST:")
  })

  test("an empty model reply is a clean miss, not an error", async () => {
    const rec = recordingInfer("")
    const result = await runHookPromptBrief({
      ...base,
      sessionId: freshSession(),
      infer: rec.infer,
    })
    expect(result.brief).toBeNull()
    expect(result.reason).toBe("miss")
  })

  test("one brief per session: the second prompt reuses the first and spends nothing", async () => {
    const sessionId = freshSession()
    const rec = recordingInfer("first brief")
    const first = await runHookPromptBrief({ ...base, sessionId, infer: rec.infer })
    expect(first.reason).toBe("ok")
    expect(rec.count).toBe(1)

    const second = await runHookPromptBrief({ ...base, sessionId, infer: rec.infer })
    expect(second.brief).toBeNull()
    expect(second.reason).toBe("already-run")
    // The load-bearing assertion: no second model call. A brief that re-billed
    // on every prompt would be the opposite of what "cheapest" means.
    expect(rec.count).toBe(1)
  })

  test("a MISS still spends the session's one shot (attempt-marked)", async () => {
    const sessionId = freshSession()
    const rec = recordingInfer("")
    const first = await runHookPromptBrief({ ...base, sessionId, infer: rec.infer })
    expect(first.reason).toBe("miss")
    expect(rec.count).toBe(1)

    // Retrying on the next prompt would re-bill a rewrite that already failed
    // once against the same repo state; the Claude hook marks on attempt for
    // exactly this reason and the two must agree.
    const second = await runHookPromptBrief({ ...base, sessionId, infer: rec.infer })
    expect(second.reason).toBe("already-run")
    expect(rec.count).toBe(1)
  })

  test("a throwing infer degrades to no brief rather than rejecting the call", async () => {
    const result = await runHookPromptBrief({
      ...base,
      sessionId: freshSession(),
      infer: () => Promise.reject(new Error("upstream 502")),
    })
    expect(result.brief).toBeNull()
    expect(result.reason).toBe("miss")
  })
})
