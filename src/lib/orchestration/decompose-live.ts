/**
 * The LIVE adapter for `decompose` — wires the injected `DecomposeDeps` to real
 * Copilot model calls (`dispatchModelCall`). The driver drafts the IR as JSON;
 * a cross-lab critic optionally reviews it. The pure parts — extracting the IR
 * JSON from possibly-fenced model text, and parsing the critic's concerns — are
 * unit-tested here; the model dispatch is the gated-E2E part.
 *
 * Imports `dispatchModelCall` from the MCP handler the same way `stand-in.ts`
 * does (a proven, non-fatal module cycle); `Effort` / endpoint are type-only
 * imports (erased at runtime).
 */

import { dispatchModelCall } from "~/routes/mcp/handler"

import { type DecomposeDeps } from "./decompose"
import type { Effort, PersonaSpec } from "~/lib/peer-mcp-personas"

type Endpoint = PersonaSpec["endpoint"]

/** Pull the first balanced JSON object out of model text (handles ```json
 *  fences and surrounding prose). Returns `undefined` on no/invalid JSON — the
 *  decompose verifier then reports it as a failed draft. */
export function extractJson(text: string): unknown {
  if (typeof text !== "string") return undefined
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)
  const src = fenced ? fenced[1]! : text
  const start = src.indexOf("{")
  if (start === -1) return undefined
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < src.length; i += 1) {
    const ch = src[i]!
    if (inString) {
      if (escaped) escaped = false
      else if (ch === "\\") escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === "{") depth += 1
    else if (ch === "}") {
      depth -= 1
      if (depth === 0) {
        try {
          return JSON.parse(src.slice(start, i + 1))
        } catch {
          return undefined
        }
      }
    }
  }
  return undefined
}

/** Parse a critic's concerns: a JSON `{ concerns: [...] }` if present, else the
 *  bullet/numbered list lines. Empty ⇒ no concerns (advisory). */
export function parseConcerns(text: string): string[] {
  if (typeof text !== "string") return []
  const json = extractJson(text)
  if (json && typeof json === "object" && Array.isArray((json as { concerns?: unknown }).concerns)) {
    return (json as { concerns: unknown[] }).concerns.filter((c): c is string => typeof c === "string")
  }
  const concerns: string[] = []
  for (const raw of text.split("\n")) {
    const m = /^\s*(?:[-*•]|\d+[.)])\s+(.*)$/.exec(raw)
    if (m && m[1]!.trim().length > 0) concerns.push(m[1]!.trim())
  }
  return concerns
}

const DECOMPOSE_INSTRUCTIONS = (toolCatalog: string): string =>
  `You compose a workflow IR for a software task. Output ONLY a JSON object — the typed WorkflowIR — no prose.

Shape: { rawAskHash: string, acceptanceCriteriaHash: string, maxDepth: 1..3, nodes: [ { id, role, inputs: string[], gate: { kind: "executable"|"cross_lab"|"none", gateId?, checkerLab? }, onFail: "loop"|"baseline"|"escalate", producerLab?, judgesOnRawAsk? } ] }.

Floor invariants the IR MUST satisfy (a static verifier rejects violations):
- exactly one node role "baseline" (inputs: [], runs the raw ask off the chain);
- exactly one node role "selector": judgesOnRawAsk: true, onFail: "baseline", takes the baseline + EXACTLY ONE orchestrated candidate, and is the terminal sink every node feeds;
- "producerLab" and a cross_lab gate's "checkerLab" are LAB identifiers, one of exactly: "openai", "google", "anthropic" (NEVER a role name like "implement"); a cross_lab gate's checkerLab must DIFFER from the node's producerLab;
- an "executable" gate's "gateId" MUST be one of exactly: "default-ci", "typecheck-test", "typecheck-only" (the kernel's SEALED gate ids; any other value is rejected, so do NOT invent ids like "tests" or "lint"). Use the SAME gateId on every executable gate (the kernel runs one canonical gate per run);
- two or more "implement" nodes require an "integration" node (executable gate) they all feed;
- the graph is a DAG; every node feeds the selector.

Available tools/roles to assign per node: ${toolCatalog}`

const CRITIQUE_INSTRUCTIONS =
  "You are a cross-lab reviewer of a workflow IR (JSON). List concrete concerns "
  + "that would weaken the result — missing verification, a mis-scoped node, a "
  + "wrong tool/role. Output a JSON object { \"concerns\": string[] } — an empty "
  + "array if the IR is sound. Concerns are advisory."

export interface LiveDecomposeOpts {
  /** The driver model + endpoint + effort (default gpt-5.5 /responses high). */
  driver?: { model: string; endpoint: Endpoint; effort: Effort }
  /** Optional cross-lab critic (a different lab than the driver). */
  critic?: { model: string; endpoint: Endpoint; effort: Effort }
  /** A description of the tools/roles the workflow may use. */
  toolCatalog: string
  signal?: AbortSignal
}

export function buildLiveDecomposeDeps(opts: LiveDecomposeOpts): DecomposeDeps {
  const driver = opts.driver ?? { model: "gpt-5.5", endpoint: "/v1/responses" as Endpoint, effort: "high" as Effort }
  const deps: DecomposeDeps = {
    async draftIR({ ask, feedback }) {
      const userText =
        `Ask:\n${ask}`
        + (feedback && feedback.length > 0 ? `\n\nFix these issues from the previous draft:\n- ${feedback.join("\n- ")}` : "")
      const text = await dispatchModelCall({
        model: driver.model,
        endpoint: driver.endpoint,
        instructions: DECOMPOSE_INSTRUCTIONS(opts.toolCatalog),
        userText,
        effort: driver.effort,
        signal: opts.signal,
      })
      return extractJson(text)
    },
  }
  if (opts.critic) {
    const critic = opts.critic
    deps.critiqueIR = async (ir) => {
      const text = await dispatchModelCall({
        model: critic.model,
        endpoint: critic.endpoint,
        instructions: CRITIQUE_INSTRUCTIONS,
        userText: JSON.stringify(ir),
        effort: critic.effort,
        signal: opts.signal,
      })
      return { concerns: parseConcerns(text) }
    }
  }
  return deps
}
