/**
 * Fleet session DRIVING primitives.
 *
 * `src/lib/fleet/tools.ts` stays a thin MCP-tool shell; the reliability logic for
 * driving a remote ai-or-die session to completion lives here so it is pure and
 * unit-testable against a mocked client (no HTTP). Everything keys on the RELIABLE
 * ai-or-die signals the control plane already emits:
 *   - completion  -> the `turn_ended` control event (transcript-derived), NEVER the
 *     flickery PTY `became_idle`/`became_busy` heuristic;
 *   - prompt-readiness -> the `waiting_input` control event / `awaiting.kind`;
 *   - a message actually reaching the composer -> the message response's
 *     `submission.status === "submitted"` sub-status.
 *
 * The one convention we OWN (ai-or-die does not define it): the OPERATOR REPORT
 * trailer a driven session emits at the end of its turn, parsed back into a typed
 * {state, summary, ask, artifact}. See {@link OPERATOR_REPORT_HEADER}.
 */

import type {
  FleetEvent,
  FleetSessionStatus,
  ReadSessionResponse,
  SendKeysResponse,
  SendMessageResponse,
  StatusResponse,
  WaitEventsResponse,
} from "./client"

/** ai-or-die named keys (raw:false maps these; never a literal "\r"). C4. */
export const SUBMIT_KEY = "enter"
export const INTERRUPT_KEY = "ctrl-c"

/** The control events that RELIABLY mark a turn boundary (transcript-derived). */
export const TURN_SETTLE_KINDS = ["turn_ended", "waiting_input"] as const

const DEFAULT_READY_POLL_MS = 500
const DEFAULT_TURN_POLL_MS = 25_000
const DEFAULT_PRIME_TIMEOUT_MS = 0
const DEFAULT_IDLE_WAIT_MS = 2_000
const DEFAULT_RECOVER_MS = 15_000
const DEFAULT_TAIL_LINES = 200

/** The minimal FleetClient surface the driver needs (a subset of FleetClientLike). */
export interface DriverClient {
  status(sessionId: string, signal?: AbortSignal): Promise<StatusResponse>
  sendMessage(
    sessionId: string,
    input: { message: string; idempotencyKey: string; awaitMs?: number },
    signal?: AbortSignal,
  ): Promise<SendMessageResponse>
  sendKeys(
    sessionId: string,
    input: { keys: string; idempotencyKey: string; raw?: boolean },
    signal?: AbortSignal,
  ): Promise<SendKeysResponse>
  waitEvents(
    input: { cursor?: string; timeoutMs?: number; sessionIds?: ReadonlyArray<string>; kinds?: ReadonlyArray<string> },
    signal?: AbortSignal,
  ): Promise<WaitEventsResponse>
  readSession(sessionId: string, lines?: number, signal?: AbortSignal): Promise<ReadSessionResponse>
}

type NowFn = () => number
type SleepFn = (ms: number) => Promise<void>

function realSleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve()
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// ---------------------------------------------------------------------------
// C4: higher-level named key ops
// ---------------------------------------------------------------------------

export type NamedKeyOp = "submit" | "interrupt"

/** Map a named op to the ai-or-die named key. `submit` = Enter, `interrupt` = Ctrl-C.
 *  Callers send the returned key with raw:false so ai-or-die interprets the NAMED
 *  key — never a literal control byte. */
export function mapNamedKeyOp(op: NamedKeyOp): string {
  switch (op) {
    case "submit":
      return SUBMIT_KEY
    case "interrupt":
      return INTERRUPT_KEY
  }
}

export function isNamedKeyOp(value: string): value is NamedKeyOp {
  return value === "submit" || value === "interrupt"
}

// ---------------------------------------------------------------------------
// C1: send-when-idle readiness classification
// ---------------------------------------------------------------------------

export type MessageReadyReason = "idle" | "awaiting_message" | "busy" | "awaiting_other" | "terminal" | "unknown"

export interface MessageReadiness {
  /** true only when a free-text message is appropriate to submit right now. */
  ready: boolean
  reason: MessageReadyReason
  interactionState?: string
  awaitingKind?: string
}

/** Read `awaiting.kind` off a status defensively (the shape is `{ kind, ... }`). */
export function readAwaitingKind(status: FleetSessionStatus | undefined): string | undefined {
  const awaiting = status?.awaiting
  if (awaiting && typeof awaiting === "object") {
    const kind = (awaiting as { kind?: unknown }).kind
    if (typeof kind === "string" && kind.trim() !== "") return kind
  }
  return undefined
}

/**
 * Classify whether a free-text message may be submitted to a session RIGHT NOW.
 * Ready only when the session is idle or explicitly awaiting the next message.
 * A pending non-message prompt (plan_approval / choice_question / tool_approval /
 * trust_prompt) is `awaiting_other` — the caller should use `respond`, not a raw
 * message. `busy` / `terminal` are hard refusals; `unknown` carries no positive
 * evidence of a busy composer (the caller fails OPEN and lets the send surface its
 * own transport result).
 */
export function classifyMessageReadiness(status: FleetSessionStatus | undefined): MessageReadiness {
  const interactionState = typeof status?.interactionState === "string" ? status.interactionState : undefined
  const awaitingKind = readAwaitingKind(status)
  if (interactionState === "busy") return { ready: false, reason: "busy", interactionState, awaitingKind }
  if (interactionState === "exited" || interactionState === "crashed") {
    return { ready: false, reason: "terminal", interactionState }
  }
  if (awaitingKind !== undefined && awaitingKind !== "next_message") {
    return { ready: false, reason: "awaiting_other", interactionState, awaitingKind }
  }
  if (interactionState === "idle") return { ready: true, reason: "idle", interactionState }
  if (awaitingKind === "next_message" || interactionState === "waiting_input") {
    return { ready: true, reason: "awaiting_message", interactionState, awaitingKind }
  }
  return { ready: false, reason: "unknown", interactionState, awaitingKind }
}

/** A refusal reason with POSITIVE evidence the composer must not be typed into. */
export function isHardNotReady(reason: MessageReadyReason): boolean {
  return reason === "busy" || reason === "awaiting_other" || reason === "terminal"
}

export interface WaitReadyOptions {
  /** Total ms to poll for readiness before giving up (0 = one immediate check). */
  waitMs?: number
  pollMs?: number
  now?: NowFn
  sleep?: SleepFn
  signal?: AbortSignal
}

export interface WaitReadyResult {
  ready: boolean
  readiness: MessageReadiness
  /** true when the status probe itself failed (we then report `unknown`, fail-open). */
  statusError?: boolean
}

/**
 * Poll `/status` until the session is ready for a message or the wait budget is
 * spent. A status probe that THROWS fails OPEN (reports `unknown` and returns) so a
 * transient status hiccup never wedges a legitimate send — the send itself carries
 * ai-or-die's own submission signal.
 */
export async function waitForMessageReady(
  client: Pick<DriverClient, "status">,
  localId: string,
  options: WaitReadyOptions = {},
): Promise<WaitReadyResult> {
  const now = options.now ?? Date.now
  const sleep = options.sleep ?? realSleep
  const waitMs = Math.max(0, options.waitMs ?? 0)
  const pollMs = Math.max(1, options.pollMs ?? DEFAULT_READY_POLL_MS)
  const deadline = now() + waitMs
  let last: MessageReadiness = { ready: false, reason: "unknown" }

  for (;;) {
    let status: FleetSessionStatus | undefined
    try {
      status = (await client.status(localId, options.signal)).status
    } catch {
      // Fail OPEN: we cannot prove the composer is busy, so do not block the send.
      return { ready: false, readiness: { ready: false, reason: "unknown" }, statusError: true }
    }
    last = classifyMessageReadiness(status)
    if (last.ready) return { ready: true, readiness: last }
    const remaining = deadline - now()
    if (remaining <= 0) return { ready: false, readiness: last }
    await sleep(Math.min(pollMs, remaining))
  }
}

// ---------------------------------------------------------------------------
// C2: turn-completion classification + a reliable "wait until settled" loop
// ---------------------------------------------------------------------------

export type TurnSettleStatus = "completed" | "awaiting_input" | "idle_flicker"

export interface TurnClassification {
  sessionId: string
  status: TurnSettleStatus
  /** false for `idle_flicker` (PTY heuristic) — never treat it as completion. */
  reliable: boolean
}

/**
 * Classify a batch of already-stamped events per session for the `await_turn`
 * summary. `turn_ended` -> completed, `waiting_input` -> awaiting_input (both
 * reliable / transcript-derived); a bare `became_idle` is surfaced as `idle_flicker`
 * with reliable:false so a caller NEVER mistakes the PTY heuristic for completion.
 * `became_busy` and other kinds are ignored (not a settle signal).
 */
export function classifyTurnEvents(events: ReadonlyArray<Record<string, unknown>>): Array<TurnClassification> {
  const rank: Record<TurnSettleStatus, number> = { completed: 3, awaiting_input: 2, idle_flicker: 1 }
  const best = new Map<string, TurnSettleStatus>()
  for (const event of events) {
    const sessionId = typeof event.sessionId === "string" ? event.sessionId : undefined
    const kind = typeof event.kind === "string" ? event.kind : undefined
    if (sessionId === undefined || kind === undefined) continue
    let status: TurnSettleStatus | undefined
    if (kind === "turn_ended") status = "completed"
    else if (kind === "waiting_input") status = "awaiting_input"
    else if (kind === "became_idle") status = "idle_flicker"
    if (status === undefined) continue
    const prior = best.get(sessionId)
    if (prior === undefined || rank[status] > rank[prior]) best.set(sessionId, status)
  }
  return [...best.entries()].map(([sessionId, status]) => ({
    sessionId,
    status,
    reliable: status !== "idle_flicker",
  }))
}

export type TurnSettleReason = "turn_ended" | "waiting_input" | "timeout"

export interface TurnSettleResult {
  settled: boolean
  reason: TurnSettleReason
  cursor?: string
  event?: FleetEvent
}

export interface TurnSettleOptions {
  timeoutMs: number
  /** Per long-poll window (ms). The loop advances the cursor across windows. */
  pollTimeoutMs?: number
  cursor?: string
  now?: NowFn
  sleep?: SleepFn
  signal?: AbortSignal
}

function pickSettleEvent(events: ReadonlyArray<FleetEvent>, localId: string): FleetEvent | undefined {
  let awaiting: FleetEvent | undefined
  for (const event of events) {
    // Server-side we filter by sessionIds:[localId], so every returned event is for
    // this session — match strictly so a stray null/other-session event can never
    // settle the turn.
    if (event.sessionId !== localId) continue
    if (event.kind === "turn_ended") return event
    if (event.kind === "waiting_input" && awaiting === undefined) awaiting = event
  }
  return awaiting
}

/** Client-side backoff after a transient waitEvents failure so the loop cannot
 *  hot-spin (hammer the control plane) when polls fail fast (network down). */
const TURN_POLL_ERROR_BACKOFF_MS = 250

/** Attempts to obtain a starting cursor before a drive send (see driveTask step 2). */
const PRIME_CURSOR_ATTEMPTS = 3

/**
 * Obtain a starting `/events` cursor before sending, retrying a bounded number of
 * times. A cursor is what prevents a stale prior-turn `turn_ended` from satisfying
 * the post-send wait; a cursorless request may replay history. Retries are cheap
 * (a zero/short poll). Returns undefined only if every attempt fails (rare) or the
 * signal aborts — the caller then proceeds best-effort.
 */
async function primeTurnCursor(
  client: Pick<DriverClient, "waitEvents">,
  localId: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<string | undefined> {
  for (let attempt = 0; attempt < PRIME_CURSOR_ATTEMPTS; attempt++) {
    if (signal?.aborted) return undefined
    try {
      const response = await client.waitEvents(
        { sessionIds: [localId], kinds: [...TURN_SETTLE_KINDS], timeoutMs },
        signal,
      )
      return response.cursor
    } catch {
      // try again (bounded); a fully-down control plane also fails the send below.
    }
  }
  return undefined
}

/**
 * Wait until the CURRENT turn actually ends (`turn_ended`) or the session is
 * awaiting input (`waiting_input`), long-polling `/events` filtered to those kinds
 * and advancing the server cursor across windows. Returns `{settled:false,
 * reason:"timeout"}` when neither fires within `timeoutMs`. It NEVER settles on
 * `became_idle`. Prime a cursor BEFORE the send (a zero/short poll) and pass it in
 * so a stale prior-turn event cannot satisfy the wait.
 */
export async function waitForTurnSettled(
  client: Pick<DriverClient, "waitEvents">,
  localId: string,
  options: TurnSettleOptions,
): Promise<TurnSettleResult> {
  const now = options.now ?? Date.now
  const sleep = options.sleep ?? realSleep
  const pollTimeoutMs = Math.max(1, options.pollTimeoutMs ?? DEFAULT_TURN_POLL_MS)
  // Guard against a non-finite timeout poisoning the deadline (NaN -> every poll
  // would carry timeoutMs:NaN and the loop would never terminate cleanly).
  const budget = Number.isFinite(options.timeoutMs) ? Math.max(0, options.timeoutMs) : 0
  const deadline = now() + budget
  let cursor = options.cursor

  do {
    if (options.signal?.aborted) return { settled: false, reason: "timeout", cursor }
    const remaining = deadline - now()
    const poll = remaining <= 0 ? 0 : Math.min(pollTimeoutMs, remaining)
    let response: WaitEventsResponse
    try {
      response = await client.waitEvents(
        { sessionIds: [localId], kinds: [...TURN_SETTLE_KINDS], timeoutMs: poll, cursor },
        options.signal,
      )
    } catch {
      // Transient poll failure: back off (a fast-failing poll must not hot-spin the
      // control plane) then retry until the deadline.
      if (now() >= deadline || options.signal?.aborted) return { settled: false, reason: "timeout", cursor }
      await sleep(Math.min(TURN_POLL_ERROR_BACKOFF_MS, Math.max(0, deadline - now())))
      continue
    }
    cursor = response.cursor
    const hit = pickSettleEvent(response.events, localId)
    if (hit) {
      return { settled: true, reason: hit.kind === "turn_ended" ? "turn_ended" : "waiting_input", cursor, event: hit }
    }
  } while (now() < deadline)

  return { settled: false, reason: "timeout", cursor }
}

// ---------------------------------------------------------------------------
// Operator report trailer (a WS2 convention; ai-or-die does not define it)
// ---------------------------------------------------------------------------

export const OPERATOR_REPORT_HEADER = "=== OPERATOR REPORT ==="
export const OPERATOR_REPORT_FOOTER = "=== END OPERATOR REPORT ==="

const OPERATOR_REPORT_LABELS = ["STATE", "SUMMARY", "ASK", "ARTIFACT"] as const

export interface OperatorReport {
  /** Parsed STATE, or "unknown" when the trailer (or the field) is absent. */
  state: string
  summary?: string
  ask?: string
  artifact?: string
  /** The transcript tail that was parsed. */
  raw: string
  /** true when a trailer block was located. */
  found: boolean
}

/**
 * Parse the LAST OPERATOR REPORT trailer in a transcript tail into typed fields.
 * Robust to: no trailer (returns state:"unknown", found:false), a missing footer,
 * multi-line field values (a value runs until the next known label or the footer),
 * and case-insensitive labels. Lines before the first label are ignored.
 */
export function parseOperatorReport(text: string): OperatorReport {
  const raw = text ?? ""
  const headerIdx = raw.lastIndexOf(OPERATOR_REPORT_HEADER)
  if (headerIdx === -1) return { state: "unknown", raw, found: false }

  let block = raw.slice(headerIdx + OPERATOR_REPORT_HEADER.length)
  const footerIdx = block.indexOf(OPERATOR_REPORT_FOOTER)
  if (footerIdx !== -1) block = block.slice(0, footerIdx)

  const values: Record<string, Array<string>> = {}
  let current: string | undefined
  for (const line of block.split(/\r?\n/)) {
    const match = /^\s*([A-Za-z]+)\s*:\s*(.*)$/.exec(line)
    const label = match?.[1]?.toUpperCase()
    if (match && label && (OPERATOR_REPORT_LABELS as ReadonlyArray<string>).includes(label)) {
      current = label
      values[current] = [match[2] ?? ""]
    } else if (current) {
      values[current]!.push(line)
    }
  }

  const join = (key: string): string | undefined => {
    const parts = values[key]
    if (parts === undefined) return undefined
    const joined = parts.join("\n").trim()
    if (joined === "") return undefined
    // Reject the instruction TEMPLATE's own placeholders (e.g. "<done | blocked | …>").
    // The trailer instruction drive_task appends contains this exact header + bracketed
    // placeholders; if the session echoes it without emitting a real report, lastIndexOf
    // would otherwise parse the template as a report. Any "<…>" token (even multi-line)
    // is a placeholder, not a real value.
    if (/^<[\s\S]*>$/.test(joined)) return undefined
    return joined
  }

  return {
    state: join("STATE") ?? "unknown",
    summary: join("SUMMARY"),
    ask: join("ASK"),
    artifact: join("ARTIFACT"),
    raw,
    found: true,
  }
}

/** The trailer instruction `drive_task` appends when `expectReport` is on, so a
 *  driven session ends its turn with a parseable {@link parseOperatorReport} block. */
export function operatorReportInstruction(): string {
  return [
    "",
    "When you have completely finished this task, end your FINAL message with EXACTLY this trailer, filling in each field:",
    OPERATOR_REPORT_HEADER,
    "STATE: <done | blocked | needs_input | in_progress>",
    "SUMMARY: <1-3 sentence summary of what you did>",
    "ASK: <what you need from the operator, or 'none'>",
    "ARTIFACT: <path or URL to the primary artifact, or 'none'>",
    OPERATOR_REPORT_FOOTER,
  ].join("\n")
}

// ---------------------------------------------------------------------------
// C5: drive_task orchestration (composes C1 + C2 + C4)
// ---------------------------------------------------------------------------

export interface DriveTaskDeps {
  client: DriverClient
  localId: string
  prompt: string
  timeoutMs: number
  /** Append the operator-report trailer instruction to the prompt (default on). */
  expectReport: boolean
  idempotencyKey: string
  interruptKey: string
  /** Ms to wait for the session to become idle before sending (C1). */
  idleWaitMs?: number
  primeTimeoutMs?: number
  pollTimeoutMs?: number
  recoverTimeoutMs?: number
  tailLines?: number
  now?: NowFn
  sleep?: SleepFn
  signal?: AbortSignal
}

export interface DriveTaskResult {
  submitted: boolean
  delivered: boolean
  settled: TurnSettleReason
  /** Parsed STATE, or a synthesized status ("busy"/"dead"/"timeout"/"unknown"/...). */
  state: string
  summary?: string
  ask?: string
  artifact?: string
  raw: string
  reportFound: boolean
  /** true when we issued a recovery interrupt after a settle timeout. */
  interrupted: boolean
  /** true when the interrupt unwedged the session (a turn boundary then fired). */
  recovered: boolean
  notReady?: boolean
  readiness?: MessageReadiness
  sendConfirmation?: string
  /** false when the pre-send cursor prime failed and the settle wait ran cursorless
   *  (a narrow window where a stale prior-turn event could satisfy the wait). */
  cursorPrimed?: boolean
  /** Set on a HARD failure (delivery failure / not-ready refusal) — maps to isError. */
  error?: "not_ready" | "delivery_failed"
}

function notReadyState(reason: MessageReadyReason): string {
  switch (reason) {
    case "busy":
      return "busy"
    case "awaiting_other":
      return "awaiting_other"
    case "terminal":
      return "dead"
    default:
      return "unknown"
  }
}

async function readTail(
  client: Pick<DriverClient, "readSession">,
  localId: string,
  lines: number,
  signal?: AbortSignal,
): Promise<string> {
  try {
    const response = await client.readSession(localId, lines, signal)
    return typeof response.text === "string" ? response.text : ""
  } catch {
    return ""
  }
}

/**
 * Drive one prompt on a session to completion and return the parsed operator report.
 * Flow: ensure the composer is idle (C1) -> send + surface whether the bytes reached
 * the composer (C2 `submitted`; a delivered-but-unconfirmed send still proceeds, since
 * the turn wait + timeout recovery covers the "nothing landed" case) -> wait for
 * `turn_ended`/`waiting_input` (C2) -> read the transcript tail -> parse the operator
 * report trailer -> if the turn did not settle in `timeoutMs`, AUTO-RECOVER via a
 * Ctrl-C interrupt (C4) rather than blocking (~10 min stop-hook hang), then re-wait
 * briefly and re-read. Robust to a busy session, a missing trailer (state:"unknown"),
 * and a hung stop hook.
 */
export async function driveTask(deps: DriveTaskDeps): Promise<DriveTaskResult> {
  const {
    client,
    localId,
    prompt,
    timeoutMs,
    expectReport,
    idempotencyKey,
    interruptKey,
    signal,
  } = deps
  const now = deps.now ?? Date.now
  const sleep = deps.sleep ?? realSleep
  const tailLines = deps.tailLines ?? DEFAULT_TAIL_LINES
  const pollTimeoutMs = deps.pollTimeoutMs

  // 1. C1: refuse to type into a busy composer (positive-busy only; fail-open on unknown).
  const readyResult = await waitForMessageReady(client, localId, {
    waitMs: deps.idleWaitMs ?? DEFAULT_IDLE_WAIT_MS,
    now,
    sleep,
    signal,
  })
  if (!readyResult.ready && isHardNotReady(readyResult.readiness.reason)) {
    return {
      submitted: false,
      delivered: false,
      settled: "timeout",
      state: notReadyState(readyResult.readiness.reason),
      raw: "",
      reportFound: false,
      interrupted: false,
      recovered: false,
      notReady: true,
      readiness: readyResult.readiness,
      error: "not_ready",
    }
  }

  // 2. C2: prime the cursor BEFORE the send so a stale prior-turn event cannot
  //    satisfy the wait (we only accept a turn boundary that fires after this). A
  //    cursorless poll may replay history, so RETRY a few times to obtain a cursor
  //    before sending; only if every attempt fails do we proceed cursorless (rare —
  //    the same transport also carries the send, which would then fail loudly).
  let cursor = await primeTurnCursor(client, localId, deps.primeTimeoutMs ?? DEFAULT_PRIME_TIMEOUT_MS, signal)
  const cursorPrimed = cursor !== undefined

  // 3. Send + verify the message actually reached the composer.
  const message = expectReport ? `${prompt}\n${operatorReportInstruction()}` : prompt
  const send = await client.sendMessage(localId, { message, idempotencyKey, awaitMs: 0 }, signal)
  const submitted = send.submission?.status === "submitted"
  const deliveryFailed =
    send.delivered === false || send.delivery?.status === "failed" || send.delivery?.status === "error"
  if (deliveryFailed) {
    return {
      submitted: false,
      delivered: false,
      settled: "timeout",
      state: "send_failed",
      raw: "",
      reportFound: false,
      interrupted: false,
      recovered: false,
      cursorPrimed,
      sendConfirmation: send.confirmation,
      error: "delivery_failed",
    }
  }

  // 4. C2: wait for the turn to actually end (or the session to await input).
  let settle = await waitForTurnSettled(client, localId, { timeoutMs, pollTimeoutMs, cursor, now, sleep, signal })
  cursor = settle.cursor

  // 5. Read the transcript tail + parse the operator report.
  let tail = await readTail(client, localId, tailLines, signal)
  let report = parseOperatorReport(tail)

  // 6. C4 recovery: if the turn never settled, the stop hook may be blocking the
  //    stop (~10 min). Interrupt to regain control rather than blocking, then
  //    re-wait briefly and re-read the (now-settled) tail.
  let interrupted = false
  let recovered = false
  if (!settle.settled) {
    interrupted = true
    await client
      .sendKeys(localId, { keys: INTERRUPT_KEY, idempotencyKey: interruptKey, raw: false }, signal)
      .catch(() => {})
    const recovery = await waitForTurnSettled(client, localId, {
      timeoutMs: deps.recoverTimeoutMs ?? DEFAULT_RECOVER_MS,
      pollTimeoutMs,
      cursor,
      now,
      sleep,
      signal,
    })
    recovered = recovery.settled
    if (recovery.settled) settle = recovery
    const recoveredTail = await readTail(client, localId, tailLines, signal)
    if (recoveredTail !== "") {
      tail = recoveredTail
      report = parseOperatorReport(recoveredTail)
    }
  }

  const settledReason: TurnSettleReason = settle.settled ? settle.reason : "timeout"
  const settleDerivedState =
    settledReason === "waiting_input" ? "awaiting_input" : settledReason === "timeout" ? "timeout" : "unknown"
  // State precedence: a reliable `waiting_input` (the session is blocked awaiting the
  // operator RIGHT NOW) is authoritative and must NOT be overridden by the model's
  // self-reported STATE (e.g. an emitted "done" just before it hit a prompt would
  // otherwise make a caller drop a still-blocked session). Otherwise trust the parsed
  // STATE only when a report was found AND carried a real (non-placeholder) STATE — a
  // partial trailer must not clobber the settle-derived state. On a timeout WITH a real
  // report (the hung-hook signature: model finished, turn_ended never fired), the
  // report's STATE is more accurate than "timeout", so it is allowed to win there.
  const state =
    settledReason === "waiting_input"
      ? "awaiting_input"
      : report.found && report.state !== "unknown"
        ? report.state
        : settleDerivedState

  return {
    submitted,
    delivered: true,
    settled: settledReason,
    state,
    summary: report.summary,
    ask: report.ask,
    artifact: report.artifact,
    raw: tail,
    reportFound: report.found,
    interrupted,
    recovered,
    cursorPrimed,
    sendConfirmation: send.confirmation,
  }
}
