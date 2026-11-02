/**
 * `runPiPromptBrief` is the server-side half of the Pi prompt brief. The Pi
 * extension is a generated STRING with no import surface, so it cannot run the
 * hook decision itself; the proxy runs it and hands the block back over the
 * authenticated `/mcp/search` hook channel.
 *
 * These tests pin the contract that channel depends on:
 *
 *   - the DECISION is `decidePromptSubmitV2`, the same function the Claude Code
 *     `UserPromptSubmit` hook runs, so the two clients cannot disagree about
 *     when to search, when to spend a model call, or when to stay silent;
 *   - the PROSE is Pi's, not Claude's: the tip names Pi's
 *     `mcp__gh-router-search__code` and the fallback goal names the `subagent`
 *     roster instead of `/gh-research` + `/gh-orchestrate` (skills Pi has none
 *     of, so naming them would point the model at something uncallable);
 *   - an empty string is the ordinary "nothing to inject" answer, never an
 *     error, and nothing here ever throws into the MCP call;
 *   - pending findings from the prior turn's review are surfaced and CLEARED
 *     (one-shot delivery), independently of prompt triviality;
 *   - the cheapest family still gets the one-shot Sol rewrite, marked on
 *     ATTEMPT, and only once per session.
 *
 * `infer` / `inferSol` are injected, which is why this file mocks no HTTP at
 * all: the Copilot call is the caller's business, and a mock here would only
 * prove the mock works. The grounding search runs for real against a temp
 * directory, so the empty-result path is exercised as it actually behaves.
 */

import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  PI_PROMPT_SEARCH_TOOL,
  runPiPromptBrief,
} from "~/lib/hook-prompt-brief"
import { fileFindingsStore, stopReviewStateDir } from "~/lib/orchestration/stop-gate-policy"

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

/** A fresh session id per test: the one-shot flag and findings are keyed on it. */
const freshSession = () => `sess-${Math.random().toString(36).slice(2)}-${Date.now()}`

type Infer = (system: string, user: string, signal?: AbortSignal) => Promise<string>

interface Recorder {
  count: number
  lastSystem: string
  lastUser: string
  fn: Infer
}

function recorder(reply: string): Recorder {
  const state: Recorder = {
    count: 0,
    lastSystem: "",
    lastUser: "",
    fn: async (system: string, user: string) => {
      state.count++
      state.lastSystem = system
      state.lastUser = user
      return reply
    },
  }
  return state
}

const base = {
  prompt: SUBSTANTIVE,
  workspace: WORK,
  profile: "balanced2",
  searchEnabled: false,
  bluebirdEnabled: false,
}

describe("runPiPromptBrief refusals", () => {
  test("an empty workspace injects nothing rather than searching the proxy's cwd", async () => {
    const scope = recorder("SHOULD NOT BE USED")
    const rewrite = recorder("SHOULD NOT BE USED")
    const text = await runPiPromptBrief({
      ...base,
      workspace: "   ",
      sessionId: freshSession(),
      infer: scope.fn,
      inferSol: rewrite.fn,
    })
    expect(text).toBe("")
    expect(scope.count).toBe(0)
    expect(rewrite.count).toBe(0)
  })

  test("a missing session id injects nothing: the findings and one-shot flag have no key", async () => {
    const scope = recorder("SHOULD NOT BE USED")
    const rewrite = recorder("SHOULD NOT BE USED")
    const text = await runPiPromptBrief({
      ...base,
      profile: "cheapest",
      sessionId: "",
      infer: scope.fn,
      inferSol: rewrite.fn,
    })
    expect(text).toBe("")
    expect(scope.count).toBe(0)
    expect(rewrite.count).toBe(0)
  })
})

describe("runPiPromptBrief triviality and opt-out", () => {
  test("a trivial prompt injects nothing and spends no model call", async () => {
    const scope = recorder("SHOULD NOT BE USED")
    const rewrite = recorder("SHOULD NOT BE USED")
    const text = await runPiPromptBrief({
      ...base,
      prompt: "hi",
      sessionId: freshSession(),
      infer: scope.fn,
      inferSol: rewrite.fn,
    })
    expect(text).toBe("")
    expect(scope.count).toBe(0)
    expect(rewrite.count).toBe(0)
  })

  test("steer disabled suppresses the tip and the goal", async () => {
    const scope = recorder("SHOULD NOT BE USED")
    const rewrite = recorder("SHOULD NOT BE USED")
    const text = await runPiPromptBrief({
      ...base,
      sessionId: freshSession(),
      steerEnabled: false,
      infer: scope.fn,
      inferSol: rewrite.fn,
    })
    expect(text).toBe("")
    expect(scope.count).toBe(0)
    expect(rewrite.count).toBe(0)
  })

  test("the rewrite opt-out keeps the scope path and never calls Sol", async () => {
    const scope = recorder("SCOPE: focused on widget.ts.\nGOAL: cache widget renders.")
    const rewrite = recorder("SHOULD NOT BE USED")
    const text = await runPiPromptBrief({
      ...base,
      profile: "cheapest",
      sessionId: freshSession(),
      rewriteDisabled: true,
      infer: scope.fn,
      inferSol: rewrite.fn,
    })
    expect(text).toContain("cache widget renders")
    expect(scope.count).toBe(1)
    expect(rewrite.count).toBe(0)
  })
})

describe("runPiPromptBrief scope path", () => {
  test("a substantive prompt injects the Pi search tip plus the grounded note", async () => {
    const scope = recorder("SCOPE: focused on widget.ts.\nGOAL: cache widget renders.")
    const rewrite = recorder("SHOULD NOT BE USED")
    const text = await runPiPromptBrief({
      ...base,
      sessionId: freshSession(),
      infer: scope.fn,
      inferSol: rewrite.fn,
    })
    expect(text).toContain("TIP (advisory)")
    // The load-bearing prose assertion: Pi's prefixed MCP key, not Claude's
    // bare `mcp__search__code`, which does not exist in a Pi session.
    expect(text).toContain(PI_PROMPT_SEARCH_TOOL)
    expect(text).toContain("cache widget renders")
    expect(scope.count).toBe(1)
    expect(rewrite.count).toBe(0)
    // The grounded user turn carries the prompt AND the search results — a
    // note produced without them would be the un-grounded guess this replaces.
    expect(scope.lastUser).toContain("widget caching layer")
    expect(scope.lastUser).toContain("USER REQUEST:")
  })

  test("no Claude-only skill names leak into the Pi prose", async () => {
    const scope = recorder("SCOPE: focused.\nGOAL: do the thing.")
    const text = await runPiPromptBrief({
      ...base,
      sessionId: freshSession(),
      infer: scope.fn,
      inferSol: recorder("SHOULD NOT BE USED").fn,
    })
    expect(text).not.toContain("/gh-research")
    expect(text).not.toContain("/gh-orchestrate")
  })

  test("a throwing infer fails open to the Pi goal instead of rejecting", async () => {
    const text = await runPiPromptBrief({
      ...base,
      sessionId: freshSession(),
      infer: () => Promise.reject(new Error("upstream 502")),
      inferSol: recorder("SHOULD NOT BE USED").fn,
    })
    expect(text).toContain("GOAL (advisory)")
    expect(text).toContain("`subagent`")
    expect(text).not.toContain("/gh-research")
  })
})

describe("runPiPromptBrief findings", () => {
  test("pending findings are surfaced once, then cleared", async () => {
    const sessionId = freshSession()
    await fileFindingsStore(stopReviewStateDir()).write(
      sessionId,
      "- widget.ts:4 leaks the cache handle",
    )
    const scope = recorder("SHOULD NOT BE USED")
    const rewrite = recorder("SHOULD NOT BE USED")
    const text = await runPiPromptBrief({
      ...base,
      prompt: "hi",
      sessionId,
      infer: scope.fn,
      inferSol: rewrite.fn,
    })
    // Trivial prompt, but findings still ride: they are the prior turn's
    // review of work the user has not seen yet, so triviality is irrelevant.
    expect(text).toContain("NON-AUTHORITATIVE")
    expect(text).toContain("leaks the cache handle")
    expect(scope.count).toBe(0)
    expect(rewrite.count).toBe(0)

    const second = await runPiPromptBrief({
      ...base,
      prompt: "hi",
      sessionId,
      infer: scope.fn,
      inferSol: rewrite.fn,
    })
    // One-shot delivery: a re-injected finding would nag on every prompt.
    expect(second).toBe("")
  })
})

describe("runPiPromptBrief cheapest rewrite", () => {
  test("the cheapest family gets the wrapped EXECUTION BRIEF and no Luna call", async () => {
    const scope = recorder("SHOULD NOT BE USED")
    const rewrite = recorder("1. Read the module\n2. Add a cache")
    const text = await runPiPromptBrief({
      ...base,
      profile: "cheapest2",
      sessionId: freshSession(),
      infer: scope.fn,
      inferSol: rewrite.fn,
    })
    expect(text).toContain("EXECUTION BRIEF")
    expect(text).toContain("Add a cache")
    // The wrapper is what makes the brief additive: it names the user's request
    // as authoritative so the model does not treat a stale brief as an order.
    expect(text).toContain("user's request remains authoritative")
    expect(text).toContain(PI_PROMPT_SEARCH_TOOL)
    expect(rewrite.count).toBe(1)
    // One voice per prompt: a brief already says how to approach the task, so
    // a second model call would only add latency and a competing opinion.
    expect(scope.count).toBe(0)
    expect(rewrite.lastUser).toContain("widget caching layer")
  })

  test("a clean miss falls through to the Luna scope path", async () => {
    const scope = recorder("SCOPE: focused.\nGOAL: cache renders.")
    const rewrite = recorder("")
    const text = await runPiPromptBrief({
      ...base,
      profile: "cheapest",
      sessionId: freshSession(),
      infer: scope.fn,
      inferSol: rewrite.fn,
    })
    expect(rewrite.count).toBe(1)
    expect(scope.count).toBe(1)
    expect(text).toContain("cache renders")
    expect(text).not.toContain("EXECUTION BRIEF")
  })

  test("one rewrite per session: the next prompt goes straight to the scope path", async () => {
    const sessionId = freshSession()
    const scope = recorder("SCOPE: focused.\nGOAL: cache renders.")
    const rewrite = recorder("1. Read the module")
    const first = await runPiPromptBrief({
      ...base,
      profile: "cheapest",
      sessionId,
      infer: scope.fn,
      inferSol: rewrite.fn,
    })
    expect(first).toContain("EXECUTION BRIEF")
    expect(rewrite.count).toBe(1)

    const second = await runPiPromptBrief({
      ...base,
      profile: "cheapest",
      sessionId,
      infer: scope.fn,
      inferSol: rewrite.fn,
    })
    expect(second).not.toContain("EXECUTION BRIEF")
    expect(second).toContain("cache renders")
    // The load-bearing assertion: no second Sol call. A brief that re-billed on
    // every prompt would be the opposite of what "cheapest" means.
    expect(rewrite.count).toBe(1)
  })

  test("a MISS still spends the session's one shot (attempt-marked)", async () => {
    const sessionId = freshSession()
    const scope = recorder("SCOPE: focused.\nGOAL: cache renders.")
    const rewrite = recorder("")
    await runPiPromptBrief({
      ...base,
      profile: "cheapest",
      sessionId,
      infer: scope.fn,
      inferSol: rewrite.fn,
    })
    expect(rewrite.count).toBe(1)

    // Retrying on the next prompt would re-bill a rewrite that already failed
    // once against the same repo state; the Claude hook marks on attempt for
    // exactly this reason and the two must agree.
    await runPiPromptBrief({
      ...base,
      profile: "cheapest",
      sessionId,
      infer: scope.fn,
      inferSol: rewrite.fn,
    })
    expect(rewrite.count).toBe(1)
  })

  test("the balanced family never spends the Sol rewrite", async () => {
    const scope = recorder("SCOPE: focused.\nGOAL: cache renders.")
    const rewrite = recorder("SHOULD NOT BE USED")
    await runPiPromptBrief({
      ...base,
      profile: "balanced",
      sessionId: freshSession(),
      infer: scope.fn,
      inferSol: rewrite.fn,
    })
    expect(rewrite.count).toBe(0)
    expect(scope.count).toBe(1)
  })
})
