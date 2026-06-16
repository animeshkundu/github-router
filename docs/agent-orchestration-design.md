# Agent Orchestration — decompose → typed IR → frozen kernel (with the floor guarantee)

> Status: **design approved, Phase 0 in progress.** This is the consolidated design; the full
> iteration log (two adversarial expert teams + three cross-lab reviews) lives in the planning
> transcript. Naming note: this is unrelated to the `docs/research/engram-*` thread — that "floor"
> is *code-search recall*; this "floor" is *delivered-software quality*. Both threads share the same
> cross-lab-critics + `stand_in` adversarial methodology.

## Goal

Take an open-ended software task and reliably deliver software that is **at least as good as a
single strong model would have produced** — and better on the asks where decorrelated multi-model
work actually helps — by decomposing the ask into role-separated units, dispatching them to isolated
agents, and recombining deterministically, with self-review / self-evaluation bias removed
*structurally* (a producer never blesses its own output; checks cross to a different lab).

The load-bearing requirement is a **do-no-harm floor**: the system must never deliver worse software
than the single-model baseline.

## The honest verdict — does this raise the worst-case floor?

**No, not unconditionally** — and not at all if the floor-critical logic is authored by an LLM at
runtime. Established by two adversarial expert teams + three cross-lab reviews (gpt-5.5,
gemini-3.1-pro, opus-4.x; verdicts triangulated by `stand_in`). Three load-bearing results:

1. **The deterministic floor-win is structural gates on a single strong model** — a non-skippable
   test/type/build/lint Stop-hook + gate-immutability + worktree-isolation. A plain baseline *also*
   runs these, so they are **not** an orchestration delta. The orchestration's own marginal floor
   effect is **sign-indeterminate**: positive in expectation on blind-spot / ambiguous asks
   (especially *independent adversarial test authorship*, which a single context structurally cannot
   do), negative on unconventional-correct / coupled / weak-routing asks.
2. **The floor is a `min` over (ask, seed) outcomes.** Adding non-monotone gates *in series* can
   only lower the worst case. LLM-judgment gates are non-monotone (they can *invent* problems or be
   *unavailable*); executable gates used as a *filter that retains a champion* are monotone.
3. **You cannot get a deterministic floor from a probabilistic authoring of the thing that enforces
   the floor.** If an LLM authors the orchestration at runtime, `P(invariant preserved) < 1`, so the
   worst-case floor over runs → 0. **The floor-critical layer must be code, not authored at runtime.**

Strongest honest guarantee with the mechanism below: the **artifact-quality floor is monotone on
asks with a real executable harness**; the **liveness floor is restored to baseline** by
fail-to-baseline; an **irreducible residual** remains on pure-judgment asks (ADRs, "is X safe?",
greenfield with no suite) where no executable oracle exists.

## v6 architecture — three enforcement layers (defense-in-depth)

1. **Frozen server-side kernel (runtime enforcement — cannot be bypassed).** A frozen TypeScript
   engine in github-router consumes a typed workflow IR and enforces the invariants *in code*:
   baseline fork in a clean worktree, **sealed executable gates the kernel runs** (the LLM submits
   commit SHAs; it never authors the runner), `git diff` **gate-immutability**, **try/catch
   fail-to-baseline** in the host, the **selector injected with the immutable raw-ask + user-blessed
   AC** (bypassing the decompose-derived AC), a mandatory **integration gate**, and the
   **superset-selection** for `max(orchestrated, baseline)`. LLMs fill bounded creative slots only
   and cannot alter the safety topology.
2. **Static IR verifier (pre-flight, Claude-callable).** A github-router MCP tool that validates the
   IR (and any composition) against the invariant schema *before the kernel runs it*:
   well-formedness; safety-topology intact (baseline present + parallel, gates sealed/executable,
   selector reads the raw-ask not the derived AC, fail-to-baseline present, no gate-weakening);
   recursion depth bound. Rejects violations with actionable errors so Claude self-corrects.
3. **Structural gates (Phase 0 — the floor underneath both).** Non-skippable Stop-hook
   (tests/types/build/lint, block-on-red) + gate-immutability + worktree-isolation — the
   provably-positive component that protects the floor even when no orchestration runs.

**Division of labor:** `decompose` is multi-model (one driver + cross-lab peer review) but emits a
**typed JSON IR**, not a build-prompt and not JS. Claude composes the *creative* parts and calls the
**verifier** to confirm correctness; the **kernel** executes and enforces. Decompose stays
**opt-in / complexity-gated** (it costs ~4–8×) — trivial asks use Phase 0's default loop.

## The 8 invariants (enforced in the kernel, checked by the verifier)

1. **Parallel baseline + champion-retention** — always compute the single-strong-model baseline B on
   the RAW ask, off the orchestration chain; deliver `select(O, B)`, best-so-far pinned across loops.
2. **Executable-primary accept** — the executable gate is a FILTER (reject ⇒ fall back), never an
   optimization target handed to the producer; LLM judgment is advisory only.
3. **Fail-closed TO BASELINE, not to halt** — artifact-failure ⇒ loop/escalate; check/infra-failure
   (critic unavailable, budget exhausted) ⇒ ship the baseline, never halt to nothing.
4. **Decorrelate the selector** — judge on the RAW ask + user-blessed AC, not the producer's derived
   AC (the most load-bearing: without it the selector can ship a wrong-but-AC-passing output and
   discard a correct baseline).
5. **Gate-immutability** — reject diffs that weaken tests/types/lint (`git diff` on those files).
6. **Worktree-isolation, escalate-from-clean** — producers mutate isolated worktrees only; on
   failure discard and escalate from a clean base so the retained baseline is never polluted.
7. **Executable integration gate** — coupled/fan-out work runs the global build/integration tests on
   the ASSEMBLED output before select.
8. **Right-sizing** — scale the workflow to the ask; trivial asks bypass orchestration entirely.

**Selection rule** (`max(orchestrated, baseline)`, made concrete): accept the orchestrated result
**only if the kernel verifies it passes a strict superset of the baseline's executable checks**
(≥ the baseline's green tests, none fewer) on the raw-ask gates; otherwise ship the baseline.

## The `decompose` tool (multi-model designer, emits typed IR)

- Input: the user ask (+ context, workspace). A strong **driver model** (gpt-5.5 / opus xhigh)
  receives the ask + the **full tool catalog** (github-router MCP tools resolved against the live
  catalog + a maintained description of the Claude-native tools) + the floor-guarantee constraints.
- It drafts the workflow (phases, nodes, per-node tool assignment, gates, data-flow, recursion,
  right-sized); the draft goes to **cross-lab peer review** (`codex_critic` + `gemini_critic`) +
  the advisor; the driver revises (bounded 1–2 rounds). This is the "multiple models have a say"
  mechanism and reduces the decompose-as-SPOF risk — but note cross-lab review de-SPOFs *within-plan*
  errors, not *framing* errors (a mis-framed ask still anchors everything; the user-blessed AC gate
  is the mitigation).
- Output: a **typed JSON IR** the verifier checks and the kernel executes.

## Phased build (build all; Phase 0 first)

- **Phase 0 — ships first, DEFAULT path:** structural gates + `worker_plan` + `worker_test` + a
  simple retry-on-gate-failure loop. Provably positive; the default for every ask. (`worker_test` =
  independent adversarial test authorship in a *different* session than the implementer — the one
  floor-raise a single context cannot do. Note: `worker_test` is **not** cheap — it must understand
  the test framework, fixtures, mocking, across languages.)
- **Phase 1:** the typed workflow **IR schema** + the **static IR verifier** MCP tool + the
  **`decompose`** tool (driver + cross-lab review) emitting the IR.
- **Phase 2:** the **frozen kernel** that executes the IR and enforces the 8 invariants +
  superset-selection + fail-to-baseline + sealed gates. **Cost/token accounting is built HERE**
  (before wiring — you cannot evaluate the orchestration delta without measuring it).
- **Phase 3:** wire Claude (call `decompose` → call `verify` → kernel-execute → deliver
  `max(orchestrated, baseline)`); bounded recursion; budgets + **backpressure on the shared
  `MAX_INFLIGHT_TOOLS_CALL=32` cap**; `attest_step` (fail-closed-to-baseline, content-hashed).

## Cost & scope

A full orchestrated run is ~4–8× the cost and ~3–5× the latency of the structural-gates baseline,
and the orchestration only helps on ~15–30% of asks while the overhead is paid on 100%. Hence:
Phase 0 + the simple loop is the **default**; the decompose/kernel path is **opt-in / complexity-
gated**; the parallel dual-run is deferred until measurement shows the orchestrated branch wins
often enough to justify doubling compute.

## Where it maps onto the existing codebase (reuse)

- Worker modes (`worker_plan`/`worker_test`) follow the `review`-mode pattern:
  `WorkerAgentOpts.mode` + `systemPromptFor` + `buildWorkerTools` in `src/lib/worker-agent/`.
- The decompose driver + cross-lab review reuse the peer dispatch infra (`dispatchModelCall`, the
  critics) in `src/lib/peer-mcp-personas.ts` + `src/routes/mcp/handler.ts`, the live model catalog,
  and the `PersonaSpec` shape.
- MCP tool/group registration + the awareness snippet: `src/lib/codex-mcp-config.ts`,
  `buildPeerAwarenessSnippet`.
- Budgets/worktree isolation: `src/lib/worker-agent/budget.ts`, `worker_implement`'s `worktree`.
- The `stand_in` code-driven-protocol pattern (`src/lib/stand-in.ts`) is the template for the kernel
  enforcing a protocol in code rather than trusting a model.

## Design history (why it evolved)

v1 fixed role list → v2 server-side `decompose` brain → v4 "Claude's Workflow tool composes" flip →
v5 decompose emits a build-prompt Claude turns into a workflow → **v5 review (3 labs, convergent):
fatal** — a probabilistic authoring step cannot enforce a deterministic floor → **v6: decompose
emits a typed IR; a frozen kernel enforces; a static verifier checks; structural gates underneath.**
Two findings reshaped the whole design: (a) the *floor analysis* — orchestration does not raise the
floor unconditionally; structural gates are the cheap, certain win; (b) the *IR/kernel correction* —
the floor-critical layer must be code.
