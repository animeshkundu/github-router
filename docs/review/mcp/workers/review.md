# Review: `mcp__workers__review`

> Per-tool audit of the model-facing surface github-router auto-injects. One doc per injected MCP tool.
> Reviewer: meta subagent. Fill every section. Cite `file:line`. Verify claims against code, do not assert.

## 1. Identity

| Field | Value |
|---|---|
| MCP path | `mcp__workers__review` |
| Group / server | `workers` (serverInfo `github-router-workers`) |
| Wire tool name | `review` |
| Definition | `src/lib/peer-mcp-personas.ts:1366` (entry) / handler `:1447` → `runWorkerToolCall({mode:"review"})` `:2134` |
| Always-on? | gated by capability `worker` |
| Capability gate | `worker` → `workerToolsEnabled()` (`src/lib/mcp-capabilities.ts:99`) |
| Backing model / endpoint | `gemini-3.1-pro-preview` (`REVIEW_DEFAULT_MODEL`, `src/lib/worker-agent/engine.ts:160`), `xhigh` clamped to `high`; Google `/chat/completions` |
| Write-capable | no (read-only; same tool surface as `explore`) |

Dual surface: the MCP tool `description` AND the `worker-review` background dispatcher subagent (`src/lib/worker-dispatch.ts:210` description, `:226` prompt). The main-agent PreToolUse guard (`worker-dispatch.ts:196`) denies a direct `mcp__workers__review` call from the lead and redirects it into the `worker-review` dispatcher, so the model-facing entry point is the subagent, not the raw tool.

## 2. Injected surfaces (verbatim)

### 2a. Tool `description` (shown in `tools/list`)

> `src/lib/peer-mcp-personas.ts:1370-1387`:

"Runs as the background `worker-review` agent. Dispatch via the Agent tool (subagent_type: worker-review) so your turn is never blocked; the result arrives as a completion notification. Read-only code review by an autonomous worker (Pi runtime; default model `gpt-5.5` at xhigh reasoning, override via `model` with any Copilot-catalog model that advertises `tool_calls`). Same read-only toolset as `explore` (read, glob, grep, code_search, web_search, fetch_url, advisor, update_plan, toolbelt) — it CANNOT edit — but the worker is framed as a reviewer: it verifies correctness against the actual code itself rather than trusting a claim, and reports findings (bugs, edge cases, security / concurrency / resource risks, missing handling) with a severity and `file:line`. Brief it with the change / diff / claim to verify (paste it, or name the files) — it reads the code to confirm, so you get a self-verifying second opinion that doesn't depend on you having pre-extracted the relevant code. Unlike the `peers` critics (single stateless model calls on the artifact you paste), this worker can navigate the repo to check surrounding context for itself."

Input schema (`:1388-1437`, `required: ["prompt"]`, `additionalProperties: false`):

- `prompt` (string): "What to review / verify — a diff, a claim about the code, or a file / function to audit. The worker reads the relevant code itself and reports findings; it does not need the code pre-pasted, but pasting the diff helps."
- `model` (string): "Optional Copilot catalog model id (defaults to gpt-5.5). Must advertise tool_calls support; the engine emits an isError envelope listing the eligible catalog models on mismatch."
- `thinking` (enum `off|minimal|low|medium|high|xhigh`): "Optional reasoning depth (default high). Silently clamped to the model's allowed range; \"off\" drops the parameter entirely."
- `workspace` (string): "Optional absolute path to the workspace the worker operates in. Defaults to the proxy's launch cwd. Use this when the parent agent has multiple workspaces open and the worker must operate in a specific one. Must be absolute (relative paths rejected)."
- `maxWallClockMs` (integer): "Optional per-call wall-clock budget in ms; default 6h (21600000). Clamped just under the MCP tool-call ceiling (the injected MCP tool-call timeout minus a 15-min teardown headroom) so the worker aborts gracefully with its partial work rather than being hard-killed; the effective value is reported in the result when a larger value is clamped down."

Dispatcher subagent description (`src/lib/worker-dispatch.ts:210` + `:218-221`):

"Non-blocking `review` worker: dispatches a read-only reviewer that reads the code itself to verify a change or claim, in the background, and delivers findings as a completion notification. Use proactively for any review-mode worker task so a long run never blocks your turn: it returns immediately and notifies you when done."

### 2b. System prompt (`--append-system-prompt`)

> `buildPeerAwarenessSnippet` (`src/lib/peer-mcp-personas.ts:598-601`), the worker sentence, verbatim:

"`worker-*` are background Agent subagents (subagent_type) that run the matching worker in its own context and deliver the result as a completion notification, so a long run never blocks the turn: `worker-explore` (read-only research), **`worker-review` (reads the code to verify a change or claim)**, `worker-plan` (ordered implementation plan), `worker-implement` (edit/write/bash; `worktree: true` isolates in a git worktree and returns the diff), `worker-test` (independent test author). The raw `mcp__${workersKey}__*` tools they call are guarded (a direct main-thread call is redirected to the matching agent); Workers themselves have `code_search`."

The snippet names `worker-review` but attaches NO model claim to it — correct, and it dodges the drift in 2a. The dispatcher subagent's own system prompt (`dispatcherPrompt`, `worker-dispatch.ts:226-253`) is a thin "call the tool once, relay verbatim" body with no model or role content of its own; the reviewer role framing lives entirely in the worker engine (`systemPromptFor("review")`, see 3d).

### 2c. CLAUDE.md (mirrored `<CLAUDE_CONFIG_DIR>/CLAUDE.md`)

Covered by the **peer-awareness** marker block, which is the SAME text as 2b — `appendPeerAwarenessToMirroredClaudeMd(peerSnippet)` writes the identical `buildPeerAwarenessSnippet` output into the mirror (`src/claude.ts:1019-1042`). So the mirrored CLAUDE.md names `worker-review` with the same accurate one-liner and no model claim.

Checked-in repo `CLAUDE.md:133` ("worker tools" section) documents review correctly and AGREES with the code: "read-only `review` → `REVIEW_DEFAULT_MODEL` = `gemini-3.1-pro-preview` at `xhigh` (clamped to `high` — gemini has no xhigh; a cross-lab reviewer deliberately decorrelated from the gpt-5.5 implementer/`implement` worker + the Opus orchestrator, for blind-spot diversity)" and "**`review` is a third worker mode** … the SAME read-only tool surface as `explore` … but `systemPromptFor("review")` adds a one-line reviewer ROLE frame". This is the authoritative, code-matching description of the tool.

## 3. Assessment

### 3a. Description quality

- **Clarity & routing signal**: strong. The description tells the model when to use it (verify a change / diff / claim, get a self-verifying second opinion) and, critically, when it is DIFFERENT from a neighbor: "Unlike the `peers` critics (single stateless model calls on the artifact you paste), this worker can navigate the repo to check surrounding context for itself." That is the correct differentiation from the stateless `codex_reviewer` / `gemini_reviewer` — a `peers` reviewer only sees the pasted artifact, this worker reads the repo. Read-only is stated ("it CANNOT edit"), steering write work to `implement`.
- **Accuracy vs implementation**: two stale facts. (1) The description names the default model as `gpt-5.5` in TWO places (`:1373` and the `model` field `:1404`), but the engine default is `gemini-3.1-pro-preview` (`REVIEW_DEFAULT_MODEL`, `engine.ts:160`, selected at `:326-327`). (2) The `thinking` field says "default high" (`:1413`), but the raw default is `xhigh` (`REVIEW_DEFAULT_THINKING`, `engine.ts:161`, `:338`); `high` is only the CLAMPED result for the default Gemini model (which advertises no xhigh). Both are cross-lab-relevant: a model reading "gpt-5.5" would assume the review runs on the SAME lab as its `implement` worker and the gpt-5.5 `implementer` subagent, defeating the deliberate cross-lab decorrelation that is the whole point of the review default (`engine.ts:148-160`).
- **Schema minimality**: all five fields pass the "ruthlessly minimal" bar. `prompt` (required) is the task. `model` / `thinking` are model-tunable overrides. `workspace` is actionable for multi-workspace parents. `maxWallClockMs` is a caller-set budget with an actionable clamp report. No echoed-input or diagnostic-only fields. `worktree` is correctly absent (review is read-only; the handler only reads `worktree` for `implement`/`test`, `peer-mcp-personas.ts:2198`).

### 3b. System-prompt coverage

- **Named**: yes, `worker-review` is named in the worker sentence (`:600`) with an accurate one-liner.
- **Accurate & non-redundant**: yes. "reads the code to verify a change or claim" is a faithful compression of the fuller description and does not duplicate it.
- **Framing-constraint compliance**: compliant. The snippet is pure capability description — no imperatives ("Lead with X"), no hedges, no anchors disguised as description. The workers-group descriptions are pinned only to CONTAIN `worker-<mode>` (`tests/peer-mcp-personas.test.ts:13-20`); the model string in 2a is NOT pinned by any test, which is why the `gpt-5.5` drift went uncaught.

### 3c. CLAUDE.md coverage

- **Injected block** (mirrored peer-awareness): accurate, non-redundant, not drifted — it is byte-identical to the system-prompt snippet and carries no model claim.
- **Checked-in root CLAUDE.md** (`:133`): accurate and agrees with `engine.ts`. It is the one surface that states the review default correctly (`gemini-3.1-pro-preview` at `xhigh` clamped to `high`), which makes the tool `description`'s `gpt-5.5` an isolated defect rather than a systemic one.

### 3d. Cross-surface consistency

The reviewer ROLE frame the description promises ("framed as a reviewer: it verifies correctness against the actual code") is really applied at runtime: `systemPromptFor("review")` prepends `REVIEW_ROLE` (`src/lib/worker-agent/prompts.ts:77`, `:83`, `:145`) — "You are reviewing code for correctness. Verify against the actual code by reading it — never assume. Report concrete findings … with a severity and a `file:line` citation; if nothing material is wrong, say so plainly rather than inventing issues." The tool surface and the runtime prompt are consistent on role, on read-only tools, and on the findings-with-severity contract.

The one contradiction is the model/thinking default: description ↔ `model` field say `gpt-5.5` / `high`, while engine + root CLAUDE.md say `gemini-3.1-pro-preview` / `xhigh`-clamped-to-`high`. docs/peer-mcp-design.md:365 sides with the stale description (`review gpt-5.5`), compounding the drift.

## 4. Findings

- **[Important]** `src/lib/peer-mcp-personas.ts:1373` and `:1404` name the review default model as `gpt-5.5`, but `REVIEW_DEFAULT_MODEL = "gemini-3.1-pro-preview"` (`engine.ts:160`, selected `:326-327`). This misroutes the model's cross-lab mental model — it would assume review shares the gpt-5.5 implementer's lab, silently defeating the deliberate Google-lab decorrelation (`engine.ts:148-160`). Fix: change both strings to `gemini-3.1-pro-preview` (Google, cross-lab reviewer). No repro of a rejected call, hence Important not Critical.
- **[Important]** `src/lib/peer-mcp-personas.ts:1413` says `thinking` "default high", but the raw default is `xhigh` (`REVIEW_DEFAULT_THINKING`, `engine.ts:161`, `:338`); `high` is only the clamped value for the default Gemini model. On an override to a model that advertises xhigh, the caller who read "default high" gets xhigh unexpectedly. Fix: "defaults to xhigh, silently clamped to the model's allowed range (the default review model clamps to high)."
- **[Suggestion resolved]** `docs/peer-mcp-design.md` now records review as `gemini-3.1-pro-preview` and explore as `gemini-3.6-flash` at high.
- **[Suggestion]** No test pins the review description's model string (`tests/peer-mcp-personas.test.ts:13-20` only asserts `.toContain("worker-review")`). Consider a `byName["...review"]?.description` assertion, or a shared constant referenced by both `engine.ts` and the description, so the model default can't silently drift again.

## 5. Verdict

**N** — routing, differentiation, minimality, and the runtime role frame are all correct, but the tool `description` and `model` schema field name the WRONG default model (`gpt-5.5` instead of `gemini-3.1-pro-preview`), which corrupts the model's cross-lab reasoning. Single most important fix: correct both `gpt-5.5` mentions at `peer-mcp-personas.ts:1373,1404` to `gemini-3.1-pro-preview`.
