# Shim prompt fidelity on non-Claude models

**Date:** 2026-08-05 · **Proxy:** v0.3.258 · **Claude Code:** 2.1.222

Bounded investigation into whether Claude Code's system prompt, forwarded verbatim to
gpt/gemini by the Anthropic-translation shim, needs per-model adaptation. The question
was raised because the prompt is written for Claude: it names the product, assumes
Claude's tool-use conventions, and references thinking blocks that a chat-egress model
cannot emit.

**Conclusion: no per-model steering is warranted.** The one intervention that already
exists (`FILE_TOOL_GUIDANCE`) is load-bearing and measurably effective. The residual
gaps are low-harm and chasing them would buy drift against every Claude Code release.

## What the shim does today

The shim (`src/lib/anthropic-translate/`) forwards `system` verbatim via `flattenSystem`.
The only modification is `FILE_TOOL_GUIDANCE` (`anthropic-request.ts`), a
`<file_tools>` block appended when the request carries a tool literally named `Edit` or
`Write`. The gate is tool presence, not model identity; Claude models never reach this
code path because they take the passthrough route. Opt out with
`GH_ROUTER_DISABLE_SHIM_TOOL_STEERING=1`, which is what makes the A/B below possible.

## Method

Two proxy instances on the built artifact, identical except for the steering opt-out.
Each request carried a Claude-Code-shaped system prompt plus five tool definitions
(`Read`, `Edit`, `Write`, `Grep`, `Bash`) and a single user turn. Recorded which tool
the model called first, and the shell command when it chose `Bash`.

Round 1 used tasks with an obvious dedicated tool. Round 2 used "shell bait": tasks a
model is tempted to solve with `sed`, `echo >>`, `wc -l`, or `>`.

## Results

Round 1 (read a field; grep for a symbol) was non-discriminating: both models called
`Read` and `Grep` correctly in all four cells, steering on or off.

Round 2, first tool called:

| task | gpt-5.6-sol ON | gpt-5.6-sol OFF | gemini-3.1-pro ON | gemini-3.1-pro OFF |
|---|---|---|---|---|
| replace a word in a file | `Read` | `Read` | `Read` | `Read` |
| **append a line to a file** | **`Read`** | **`Bash printf … >>`** | **`Read`** | **`Bash echo … >>`** |
| count lines in a file | `Read` | `Read` | `Bash wc -l` | `Bash wc -l` |
| create a file with content | `Write` | `Write` | `Bash mkdir -p` | `Bash mkdir && echo -n >` |

## Findings

**1. `FILE_TOOL_GUIDANCE` earns its place.** The append case flips both models from
shelling out to reading first (then editing) purely from the steering block. Without it
each model writes to a file through the shell, which produces no reviewable diff. On
the create case it moves gemini from shelling the whole operation to shelling only the
`mkdir`, which is a legitimate use since no dedicated tool covers it.

**2. Residual gap, gemini only, low harm.** Gemini still prefers `Bash wc -l` for
counting, steering or not. It is read-only and produces no diff, so the cost is a
missed opportunity rather than an unreviewable mutation. gpt-5.6-sol does not exhibit
it.

**3. Identity capture, gpt only.** Asked which company built the model it is running
on, under the Claude Code system prompt:

- `gpt-5.6-sol` → "Anthropic built the underlying model I'm running on." **False.**
- `gemini-3.1-pro-preview` → "The underlying model I am running on right now is Gemini." Correct.

So the verbatim prompt does capture gpt's self-report. This is a self-description
inaccuracy, not a task-execution defect: no probe showed it changing tool selection or
output structure. It would matter more if a model reasoned from a false self-model
(for instance assuming it can emit thinking blocks, which the chat egress never
produces).

**4. No structural artifacts.** Every response across both rounds carried well-formed
`tool_use` blocks with correct parameter names. Nothing in the Claude-specific prompt
text produced malformed output, refusals, or references to unavailable capabilities.

## Recommendation

Leave the prompt handling as it is.

The evidence supports the current design rather than an extension of it: one
tool-presence-gated block fixes the failure mode that actually corrupts work (writing
files through the shell), and the two residuals are a read-only tool preference and a
self-report inaccuracy. Per-model steering blocks would have to be re-validated against
every Claude Code release, which is a standing maintenance cost for gains this probe
could not measure.

If identity capture ever becomes user-visible enough to matter, the smallest correct
fix is a single factual line appended on the shim path only, stating which model is
actually serving the request. That is one sentence gated the same way the file-tool
block already is, not a per-model prompt fork.

## Reproducing

Start two proxies on the built artifact, one with `GH_ROUTER_DISABLE_SHIM_TOOL_STEERING=1`,
and POST `/v1/messages` with `Edit`/`Write` among the tools so the steering gate fires.
Round 2's discriminating case is the append task; the others do not separate the arms.
