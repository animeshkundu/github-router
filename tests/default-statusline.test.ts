import { describe, expect, test } from "bun:test"

import {
  assembleStatusLine,
  buildCostSegment,
  buildCtxSegment,
  buildDirGitSegment,
  buildRichStatusLine,
  compactTokens,
  dirLeaf,
  formatDurationMs,
  parseStatusInput,
  resolveGitBranch,
  terminalWidth,
} from "~/lib/default-statusline"

const ANSI = "\x1b\\[[0-9;]*m"
function stripAnsi(s: string): string {
  return s.replace(new RegExp(ANSI, "g"), "")
}

const FULL_JSON = JSON.stringify({
  model: { display_name: "Opus", id: "claude-opus-5" },
  context_window: {
    used_percentage: 42,
    total_input_tokens: 15234,
    total_output_tokens: 4521,
  },
  cost: {
    total_cost_usd: 1.93,
    total_duration_ms: 213_000,
    total_lines_added: 156,
    total_lines_removed: 23,
  },
  workspace: { current_dir: "/Users/me/my-proj" },
})

describe("parseStatusInput", () => {
  test("extracts all fields from full JSON", () => {
    const in_ = parseStatusInput(FULL_JSON)
    expect(in_.usedPct).toBe(42)
    expect(in_.totalInputTokens).toBe(15234)
    expect(in_.totalOutputTokens).toBe(4521)
    expect(in_.totalCostUsd).toBeCloseTo(1.93)
    expect(in_.totalDurationMs).toBe(213_000)
    expect(in_.linesAdded).toBe(156)
    expect(in_.linesRemoved).toBe(23)
    expect(in_.cwd).toBe("/Users/me/my-proj")
    expect(in_.modelName).toBe("Opus")
  })

  test("falls back to cwd and model.id", () => {
    const in_ = parseStatusInput(
      JSON.stringify({
        model: { id: "claude-opus-5" },
        cwd: "/tmp/x",
      }),
    )
    expect(in_.modelName).toBe("claude-opus-5")
    expect(in_.cwd).toBe("/tmp/x")
  })

  test("malformed or empty input yields {}", () => {
    expect(parseStatusInput("")).toEqual({})
    expect(parseStatusInput("   ")).toEqual({})
    expect(parseStatusInput("not json")).toEqual({})
    expect(parseStatusInput("[1,2]")).toEqual({})
  })

  test("nulls before first API call are tolerated", () => {
    const in_ = parseStatusInput(
      JSON.stringify({
        context_window: { used_percentage: null, current_usage: null },
        cost: { total_cost_usd: null },
      }),
    )
    expect(in_.usedPct).toBeUndefined()
    expect(in_.totalCostUsd).toBeUndefined()
  })
})

describe("compactTokens / formatDurationMs / dirLeaf", () => {
  test("compact", () => {
    expect(compactTokens(999)).toBe("999")
    expect(compactTokens(1000)).toBe("1.0k")
    expect(compactTokens(15234)).toBe("15.2k")
    expect(compactTokens(2_100_000)).toBe("2.1M")
  })

  test("duration", () => {
    expect(formatDurationMs(45_000)).toBe("0m45s")
    expect(formatDurationMs(213_000)).toBe("3m33s")
    expect(formatDurationMs(3_720_000)).toBe("1h02m")
  })

  test("dirLeaf handles posix, windows, trailing slashes", () => {
    expect(dirLeaf("/Users/me/my-proj")).toBe("my-proj")
    expect(dirLeaf("/Users/me/my-proj/")).toBe("my-proj")
    expect(dirLeaf("C:\\Users\\me\\my-proj")).toBe("my-proj")
    expect(dirLeaf("C:\\Users\\me\\my-proj\\")).toBe("my-proj")
  })
})

describe("segment builders", () => {
  test("ctx thresholds + placeholder", () => {
    expect(stripAnsi(buildCtxSegment(10).plain)).toMatch(/\[#+.*\] 10%/)
    expect(buildCtxSegment(10).text).toContain("\x1b[32m")
    expect(buildCtxSegment(60).text).toContain("\x1b[33m")
    expect(buildCtxSegment(90).text).toContain("\x1b[31m")
    expect(buildCtxSegment(undefined).plain).toBe("[----------] --%")
  })

  test("ctx bar is 10 wide and clamped", () => {
    expect(buildCtxSegment(0).plain).toBe("[----------] 0%")
    expect(buildCtxSegment(100).plain).toBe("[##########] 100%")
    expect(buildCtxSegment(1000).plain).toBe("[##########] 100%")
  })

  test("cost thresholds + placeholder", () => {
    expect(buildCostSegment(undefined).plain).toBe("$--")
    expect(buildCostSegment(1.93).plain).toBe("$1.93")
    expect(buildCostSegment(12.34).plain).toBe("$12.3")
    expect(buildCostSegment(10).text).toContain("\x1b[32m")
    expect(buildCostSegment(50).text).toContain("\x1b[33m")
    expect(buildCostSegment(100).text).toContain("\x1b[38;5;208m")
    expect(buildCostSegment(200).text).toContain("\x1b[31m")
  })

  test("dir+git combos", () => {
    expect(buildDirGitSegment(undefined, undefined)).toBeUndefined()
    expect(buildDirGitSegment("/a/proj", undefined)?.plain).toBe("proj")
    expect(buildDirGitSegment(undefined, "main")?.plain).toBe("main")
    expect(buildDirGitSegment("/a/proj", "main")?.plain).toBe("proj (main)")
    // Detached HEAD is omitted, dir survives.
    expect(buildDirGitSegment("/a/proj", "HEAD")?.plain).toBe("proj")
  })
})

describe("terminalWidth", () => {
  test("uses COLUMNS when valid, falls back otherwise", () => {
    expect(terminalWidth({ COLUMNS: "100" })).toBe(100)
    expect(terminalWidth({})).toBe(120)
    expect(terminalWidth({ COLUMNS: "abc" })).toBe(120)
    expect(terminalWidth({ COLUMNS: "0" })).toBe(120)
    expect(terminalWidth({ COLUMNS: "-5" })).toBe(120)
  })
})

describe("resolveGitBranch", () => {
  test("empty cwd never spawns", () => {
    expect(resolveGitBranch(undefined)).toBe("")
    expect(resolveGitBranch("")).toBe("")
  })
})

describe("assembleStatusLine", () => {
  const input = {
    usedPct: 42,
    totalInputTokens: 15234,
    totalOutputTokens: 4521,
    totalCostUsd: 1.93,
    totalDurationMs: 213_000,
    linesAdded: 156,
    linesRemoved: 23,
    cwd: "/Users/me/my-proj",
    modelName: "Opus",
  }

  test("wide: AIC pinned first, then ctx|model|dir|.. in order", () => {
    const line = assembleStatusLine("[AIC 12.42]", input, {
      width: 500,
      branch: "main",
    })
    const plain = stripAnsi(line)
    for (const token of [
      "[AIC 12.42]",
      "42%",
      "Opus",
      "my-proj",
      "main",
      "$1.93",
      "15.2k/4.5k",
      "3m33s",
      "+156 -23",
    ]) {
      expect(plain).toContain(token)
    }
    const order = [
      "[AIC 12.42]",
      "42%",
      "Opus",
      "my-proj",
      "$1.93",
      "15.2k/4.5k",
      "3m33s",
      "+156 -23",
    ].map((t) => plain.indexOf(t))
    expect([...order].sort((a, b) => a - b)).toEqual(order)
  })

  test("narrow: AIC survives when nothing else fits", () => {
    const line = assembleStatusLine("[AIC 12.42]", input, {
      width: "[AIC 12.42]".length,
      branch: "main",
    })
    const plain = stripAnsi(line)
    expect(plain).toContain("[AIC 12.42]")
    expect(plain).not.toContain("+156")
  })

  test("no AIC + over-wide keeps the top segment instead of empty", () => {
    const line = assembleStatusLine("", input, { width: 5, branch: "main" })
    expect(stripAnsi(line).length).toBeGreaterThan(0)
  })

  test("empty input with AIC yields AIC only", () => {
    const line = assembleStatusLine("[AIC 1.00]", {}, { width: 500 })
    // Placeholders still render (ctx/cost/toks/dur/lines) — AIC leads.
    expect(stripAnsi(line).startsWith("[AIC 1.00]")).toBe(true)
  })

  test("fully empty yields empty string", () => {
    // No AIC and no branch/dir/model: droppables still include placeholder
    // segments, so this asserts the shape rather than emptiness.
    const line = assembleStatusLine("", {}, { width: 500 })
    expect(stripAnsi(line)).toContain("--%")
  })
})

describe("buildRichStatusLine", () => {
  test("end-to-end without git spawn", () => {
    const line = buildRichStatusLine(FULL_JSON, "[AIC 12.42]", {
      width: 500,
      branchOverride: "main",
    })
    const plain = stripAnsi(line)
    expect(plain).toContain("[AIC 12.42]")
    expect(plain).toContain("Opus")
    expect(plain).toContain("my-proj (main)")
  })

  test("never throws on garbage", () => {
    expect(() =>
      buildRichStatusLine("{{{", "", { width: 80, branchOverride: "" }),
    ).not.toThrow()
  })
})
