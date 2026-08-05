// Equivalence + fast-path coverage for `injectAdvisorTool`.
//
// This function runs on essentially every request (the advisor beta is
// auto-enabled), and was the only unguarded full JSON.parse + JSON.stringify
// pair in the /v1/messages prologue. A substring fast path now skips that pair
// when the body provably needs neither an injection nor a strip.
//
// The guard is only safe if it is EXACTLY equivalent to the pre-existing
// no-op branch. These tests pin that equivalence across the shapes that could
// break it, so a future edit to either side cannot silently diverge.

import { expect, test } from "bun:test"

import { injectAdvisorTool } from "~/services/advisor/advisor"

const ADVISOR_TOOL = "__anthropic_advisor"

/** Reference implementation: the semantics BEFORE the fast path was added. */
function referenceInject(rawBody: string): string {
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(rawBody) as Record<string, unknown>
  } catch {
    return rawBody
  }
  const rawTools = Array.isArray(parsed.tools) ? parsed.tools : []
  const tools = rawTools.filter((t: Record<string, unknown>) => {
    if (typeof t !== "object" || t === null) return true
    const type = t.type
    return typeof type !== "string" || !type.startsWith("advisor_")
  })
  const stripped = tools.length !== rawTools.length
  const alreadyInjected = tools.some(
    (t: Record<string, unknown>) => t?.name === ADVISOR_TOOL,
  )
  if (alreadyInjected && !stripped) return rawBody
  return "CHANGED"
}

/** Did the real implementation leave the body byte-identical? */
const isNoOp = (body: string) => injectAdvisorTool(body) === body
/** Did the reference consider it a no-op? */
const refNoOp = (body: string) => referenceInject(body) === body

const cases: Record<string, unknown> = {
  "no tools at all": { model: "m", messages: [] },
  "empty tools array": { model: "m", tools: [] },
  "unrelated tool only": { model: "m", tools: [{ name: "Read" }] },
  "advisor tool already injected": {
    model: "m",
    tools: [{ name: ADVISOR_TOOL, description: "d", input_schema: {} }],
  },
  "advisor typed tool needing strip": {
    model: "m",
    tools: [{ type: "advisor_20260301", name: "advisor" }],
  },
  "both injected and a typed tool to strip": {
    model: "m",
    tools: [
      { name: ADVISOR_TOOL, description: "d", input_schema: {} },
      { type: "advisor_20260301", name: "advisor" },
    ],
  },
  "injected plus unrelated tools": {
    model: "m",
    tools: [
      { name: "Read" },
      { name: ADVISOR_TOOL, description: "d", input_schema: {} },
      { name: "Write" },
    ],
  },
  "tools containing null": {
    model: "m",
    tools: [null, { name: ADVISOR_TOOL, description: "d", input_schema: {} }],
  },
  "tool with non-string type": {
    model: "m",
    tools: [{ type: 7, name: "x" }, { name: ADVISOR_TOOL, input_schema: {} }],
  },
  "advisor-like name in message text, no tools": {
    model: "m",
    messages: [{ role: "user", content: "tell me about advisor_20260301" }],
  },
  "tool name mentioned only in prose": {
    model: "m",
    messages: [{ role: "user", content: `what is ${ADVISOR_TOOL}?` }],
    tools: [{ name: "Read" }],
  },
}

for (const [name, body] of Object.entries(cases)) {
  test(`fast path matches reference semantics: ${name}`, () => {
    const raw = JSON.stringify(body)
    // The no-op decision must be identical to the pre-fast-path behavior.
    expect(isNoOp(raw)).toBe(refNoOp(raw))
  })
}

test("no-op bodies are returned byte-identical (not reserialized)", () => {
  // Reserializing would also reorder/normalize; identity proves the parse and
  // stringify were genuinely skipped.
  const raw = JSON.stringify({
    model: "m",
    tools: [{ name: ADVISOR_TOOL, description: "d", input_schema: {} }],
    messages: [{ role: "user", content: "hi" }],
  })
  expect(injectAdvisorTool(raw)).toBe(raw)
})

test("injection still happens when the tool is absent", () => {
  const raw = JSON.stringify({ model: "m", tools: [{ name: "Read" }] })
  const out = injectAdvisorTool(raw)
  expect(out).not.toBe(raw)
  const parsed = JSON.parse(out) as { tools: Array<{ name?: string }> }
  expect(parsed.tools.some((t) => t.name === ADVISOR_TOOL)).toBe(true)
  expect(parsed.tools.some((t) => t.name === "Read")).toBe(true)
})

test("advisor-typed tools are still stripped even when already injected", () => {
  const raw = JSON.stringify({
    model: "m",
    tools: [
      { name: ADVISOR_TOOL, description: "d", input_schema: {} },
      { type: "advisor_20260301", name: "advisor" },
    ],
  })
  const out = injectAdvisorTool(raw)
  expect(out).not.toBe(raw)
  const parsed = JSON.parse(out) as { tools: Array<{ type?: string }> }
  expect(parsed.tools.some((t) => typeof t.type === "string")).toBe(false)
})

test("malformed JSON is passed through untouched", () => {
  const raw = '{"model":"m",'
  expect(injectAdvisorTool(raw)).toBe(raw)
})

test("prose mentioning the tool name does not suppress a real injection", () => {
  // The dangerous false-positive: the fast path sees the tool NAME in message
  // text and wrongly concludes it is already injected. The guard requires the
  // name to be present AND no "advisor_ typed tool; here the name appears only
  // in prose, so injection must still occur.
  const raw = JSON.stringify({
    model: "m",
    messages: [{ role: "user", content: `explain ${ADVISOR_TOOL}` }],
    tools: [{ name: "Read" }],
  })
  const out = injectAdvisorTool(raw)
  const parsed = JSON.parse(out) as { tools: Array<{ name?: string }> }
  expect(parsed.tools.some((t) => t.name === ADVISOR_TOOL)).toBe(true)
})

// ---------------------------------------------------------------------------
// Adversarial: the fast path keys on a substring of serialized JSON, so the
// question that decides whether it is sound is "can untrusted input FORGE that
// substring?". It cannot — JSON.stringify escapes the inner quotes of every
// string value, so a user writing the literal on the wire produces
// \"name\":\"__anthropic_advisor\", which does not match the probe.
//
// These cases pin that property. If a future change ever makes the probe
// forgeable (e.g. matching the bare name again, or accepting escaped forms),
// they go red — the advisor silently never injecting is otherwise an extremely
// quiet failure.
// ---------------------------------------------------------------------------

const forgeryAttempts: Record<string, unknown> = {
  "literal probe string in user message": {
    model: "m",
    messages: [{ role: "user", content: `"name":"${ADVISOR_TOOL}"` }],
    tools: [{ name: "Read" }],
  },
  "literal probe string in a system block": {
    model: "m",
    system: [{ type: "text", text: `"name":"${ADVISOR_TOOL}"` }],
    tools: [{ name: "Read" }],
  },
  "literal probe string in another tool's description": {
    model: "m",
    tools: [{ name: "Read", description: `calls "name":"${ADVISOR_TOOL}"` }],
  },
  "literal probe string in an assistant turn": {
    model: "m",
    messages: [{ role: "assistant", content: `"name":"${ADVISOR_TOOL}"` }],
    tools: [{ name: "Read" }],
  },
}

for (const [name, body] of Object.entries(forgeryAttempts)) {
  test(`untrusted input cannot forge the fast path: ${name}`, () => {
    const raw = JSON.stringify(body)
    // The advisor tool is genuinely absent, so injection MUST still happen.
    const out = injectAdvisorTool(raw)
    expect(out).not.toBe(raw)
    const parsed = JSON.parse(out) as { tools: Array<{ name?: string }> }
    expect(parsed.tools.some((t) => t.name === ADVISOR_TOOL)).toBe(true)
    // And it agrees with the pre-fast-path reference.
    expect(isNoOp(raw)).toBe(refNoOp(raw))
  })
}

test("the tool object is matched regardless of key order", () => {
  // JSON.stringify preserves insertion order, so a serializer that emits
  // `name` last still yields the adjacent "name":"..." pair the probe needs.
  const raw = JSON.stringify({
    model: "m",
    tools: [{ description: "d", input_schema: {}, name: ADVISOR_TOOL }],
  })
  expect(injectAdvisorTool(raw)).toBe(raw)
  expect(isNoOp(raw)).toBe(refNoOp(raw))
})
