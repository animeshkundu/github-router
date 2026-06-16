/**
 * The reference `NodeRunner` for the kernel — maps each node role to a concrete
 * action and (critically) threads the EXECUTABLE gate outcome to the selector so
 * champion-retention compares real test results, not LLM opinions.
 *
 * Selection-correctness rule: the baseline AND the orchestrated candidate must
 * be gated over the SAME canonical acceptance gate, or the comparison is
 * apples-to-oranges. So every producer (baseline / implement / test /
 * integration) runs `ctx.canonicalGate` and reports its outcome over the canonical
 * checks; an advisory `review` passes its input's outcome through unchanged (the
 * critic's verdict never overrides the executable gate — invariant 2).
 *
 * The primitives are INJECTED (`RunnerDeps`) so the role→action mapping is
 * unit-testable; the live adapter (wiring `runWorker` to the worker engine,
 * `runGate` to a sandboxed `bun test`/`tsc`/`lint`, `runCritic` to a cross-lab
 * persona, `prepareWorkspace` to a git worktree) is a thin separate slice and the
 * only part that needs E2E verification.
 */

import { type WorkflowNode } from "./ir"
import { type NodeRunResult, type NodeRunner } from "./kernel"
import { type GateOutcome } from "./select"

export interface RunnerDeps {
  /** Isolated workspace for a write node (a fresh worktree); the base workspace
   *  for read-only nodes. Returns the workspace path. */
  prepareWorkspace(node: WorkflowNode): Promise<string>
  /** Run a worker agent of the given role on a prompt in a workspace. */
  runWorker(input: {
    role: WorkflowNode["role"]
    prompt: string
    workspace: string
  }): Promise<{ text: string; isError?: boolean; artifact?: string }>
  /** Run a SEALED executable gate (the kernel/registry owns the command); returns
   *  which of the canonical checks passed/ran. */
  runGate(input: { gateId: string; workspace: string }): Promise<GateOutcome>
  /** Run a cross-lab critic on an artifact (advisory). `block` is recorded but
   *  never overrides the executable gate. */
  runCritic(input: { checkerLab: string; prompt: string; workspace: string }): Promise<{ block: boolean }>
}

export interface RunnerCtx {
  /** The raw user ask (the baseline runs on THIS; producers also see it). */
  rawAsk: string
  /** Base workspace path for read-only nodes. */
  baseWorkspace: string
  /** The canonical acceptance gate every producer is judged over (one sealed
   *  command `id`, producing the set of `checks` the selector compares). */
  canonicalGate: { id: string; checks: ReadonlySet<string> }
}

const passesAll = (g: GateOutcome, checks: ReadonlySet<string>): boolean => {
  for (const id of checks) if (!g.passed.has(id)) return false
  return true
}

/** A producer's task text. Baseline gets the RAW ask (off the chain); other
 *  producers get the ask plus a short note of their inputs. */
const producerPrompt = (
  node: WorkflowNode,
  ctx: RunnerCtx,
  inputs: ReadonlyMap<string, NodeRunResult>,
): string => {
  if (node.role === "baseline") return ctx.rawAsk
  const refs = [...inputs.keys()]
  return refs.length > 0 ? `${ctx.rawAsk}\n\nInputs available: ${refs.join(", ")}.` : ctx.rawAsk
}

export function makeRunner(deps: RunnerDeps, ctx: RunnerCtx): NodeRunner {
  /** Run a worker (where applicable) then the CANONICAL gate, so every producer
   *  is comparable. `integration` skips the worker (it only gates the assembly). */
  const runProducer = async (
    node: WorkflowNode,
    inputs: ReadonlyMap<string, NodeRunResult>,
  ): Promise<NodeRunResult> => {
    const workspace = await deps.prepareWorkspace(node)
    let artifact = workspace
    if (node.role !== "integration") {
      const w = await deps.runWorker({
        role: node.role === "baseline" ? "implement" : node.role,
        prompt: producerPrompt(node, ctx, inputs),
        workspace,
      })
      if (w.isError) return { ok: false, infraFailure: true }
      artifact = w.artifact ?? workspace
    }
    const gate = await deps.runGate({ gateId: ctx.canonicalGate.id, workspace })
    return { ok: passesAll(gate, ctx.canonicalGate.checks), gate, artifact }
  }

  return {
    async runNode(node, inputs): Promise<NodeRunResult> {
      switch (node.role) {
        case "baseline":
        case "implement":
        case "test":
        case "integration":
          return runProducer(node, inputs)

        case "review": {
          // Advisory cross-lab critic; PASS THROUGH the input's executable
          // outcome so the selector compares executable results, not opinions.
          const input = [...inputs.values()][0]
          if (node.gate.kind === "cross_lab" && node.gate.checkerLab) {
            try {
              await deps.runCritic({
                checkerLab: node.gate.checkerLab,
                prompt: `Review the artifact for ${[...inputs.keys()].join(", ")}.`,
                workspace: input?.artifact ?? ctx.baseWorkspace,
              })
            } catch {
              // advisory — a critic failure never blocks (invariant 2).
            }
          }
          return { ok: input?.ok ?? true, gate: input?.gate, artifact: input?.artifact }
        }

        case "research":
        case "plan":
        case "verify": {
          const w = await deps.runWorker({
            role: node.role,
            prompt: producerPrompt(node, ctx, inputs),
            workspace: ctx.baseWorkspace,
          })
          return { ok: !w.isError, artifact: w.artifact }
        }

        // The selector is handled by the kernel, never the runner.
        default:
          return { ok: true }
      }
    },
  }
}
