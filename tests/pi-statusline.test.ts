import { describe, expect, test } from "bun:test"

import { buildPiExtensionSource } from "~/lib/pi-extension"
import {
  PI_STATUS_COMMAND_ENV,
  PI_STATUSLINE_DEBOUNCE_MS,
  PI_STATUSLINE_TIMEOUT_MS,
  buildPiStatusPayload,
} from "~/lib/pi-statusline"
import {
  buildRichStatusLine,
  parseStatusInput,
} from "~/lib/default-statusline"

const NOW = 1_769_000_000_000

const ANSI_PATTERN = "\\x1b\\[[0-9;]*m"
function stripAnsiForParity(s: string): string {
  return s.replace(new RegExp(ANSI_PATTERN, "g"), "")
}

function midSessionSource() {
  return {
    cwd: "/Users/me/my-proj",
    sessionId: "sess-123",
    model: { id: "gpt-6-luna", displayName: "gpt-6-luna", contextWindow: 272000 },
    contextUsage: { tokens: 114000, contextWindow: 272000, percent: 42 },
    entries: [
      { id: "m1", type: "message", parentId: null, timestamp: new Date(NOW - 213000).toISOString(), message: { role: "user" } },
      {
        id: "m2",
        type: "message",
        parentId: "m1",
        timestamp: new Date(NOW - 200000).toISOString(),
        message: {
          role: "assistant",
          stopReason: "stop",
          timestamp: NOW - 200000,
          usage: { input: 15234, output: 4521, cacheRead: 100, cacheWrite: 50, totalTokens: 19905, cost: { total: 0.05 } },
        },
      },
      {
        id: "m3",
        type: "message",
        parentId: "m2",
        timestamp: new Date(NOW).toISOString(),
        message: { role: "toolResult", toolCallId: "t1", toolName: "edit", isError: false, timestamp: NOW, details: { linesAdded: 156, linesRemoved: 23 } },
      },
    ],
  }
}

describe("buildPiStatusPayload", () => {
  test("mid-session payload carries native Pi data in Claude field names", () => {
    const payload = buildPiStatusPayload(midSessionSource(), {
      nowMs: NOW,
      sessionStartMs: NOW - 213000,
    })
    expect(payload.cwd).toBe("/Users/me/my-proj")
    expect(payload.session_id).toBe("sess-123")
    const model = payload.model as Record<string, unknown>
    expect(model.id).toBe("gpt-6-luna")
    expect(model.display_name).toBe("gpt-6-luna")
    const workspace = payload.workspace as Record<string, unknown>
    expect(workspace.current_dir).toBe("/Users/me/my-proj")
    const cost = payload.cost as Record<string, unknown>
    // Wall-clock from the tracked session start (Claude semantics).
    expect(cost.total_duration_ms).toBe(213000)
    expect(cost.total_lines_added).toBe(156)
    expect(cost.total_lines_removed).toBe(23)
    // List-price USD is never forwarded.
    expect(cost.total_cost_usd).toBeNull()
    const ctx = payload.context_window as Record<string, unknown>
    expect(ctx.total_input_tokens).toBe(15234)
    expect(ctx.total_output_tokens).toBe(4521)
    // Authoritative Pi percent — never a latest-turn ratio.
    expect(ctx.used_percentage).toBe(42)
    expect(ctx.remaining_percentage).toBe(58)
    expect(ctx.context_window_size).toBe(272000)
  })

  test("early session: placeholders until data exists, duration from start", () => {
    const payload = buildPiStatusPayload(
      { cwd: "/tmp/x", entries: [] },
      { nowMs: NOW, sessionStartMs: NOW - 5000 },
    )
    const cost = payload.cost as Record<string, unknown>
    expect(cost.total_duration_ms).toBe(5000)
    expect(cost.total_lines_added).toBe(0)
    expect(cost.total_lines_removed).toBe(0)
    const ctx = payload.context_window as Record<string, unknown>
    expect(ctx.total_input_tokens).toBeNull()
    expect(ctx.total_output_tokens).toBeNull()
    expect(ctx.used_percentage).toBeNull()
    const model = payload.model as Record<string, unknown>
    expect(model.id).toBeNull()
    expect(model.display_name).toBeNull()
  })

  test("transcript-derived duration when no session start was tracked", () => {
    const payload = buildPiStatusPayload(midSessionSource(), { nowMs: NOW })
    const cost = payload.cost as Record<string, unknown>
    expect(cost.total_duration_ms).toBe(213000)
  })

  test("aborted assistant turns are skipped; nested tool details counted once", () => {
    const payload = buildPiStatusPayload(
      {
        entries: [
          {
            type: "message",
            timestamp: NOW,
            message: { role: "assistant", stopReason: "aborted", usage: { input: 99999, output: 99999 } },
          },
          {
            type: "message",
            timestamp: NOW,
            message: { role: "toolResult", details: { details: { linesAdded: 10, linesRemoved: 4 } } },
          },
        ],
      },
      { nowMs: NOW },
    )
    const ctx = payload.context_window as Record<string, unknown>
    expect(ctx.total_input_tokens).toBeNull()
    const cost = payload.cost as Record<string, unknown>
    expect(cost.total_lines_added).toBe(10)
    expect(cost.total_lines_removed).toBe(4)
  })

  test("model falls back through name to id; window falls back to model", () => {
    const payload = buildPiStatusPayload(
      { model: { id: "grok-4.6", contextWindow: 200000 }, entries: [] },
      { nowMs: NOW },
    )
    const model = payload.model as Record<string, unknown>
    expect(model.display_name).toBe("grok-4.6")
    const ctx = payload.context_window as Record<string, unknown>
    expect(ctx.context_window_size).toBe(200000)
  })

  test("garbage in, placeholders out — never throws", () => {
    expect(() =>
      buildPiStatusPayload(
        { cwd: 42, sessionId: ["x"], model: "nope", contextUsage: "nope", entries: "nope" } as never,
        { nowMs: NOW },
      ),
    ).not.toThrow()
    const payload = buildPiStatusPayload({} as never, { nowMs: NOW })
    expect(payload.cwd).toBe("")
    expect(payload.session_id).toBeNull()
    const cost = payload.cost as Record<string, unknown>
    expect(cost.total_duration_ms).toBeNull()
  })

  test("payload builder is dependency-free (safe to embed in generated code)", () => {
    const source = buildPiStatusPayload.toString()
    expect(source).toContain("function buildPiStatusPayload")
    expect(source).not.toContain("import ")
    expect(source).not.toContain("require(")
  })
})

describe("Pi → Claude rendering parity", () => {
  test("a Pi-native payload renders every Claude segment", () => {
    const payload = buildPiStatusPayload(midSessionSource(), {
      nowMs: NOW,
      sessionStartMs: NOW - 213000,
    })
    const input = parseStatusInput(JSON.stringify(payload))
    expect(input.usedPct).toBe(42)
    expect(input.totalInputTokens).toBe(15234)
    expect(input.totalOutputTokens).toBe(4521)
    expect(input.totalDurationMs).toBe(213000)
    expect(input.linesAdded).toBe(156)
    expect(input.linesRemoved).toBe(23)
    expect(input.cwd).toBe("/Users/me/my-proj")
    expect(input.modelName).toBe("gpt-6-luna")

    const line = buildRichStatusLine(JSON.stringify(payload), "[AIC 12.42]", {
      width: 500,
      branchOverride: "main",
      actualUsd: 0.1242,
    })
    const plain = stripAnsiForParity(line)
    for (const token of [
      "[AIC 12.42]",
      "42%",
      "gpt-6-luna",
      "my-proj",
      "main",
      "~$0.12",
      "15.2k/4.5k",
      "3m33s",
      "+156 -23",
    ]) {
      expect(plain).toContain(token)
    }
  })
})

describe("generated gh-router-pi extension footer", () => {
  for (const profileId of ["cheapest", "balanced"] as const) {
    test(`${profileId}: footer section present with shared runner wiring`, () => {
      const source = buildPiExtensionSource({
        profileId,
        searchEnabled: false,
        browseEnabled: false,
      })
      // Embedded payload builder is verbatim (what's tested is what's shipped).
      expect(source).toContain(buildPiStatusPayload.toString())
      // Command arrives via env; kill-switch honored.
      expect(source).toContain(PI_STATUS_COMMAND_ENV)
      expect(source).toContain("GH_ROUTER_DISABLE_AIC_STATUSLINE")
      // Footer ownership lifecycle.
      expect(source).toContain("setFooter")
      expect(source).toContain("session_shutdown")
      // Timing constants flow from the single source of truth.
      expect(source).toContain(`DEBOUNCE_MS = ${PI_STATUSLINE_DEBOUNCE_MS}`)
      expect(source).toContain(`TIMEOUT_MS = ${PI_STATUSLINE_TIMEOUT_MS}`)
      // Refresh coverage mirrors the retired bridge's event set.
      for (const event of ["turn_end", "model_select", "session_compact", "session_tree"]) {
        expect(source).toContain(event)
      }
      // No third-party statusline package reference remains.
      expect(source).not.toContain("pi-statusline")
    })

    test(`${profileId}: generated source is syntactically valid TypeScript`, () => {
      const source = buildPiExtensionSource({
        profileId,
        searchEnabled: true,
        browseEnabled: true,
      })
      const transpiler = new Bun.Transpiler({ loader: "ts" })
      expect(() => transpiler.transformSync(source)).not.toThrow()
    })
  }
})
