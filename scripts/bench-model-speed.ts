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
//   - Wall-clock includes time-to-first-token, so short responses look slow.
//     This is why an early n=1 run put gemini-3.1-pro at 9 tok/s when n=3 on
//     full-length responses put it at ~23.
//   - Reasoning tokens are billed and timed but may not appear in
//     `output_tokens`, so a heavy-reasoning model is penalised here.
//   - One machine, one region, one account, one moment. Load varies.
// The numbers are an ORDER-OF-MAGNITUDE hint for routing, never a benchmark.
//
// Usage:
//   GH_ROUTER_BENCH_BASE_URL=http://127.0.0.1:8787 bun scripts/bench-model-speed.ts
//   GH_ROUTER_BENCH_MODELS=gpt-5.6-luna,gemini-3.6-flash bun scripts/bench-model-speed.ts

const BASE_URL = process.env.GH_ROUTER_BENCH_BASE_URL ?? "http://127.0.0.1:8787"
const REPS = Number(process.env.GH_ROUTER_BENCH_REPS ?? "3")

const DEFAULT_MODELS = [
  "gpt-5.6-luna",
  "gemini-3.6-flash",
  "gemini-3.5-flash",
  "gpt-5.6-terra",
  "gpt-5.6-sol",
  "gemini-3.1-pro-preview",
  "claude-opus-5",
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
}

async function once(model: string, mode: "generate" | "tool"): Promise<Sample | undefined> {
  const body: Record<string, unknown> = {
    model,
    max_tokens: 400,
    messages: [{ role: "user", content: mode === "tool" ? TOOL_PROMPT : GENERATION_PROMPT }],
  }
  if (mode === "tool") body.tools = [TOOL_DEF]

  const started = performance.now()
  let res: Response
  try {
    res = await fetch(`${BASE_URL}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
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

function median(values: Array<number>): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}

async function main(): Promise<void> {
  const models = (process.env.GH_ROUTER_BENCH_MODELS ?? DEFAULT_MODELS.join(",")).split(",")
  console.log(`base=${BASE_URL} reps=${REPS}  (median reported; wall clock includes TTFT)\n`)
  console.log("model                     gen tok/s   tool p50 ms   tool-call rate")
  console.log("-".repeat(72))

  for (const model of models) {
    const genRates: Array<number> = []
    for (let i = 0; i < REPS; i++) {
      const sample = await once(model, "generate")
      // A truncated or refused response makes the rate meaningless rather than
      // slow, so drop it instead of letting it drag the median down.
      if (sample && sample.ms > 0 && sample.outputTokens >= 50) {
        genRates.push((sample.outputTokens * 1000) / sample.ms)
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
    console.log(
      `${model.padEnd(24)} ${String(gen ?? "n/a").padStart(9)}   ${String(p50 ?? "n/a").padStart(11)}   ${
        toolRuns > 0 ? `${toolCalls}/${toolRuns}` : "n/a"
      }`,
    )
  }
  console.log(
    "\ngen tok/s feeds INDICATIVE_TOKENS_PER_SECOND. tool p50 is the workload that"
    + "\nactually matters for an agent model and is NOT currently surfaced to the model.",
  )
}

await main()
