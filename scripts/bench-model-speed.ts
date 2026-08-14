// bench-model-speed.ts — reproduce the indicative throughput numbers that back
// `INDICATIVE_TOKENS_PER_SECOND` in `src/lib/worker-agent/model-resolve.ts`.
//
// WHY THIS EXISTS: those constants were originally produced by ad-hoc shell
// loops that were then deleted, leaving hardcoded numbers nobody could re-derive
// or challenge. A performance claim with no reproduction is an assertion, not a
// measurement, so the harness is committed alongside the numbers it produced.
//
// TWO WORKLOADS, deliberately. The repo's own pre-registered test for the
// Flash-vs-Luna roster question was "time an identical trivial TOOL-CALLING task
// through the proxy against both models" — not raw generation. Tool-calling
// latency is the decision-relevant axis for an agent model, because a worker
// spends its turns emitting tool calls, not prose. Raw generation is kept as the
// second workload because it is what `tok/s` conventionally means and it is what
// the `tps` field advertises.
//
// HONEST LIMITS, which the caller must carry into any claim made from the output:
//   - Non-streaming (the default) wall-clock includes time-to-first-token, so
//     short responses look slow. This is why an early n=1 run put gemini-3.1-pro
//     at 9 tok/s when n=3 on full-length responses put it at ~23.
//   - Reasoning tokens are billed and timed but may not appear in
//     `output_tokens`, so a heavy-reasoning model is penalised here.
//   - One machine, one region, one account, one moment. Load varies.
// The numbers are an ORDER-OF-MAGNITUDE hint for routing, never a benchmark.
//
// STREAMING MODE (GH_ROUTER_BENCH_STREAM=1): splits total wall-clock into TTFT
// (time to the first content-bearing delta) and a decode-phase tok/s that
// deliberately EXCLUDES the first delta's own tokens and time from both the
// numerator and denominator — tokens in the first chunk were generated before
// our start marker, so including them inflates the rate (this was a real bug in
// an earlier draft of this harness: `outputTokens / (totalMs - ttftMs)` counted
// every token in the numerator while only trimming time from the denominator).
// This does NOT replace the existing default `gen tok/s` column — the existing
// `INDICATIVE_TOKENS_PER_SECOND` table is calibrated against the old
// non-streaming metric, so both are reported side by side rather than one
// overwriting the other.
//
// EFFORT MATCHING (GH_ROUTER_BENCH_EFFORT=<low|medium|high>): a separate,
// optional knob, NOT part of the streaming/TTFT fix above. It forces an explicit
// `output_config.effort` (highest precedence in the shim) so every compared
// model gets the identical requested reasoning bucket instead of each landing on
// its own "no thinking field -> default high" behavior. Useful for asking "what
// if effort is pinned to low," a different question from "what is decode-phase
// throughput."
//
// Usage:
//   GH_ROUTER_BENCH_BASE_URL=http://127.0.0.1:8787 bun scripts/bench-model-speed.ts
//   GH_ROUTER_BENCH_MODELS=gpt-5.6-luna,gemini-3.6-flash bun scripts/bench-model-speed.ts
//   GH_ROUTER_BENCH_STREAM=1 GH_ROUTER_BENCH_MODELS=gemini-3.7-flash,gpt-5.6-terra bun scripts/bench-model-speed.ts
//   GH_ROUTER_BENCH_STREAM=1 GH_ROUTER_BENCH_EFFORT=low bun scripts/bench-model-speed.ts

const BASE_URL = process.env.GH_ROUTER_BENCH_BASE_URL ?? "http://127.0.0.1:8787"
const REPS = Number(process.env.GH_ROUTER_BENCH_REPS ?? "3")
const STREAM = process.env.GH_ROUTER_BENCH_STREAM === "1"
const EFFORT = process.env.GH_ROUTER_BENCH_EFFORT

// Every model any agent, worker, critic, or fallback chain can route to. This
// list must stay a SUPERSET of `INDICATIVE_TOKENS_PER_SECOND` in
// `src/lib/worker-agent/model-resolve.ts`: a figure in that table which this
// harness cannot re-derive is an unreproducible claim, which is the exact
// failure this script exists to prevent.
const DEFAULT_MODELS = [
  "gpt-5.6-luna",
  "gpt-5.6-terra",
  "gpt-5.6-sol",
  "gpt-5.5",
  "gpt-5.3-codex",
  "gpt-5.4-mini",
  "gemini-3.6-flash",
  "gemini-3.5-flash",
  "gemini-3.1-pro-preview",
  "claude-opus-5",
  "claude-sonnet-5",
  "claude-haiku-4.5",
  "grok-4.5",
]

/** Long enough that time-to-first-token does not dominate the rate. */
const GENERATION_PROMPT = "Count from 1 to 120, one number per line, digits only."

/** The trivial tool-calling task the repo pre-registered. One obvious call, no
 *  ambiguity about WHICH tool, so the measurement is latency-to-tool-call and
 *  not a reasoning contest. */
const TOOL_PROMPT = "What is the weather in Paris? Use the provided tool."
const TOOL_DEF = {
  name: "get_weather",
  description: "Get the current weather in a city.",
  input_schema: {
    type: "object",
    properties: { city: { type: "string", description: "City name" } },
    required: ["city"],
  },
}

interface Sample {
  ms: number
  outputTokens: number
  toolCalled: boolean
  /** Streaming-only fields; undefined in non-streaming mode. */
  ttftMs?: number
  decodeTokPerSec?: number
  sawThinkingDelta?: boolean
}

function buildBody(model: string, mode: "generate" | "tool"): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model,
    max_tokens: 400,
    messages: [{ role: "user", content: mode === "tool" ? TOOL_PROMPT : GENERATION_PROMPT }],
  }
  if (mode === "tool") body.tools = [TOOL_DEF]
  if (STREAM) body.stream = true
  if (EFFORT) body.output_config = { effort: EFFORT }
  return body
}

async function onceNonStreaming(model: string, mode: "generate" | "tool"): Promise<Sample | undefined> {
  const started = performance.now()
  let res: Response
  try {
    res = await fetch(`${BASE_URL}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(buildBody(model, mode)),
    })
  } catch {
    return undefined
  }
  const json = (await res.json().catch(() => undefined)) as
    | { usage?: { output_tokens?: number }, content?: Array<{ type?: string }> }
    | undefined
  const ms = performance.now() - started
  if (!json?.usage) return undefined
  return {
    ms,
    outputTokens: json.usage.output_tokens ?? 0,
    toolCalled: (json.content ?? []).some((block) => block.type === "tool_use"),
  }
}

/** Parses one SSE frame's `data:` payload; returns undefined for non-JSON/keepalive lines. */
function parseSseData(chunk: string): { type?: string, [key: string]: unknown } | undefined {
  const line = chunk.split("\n").find((l) => l.startsWith("data:"))
  if (!line) return undefined
  const jsonText = line.slice("data:".length).trim()
  if (!jsonText || jsonText === "[DONE]") return undefined
  try {
    return JSON.parse(jsonText) as { type?: string, [key: string]: unknown }
  } catch {
    return undefined
  }
}

async function onceStreaming(model: string, mode: "generate" | "tool"): Promise<Sample | undefined> {
  const started = performance.now()
  let res: Response
  try {
    res = await fetch(`${BASE_URL}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(buildBody(model, mode)),
    })
  } catch {
    return undefined
  }
  if (!res.body) return undefined

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ""
  let toolCalled = false
  let sawThinkingDelta = false
  let finalOutputTokens: number | undefined
  // Timestamps + char lengths of every content-bearing delta (text or thinking),
  // in arrival order, so we can exclude the first delta's contribution below.
  const deltas: Array<{ t: number, chars: number }> = []

  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    const frames = buf.split("\n\n")
    buf = frames.pop() ?? ""
    for (const frame of frames) {
      const ev = parseSseData(frame)
      if (!ev) continue
      const now = performance.now()
      if (ev.type === "content_block_start") {
        const block = (ev as { content_block?: { type?: string } }).content_block
        if (block?.type === "tool_use") toolCalled = true
      } else if (ev.type === "content_block_delta") {
        const delta = (ev as { delta?: { type?: string, text?: string, thinking?: string } }).delta
        if (delta?.type === "text_delta" && typeof delta.text === "string") {
          deltas.push({ t: now, chars: delta.text.length })
        } else if (delta?.type === "thinking_delta" && typeof delta.thinking === "string") {
          sawThinkingDelta = true
          deltas.push({ t: now, chars: delta.thinking.length })
        }
      } else if (ev.type === "message_delta") {
        const usage = (ev as { usage?: { output_tokens?: number } }).usage
        if (typeof usage?.output_tokens === "number") finalOutputTokens = usage.output_tokens
      }
    }
  }
  const ms = performance.now() - started
  if (finalOutputTokens === undefined || deltas.length === 0) return undefined

  const ttftMs = deltas[0].t - started
  let decodeTokPerSec: number | undefined
  if (deltas.length >= 2) {
    // Exclude the first delta's own time AND its share of tokens: its tokens
    // were generated before our start marker (deltas[1].t), so folding them
    // into the numerator over a denominator that starts later inflates the
    // rate — the exact bug this streaming mode exists to avoid repeating.
    const totalChars = deltas.reduce((sum, d) => sum + d.chars, 0)
    const firstDeltaChars = deltas[0].chars
    const estimatedFirstDeltaTokens = totalChars > 0
      ? finalOutputTokens * (firstDeltaChars / totalChars)
      : 0
    const decodeTokens = finalOutputTokens - estimatedFirstDeltaTokens
    const decodeWindowMs = deltas[deltas.length - 1].t - deltas[1].t
    if (decodeWindowMs > 0 && decodeTokens > 0) {
      decodeTokPerSec = (decodeTokens * 1000) / decodeWindowMs
    }
  }

  return { ms, outputTokens: finalOutputTokens, toolCalled, ttftMs, decodeTokPerSec, sawThinkingDelta }
}

async function once(model: string, mode: "generate" | "tool"): Promise<Sample | undefined> {
  return STREAM ? onceStreaming(model, mode) : onceNonStreaming(model, mode)
}

function median(values: Array<number>): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}

async function main(): Promise<void> {
  const models = (process.env.GH_ROUTER_BENCH_MODELS ?? DEFAULT_MODELS.join(",")).split(",")
  console.log(
    `base=${BASE_URL} reps=${REPS} stream=${STREAM} effort=${EFFORT ?? "(unset, shim default)"}\n`,
  )
  if (STREAM) {
    console.log(
      "model                     ttft ms   decode tok/s   total tok/s   thinking?   tool p50 ms   tool-call rate",
    )
    console.log("-".repeat(104))
  } else {
    console.log("model                     gen tok/s   tool p50 ms   tool-call rate")
    console.log("-".repeat(72))
  }

  for (const model of models) {
    // One untimed warmup rep per model to absorb connection setup / cold-start
    // bias before the timed reps, and interleaving is achieved by looping
    // models in the outer loop rather than running all reps of one model
    // before starting the next (already the existing structure below runs one
    // model fully before the next; true round-robin interleaving across
    // models would require restructuring the loop nest, which is left as a
    // follow-up if load-drift bias turns out to matter for a given comparison).
    await once(model, "generate")

    const genRates: Array<number> = []
    const ttfts: Array<number> = []
    const decodeRates: Array<number> = []
    let anyThinking = false
    for (let i = 0; i < REPS; i++) {
      const sample = await once(model, "generate")
      // A truncated or refused response makes the rate meaningless rather than
      // slow, so drop it instead of letting it drag the median down.
      if (sample && sample.ms > 0 && sample.outputTokens >= 50) {
        genRates.push((sample.outputTokens * 1000) / sample.ms)
        if (sample.ttftMs !== undefined) ttfts.push(sample.ttftMs)
        if (sample.decodeTokPerSec !== undefined) decodeRates.push(sample.decodeTokPerSec)
        if (sample.sawThinkingDelta) anyThinking = true
      }
    }
    const toolMs: Array<number> = []
    let toolCalls = 0
    let toolRuns = 0
    for (let i = 0; i < REPS; i++) {
      const sample = await once(model, "tool")
      if (!sample) continue
      toolRuns++
      toolMs.push(sample.ms)
      if (sample.toolCalled) toolCalls++
    }
    const gen = genRates.length > 0 ? Math.round(median(genRates)) : undefined
    const p50 = toolMs.length > 0 ? Math.round(median(toolMs)) : undefined
    const toolRate = toolRuns > 0 ? `${toolCalls}/${toolRuns}` : "n/a"

    if (STREAM) {
      const ttft = ttfts.length > 0 ? Math.round(median(ttfts)) : undefined
      const decode = decodeRates.length > 0 ? Math.round(median(decodeRates)) : undefined
      console.log(
        `${model.padEnd(24)} ${String(ttft ?? "n/a").padStart(8)}   ${String(decode ?? "n/a").padStart(12)}   `
        + `${String(gen ?? "n/a").padStart(11)}   ${String(anyThinking).padEnd(9)}   ${String(p50 ?? "n/a").padStart(11)}   ${toolRate}`,
      )
    } else {
      console.log(
        `${model.padEnd(24)} ${String(gen ?? "n/a").padStart(9)}   ${String(p50 ?? "n/a").padStart(11)}   ${toolRate}`,
      )
    }
  }
  console.log(
    "\ngen tok/s / total tok/s feed INDICATIVE_TOKENS_PER_SECOND. tool p50 is the workload"
    + "\nthat actually matters for an agent model and is NOT currently surfaced to the model."
    + (STREAM
      ? "\ndecode tok/s excludes the first content delta's own time+tokens (pre-TTFT generation)."
      + "\nthinking?=true means the model streamed thinking_delta content — output_tokens may"
      + "\ninclude reasoning tokens not reflected in visible text, which can inflate decode tok/s."
      : ""),
  )
}

await main()
