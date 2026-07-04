import { describe, expect, mock, test } from "bun:test"

import type {
  ReadSessionResponse,
  SendKeysResponse,
  SendMessageResponse,
  StatusResponse,
  WaitEventsResponse,
} from "../../src/lib/fleet/client"
import {
  classifyMessageReadiness,
  classifyTurnEvents,
  driveTask,
  INTERRUPT_KEY,
  isHardNotReady,
  isNamedKeyOp,
  mapNamedKeyOp,
  OPERATOR_REPORT_FOOTER,
  OPERATOR_REPORT_HEADER,
  operatorReportInstruction,
  parseOperatorReport,
  SUBMIT_KEY,
  waitForMessageReady,
  waitForTurnSettled,
  type DriverClient,
} from "../../src/lib/fleet/driver"

const LOCAL = "local-1"

function statusResponse(status: Record<string, unknown>): StatusResponse {
  return { sessionId: LOCAL, status: status as StatusResponse["status"] }
}

/** A deterministic clock; `sleep` advances it so wait loops need no real timers. */
function makeClock(start = 0) {
  let t = start
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms
    },
    sleep: async (ms: number) => {
      t += Math.max(0, ms)
    },
  }
}

function driverClientStub(overrides: Partial<DriverClient>): DriverClient {
  const reject = (): Promise<never> => Promise.reject(new Error("unexpected driver client call"))
  return {
    status: reject as DriverClient["status"],
    sendMessage: reject as DriverClient["sendMessage"],
    sendKeys: reject as DriverClient["sendKeys"],
    waitEvents: reject as DriverClient["waitEvents"],
    readSession: reject as DriverClient["readSession"],
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// C4: named key ops
// ---------------------------------------------------------------------------

describe("driver: named key ops (C4)", () => {
  test("maps submit->enter and interrupt->ctrl-c (never a literal byte)", () => {
    expect(mapNamedKeyOp("submit")).toBe(SUBMIT_KEY)
    expect(mapNamedKeyOp("submit")).toBe("enter")
    expect(mapNamedKeyOp("interrupt")).toBe(INTERRUPT_KEY)
    expect(mapNamedKeyOp("interrupt")).toBe("ctrl-c")
  })

  test("isNamedKeyOp guards the op set", () => {
    expect(isNamedKeyOp("submit")).toBe(true)
    expect(isNamedKeyOp("interrupt")).toBe(true)
    expect(isNamedKeyOp("enter")).toBe(false)
    expect(isNamedKeyOp("")).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// C1: readiness classification
// ---------------------------------------------------------------------------

describe("driver: classifyMessageReadiness (C1)", () => {
  test("idle is ready", () => {
    expect(classifyMessageReadiness({ interactionState: "idle" })).toMatchObject({ ready: true, reason: "idle" })
  })

  test("waiting_input awaiting next_message is ready", () => {
    expect(classifyMessageReadiness({ interactionState: "waiting_input", awaiting: { kind: "next_message" } }))
      .toMatchObject({ ready: true, reason: "awaiting_message" })
  })

  test("waiting_input with no awaiting kind is ready", () => {
    expect(classifyMessageReadiness({ interactionState: "waiting_input" })).toMatchObject({ ready: true })
  })

  test("a non-message pending prompt is awaiting_other (use respond)", () => {
    expect(classifyMessageReadiness({ interactionState: "waiting_input", awaiting: { kind: "plan_approval" } }))
      .toMatchObject({ ready: false, reason: "awaiting_other", awaitingKind: "plan_approval" })
  })

  test("busy is not ready", () => {
    expect(classifyMessageReadiness({ interactionState: "busy" })).toMatchObject({ ready: false, reason: "busy" })
  })

  test("exited/crashed are terminal", () => {
    expect(classifyMessageReadiness({ interactionState: "exited" })).toMatchObject({ ready: false, reason: "terminal" })
    expect(classifyMessageReadiness({ interactionState: "crashed" })).toMatchObject({ ready: false, reason: "terminal" })
  })

  test("undefined/unknown carries no positive busy evidence", () => {
    expect(classifyMessageReadiness(undefined)).toMatchObject({ ready: false, reason: "unknown" })
    expect(classifyMessageReadiness({ interactionState: "unknown" })).toMatchObject({ ready: false, reason: "unknown" })
  })

  test("isHardNotReady: only busy/awaiting_other/terminal are hard refusals", () => {
    expect(isHardNotReady("busy")).toBe(true)
    expect(isHardNotReady("awaiting_other")).toBe(true)
    expect(isHardNotReady("terminal")).toBe(true)
    expect(isHardNotReady("unknown")).toBe(false)
    expect(isHardNotReady("idle")).toBe(false)
  })
})

describe("driver: waitForMessageReady (C1)", () => {
  test("returns ready immediately for an idle session", async () => {
    const status = mock(async () => statusResponse({ interactionState: "idle" }))
    const result = await waitForMessageReady(driverClientStub({ status }), LOCAL, { waitMs: 0 })
    expect(result.ready).toBe(true)
    expect(status).toHaveBeenCalledTimes(1)
  })

  test("refuses a busy session with no wait budget after one check", async () => {
    const clock = makeClock()
    const status = mock(async () => statusResponse({ interactionState: "busy" }))
    const result = await waitForMessageReady(driverClientStub({ status }), LOCAL, {
      waitMs: 0,
      now: clock.now,
      sleep: clock.sleep,
    })
    expect(result.ready).toBe(false)
    expect(result.readiness.reason).toBe("busy")
    expect(status).toHaveBeenCalledTimes(1)
  })

  test("waits for a busy session to become idle within the budget", async () => {
    const clock = makeClock()
    let call = 0
    const status = mock(async () => {
      call += 1
      return statusResponse({ interactionState: call >= 3 ? "idle" : "busy" })
    })
    const result = await waitForMessageReady(driverClientStub({ status }), LOCAL, {
      waitMs: 1_000,
      pollMs: 100,
      now: clock.now,
      sleep: clock.sleep,
    })
    expect(result.ready).toBe(true)
    expect(status).toHaveBeenCalledTimes(3)
  })

  test("fails OPEN when the status probe throws (unknown, statusError)", async () => {
    const status = mock(async () => {
      throw new Error("status boom")
    })
    const result = await waitForMessageReady(driverClientStub({ status }), LOCAL, { waitMs: 50 })
    expect(result.ready).toBe(false)
    expect(result.readiness.reason).toBe("unknown")
    expect(result.statusError).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// C2: turn classification + settle loop
// ---------------------------------------------------------------------------

describe("driver: classifyTurnEvents (C2)", () => {
  test("turn_ended -> completed (reliable); waiting_input -> awaiting_input", () => {
    const out = classifyTurnEvents([
      { sessionId: "a", kind: "turn_ended" },
      { sessionId: "b", kind: "waiting_input" },
    ])
    expect(out).toContainEqual({ sessionId: "a", status: "completed", reliable: true })
    expect(out).toContainEqual({ sessionId: "b", status: "awaiting_input", reliable: true })
  })

  test("became_idle is idle_flicker and NEVER reliable/completion", () => {
    const out = classifyTurnEvents([{ sessionId: "c", kind: "became_idle" }])
    expect(out).toEqual([{ sessionId: "c", status: "idle_flicker", reliable: false }])
  })

  test("turn_ended outranks waiting_input outranks became_idle for one session", () => {
    const out = classifyTurnEvents([
      { sessionId: "s", kind: "became_idle" },
      { sessionId: "s", kind: "waiting_input" },
      { sessionId: "s", kind: "turn_ended" },
    ])
    expect(out).toEqual([{ sessionId: "s", status: "completed", reliable: true }])
  })

  test("became_busy and unknown kinds are ignored", () => {
    expect(classifyTurnEvents([
      { sessionId: "s", kind: "became_busy" },
      { sessionId: "s", kind: "noise" },
    ])).toEqual([])
  })
})

describe("driver: waitForTurnSettled (C2)", () => {
  test("settles on turn_ended", async () => {
    const waitEvents = mock(async (): Promise<WaitEventsResponse> => ({
      events: [{ seq: 1, sessionId: LOCAL, kind: "turn_ended", at: 1 }],
      gaps: [],
      cursor: "c1",
      more: false,
    }))
    const result = await waitForTurnSettled(driverClientStub({ waitEvents }), LOCAL, { timeoutMs: 1_000 })
    expect(result).toMatchObject({ settled: true, reason: "turn_ended", cursor: "c1" })
  })

  test("settles on waiting_input", async () => {
    const waitEvents = mock(async (): Promise<WaitEventsResponse> => ({
      events: [{ seq: 1, sessionId: LOCAL, kind: "waiting_input", at: 1 }],
      gaps: [],
      cursor: "c1",
      more: false,
    }))
    const result = await waitForTurnSettled(driverClientStub({ waitEvents }), LOCAL, { timeoutMs: 1_000 })
    expect(result).toMatchObject({ settled: true, reason: "waiting_input" })
  })

  test("only requests the reliable kinds and filters to the session", async () => {
    const seen: Array<{ kinds?: ReadonlyArray<string>; sessionIds?: ReadonlyArray<string> }> = []
    const waitEvents = mock(async (input: { kinds?: ReadonlyArray<string>; sessionIds?: ReadonlyArray<string> }): Promise<WaitEventsResponse> => {
      seen.push({ kinds: input.kinds, sessionIds: input.sessionIds })
      return { events: [{ seq: 1, sessionId: LOCAL, kind: "turn_ended", at: 1 }], gaps: [], cursor: "c", more: false }
    })
    await waitForTurnSettled(driverClientStub({ waitEvents }), LOCAL, { timeoutMs: 1_000 })
    expect(seen[0]?.kinds).toEqual(["turn_ended", "waiting_input"])
    expect(seen[0]?.sessionIds).toEqual([LOCAL])
  })

  test("times out (never settling on a became_idle it never even requests) and advances the cursor", async () => {
    const clock = makeClock()
    const cursors: Array<string | undefined> = []
    const waitEvents = mock(async (input: { timeoutMs?: number; cursor?: string }): Promise<WaitEventsResponse> => {
      cursors.push(input.cursor)
      clock.advance(input.timeoutMs ?? 0)
      return { events: [], gaps: [], cursor: `c-${cursors.length}`, more: false }
    })
    const result = await waitForTurnSettled(driverClientStub({ waitEvents }), LOCAL, {
      timeoutMs: 30,
      pollTimeoutMs: 10,
      cursor: "start",
      now: clock.now,
    })
    expect(result.settled).toBe(false)
    expect(result.reason).toBe("timeout")
    // advanced across windows: first poll used the primed cursor, later ones the returned cursors.
    expect(cursors[0]).toBe("start")
    expect(cursors[1]).toBe("c-1")
  })

  test("prefers turn_ended over waiting_input within one batch", async () => {
    const waitEvents = mock(async (): Promise<WaitEventsResponse> => ({
      events: [
        { seq: 1, sessionId: LOCAL, kind: "waiting_input", at: 1 },
        { seq: 2, sessionId: LOCAL, kind: "turn_ended", at: 2 },
      ],
      gaps: [],
      cursor: "c",
      more: false,
    }))
    const result = await waitForTurnSettled(driverClientStub({ waitEvents }), LOCAL, { timeoutMs: 1_000 })
    expect(result.reason).toBe("turn_ended")
  })

  test("backs off and terminates on repeated transport errors (no hot-spin)", async () => {
    const clock = makeClock()
    let calls = 0
    let sleeps = 0
    const waitEvents = mock(async (): Promise<WaitEventsResponse> => {
      calls += 1
      throw new Error("network down")
    })
    const sleep = async (ms: number) => {
      sleeps += 1
      clock.advance(Math.max(1, ms))
    }
    const result = await waitForTurnSettled(driverClientStub({ waitEvents }), LOCAL, {
      timeoutMs: 1_000,
      pollTimeoutMs: 10,
      now: clock.now,
      sleep,
    })
    expect(result).toMatchObject({ settled: false, reason: "timeout" })
    expect(sleeps).toBeGreaterThan(0)
    // bounded by the 250ms backoff across a 1s budget — never a tight spin.
    expect(calls).toBeLessThanOrEqual(5)
  })

  test("returns immediately when the signal is already aborted (never polls)", async () => {
    const controller = new AbortController()
    controller.abort()
    const waitEvents = mock(async (): Promise<WaitEventsResponse> => ({ events: [], gaps: [], cursor: "c", more: false }))
    const result = await waitForTurnSettled(driverClientStub({ waitEvents }), LOCAL, { timeoutMs: 1_000, signal: controller.signal })
    expect(result.settled).toBe(false)
    expect(result.reason).toBe("aborted")
    expect(waitEvents).toHaveBeenCalledTimes(0)
  })

  test("a mid-wait abort surfaces reason 'aborted', distinct from a deadline timeout", async () => {
    const controller = new AbortController()
    let calls = 0
    const waitEvents = mock(async (): Promise<WaitEventsResponse> => {
      calls += 1
      controller.abort() // abort after the first poll returns nothing
      return { events: [], gaps: [], cursor: `c-${calls}`, more: false }
    })
    const result = await waitForTurnSettled(driverClientStub({ waitEvents }), LOCAL, {
      timeoutMs: 10_000,
      pollTimeoutMs: 10,
      signal: controller.signal,
    })
    expect(result).toMatchObject({ settled: false, reason: "aborted" })
  })

  test("a non-finite timeoutMs does not poison the deadline (terminates)", async () => {
    const waitEvents = mock(async (): Promise<WaitEventsResponse> => ({ events: [], gaps: [], cursor: "c", more: false }))
    const result = await waitForTurnSettled(driverClientStub({ waitEvents }), LOCAL, {
      timeoutMs: Number.NaN as unknown as number,
      now: () => 0,
    })
    expect(result).toMatchObject({ settled: false, reason: "timeout" })
    expect(waitEvents).toHaveBeenCalledTimes(1)
  })
})

// ---------------------------------------------------------------------------
// Operator report trailer parsing
// ---------------------------------------------------------------------------

describe("driver: parseOperatorReport", () => {
  test("parses a full trailer", () => {
    const tail = [
      "some earlier chatter",
      OPERATOR_REPORT_HEADER,
      "STATE: done",
      "SUMMARY: implemented the widget",
      "ASK: none",
      "ARTIFACT: /tmp/out.txt",
      OPERATOR_REPORT_FOOTER,
    ].join("\n")
    expect(parseOperatorReport(tail)).toMatchObject({
      state: "done",
      summary: "implemented the widget",
      ask: "none",
      artifact: "/tmp/out.txt",
      found: true,
    })
  })

  test("missing trailer -> state unknown, found false, raw preserved", () => {
    const report = parseOperatorReport("just some transcript output\nno trailer here")
    expect(report.found).toBe(false)
    expect(report.state).toBe("unknown")
    expect(report.raw).toContain("no trailer here")
  })

  test("tolerates a missing footer", () => {
    const tail = `${OPERATOR_REPORT_HEADER}\nSTATE: blocked\nSUMMARY: hit an error`
    expect(parseOperatorReport(tail)).toMatchObject({ state: "blocked", summary: "hit an error", found: true })
  })

  test("captures a multi-line SUMMARY until the next label", () => {
    const tail = [
      OPERATOR_REPORT_HEADER,
      "STATE: needs_input",
      "SUMMARY: line one",
      "line two continues",
      "line three",
      "ASK: which database?",
      OPERATOR_REPORT_FOOTER,
    ].join("\n")
    const report = parseOperatorReport(tail)
    expect(report.summary).toBe("line one\nline two continues\nline three")
    expect(report.ask).toBe("which database?")
    expect(report.state).toBe("needs_input")
  })

  test("labels are case-insensitive", () => {
    const tail = `${OPERATOR_REPORT_HEADER}\nstate: done\nsummary: ok`
    expect(parseOperatorReport(tail)).toMatchObject({ state: "done", summary: "ok" })
  })

  test("the LAST trailer wins when several are present", () => {
    const tail = [
      OPERATOR_REPORT_HEADER,
      "STATE: in_progress",
      OPERATOR_REPORT_FOOTER,
      "more work happened",
      OPERATOR_REPORT_HEADER,
      "STATE: done",
      OPERATOR_REPORT_FOOTER,
    ].join("\n")
    expect(parseOperatorReport(tail).state).toBe("done")
  })

  test("absent fields are undefined; a header with no STATE is unknown", () => {
    const report = parseOperatorReport(`${OPERATOR_REPORT_HEADER}\nSUMMARY: only a summary`)
    expect(report.state).toBe("unknown")
    expect(report.summary).toBe("only a summary")
    expect(report.ask).toBeUndefined()
    expect(report.artifact).toBeUndefined()
    expect(report.found).toBe(true)
  })

  test("operatorReportInstruction embeds the header and footer", () => {
    const text = operatorReportInstruction()
    expect(text).toContain(OPERATOR_REPORT_HEADER)
    expect(text).toContain(OPERATOR_REPORT_FOOTER)
    expect(text).toContain("STATE:")
  })

  test("ignores the echoed instruction template — bracketed placeholders are not a real report", () => {
    // A driven session that echoes the appended instruction without emitting a real
    // report must not be parsed as one: the header is present (found:true) but every
    // field is a "<...>" placeholder, so state falls back to unknown.
    const report = parseOperatorReport(`the model repeated the instructions:\n${operatorReportInstruction()}`)
    expect(report.found).toBe(true)
    expect(report.state).toBe("unknown")
    expect(report.summary).toBeUndefined()
    expect(report.ask).toBeUndefined()
    expect(report.artifact).toBeUndefined()
  })

  test("extracts the REPORT_ID nonce (underscore label) when present", () => {
    const tail = `${OPERATOR_REPORT_HEADER}\nREPORT_ID: abc-123\nSTATE: done\n${OPERATOR_REPORT_FOOTER}`
    expect(parseOperatorReport(tail)).toMatchObject({ reportId: "abc-123", state: "done", found: true })
  })

  test("reportId is undefined when no REPORT_ID line is present", () => {
    expect(parseOperatorReport(`${OPERATOR_REPORT_HEADER}\nSTATE: done`).reportId).toBeUndefined()
  })

  test("operatorReportInstruction embeds the REPORT_ID nonce verbatim when given", () => {
    const text = operatorReportInstruction("nonce-xyz")
    expect(text).toContain("REPORT_ID: nonce-xyz")
    expect(text).toContain("verbatim")
    // Round-trips: parsing the instruction back recovers the nonce.
    expect(parseOperatorReport(text).reportId).toBe("nonce-xyz")
  })

  test("keeps real angle-bracket values (autolink URL, interior tags, HTML) — only spaced placeholders are dropped", () => {
    // A bare autolink: single token, no inner whitespace -> kept.
    expect(parseOperatorReport(`${OPERATOR_REPORT_HEADER}\nSTATE: done\nARTIFACT: <https://example.com/pr/84>`).artifact)
      .toBe("<https://example.com/pr/84>")
    // Interior '>' (multiple tags) -> not a single wrapped token -> kept.
    expect(parseOperatorReport(`${OPERATOR_REPORT_HEADER}\nSTATE: done\nSUMMARY: <Foo> now renders <Bar>`).summary)
      .toBe("<Foo> now renders <Bar>")
    // Multi-line HTML value -> kept.
    const html = parseOperatorReport(`${OPERATOR_REPORT_HEADER}\nSTATE: done\nSUMMARY: <div class="x">\nbody\n</div>`)
    expect(html.summary).toBe(`<div class="x">\nbody\n</div>`)
  })

  test("still drops the descriptive template placeholders (spaced single tokens)", () => {
    // Load-bearing for the nonce guard: an echoed empty template must not parse as a report.
    const r = parseOperatorReport(`${OPERATOR_REPORT_HEADER}\nSTATE: <done | blocked | needs_input | in_progress>\nSUMMARY: <1-3 sentence summary of what you did>`)
    expect(r.state).toBe("unknown")
    expect(r.summary).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// C5: driveTask orchestration
// ---------------------------------------------------------------------------

const RID = "rid-1"

const TRAILER = [
  OPERATOR_REPORT_HEADER,
  `REPORT_ID: ${RID}`,
  "STATE: done",
  "SUMMARY: did the thing",
  "ASK: none",
  "ARTIFACT: /tmp/x",
  OPERATOR_REPORT_FOOTER,
].join("\n")

function baseDeps(overrides: Partial<Parameters<typeof driveTask>[0]>): Parameters<typeof driveTask>[0] {
  const clock = makeClock()
  return {
    client: driverClientStub({}),
    localId: LOCAL,
    prompt: "do the task",
    timeoutMs: 30,
    expectReport: true,
    idempotencyKey: "idem-drive",
    interruptKey: "idem-int",
    reportId: RID,
    idleWaitMs: 0,
    primeTimeoutMs: 0,
    pollTimeoutMs: 10,
    recoverTimeoutMs: 30,
    now: clock.now,
    sleep: clock.sleep,
    ...overrides,
  }
}

describe("driver: driveTask (C5)", () => {
  test("happy path: idle -> submitted -> turn_ended -> parsed report", async () => {
    let sent = false
    const sendMessage = mock(async (): Promise<SendMessageResponse> => {
      sent = true
      return { messageId: "m", delivered: true, confirmed: true, confirmation: "submitted", submission: { status: "submitted" } }
    })
    const client = driverClientStub({
      status: async () => statusResponse({ interactionState: "idle" }),
      sendMessage,
      waitEvents: async (): Promise<WaitEventsResponse> =>
        sent
          ? { events: [{ seq: 1, sessionId: LOCAL, kind: "turn_ended", at: 1 }], gaps: [], cursor: "c", more: false }
          : { events: [], gaps: [], cursor: "c-prime", more: false },
      readSession: async (): Promise<ReadSessionResponse> => ({
        sessionId: LOCAL,
        text: `chatter\n${TRAILER}`,
        truncated: false,
        source: "pty",
        status: {},
      }),
    })

    const result = await driveTask(baseDeps({ client }))

    expect(result).toMatchObject({
      submitted: true,
      delivered: true,
      settled: "turn_ended",
      state: "done",
      summary: "did the thing",
      ask: "none",
      artifact: "/tmp/x",
      reportFound: true,
      interrupted: false,
      recovered: false,
      cursorPrimed: true,
    })
    expect(result.error).toBeUndefined()
  })

  test("surfaces cursorPrimed:false when every prime attempt fails but still proceeds", async () => {
    let sent = false
    const client = driverClientStub({
      status: async () => statusResponse({ interactionState: "idle" }),
      sendMessage: async (): Promise<SendMessageResponse> => {
        sent = true
        return { messageId: "m", delivered: true, confirmed: true, submission: { status: "submitted" } }
      },
      waitEvents: async (): Promise<WaitEventsResponse> => {
        if (!sent) throw new Error("prime always fails")
        return { events: [{ seq: 1, sessionId: LOCAL, kind: "turn_ended", at: 1 }], gaps: [], cursor: "c", more: false }
      },
      readSession: async (): Promise<ReadSessionResponse> => ({ sessionId: LOCAL, text: TRAILER, truncated: false, source: "pty", status: {} }),
    })
    const result = await driveTask(baseDeps({ client }))
    expect(result).toMatchObject({ cursorPrimed: false, settled: "turn_ended", state: "done" })
  })

  test("appends the operator-report instruction by default; expectReport:false sends verbatim", async () => {
    const bodies: Array<string> = []
    const makeClient = () => driverClientStub({
      status: async () => statusResponse({ interactionState: "idle" }),
      sendMessage: async (_id, input): Promise<SendMessageResponse> => {
        bodies.push(input.message)
        return { messageId: "m", delivered: true, confirmed: false, submission: { status: "submitted" } }
      },
      waitEvents: async (): Promise<WaitEventsResponse> => ({
        events: [{ seq: 1, sessionId: LOCAL, kind: "turn_ended", at: 1 }],
        gaps: [],
        cursor: "c",
        more: false,
      }),
      readSession: async (): Promise<ReadSessionResponse> => ({ sessionId: LOCAL, text: "", truncated: false, source: "pty", status: {} }),
    })

    await driveTask(baseDeps({ client: makeClient(), prompt: "P", expectReport: true }))
    await driveTask(baseDeps({ client: makeClient(), prompt: "P", expectReport: false }))

    expect(bodies[0]).toContain(OPERATOR_REPORT_HEADER)
    expect(bodies[0]).toContain("P")
    expect(bodies[1]).toBe("P")
  })

  test("busy-on-send: refuses without sending (notReady, error not_ready)", async () => {
    const sendMessage = mock(async (): Promise<SendMessageResponse> => ({ messageId: "m", delivered: true, confirmed: false }))
    const client = driverClientStub({
      status: async () => statusResponse({ interactionState: "busy" }),
      sendMessage,
    })

    const result = await driveTask(baseDeps({ client, idleWaitMs: 0 }))

    expect(result).toMatchObject({ notReady: true, error: "not_ready", state: "busy", submitted: false, delivered: false })
    expect(sendMessage).toHaveBeenCalledTimes(0)
  })

  test("awaiting a non-message prompt refuses with state awaiting_other", async () => {
    const client = driverClientStub({
      status: async () => statusResponse({ interactionState: "waiting_input", awaiting: { kind: "plan_approval" } }),
    })
    const result = await driveTask(baseDeps({ client }))
    expect(result).toMatchObject({ notReady: true, error: "not_ready", state: "awaiting_other" })
  })

  test("delivery failure returns error delivery_failed", async () => {
    const client = driverClientStub({
      status: async () => statusResponse({ interactionState: "idle" }),
      waitEvents: async (): Promise<WaitEventsResponse> => ({ events: [], gaps: [], cursor: "c", more: false }),
      sendMessage: async (): Promise<SendMessageResponse> => ({ messageId: "m", delivered: false, confirmed: false, delivery: { status: "failed" } }),
    })
    const result = await driveTask(baseDeps({ client }))
    expect(result).toMatchObject({ error: "delivery_failed", delivered: false, submitted: false, state: "send_failed" })
  })

  test("no-trailer: turn ends but the tail has no report -> state unknown + raw", async () => {
    let sent = false
    const client = driverClientStub({
      status: async () => statusResponse({ interactionState: "idle" }),
      sendMessage: async (): Promise<SendMessageResponse> => {
        sent = true
        return { messageId: "m", delivered: true, confirmed: true, submission: { status: "submitted" } }
      },
      waitEvents: async (): Promise<WaitEventsResponse> =>
        sent
          ? { events: [{ seq: 1, sessionId: LOCAL, kind: "turn_ended", at: 1 }], gaps: [], cursor: "c", more: false }
          : { events: [], gaps: [], cursor: "c-prime", more: false },
      readSession: async (): Promise<ReadSessionResponse> => ({
        sessionId: LOCAL,
        text: "the model just talked, no trailer",
        truncated: false,
        source: "pty",
        status: {},
      }),
    })
    const result = await driveTask(baseDeps({ client }))
    expect(result).toMatchObject({ settled: "turn_ended", state: "unknown", reportFound: false })
    expect(result.raw).toContain("no trailer")
  })

  test("hung hook: first wait times out -> interrupt -> recovery settles and re-reads the report", async () => {
    let sent = false
    let interrupted = false
    const sendKeys = mock(async (_id: string, input: { keys: string }): Promise<SendKeysResponse> => {
      expect(input.keys).toBe(INTERRUPT_KEY)
      interrupted = true
      return { keysId: "k", delivered: true }
    })
    const clock = makeClock()
    const client = driverClientStub({
      status: async () => statusResponse({ interactionState: "idle" }),
      sendMessage: async (): Promise<SendMessageResponse> => {
        sent = true
        return { messageId: "m", delivered: true, confirmed: false, submission: { status: "submitted" } }
      },
      sendKeys,
      waitEvents: async (input: { timeoutMs?: number }): Promise<WaitEventsResponse> => {
        if (!sent) return { events: [], gaps: [], cursor: "c-prime", more: false }
        if (!interrupted) {
          // The turn never ends within the budget (the stop hook is blocking).
          clock.advance(input.timeoutMs ?? 0)
          return { events: [], gaps: [], cursor: "c-wait", more: false }
        }
        // After the recovery interrupt, the turn boundary finally fires.
        return { events: [{ seq: 9, sessionId: LOCAL, kind: "turn_ended", at: 9 }], gaps: [], cursor: "c-recover", more: false }
      },
      readSession: async (): Promise<ReadSessionResponse> => ({
        sessionId: LOCAL,
        text: interrupted ? TRAILER : "",
        truncated: false,
        source: "pty",
        status: {},
      }),
    })

    const result = await driveTask(baseDeps({ client, now: clock.now, sleep: clock.sleep, timeoutMs: 30, recoverTimeoutMs: 30 }))

    expect(sendKeys).toHaveBeenCalledTimes(1)
    expect(result).toMatchObject({
      interrupted: true,
      recovered: true,
      settled: "turn_ended",
      state: "done",
      reportFound: true,
    })
  })

  test("hung hook with no recovery: interrupt issued but turn never settles -> timeout, not recovered", async () => {
    let sent = false
    const clock = makeClock()
    const sendKeys = mock(async (): Promise<SendKeysResponse> => ({ keysId: "k", delivered: true }))
    const client = driverClientStub({
      status: async () => statusResponse({ interactionState: "idle" }),
      sendMessage: async (): Promise<SendMessageResponse> => {
        sent = true
        return { messageId: "m", delivered: true, confirmed: false, submission: { status: "unconfirmed" } }
      },
      sendKeys,
      waitEvents: async (input: { timeoutMs?: number }): Promise<WaitEventsResponse> => {
        if (sent) clock.advance(input.timeoutMs ?? 0)
        return { events: [], gaps: [], cursor: "c", more: false }
      },
      readSession: async (): Promise<ReadSessionResponse> => ({ sessionId: LOCAL, text: "still working", truncated: false, source: "pty", status: {} }),
    })

    const result = await driveTask(baseDeps({ client, now: clock.now, sleep: clock.sleep }))

    expect(sendKeys).toHaveBeenCalledTimes(1)
    expect(result).toMatchObject({ interrupted: true, recovered: false, settled: "timeout", state: "timeout", submitted: false })
    expect(result.error).toBeUndefined()
  })

  test("waiting_input settle with no trailer maps to state awaiting_input", async () => {
    let sent = false
    const client = driverClientStub({
      status: async () => statusResponse({ interactionState: "idle" }),
      sendMessage: async (): Promise<SendMessageResponse> => {
        sent = true
        return { messageId: "m", delivered: true, confirmed: false, submission: { status: "submitted" } }
      },
      waitEvents: async (): Promise<WaitEventsResponse> =>
        sent
          ? { events: [{ seq: 1, sessionId: LOCAL, kind: "waiting_input", at: 1 }], gaps: [], cursor: "c", more: false }
          : { events: [], gaps: [], cursor: "c-prime", more: false },
      readSession: async (): Promise<ReadSessionResponse> => ({ sessionId: LOCAL, text: "asking you something", truncated: false, source: "pty", status: {} }),
    })
    const result = await driveTask(baseDeps({ client }))
    expect(result).toMatchObject({ settled: "waiting_input", state: "awaiting_input", interrupted: false })
  })

  test("a placeholder-only echoed trailer does not clobber the settle-derived state", async () => {
    let sent = false
    const client = driverClientStub({
      status: async () => statusResponse({ interactionState: "idle" }),
      sendMessage: async (): Promise<SendMessageResponse> => {
        sent = true
        return { messageId: "m", delivered: true, confirmed: false, submission: { status: "submitted" } }
      },
      waitEvents: async (): Promise<WaitEventsResponse> =>
        sent
          ? { events: [{ seq: 1, sessionId: LOCAL, kind: "waiting_input", at: 1 }], gaps: [], cursor: "c", more: false }
          : { events: [], gaps: [], cursor: "c-prime", more: false },
      // The tail only contains the echoed instruction template (header + placeholders + nonce).
      readSession: async (): Promise<ReadSessionResponse> => ({ sessionId: LOCAL, text: operatorReportInstruction(RID), truncated: false, source: "pty", status: {} }),
    })
    const result = await driveTask(baseDeps({ client }))
    // Header present -> reportFound true, but the placeholder STATE must NOT overwrite
    // the reliable settle-derived state.
    expect(result).toMatchObject({ settled: "waiting_input", state: "awaiting_input", reportFound: true })
  })

  test("a real STATE:done does NOT override a control-plane waiting_input (session still blocked)", async () => {
    let sent = false
    const client = driverClientStub({
      status: async () => statusResponse({ interactionState: "idle" }),
      sendMessage: async (): Promise<SendMessageResponse> => {
        sent = true
        return { messageId: "m", delivered: true, confirmed: false, submission: { status: "submitted" } }
      },
      waitEvents: async (): Promise<WaitEventsResponse> =>
        sent
          ? { events: [{ seq: 1, sessionId: LOCAL, kind: "waiting_input", at: 1 }], gaps: [], cursor: "c", more: false }
          : { events: [], gaps: [], cursor: "c-prime", more: false },
      readSession: async (): Promise<ReadSessionResponse> => ({
        sessionId: LOCAL,
        // A real, current (nonce-matched) report claiming done — but the control plane says awaiting input.
        text: `${OPERATOR_REPORT_HEADER}\nREPORT_ID: ${RID}\nSTATE: done\nASK: need the db creds\n${OPERATOR_REPORT_FOOTER}`,
        truncated: false,
        source: "pty",
        status: {},
      }),
    })
    const result = await driveTask(baseDeps({ client }))
    // The reliable control-plane signal wins for `state`, so a caller does not drop a
    // still-blocked session; the report's ASK is still surfaced.
    expect(result).toMatchObject({ settled: "waiting_input", state: "awaiting_input", ask: "need the db creds", reportFound: true })
  })

  test("primes the cursor with retry, tolerating a transient prime failure before send", async () => {
    let sent = false
    let primeCalls = 0
    const client = driverClientStub({
      status: async () => statusResponse({ interactionState: "idle" }),
      sendMessage: async (): Promise<SendMessageResponse> => {
        sent = true
        return { messageId: "m", delivered: true, confirmed: true, submission: { status: "submitted" } }
      },
      waitEvents: async (): Promise<WaitEventsResponse> => {
        if (!sent) {
          primeCalls += 1
          if (primeCalls === 1) throw new Error("transient prime blip")
          return { events: [], gaps: [], cursor: "c-primed", more: false }
        }
        return { events: [{ seq: 1, sessionId: LOCAL, kind: "turn_ended", at: 1 }], gaps: [], cursor: "c", more: false }
      },
      readSession: async (): Promise<ReadSessionResponse> => ({ sessionId: LOCAL, text: TRAILER, truncated: false, source: "pty", status: {} }),
    })
    const result = await driveTask(baseDeps({ client }))
    expect(primeCalls).toBeGreaterThanOrEqual(2)
    expect(result).toMatchObject({ settled: "turn_ended", state: "done", submitted: true })
  })

  // ---- Fix #1: per-call nonce defeats a stale prior-turn trailer being returned as this turn's result ----

  test("a stale PRIOR-turn trailer (different REPORT_ID) is NOT trusted — no false success", async () => {
    let sent = false
    // The tail carries a REAL, fully-populated trailer, but from a PRIOR turn (different nonce).
    // The current turn produced no matching report. It must NOT be reported as done.
    const stalePriorTrailer = [
      "output from an earlier turn...",
      OPERATOR_REPORT_HEADER,
      "REPORT_ID: OLD-nonce-999",
      "STATE: done",
      "SUMMARY: fixed the OTHER bug last turn",
      "ASK: none",
      "ARTIFACT: /tmp/prev.json",
      OPERATOR_REPORT_FOOTER,
    ].join("\n")
    const client = driverClientStub({
      status: async () => statusResponse({ interactionState: "idle" }),
      sendMessage: async (): Promise<SendMessageResponse> => {
        sent = true
        return { messageId: "m", delivered: true, confirmed: true, submission: { status: "submitted" } }
      },
      waitEvents: async (): Promise<WaitEventsResponse> =>
        sent
          ? { events: [{ seq: 1, sessionId: LOCAL, kind: "turn_ended", at: 1 }], gaps: [], cursor: "c", more: false }
          : { events: [], gaps: [], cursor: "c-prime", more: false },
      readSession: async (): Promise<ReadSessionResponse> => ({ sessionId: LOCAL, text: stalePriorTrailer, truncated: false, source: "pty", status: {} }),
    })
    const result = await driveTask(baseDeps({ client, reportId: "rid-CURRENT" }))
    // turn_ended settled, but the only trailer is stale -> state is settle-derived, not "done",
    // and none of the prior report's fields leak through.
    expect(result).toMatchObject({ settled: "turn_ended", state: "unknown", reportFound: false })
    expect(result.summary).toBeUndefined()
    expect(result.artifact).toBeUndefined()
  })

  test("expectReport:false never trusts a trailer left in the tail (opted out of a report this turn)", async () => {
    let sent = false
    const client = driverClientStub({
      status: async () => statusResponse({ interactionState: "idle" }),
      sendMessage: async (): Promise<SendMessageResponse> => {
        sent = true
        return { messageId: "m", delivered: true, confirmed: true, submission: { status: "submitted" } }
      },
      waitEvents: async (): Promise<WaitEventsResponse> =>
        sent
          ? { events: [{ seq: 1, sessionId: LOCAL, kind: "turn_ended", at: 1 }], gaps: [], cursor: "c", more: false }
          : { events: [], gaps: [], cursor: "c-prime", more: false },
      // The tail still contains a matching-looking trailer, but we did NOT append the instruction.
      readSession: async (): Promise<ReadSessionResponse> => ({ sessionId: LOCAL, text: TRAILER, truncated: false, source: "pty", status: {} }),
    })
    const result = await driveTask(baseDeps({ client, expectReport: false }))
    expect(result).toMatchObject({ settled: "turn_ended", state: "unknown", reportFound: false })
    expect(result.summary).toBeUndefined()
  })

  // ---- Fix #2: a caller abort must NOT inject a Ctrl-C into the live session ----

  test("a caller abort during the turn wait returns state 'aborted' and never sends Ctrl-C", async () => {
    const controller = new AbortController()
    let sent = false
    const sendKeys = mock(async (): Promise<SendKeysResponse> => ({ keysId: "k", delivered: true }))
    const client = driverClientStub({
      status: async () => statusResponse({ interactionState: "idle" }),
      sendMessage: async (): Promise<SendMessageResponse> => {
        sent = true
        return { messageId: "m", delivered: true, confirmed: false, submission: { status: "submitted" } }
      },
      sendKeys,
      waitEvents: async (): Promise<WaitEventsResponse> => {
        if (sent) controller.abort() // caller cancels while we wait for the turn
        return { events: [], gaps: [], cursor: "c", more: false }
      },
      readSession: async (): Promise<ReadSessionResponse> => ({ sessionId: LOCAL, text: "work in progress", truncated: false, source: "pty", status: {} }),
    })
    const result = await driveTask(baseDeps({ client, signal: controller.signal }))
    expect(sendKeys).toHaveBeenCalledTimes(0)
    expect(result).toMatchObject({ settled: "aborted", state: "aborted", interrupted: false, recovered: false })
    expect(result.error).toBeUndefined()
  })

  // ---- Fix #3: a trailer-less recovery re-read must not clobber a good pre-interrupt report ----

  test("recovery re-read without a trailer does NOT clobber a report captured before the interrupt", async () => {
    let sent = false
    let interrupted = false
    const clock = makeClock()
    const sendKeys = mock(async (): Promise<SendKeysResponse> => {
      interrupted = true
      return { keysId: "k", delivered: true }
    })
    const client = driverClientStub({
      status: async () => statusResponse({ interactionState: "idle" }),
      sendMessage: async (): Promise<SendMessageResponse> => {
        sent = true
        return { messageId: "m", delivered: true, confirmed: false, submission: { status: "submitted" } }
      },
      sendKeys,
      waitEvents: async (input: { timeoutMs?: number }): Promise<WaitEventsResponse> => {
        if (!sent) return { events: [], gaps: [], cursor: "c-prime", more: false }
        if (!interrupted) {
          clock.advance(input.timeoutMs ?? 0) // first wait times out (hung hook)
          return { events: [], gaps: [], cursor: "c-wait", more: false }
        }
        return { events: [{ seq: 9, sessionId: LOCAL, kind: "turn_ended", at: 9 }], gaps: [], cursor: "c-recover", more: false }
      },
      // Before interrupt: a real current report. After: a non-empty tail WITHOUT the trailer.
      readSession: async (): Promise<ReadSessionResponse> => ({
        sessionId: LOCAL,
        text: interrupted ? "^C\nRequest interrupted by user" : TRAILER,
        truncated: false,
        source: "pty",
        status: {},
      }),
    })
    const result = await driveTask(baseDeps({ client, now: clock.now, sleep: clock.sleep, timeoutMs: 30, recoverTimeoutMs: 30 }))
    expect(sendKeys).toHaveBeenCalledTimes(1)
    // The good pre-interrupt report survived the trailer-less recovery re-read.
    expect(result).toMatchObject({ interrupted: true, recovered: true, state: "done", reportFound: true, summary: "did the thing" })
  })

  test("recovery re-read that surfaces a STALE trailer does NOT clobber the current pre-interrupt report", async () => {
    let sent = false
    let interrupted = false
    const clock = makeClock()
    const sendKeys = mock(async (): Promise<SendKeysResponse> => {
      interrupted = true
      return { keysId: "k", delivered: true }
    })
    const stalePrior = [
      OPERATOR_REPORT_HEADER,
      "REPORT_ID: OLD-nonce-999",
      "STATE: done",
      "SUMMARY: an OLD turn's report still in the scrollback",
      OPERATOR_REPORT_FOOTER,
    ].join("\n")
    const client = driverClientStub({
      status: async () => statusResponse({ interactionState: "idle" }),
      sendMessage: async (): Promise<SendMessageResponse> => {
        sent = true
        return { messageId: "m", delivered: true, confirmed: false, submission: { status: "submitted" } }
      },
      sendKeys,
      waitEvents: async (input: { timeoutMs?: number }): Promise<WaitEventsResponse> => {
        if (!sent) return { events: [], gaps: [], cursor: "c-prime", more: false }
        if (!interrupted) {
          clock.advance(input.timeoutMs ?? 0)
          return { events: [], gaps: [], cursor: "c-wait", more: false }
        }
        return { events: [{ seq: 9, sessionId: LOCAL, kind: "turn_ended", at: 9 }], gaps: [], cursor: "c-recover", more: false }
      },
      // Before interrupt: the CURRENT report (rid-1). After: only a STALE trailer (found=true,
      // but a different nonce) — it must not clobber the current one.
      readSession: async (): Promise<ReadSessionResponse> => ({
        sessionId: LOCAL,
        text: interrupted ? stalePrior : TRAILER,
        truncated: false,
        source: "pty",
        status: {},
      }),
    })
    const result = await driveTask(baseDeps({ client, now: clock.now, sleep: clock.sleep, timeoutMs: 30, recoverTimeoutMs: 30 }))
    expect(result).toMatchObject({ interrupted: true, recovered: true, state: "done", reportFound: true, summary: "did the thing" })
    // The stale report's fields must NOT have leaked in.
    expect(result.summary).not.toContain("OLD turn")
  })

  test("no current report + a stale recovery trailer -> settle-derived state, reportFound false, no stale leak", async () => {
    let sent = false
    let interrupted = false
    const clock = makeClock()
    const staleOnly = [
      OPERATOR_REPORT_HEADER,
      "REPORT_ID: OLD-nonce-42",
      "STATE: done",
      "SUMMARY: STALE-VALUE-must-not-leak",
      OPERATOR_REPORT_FOOTER,
    ].join("\n")
    const client = driverClientStub({
      status: async () => statusResponse({ interactionState: "idle" }),
      sendMessage: async (): Promise<SendMessageResponse> => {
        sent = true
        return { messageId: "m", delivered: true, confirmed: false, submission: { status: "submitted" } }
      },
      sendKeys: async (): Promise<SendKeysResponse> => {
        interrupted = true
        return { keysId: "k", delivered: true }
      },
      waitEvents: async (input: { timeoutMs?: number }): Promise<WaitEventsResponse> => {
        if (!sent) return { events: [], gaps: [], cursor: "c-prime", more: false }
        if (!interrupted) {
          clock.advance(input.timeoutMs ?? 0)
          return { events: [], gaps: [], cursor: "c-wait", more: false }
        }
        return { events: [{ seq: 9, sessionId: LOCAL, kind: "turn_ended", at: 9 }], gaps: [], cursor: "c-recover", more: false }
      },
      // Before interrupt: no trailer at all. After: only a STALE (non-current) trailer.
      readSession: async (): Promise<ReadSessionResponse> => ({
        sessionId: LOCAL,
        text: interrupted ? staleOnly : "still working, no report yet",
        truncated: false,
        source: "pty",
        status: {},
      }),
    })
    const result = await driveTask(baseDeps({ client, now: clock.now, sleep: clock.sleep, timeoutMs: 30, recoverTimeoutMs: 30 }))
    // Recovery settled turn_ended, but the only trailer is stale -> not trusted.
    expect(result).toMatchObject({ interrupted: true, recovered: true, state: "unknown", reportFound: false })
    expect(result.summary).toBeUndefined()
    expect(result.raw).toContain("STALE-VALUE-must-not-leak") // raw still carries it, but no field leaks
  })
})
