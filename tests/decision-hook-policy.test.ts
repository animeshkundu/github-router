import { describe, expect, mock, test } from "bun:test"

import {
  createDecisionHookHttp,
  runDecisionHookPolicy,
  type DecisionHookHttp,
  type DecisionHookHttpCallOptions,
  type DecisionPacket,
} from "../src/lib/decision-hook-policy"

function payload(obj: Record<string, unknown>): string {
  return JSON.stringify(obj)
}

function parsedDeny(output: string | null): { hookSpecificOutput: { hookEventName: string; permissionDecision: string; permissionDecisionReason: string } } {
  expect(output).not.toBeNull()
  return JSON.parse(output as string) as { hookSpecificOutput: { hookEventName: string; permissionDecision: string; permissionDecisionReason: string } }
}

type CreateDecisionFn = (packet: DecisionPacket, options?: DecisionHookHttpCallOptions) => Promise<{ decisionId: string }>
type AwaitDecisionFn = (decisionId: string, timeoutMs: number, options?: DecisionHookHttpCallOptions) => Promise<unknown>

function mockHttp(args: {
  create?: CreateDecisionFn
  await?: AwaitDecisionFn
} = {}): {
  http: DecisionHookHttp
  createDecision: ReturnType<typeof mock<CreateDecisionFn>>
  awaitDecision: ReturnType<typeof mock<AwaitDecisionFn>>
} {
  const createDecision = mock(args.create ?? (async (_packet: DecisionPacket) => ({ decisionId: "dec-1" })))
  const awaitDecision = mock(args.await ?? (async (_decisionId: string, _timeoutMs: number) => ({ answered: true, choice: "approve" })))
  return { http: { createDecision, awaitDecision }, createDecision, awaitDecision }
}

describe("decision-hook policy", () => {
  test("answered approve -> allow (prints nothing)", async () => {
    const { http, createDecision, awaitDecision } = mockHttp({
      await: async () => ({ answered: true, choice: "approve" }),
    })

    const result = await runDecisionHookPolicy({
      stdin: payload({ tool_name: "Bash", tool_input: { command: "bun test" }, cwd: "/repo" }),
      http,
      fallbackCwd: "/fallback",
      now: () => 0,
      returnMarginMs: 0,
    })

    expect(result.verdict).toBe("allow-approved")
    expect(result.output).toBeNull()
    expect(createDecision.mock.calls.length).toBe(1)
    expect(createDecision.mock.calls[0]?.[0]).toEqual({
      kind: "tool_approval",
      tool: "Bash",
      command: "bun test",
      cwd: "/repo",
    })
    expect(awaitDecision.mock.calls.length).toBe(1)
    expect(awaitDecision.mock.calls[0]?.[0]).toBe("dec-1")
    expect(awaitDecision.mock.calls[0]?.[1]).toBe(25_000)
    expect(awaitDecision.mock.calls[0]?.[2]?.signal).toBeInstanceOf(AbortSignal)
  })

  test("answered reject -> deny PreToolUse JSON", async () => {
    const { http } = mockHttp({ await: async () => ({ answered: true, choice: "reject" }) })

    const result = await runDecisionHookPolicy({
      stdin: payload({ tool_name: "ExitPlanMode", tool_input: { plan: "1. Do the thing" } }),
      http,
      fallbackCwd: "/repo",
      now: () => 0,
      returnMarginMs: 0,
    })

    expect(result.verdict).toBe("deny-rejected")
    const denied = parsedDeny(result.output)
    expect(denied.hookSpecificOutput.hookEventName).toBe("PreToolUse")
    expect(denied.hookSpecificOutput.permissionDecision).toBe("deny")
    expect(denied.hookSpecificOutput.permissionDecisionReason).toContain("choice=reject")
  })

  test("viewers === 0 -> deny immediately (no reviewer connected)", async () => {
    const { http, awaitDecision } = mockHttp({ await: async () => ({ answered: false, viewers: 0 }) })

    const result = await runDecisionHookPolicy({
      stdin: payload({ tool_name: "Write", tool_input: { file_path: "src/a.ts", content: "x" }, cwd: "/repo" }),
      http,
      fallbackCwd: "/fallback",
      now: () => 0,
      returnMarginMs: 0,
    })

    expect(result.verdict).toBe("deny-no-reviewer")
    expect(awaitDecision.mock.calls.length).toBe(1)
    expect(parsedDeny(result.output).hookSpecificOutput.permissionDecisionReason).toContain("no mobile reviewer connected")
  })

  test("human-wait budget expiry -> deny before the host hook timeout can fail open", async () => {
    let nowMs = 0
    const { http } = mockHttp({
      await: async () => {
        nowMs = 11
        return { answered: false, viewers: 1 }
      },
    })

    const result = await runDecisionHookPolicy({
      stdin: payload({ tool_name: "Edit", tool_input: { file_path: "src/a.ts", old_string: "a", new_string: "b" } }),
      http,
      fallbackCwd: "/repo",
      now: () => nowMs,
      sleep: async () => {},
      maxHumanWaitMs: 10,
      hardDeadlineMs: 1_000,
      pollTimeoutMs: 25,
      returnMarginMs: 0,
      repollDelayMs: 0,
    })

    expect(result.verdict).toBe("deny-budget-expired")
    expect(parsedDeny(result.output).hookSpecificOutput.permissionDecisionReason).toContain("timed out")
  })

  test("HTTP error -> deny fail-closed", async () => {
    const { http, awaitDecision } = mockHttp({
      create: async () => {
        throw new Error("network down")
      },
    })

    const result = await runDecisionHookPolicy({
      stdin: payload({ tool_name: "Bash", tool_input: { command: "rm -rf dist" } }),
      http,
      fallbackCwd: "/repo",
      now: () => 0,
      returnMarginMs: 0,
    })

    expect(result.verdict).toBe("deny-http-error")
    expect(awaitDecision.mock.calls.length).toBe(0)
    expect(parsedDeny(result.output).hookSpecificOutput.permissionDecisionReason).toContain("fail-closed")
  })

  test("hanging decision POST trips the policy watchdog -> budget deny", async () => {
    const start = Date.now()
    let sawAbort = false
    const { http, createDecision, awaitDecision } = mockHttp({
      create: async (_packet, options) => new Promise<{ decisionId: string }>((_resolve, reject) => {
        options?.signal?.addEventListener("abort", () => {
          sawAbort = true
          reject(options.signal?.reason ?? new Error("aborted"))
        }, { once: true })
      }),
    })

    const result = await runDecisionHookPolicy({
      stdin: payload({ tool_name: "Bash", tool_input: { command: "sleep forever" } }),
      http,
      fallbackCwd: "/repo",
      now: () => Date.now() - start,
      maxHumanWaitMs: 15,
      hardDeadlineMs: 1_000,
      returnMarginMs: 0,
    })

    expect(result.verdict).toBe("deny-budget-expired")
    expect(createDecision.mock.calls.length).toBe(1)
    expect(createDecision.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal)
    expect(sawAbort).toBe(true)
    expect(awaitDecision.mock.calls.length).toBe(0)
  })

  test("hanging await poll trips the policy watchdog -> self-deadline deny", async () => {
    const start = Date.now()
    let sawAbort = false
    const { http, awaitDecision } = mockHttp({
      await: async (_decisionId, _timeoutMs, options) => new Promise<unknown>((_resolve, reject) => {
        options?.signal?.addEventListener("abort", () => {
          sawAbort = true
          reject(options.signal?.reason ?? new Error("aborted"))
        }, { once: true })
      }),
    })

    const result = await runDecisionHookPolicy({
      stdin: payload({ tool_name: "ExitPlanMode", tool_input: { plan: "Ship it" } }),
      http,
      fallbackCwd: "/repo",
      now: () => Date.now() - start,
      maxHumanWaitMs: 1_000,
      hardDeadlineMs: 15,
      pollTimeoutMs: 25_000,
      returnMarginMs: 0,
    })

    expect(result.verdict).toBe("deny-self-deadline")
    expect(awaitDecision.mock.calls.length).toBe(1)
    expect(awaitDecision.mock.calls[0]?.[2]?.signal).toBeInstanceOf(AbortSignal)
    expect(sawAbort).toBe(true)
    expect(parsedDeny(result.output).hookSpecificOutput.permissionDecisionReason).toContain("self-deadline")
  })

  test("unknown tool -> allow passthrough and never calls HTTP", async () => {
    const { http, createDecision, awaitDecision } = mockHttp()

    const result = await runDecisionHookPolicy({
      stdin: payload({ tool_name: "Read", tool_input: { file_path: "src/a.ts" } }),
      http,
      fallbackCwd: "/repo",
      now: () => 0,
    })

    expect(result.verdict).toBe("allow-passthrough")
    expect(result.output).toBeNull()
    expect(createDecision.mock.calls.length).toBe(0)
    expect(awaitDecision.mock.calls.length).toBe(0)
  })

  test("bypassPermissions mode -> allow passthrough for a gated tool, never calls HTTP", async () => {
    const { http, createDecision, awaitDecision } = mockHttp()

    const result = await runDecisionHookPolicy({
      stdin: payload({
        tool_name: "Bash",
        tool_input: { command: "rm -rf build" },
        permission_mode: "bypassPermissions",
      }),
      http,
      fallbackCwd: "/repo",
      now: () => 0,
    })

    // Claude does not prompt in bypass, so the mobile sheet must NOT pop and the
    // tool must run under Claude's own flow — no decision is ever registered.
    expect(result.verdict).toBe("allow-passthrough")
    expect(result.output).toBeNull()
    expect(createDecision.mock.calls.length).toBe(0)
    expect(awaitDecision.mock.calls.length).toBe(0)
  })

  test("dontAsk and auto modes -> allow passthrough (no prompt, no HTTP)", async () => {
    for (const mode of ["dontAsk", "auto"]) {
      const { http, createDecision } = mockHttp()
      const result = await runDecisionHookPolicy({
        stdin: payload({ tool_name: "Write", tool_input: { file_path: "a.ts" }, permission_mode: mode }),
        http,
        fallbackCwd: "/repo",
        now: () => 0,
      })
      expect(result.verdict).toBe("allow-passthrough")
      expect(createDecision.mock.calls.length).toBe(0)
    }
  })

  test("default mode -> still intercepts a gated tool (mobile approval applies)", async () => {
    const { http, createDecision } = mockHttp()

    const result = await runDecisionHookPolicy({
      stdin: payload({
        tool_name: "Bash",
        tool_input: { command: "npm test" },
        permission_mode: "default",
      }),
      http,
      fallbackCwd: "/repo",
      now: () => 0,
    })

    // default mode is a prompting mode → Claude would ask → the hook registers a
    // decision (here the mock auto-approves) rather than standing down.
    expect(result.verdict).toBe("allow-approved")
    expect(createDecision.mock.calls.length).toBe(1)
  })
})

describe("decision-hook HTTP client", () => {
  test("uses the ai-or-die control-plane endpoints with Bearer auth", async () => {
    const seen: Array<{ url: string; method?: string; auth?: string; contentType?: string; body?: unknown }> = []
    const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string> | undefined
      seen.push({
        url: url.toString(),
        method: init?.method,
        auth: headers?.Authorization,
        contentType: headers?.["Content-Type"],
        body: typeof init?.body === "string" ? JSON.parse(init.body) as unknown : undefined,
      })
      if (init?.method === "POST") return Response.json({ decisionId: "dec/1" })
      return Response.json({ answered: false, viewers: 2 })
    }) as unknown as typeof fetch

    const client = createDecisionHookHttp({
      baseUrl: "https://ai.example/",
      token: "tok-mobile",
      sessionId: "sess 1",
      fetchFn,
    })
    const packet: DecisionPacket = { kind: "plan_approval", plan: "ship it" }

    expect(await client.createDecision(packet)).toEqual({ decisionId: "dec/1" })
    expect(await client.awaitDecision("dec/1", 25_000)).toEqual({ answered: false, viewers: 2 })

    expect(seen).toEqual([
      {
        url: "https://ai.example/api/control/sessions/sess%201/decision",
        method: "POST",
        auth: "Bearer tok-mobile",
        contentType: "application/json",
        body: packet,
      },
      {
        url: "https://ai.example/api/control/decisions/dec%2F1/await?timeoutMs=25000",
        method: "GET",
        auth: "Bearer tok-mobile",
        contentType: undefined,
        body: undefined,
      },
    ])
  })
})
