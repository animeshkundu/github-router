# Delegation evaluation protocol

## Status and purpose

This protocol is preregistered before collecting live data. The eval asks whether an unprompted Claude Code lead uses the injected native subagents appropriately, and whether the `generic` → `implementer-fast` treatment package improves that policy. It is a comparative instrument over a synthetic, first-turn task battery. It is not a claim about every real interactive session.

The live harness is opt-in and costs Copilot budget. Start the treatment proxy separately so its logs and subagent short-circuit are visible, then run the harness:

```bash
GH_ROUTER_DELEGATION_EVAL=1 GH_ROUTER_LOG_FIELDS=1 bun run dev
GH_ROUTER_RUN_DELEGATION_EVAL=1 bun scripts/eval-delegation.ts
```

The no-cost parser/scorer check is:

```bash
GH_ROUTER_RUN_DELEGATION_EVAL=1 bun scripts/eval-delegation.ts --self-test
```

### Invocation-failure modes fixed after live data revealed them

Three defects in `runOne()`'s CLI invocation each independently made every run fail before the model ever saw a prompt, and each went undetected because the scoring endpoints (other than `parallelFanout`) had no error-exclusion at all — a systematic crash silently read as "0% delegation, 100% restraint" rather than as a null result. All three are now fixed and each is exercised in the self-test:

1. **`--no-auto-update`/`--no-self-update`** were `github-router claude`-only flags, unconditionally appended even though the default `arm.command` invokes the raw `claude` binary directly (per the architecture above). The real CLI rejects them with `error: unknown option`. Removed; `GH_ROUTER_NO_SELF_UPDATE=1` in `armEnv` is the correct guard for an arm that DOES point at `github-router claude`.
2. **`--verbose` is required** by the installed CLI (verified against 2.1.229) whenever `--print --output-format=stream-json` is used without it; omitting it is a hard CLI error, not a warning. Now always passed.
3. **`CLAUDE_CODE_COORDINATOR_MODE=1` and/or `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`**, if present ambiently (inherited process env, or a `settings.json` `env` block at the target `CLAUDE_CONFIG_DIR`), collapse a `--print` session's own tool list from the full native+MCP set down to exactly `Task, SendMessage, TaskStop, Workflow` — no Read, Write, Edit, Bash, Grep, or Glob, and no MCP tools. This is not "the model chose not to delegate"; it is "the model cannot do anything BUT attempt to delegate", and since a `Task`/`Agent` dispatch under `--print` never resolves synchronously within the same turn sequence, the observed failure mode is a doomed retry loop across subagent types ending in a stalling non-answer. Running this harness from *inside* an active `github-router claude` session — the natural way to invoke it — inherits both vectors ambiently, since `github-router claude` auto-enables `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` by default. `armEnv` now scrubs both keys in the spawned process env, and `scrubbedAmbientConfigDir()` additionally makes a throwaway copy of the ambient `CLAUDE_CONFIG_DIR` with both keys deleted from its `settings.json` `env` block when neither arm sets its own explicit `GH_ROUTER_DELEGATION_ARM_{A,B}_CONFIG_DIR` — process-env scrubbing alone was measured insufficient, since the `settings.json` `env` block value takes effect regardless.

This third fix is scoped to the eval harness only. The same `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS`/`--print` interaction affects any `github-router claude --print ...` invocation by an end user (scripts, CI, a piped one-off query) — that is a separate, real gap in `getClaudeCodeEnvVars` (`src/lib/server-setup.ts`), tracked as follow-up rather than fixed here. It does **not** affect interactive sessions — verified directly: an interactive `github-router claude` session with the same env/settings has the full tool list.

First live run after all three fixes, `claude-sonnet-5[1m]` as the budget lead, n=17 prompts × 2 arms (identical arm config — this was a real-numbers check, not an A/B): `spontaneousDelegation` 63.6%/66.7% (Wilson 95% CIs span the 70% bar), `routingConditionalOnDelegation` 87.5%/87.5%, `restraint` 100%/100%, `complexImplementationDelegation` 66.7%/50.0% (n=3/n=2, wide intervals). Real `Task` calls observed: `implementer`, `implementer-fast`, `scribe`, `brainstorm`, `reviewer`, `scout`, all within their acceptable sets. `parallelFanout` stayed inconclusive (the documented headless one-tool-per-message limitation below).

## Treatment and execution

Each prompt instance is run once under each arm. Both arms invoke the Claude Code CLI directly and point it at an already-running proxy endpoint; the default endpoint is `http://127.0.0.1:8787`.

- **A, baseline:** a Claude Code config directory containing the current agent definitions, selected through the A command or its environment wrapper.
- **B, treatment:** a separate Claude Code config directory containing the full Part 1 agent definitions, selected through the B command or its environment wrapper.

Commands can be pinned explicitly with `GH_ROUTER_DELEGATION_ARM_A_COMMAND` and `GH_ROUTER_DELEGATION_ARM_B_COMMAND`, each a JSON string array. A common endpoint can be set with `GH_ROUTER_DELEGATION_EVAL_BASE_URL`, or per arm with `GH_ROUTER_DELEGATION_ARM_{A,B}_BASE_URL`. Set `GH_ROUTER_DELEGATION_ARM_{A,B}_CONFIG_DIR` when each arm is represented by a separate `CLAUDE_CONFIG_DIR`. In the common one-proxy setup, start the proxy itself with `GH_ROUTER_DELEGATION_EVAL=1 GH_ROUTER_LOG_FIELDS=1`; arm commands differ only in the Claude Code configuration they select. The run records the actual command, declared proxy revision, Claude Code version, model ID, start/end timestamps, elapsed time, and randomized schedule seed. `GH_ROUTER_DELEGATION_ARM_{A,B}_REVISION` should identify external builds or config snapshots whose Git revision cannot be read locally.

Prompt blocks are randomized, arm order is randomized inside each block, and the schedule is interleaved. Analysis is paired by prompt ID. A baseline-then-treatment sequence is prohibited because model aliases, Claude Code, and the backend may change between batches.

Every run receives a fresh copy of `tests/fixtures/delegation-repo`, initialized as its own git repository. The harness resets it with `git reset --hard` and `git clean -fdx` before each run. It never runs against the real repository.

## Battery and acceptable sets

The battery contains multiple independently worded instances in six strata:

1. cheap or mechanical implementation, testing the `implementer-fast` boundary;
2. complex implementation, predetermined to require full `implementer`;
3. specialist work for `scout`, `reviewer`, `brainstorm`, or `scribe`;
4. ambiguous boundary work with more than one defensible route;
5. negative controls where direct action is correct;
6. parallel fan-out with several independent tracks.

Prompts do not name agents. Each positive instance declares an **acceptable set**, not a single label. The `implementer-fast` boundary intentionally scores the new role by its treatment name; baseline `generic` calls remain visible in raw results but do not receive routing credit for a role the baseline roster does not yet expose. The checked-in battery is the denominator. Prompts or acceptable sets must not be edited after live results are inspected without declaring a new eval version.

## Signal and cost bound

Claude Code runs with `--print --output-format stream-json`. The parser records every top-level `Task` or `Agent` tool-use block, its `subagent_type`, global order, assistant-message number, and position within that message, plus the largest tool-use batch in any assistant message across all tools. Child-agent events are excluded via `parent_tool_use_id`. For parallel fan-out, calls count as concurrent only when issued in the same top-level assistant message.

`GH_ROUTER_DELEGATION_EVAL=1` makes the proxy return a minimal valid Anthropic response to requests carrying `x-claude-code-agent-id`. The lead can choose a subagent, but the subagent does no model work. Independently, the harness terminates the CLI immediately on the first top-level Task-bearing event.

The harness also sets `GH_ROUTER_LOG_FIELDS=1` and parses `[fields] ... agent=<id>` lines derived from the proxy's `x-claude-code-agent-id` header. A Task request with no observed non-main agent header is reported as `requestedButNeverStarted`. This is a diagnostic discrepancy, not silently counted as successful execution.

The installed Claude Code 2.1.228 has no `--max-turns` option. This protocol does not use or claim that nonexistent bound. The harness imposes a per-run wall-clock timeout in addition to the two cost controls above.

## Three separate estimands

The evaluation reports these separately. There is no combined delegation score.

### 1. Spontaneous delegation

**Endpoint:** proportion of eligible non-negative, non-fan-out prompt runs with at least one top-level Task/Agent call.

**Denominator:** all runs in cheap implementation, complex implementation, specialist, and ambiguous strata. Each prompt contributes one observation per arm.

**Weighting:** prompt-micro-average, one equal vote per prompt. Report per arm with a Wilson 95% confidence interval. The paired A→B transition table is also reported so prompt difficulty cannot masquerade as treatment effect.

### 2. Routing conditional on delegation

**Endpoint:** proportion of delegated runs on which every observed Task/Agent call names an agent in that instance's acceptable set.

**Denominator:** runs with at least one top-level Task/Agent call. This is explicitly conditional on delegation. It must never be combined with spontaneous delegation by treating non-delegation as a routing failure.

**Weighting:** prompt-micro-average, one equal vote per delegated run. Report per arm with a Wilson 95% confidence interval. A run that launches several agents passes only if all chosen agents are acceptable for that prompt.

### 3. Restraint

**Endpoint:** proportion of negative-control runs with no top-level Task/Agent call.

**Denominator:** all negative-control runs.

**Weighting:** prompt-micro-average, one equal vote per negative-control prompt. Report per arm with a Wilson 95% confidence interval.

## Parallel fan-out endpoint

Parallel fan-out is a first-class additional endpoint, not folded into spontaneous delegation. A measurable run passes when the first Task-bearing assistant message contains at least the instance's preregistered number of Task/Agent calls and every call is in the acceptable set. Later serial calls cannot rescue a failed first batch. Report per arm with a Wilson 95% confidence interval.

Fan-out scoring is four-valued, and the three non-`pass` outcomes are deliberately not interchangeable:

- `maxToolBatch >= 2` — the mode demonstrably batches, so the run is scored `pass`/`fail` on whether the first Task-bearing message carried the expected concurrent calls.
- `maxToolBatch === 1` — **inconclusive**, excluded from the denominator. One tool use per message cannot distinguish a lead that chose to serialize from an execution mode that structurally cannot batch.
- `maxToolBatch === 0` on a clean run — a genuine **failure** that stays in the denominator. The lead answered directly instead of fanning out, which is a real result and says nothing about the mode's batching limit. Folding this into `inconclusive` would silently inflate the rate by removing true failures.
- Timed out or non-zero exit (excluding the harness's own `killedAfterTask`) — **errored**, excluded in its own bucket. A crashed run measures neither the model's choice nor the mode's capability.

The summary must report the inconclusive and errored counts separately, each with its own reason. An undisclosed exclusion reads as "measured and passed" when it was never measured.

## Primary bar

The historical “7/10” threshold is defined here as follows:

> **Primary endpoint:** treatment-arm spontaneous delegation on the positive non-fan-out battery must be at least 70%.

This bar answers whether an unprompted lead delegates at all on tasks where delegation is considered appropriate. It does **not** cover routing quality, restraint, parallelism, latency, implementation correctness, or real-session external validity. Those remain separate endpoints and can veto a superficially good primary result. In particular, a treatment that clears 70% by delegating indiscriminately but loses restraint is not considered an improvement.

The treatment is considered directionally successful only if it clears the primary bar, routing does not visibly collapse, restraint remains credible, and the fan-out endpoint improves or stays strong. Given the small battery, these judgments are descriptive rather than formal hypothesis tests.

## Complex-implementation non-degradation

Raw `implementer` frequency across all prompts is not a safety metric. A lower rate can be the desired migration of mechanical work to `implementer-fast`. Full-`implementer` non-degradation is evaluated only on the complex-implementation stratum, using the proportion of runs that include `subagent_type: "implementer"`.

This battery will likely be underpowered to prove non-inferiority. A proper claim would require a preregistered non-inferiority margin and enough samples for the confidence bound to exclude it. Unless that condition is met, a null result must be reported exactly as:

> **No drop observed, underpowered to exclude one.**

It must not be described as proof, safety, equivalence, or non-degradation.

## Reporting

The JSON artifact contains all run metadata, ordered Task calls, agent-start cross-checks, raw-output tails, rates, Wilson intervals, and paired transitions. Reports must include:

- CLI version, model ID, arm commands and revisions, schedule seed, timestamps;
- every endpoint above with numerator, denominator, point estimate, and Wilson 95% interval;
- paired spontaneous-delegation transitions by prompt;
- ordered Task calls and same-message fan-out status;
- requested-but-never-started discrepancies;
- time to first Task and total elapsed time;
- failures, timeouts, and any run whose process was not terminated after Task as designed.

A rate without its numerator, denominator, and Wilson interval is incomplete.

## Known limits

The task distribution is synthetic and first-turn. Real sessions contain accumulated context, corrections, and prior tool use. Part 1 is a bundled treatment: rename, role framing, trigger idiom, and reciprocal `implementer` boundary. This A/B estimates the package rather than isolating a single wording change. The cost short-circuit measures delegation choice and request start, not the delegated agent's output quality. Finally, the eval's product goal is faster time to a correct outcome; delegation rates are policy diagnostics, not ends in themselves.

### Measured headless fan-out limitation

Live verification across multiple runs found that `claude --print --output-format stream-json` emits exactly one `tool_use` block in every assistant message, including ordinary `Read`, `Grep`, and `Glob` calls. No observed headless assistant message contained two or more tool uses. Interactive Claude Code does batch multiple calls per message through the same proxy.

Consequently, the `parallel-fanout` stratum is currently **unmeasurable under `--print`**: its former requirement for multiple `Task`/`Agent` calls in the first message could only produce a structural false negative. The harness retains the preregistered stratum and prompts, records the all-tool `maxToolBatch` diagnostic, and marks runs whose maximum is exactly one as inconclusive rather than failures. Runs with zero tool calls remain failures, and crashed runs are excluded separately, so neither is laundered into the inconclusive bucket. Measuring actual parallel fan-out requires a harness that drives interactive Claude Code rather than headless print mode.
