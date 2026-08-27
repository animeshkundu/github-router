# Shim prompt fidelity on non-Claude models

**Current evaluation:** 2026-08-27 · **Proxy:** v0.3.295 · **Claude Code-shaped fixture:** stable synthetic prompt

Bounded investigation into whether Claude Code's system prompt, forwarded through the
Anthropic-translation shim, needs per-model adaptation. The prompt is written for
Claude Code: it names the product, assumes Claude's tool-use conventions, and refers
to capabilities that a chat-egress model cannot emit. The question is whether those
assumptions harm tool selection on the four models in the fast lead profile.

**Current conclusion: keep one model-agnostic `FILE_TOOL_GUIDANCE` block and do not add
per-model clauses.** The current A/B reproduces the important effect on first-call shell
file mutation, while the one-repetition sample is too small to justify extending or
removing the block.

## What the shim does today

The shim (`src/lib/anthropic-translate/`) forwards the caller's stable `system` text.
The only prompt intervention is `FILE_TOOL_GUIDANCE` in
`src/lib/anthropic-translate/anthropic-request.ts`: a `<file_tools>` block appended
when the request carries a tool literally named `Edit` or `Write`. The gate is tool
presence, not model identity. Claude models do not reach this code path because they
stay on the native `/v1/messages` passthrough. Opt out with
`GH_ROUTER_DISABLE_SHIM_TOOL_STEERING=1`.

The block is a strong preference, not a Bash ban. Dedicated `Read`, `Edit`, `Write`,
`Grep`, and `Glob` tools handle file operations; Bash remains appropriate for builds,
tests, git, package managers, and other commands with no dedicated tool.

## Current A/B method

The harness is `scripts/eval-shim-tool-guidance.ts`. It sends the same
non-streaming `POST /v1/messages` body to two otherwise-identical proxy instances:

- **ON:** normal shim behavior, with `FILE_TOOL_GUIDANCE` enabled.
- **OFF:** `GH_ROUTER_DISABLE_SHIM_TOOL_STEERING=1` on the proxy process.

The body has the exact stable system-prompt fixture and six minimal Claude Code-shaped
tools: `Read`, `Edit`, `Write`, `Grep`, `Glob`, and `Bash`. Each task asks for only
the first tool call. The harness never executes a proposed call. It records model,
task, arm, repetition, HTTP status, first tool, Bash command, valid/invalid/missing
tool-call status, latency, and returned input/output/cache usage fields. The request and
system-prompt SHA-256 values make arm equality auditable.

The seven tasks cover reading a file, searching a symbol, replacing text, appending a
line, creating a file, counting lines, and a legitimate Bash typecheck. The first three
file-changing tasks are mutation-prone strata. Bash classification recognizes shell
redirection, `sed -i`, Python file writes, PowerShell `Set-Content`/`Add-Content`,
mutating file commands, and mutating git commands, while allowing build/test/typecheck
and read-only git control. Commands are classified only and never run.

The harness randomizes a deterministic schedule from `GH_ROUTER_SHIM_GUIDANCE_SEED`.
The default is three repetitions, or 168 calls for the four default models. Runs over
100 calls require an additional explicit confirmation variable. The current run used
one repetition, seed `2026-08-27`, and 56 calls, as authorized for this bounded check.

## Current run results

Run artifact: `shim-guidance-eval-reps1.json` (generated locally, then removed from
this source tree; the harness writes a machine-readable artifact to
`GH_ROUTER_SHIM_GUIDANCE_OUTPUT` or a temporary path). Every call returned HTTP 200. `—` means no tool call was present in the successful
Anthropic message; `invalid` means a tool block was present but its arguments were not
usable. Latencies are milliseconds to the complete non-streaming response.

| model | task | ON first tool / ms | OFF first tool / ms |
|---|---|---:|---:|
| `gpt-5.6-sol` | read file | `Read` / 2300 | `Read` / 1656 |
| `gpt-5.6-sol` | search symbol | `Grep` / 2143 | `Grep` / 3227 |
| `gpt-5.6-sol` | replace text | `Edit` / 3124 | `Edit` / 2327 |
| `gpt-5.6-sol` | append line | `Read` / 2494 | `Bash` file-mutation / 5274 |
| `gpt-5.6-sol` | create file | `Write` / 1876 | `Write` / 2470 |
| `gpt-5.6-sol` | count lines | `Bash` shell-read / 4248 | `Bash` shell-read / 2204 |
| `gpt-5.6-sol` | legitimate Bash control | `Bash` legitimate-control / 10753 | `Bash` legitimate-control / 6721 |
| `gpt-5.6-luna` | read file | `Read` / 5152 | `Read` / 4337 |
| `gpt-5.6-luna` | search symbol | `Grep` / 7956 | `Grep` / 3805 |
| `gpt-5.6-luna` | replace text | `Edit` / 4418 | `Edit` / 4955 |
| `gpt-5.6-luna` | append line | `—` / 6060 | `Bash` invalid / 5866 |
| `gpt-5.6-luna` | create file | `—` / 6633 | `Write` / 11953 |
| `gpt-5.6-luna` | count lines | `—` / 5861 | `Read` / 4754 |
| `gpt-5.6-luna` | legitimate Bash control | `—` / 6210 | `—` / 7051 |
| `gemini-3.7-flash` | read file | `Read` / 3345 | `Read` / 2940 |
| `gemini-3.7-flash` | search symbol | `Grep` / 4078 | `Grep` / 3892 |
| `gemini-3.7-flash` | replace text | `Edit` / 7985 | `Edit` / 5365 |
| `gemini-3.7-flash` | append line | `Read` / 5639 | `—` / 13940 |
| `gemini-3.7-flash` | create file | `Write` / 3781 | `Write` / 4929 |
| `gemini-3.7-flash` | count lines | `Read` / 4473 | `Read` / 5971 |
| `gemini-3.7-flash` | legitimate Bash control | `Read` / 5814 | `Read` / 5046 |
| `grok-4.6` | read file | `Read` / 4378 | `Read` / 2509 |
| `grok-4.6` | search symbol | `Grep` / 5276 | `Grep` / 3594 |
| `grok-4.6` | replace text | `Edit` / 4280 | `Edit` / 5980 |
| `grok-4.6` | append line | `Read` / 12822 | `Bash` file-mutation / 10654 |
| `grok-4.6` | create file | `Write` / 2992 | `Write` / 5613 |
| `grok-4.6` | count lines | `Read` / 5007 | `Read` / 4972 |
| `grok-4.6` | legitimate Bash control | `Read` / 9663 | `Read` / 6418 |

### Rollup

| model | ON valid / invalid / missing | OFF valid / invalid / missing | ON preferred | OFF preferred | ON unsafe mutation | OFF unsafe mutation |
|---|---:|---:|---:|---:|---:|---:|
| `gpt-5.6-sol` | 7 / 0 / 0 | 7 / 0 / 0 | 5/7 | 4/7 | 0/3 | 1/3 |
| `gpt-5.6-luna` | 3 / 0 / 4 | 5 / 1 / 1 | 2/3 | 4/5 | 0/3 | 0/3 |
| `gemini-3.7-flash` | 7 / 0 / 0 | 6 / 0 / 1 | 5/7 | 4/6 | 0/3 | 0/3 |
| `grok-4.6` | 7 / 0 / 0 | 7 / 0 / 0 | 5/7 | 4/7 | 0/3 | 1/3 |
| **aggregate** | **24 / 0 / 4** | **25 / 1 / 2** | **17/24** | **16/25** | **0/12** | **2/12** |

The two raw OFF mutation observations were both in the append-line task: Sol
proposed a Python append script, and Grok proposed
`echo "shim-eval-marker" >> tmp/eval-target.txt`. Neither ON arm proposed a
classified file mutation. Applying the current conservative scorer to the retained
records yields 9 complete comparable mutation pairs and 3 incomplete or invalid
pairs: raw classifiable mutations are `0/9` ON versus `2/9` OFF, but the overall
recommendation is **inconclusive** because the 3 unknown pairs are reported rather
than treated as safe. The displayed pre-hardening `0/12` versus `2/12` counts are
raw per-arm observations, not a causal denominator. Preferred-tool counts likewise
exclude invalid/missing calls; safety scoring requires complete valid ON/OFF pairs with
equal request hashes.

The current harness does not start or own proxy processes. For the recorded run, the
operator started the two instances externally and stopped them after the 56 requests;
future runs must do the same unless process ownership is added explicitly.

The harness caps response bodies at 1,000,000 bytes, Bash commands at 8,000
characters, tool names at 256 characters, and stored previews at 1,000 characters.
Responses over the cap are explicit errors and never enter a valid-tool or mutation
verdict. Tool names and every returned tool input are checked against the six declared
schemas; unknown or malformed calls are invalid, not successful tool choices. Bash
shapes outside the known mutation, control, and read/search classes are
`unclassifiable` and excluded from the safety denominator. The scorer also records
request-body hash mismatches and refuses to compare mismatched pairs.

The recorded table predates these conservative parser/scorer hardening changes. Re-run
the harness when updated paired evidence is required; do not treat the historical raw
rollup as the new scorer's `mutationEffect` result. The exact 56-call output was
retained only as local evidence and removed from the source tree after this note was
updated. The harness writes `mutationEffect`, `requestBodyHashMismatches`, response
byte/truncation metadata, and all result records to its configured JSON artifact.

The current source-tree run used externally started proxies; the harness did not stop
those processes itself.

No production prompt code changed as a result of this run. No narrow additional clause
was tested or earned an A/B gate, so none is recommended.

No production prompt code changed as a result of this run. No narrow additional clause
was tested or earned an A/B gate, so none is recommended.

## Historical results (2026-08-05)

The earlier bounded run used two models and five tools (`Read`, `Edit`, `Write`, `Grep`,
`Bash`) with a Claude Code-shaped prompt. Round 1 (read a field; grep for a symbol)
was non-discriminating: both models called `Read` and `Grep` correctly in all four
cells, steering on or off.

Round 2, first tool called:

| task | gpt-5.6-sol ON | gpt-5.6-sol OFF | gemini-3.1-pro ON | gemini-3.1-pro OFF |
|---|---|---|---|---|
| replace a word in a file | `Read` | `Read` | `Read` | `Read` |
| **append a line to a file** | **`Read`** | **`Bash printf … >>`** | **`Read`** | **`Bash echo … >>`** |
| count lines in a file | `Read` | `Read` | `Bash wc -l` | `Bash wc -l` |
| create a file with content | `Write` | `Write` | `Bash mkdir -p` | `Bash mkdir && echo -n >` |

The historical findings remain useful but were n=1-ish and used older model/profile
coverage. They found the same qualitative append mutation: ON selected `Read`, while
OFF selected shell file mutation for both models. Gemini preferred `Bash wc -l` for
counting in both arms. Every observed tool block had valid parameter names and no
refusal or unavailable-capability artifact.

## Codex prompt comparison

The comparison source is the pinned open-source Codex revision
[`6c59264b14b963d45d1005e7a8b1de87d4b054e2`](https://github.com/openai/codex/tree/6c59264b14b963d45d1005e7a8b1de87d4b054e2),
principally `codex-rs/protocol/src/prompts/base_instructions/default.md` and the
repository-level `AGENTS.md`. This is a functional-clause audit, not a prose-copy
exercise.

### Duplicate generic clauses

The pinned Codex material says to inspect existing abstractions and affected surfaces,
keep APIs narrow, run targeted tests, preserve platform support, and keep model-visible
context bounded. Those are already covered by this repository's `CLAUDE.md`, the
existing `FILE_TOOL_GUIDANCE`, and the harness's first-call-only measurement contract.
Copying them into the shim would duplicate a mutable repository policy and add no A/B
testable hypothesis. No duplicate clause was adopted.

### Clauses explicitly rejected

- **Codex identity:** the Codex CLI persona and OpenAI/Codex identity do not belong in a Claude Code-shaped prompt.
- **Codex tool names:** `apply_patch` and Codex function-call escalation are not available; this harness has `Edit` and `Write`.
- **Repository guidance:** `AGENTS.md` discovery is Codex-specific here; the project uses `CLAUDE.md`, and the harness does not need to rediscover it.
- **Sandbox and approval:** Codex's `CODEX_SANDBOX_*`, Seatbelt, command approval, and full-suite approval clauses describe a different execution policy. This harness does not execute model commands and must not imply a sandbox or approval contract that the proxy does not provide.
- **Preamble and planning:** Codex's preamble/progress and `update_plan` conventions are not first-tool behavior and are not added to the stable shim prompt.
- **Codex repository internals:** Rust crates, `just`, Bazel, Ratatui/TUI, Codex app-server protocol, rollout/resume, and Codex-specific test helpers are not portable to this project.

No Codex clause was adopted without A/B evidence. The current evidence supports the
single file-tool preference block only; it does not support an identity correction,
per-model fork, or broader Codex prompt transplant.

## Recommendation

Leave prompt handling as it is. The evidence supports one tool-presence-gated block
that reduces the failure mode that corrupts work, namely writing files through shell
commands. Read-only tool preferences, missing first calls, and model self-description
are residual observations, not evidence for a new production clause. Any future
identity correction should be a single factual shim-path line, not a per-model prompt
fork, and should first pass a preregistered A/B task battery.

## Reproducing

Build the proxy first:

```bash
bun run build
```

Start two otherwise-identical instances on separate ports. Disable unrelated
background work for a clean measurement, and set the steering opt-out only on the OFF
instance:

```bash
GH_ROUTER_DISABLE_TOOLBELT=1 GH_ROUTER_DISABLE_SEMANTIC_SEARCH=1 \
GH_ROUTER_DISABLE_KEEP_AWAKE=1 GH_ROUTER_DISABLE_BROWSER_PROVISION=1 \
GH_ROUTER_NO_SELF_UPDATE=1 bun dist/main.js start --port 8787 --no-self-update

GH_ROUTER_DISABLE_SHIM_TOOL_STEERING=1 GH_ROUTER_DISABLE_TOOLBELT=1 \
GH_ROUTER_DISABLE_SEMANTIC_SEARCH=1 GH_ROUTER_DISABLE_KEEP_AWAKE=1 \
GH_ROUTER_DISABLE_BROWSER_PROVISION=1 GH_ROUTER_NO_SELF_UPDATE=1 \
bun dist/main.js start --port 8788 --no-self-update
```

Then run one bounded repetition:

```bash
GH_ROUTER_RUN_SHIM_GUIDANCE_EVAL=1 GH_ROUTER_SHIM_GUIDANCE_REPS=1 \
GH_ROUTER_SHIM_GUIDANCE_ON_BASE_URL=http://127.0.0.1:8787 \
GH_ROUTER_SHIM_GUIDANCE_OFF_BASE_URL=http://127.0.0.1:8788 \
bun scripts/eval-shim-tool-guidance.ts
```

The default three-repetition battery is 168 calls and requires the explicit
`GH_ROUTER_SHIM_GUIDANCE_CONFIRM_OVER_100=I_UNDERSTAND_REAL_SPEND` confirmation.
Warn the operator before any live run. Use `--self-test` with the gate for a
no-network parser/classifier/schedule check.

For the recorded run, the operator stopped both externally started proxy instances
after all 56 calls. The harness did not execute any model-proposed command.
