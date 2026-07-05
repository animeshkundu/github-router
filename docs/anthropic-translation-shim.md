# Anthropic-translation shim — non-Claude models on `/v1/messages`

> Status: **shipped.** Lets Claude Code (and any Anthropic `/v1/messages` client)
> run its MAIN agent loop on non-Claude models served by Copilot, by translating
> the Anthropic Messages wire format to/from Copilot's `/responses` and
> `/chat/completions` endpoints. This document describes the implementation in
> `src/lib/anthropic-translate/` today.

See [`../CLAUDE.md`](../CLAUDE.md) for the project overview,
[`default-models.md`](default-models.md) for Claude-model selection and slug
translation, and [`claude-env-injection.md`](claude-env-injection.md) for the
`CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY` gate this feature now conditionally
enables.

## Purpose

Copilot serves Claude models on its native Anthropic `/v1/messages` endpoint, but
a `gpt-*` or `gemini-*` request sent to `/v1/messages` returns a 4xx. Claude Code
speaks only the Anthropic Messages wire format, so without a shim its main loop
could never run on a non-Claude Copilot model. The shim closes that gap: it
translates an incoming Anthropic Messages request into the OpenAI-shaped request
the target model actually serves, calls the existing streaming Copilot client,
and translates the response back to the Anthropic Messages shape — streaming or
non-streaming, tools and all.

There are two independent gates, and both must be satisfied for a non-Claude
model to run a Claude Code session end-to-end:

1. **Selection gate (client side)** — Claude Code has to let the user *pick* a
   non-Claude id. Phase 3 makes the four target models appear as first-class rows
   in Claude Code's `/model` picker by pre-seeding its gateway-model discovery
   cache (see [Phase 3](#phase-3-native-model-selection-gateway-cache-seed)).
   Any explicit selection (`github-router claude -m <id>`) also works without the
   picker.
2. **Serving gate (proxy side)** — once the request arrives at `/v1/messages`
   carrying a non-Claude model, the shim translates it. This is the bulk of the
   design below.

## Target models

Live-verified working end-to-end against real Copilot:

| Model | Served via | Notes |
|---|---|---|
| `gpt-5.5` | `/responses` | 1M context on the base slug |
| `gpt-5.3-codex` | `/responses` | 400k context (see [Model gaps](#model-gaps-inherent-copilot-limits)) |
| `gemini-3.5-flash` | `/chat/completions` | |
| `gemini-3.1-pro-preview` | `/chat/completions` | preview slug — NOT `gemini-3.1-pro` |

The routing is derived from each model's catalog `supported_endpoints`, never a
hardcoded slug list, so it generalizes to any future non-Claude model Copilot
serves via one of those two endpoints.

## Architecture

```
POST /v1/messages
   │
   ▼
resolveModelInBody ──► modelId (+ catalog entry, + original request id)
   │
   ▼
classifyMessagesRoute(modelId, model, originalModelId)
   │
   ├─ "claude-passthrough" ─► createMessages  (EXISTING native path, byte-for-byte unchanged)
   │
   ├─ "responses-shim" ─────► handleNonClaudeResponses
   │                              parseAnthropicRequest → neutral IR
   │                              parsedToResponsesPayload → /responses payload
   │                              createResponses(...)
   │                              synthAnthropicFromResponses / responsesResponseToAnthropicMessage
   │
   └─ "chat-shim" ──────────► handleNonClaudeChat
                                  parseAnthropicRequest → neutral IR
                                  parsedToChatPayload → /chat/completions payload
                                  createChatCompletions(...)
                                  synthAnthropicFromChat / chatResponseToAnthropicMessage
```

### Files

| File | Role |
|---|---|
| `src/lib/anthropic-translate/classifier.ts` | Routing decision: `classifyMessagesRoute` + `isClaudeModel` |
| `src/lib/anthropic-translate/anthropic-request.ts` | Anthropic Messages body → provider-neutral IR; `parsedToResponsesPayload` |
| `src/services/copilot/responses-request.ts` | The neutral IR types + `assembleResponsesPayload` (SHARED with the worker) |
| `src/lib/anthropic-translate/chat-request.ts` | neutral IR → `/chat/completions` payload |
| `src/lib/anthropic-translate/responses-egress.ts` | `/responses` object/SSE → Anthropic Messages object / synthesized Anthropic SSE |
| `src/lib/anthropic-translate/chat-egress.ts` | `/chat/completions` object/SSE → Anthropic Messages object / synthesized Anthropic SSE |
| `src/lib/anthropic-translate/anthropic-sse.ts` | Anthropic SSE frame builders + the Bun-safe pull-based `ReadableStream` adapter |
| `src/lib/anthropic-translate/index.ts` | Orchestrators `handleNonClaudeResponses` / `handleNonClaudeChat` |
| `src/lib/reasoning-effort.ts` | `bucketEffort` / `clampEffort` (shared with the `/v1/messages` adaptive-thinking translation) |

### The unified neutral IR

Both shim paths parse the Anthropic body into ONE provider-neutral shape
(`NeutralMessage[]` + `NeutralTool[]` + reasoning effort + max tokens + stop
sequences + parallel-tool signal), defined in `responses-request.ts`:

- `NeutralMessage` = `{role:"user", content: string | NeutralContentPart[]}` |
  `{role:"assistant", content: NeutralContentPart[]}` |
  `{role:"toolResult", toolCallId, output}`. Tool results are their own role
  (as in Copilot's Responses wire shape and Pi's message shape), never nested
  inside a user message.
- `NeutralContentPart` = `{type:"text"}` | `{type:"image", mimeType?/data?/url?}` |
  `{type:"toolCall", id, name, arguments}`.

`parseAnthropicRequest` (in `anthropic-request.ts`) is the single ingest for BOTH
paths; only the wire assembly differs afterward (`parsedToResponsesPayload` vs
`parsedToChatPayload`). Keeping the mapping in one place is deliberate: the
Responses assembler `assembleResponsesPayload` is **shared with the worker-agent
stream** (`src/lib/worker-agent/stream-fn.ts`), which feeds it the same neutral
shape converted from Pi `Context` messages. One assembler means the shim and the
worker can never drift on how a tool result, an image, or assistant text/tool-call
ordering is encoded on the wire.

Anthropic → neutral correspondence (both paths):

| Anthropic Messages | Neutral / wire |
|---|---|
| `system` (string or text-block array) | flattened to `instructions` (→ Responses `instructions` / chat `messages[0]` system) |
| user `text` / `image` blocks | user message with text / image parts |
| user `tool_result` block | its own `toolResult` message (→ Responses `function_call_output` / chat `role:"tool"`); images inside it can't ride in that item, so they're re-emitted as a follow-up user message in wire order |
| assistant `text` blocks | assistant text parts |
| assistant `tool_use` blocks | assistant `toolCall` parts (→ Responses `function_call` / chat `tool_calls[]`) |
| assistant `thinking` / `redacted_thinking` | **dropped** (not replayable as input to either endpoint) |
| `tools[] {name, input_schema}` | `tools[] {name, parameters}` |
| `tool_choice {auto\|any\|tool\|none}` | `auto` / `required` / forced-function / `none`; a name-less forced `tool` becomes unset (default applies) rather than silently downgrading to `auto` |
| `tool_choice.disable_parallel_tool_use: true` | `parallel_tool_calls: false` (only the disable — never sent as `true`) |
| `thinking {enabled, budget_tokens}` | `reasoning.effort` (bucketed, then clamped to the model allowlist) |
| `max_tokens` | Responses `max_output_tokens` / chat `max_tokens` |
| `stop_sequences` | `stop` (best-effort — honored on chat/gemini, accepted-but-ignored on Responses/gpt; see [Fields](#fields)) |

A `tool_result` that carried only an image emits a `"[image result below]"`
placeholder as its `function_call_output`/tool string (which must be non-empty)
and points the model at the follow-up user message that carries the pixels. An
`is_error: true` tool_result is prefixed `[tool error]` so the model still learns
the call failed.

### Reasoning effort

`thinking.budget_tokens` is bucketed by `bucketEffort` (`<2k→low`, `<8k→medium`,
`<24k→high`, else `xhigh`; a missing/non-numeric budget defaults to `high`) and
then `clampEffort`-ed to the model's `capabilities.supports.reasoning_effort`
allowlist, ties resolving to the lower tier. The clamp is why a Gemini request
asking for `xhigh` lands on `high` — Gemini's allowlist has no `xhigh`. `off` /
absent drops the reasoning field entirely.

### Egress: Responses vs Chat

The two egress modules translate the upstream response back to Anthropic. Each
has a non-streaming mapper (upstream object → one Anthropic Messages object) and
a streaming state machine (upstream SSE → an async generator of Anthropic stream
events). They differ in the correlation key and the "clean end" signal:

- **Responses** (`responses-egress.ts`): the tool/reasoning/text block key is the
  STABLE `output_index`, **never** the per-event `item_id` — Copilot re-encrypts
  `item_id` on every event, so an id key would make every delta lookup miss and
  tool args would drop to `{}`. (This mirrors the empirically-verified worker
  `/responses` decode in `stream-fn.ts`.) The clean-end signal is a terminal
  `response.completed` / `response.incomplete` event; `response.failed` throws.
- **Chat** (`chat-egress.ts`): the tool key is the OpenAI `tool_calls[].index`
  array index. The authoritative clean-end marker is the `[DONE]` sentinel —
  **not** `finish_reason`, because Copilot's Gemini path can omit a chunk-level
  `finish_reason` on an otherwise-clean stream.

Both surface a `stop_reason` with the same precedence: a truncated (max-output)
response is `max_tokens` even when a partial tool call is present; else a tool
call → `tool_use`; else `end_turn`.

**Truncation guard.** A stream that ends WITHOUT its terminal marker (a
`/responses` stream with no `completed`/`incomplete`/`failed`, or a chat stream
with no `[DONE]`) was cut mid-flight — the underlying event iterator returns-done
on a clean-but-premature EOF rather than throwing. The synthesizer THROWS in that
case rather than synthesizing a clean, successful `message_stop`; the stream
adapter converts the throw into a terminal Anthropic `event: error`.

### The Anthropic SSE emitter (`anthropic-sse.ts`)

The synthesizers stay pure state machines: they `yield` plain event objects. The
SSE module owns the wire shape (frame builders `makeMessageStart`,
`makeContentBlockStart/Stop`, `makeTextDelta`, `makeInputJsonDelta`,
`makeThinkingDelta`, `makeSignatureDelta`, `makeMessageDelta`, `makeMessageStop`)
and the stream lifecycle.

`anthropicSseStreamFromEvents(events, {routePath, onCancel})` wraps the generator
into a byte `ReadableStream` under this repo's mandatory stream-lifecycle
contract (see the "Stream lifecycle" review checklist in `CLAUDE.md`):

- **Pull-based** (backpressure-respecting) — one `events.next()` per `pull`.
- Guards **every** `controller.enqueue`/`controller.close` against the
  consumer-cancel race via `isControllerClosedError` (verified against Bun's
  `TypeError: Invalid state: Controller is already closed`).
- On a mid-stream generator throw it emits a terminal `event: error` frame before
  closing — mirroring `relayAnthropicStream`.
- On consumer cancel it calls `onCancel()` (which aborts the upstream fetch via a
  caller-owned `AbortController`) and `return()`s the generator so its `finally`
  tears down the upstream reader.

The upstream fetch uses a **caller-owned `AbortController`**, never
`c.req.raw.signal` — Bun aborts the request signal as soon as the request body is
consumed (see the "Bun request-signal quirk" note in `CLAUDE.md`), which would
kill the upstream call immediately. Non-streaming shim responses pass no signal
(the upstream completes regardless; there is no cancel hook for a buffered
response), consistent with the passthrough path.

### Handler branch + non-regression guarantee

The branch is a single decision in `src/routes/messages/handler.ts` (~L296-336):
after model resolution it computes `messagesRoute = classifyMessagesRoute(modelId,
selectedModel, originalModel)` exactly once.

- `claude-passthrough` → falls through to the EXISTING `createMessages`
  passthrough, **byte-for-byte unchanged** (default betas, thinking translation,
  ADVISOR loop, all untouched).
- `responses-shim` / `chat-shim` → dispatched to the shim.

Non-regression is **structural**, not "we were careful": the Claude path shares
no code with the shim beyond the branch, and the classifier is guard-tested to
keep every Claude model on the passthrough. ADVISOR (`advisor-tool` beta) plus a
non-Claude model is refused with a clear 400 — there is no server-side advisor
translate-loop for either shim path, so failing fast beats silently translating
the injected tool with no handler.

`classifyMessagesRoute` fails **CLOSED toward Claude**. `isClaudeModel` returns
true on any of: catalog vendor containing `anthropic`, capability family
containing `claude`, or a delimiter-bounded `claude`/`anthropic` segment
(`CLAUDE_ID_RE`) in ANY id it holds — the resolved id, the pre-resolution request
id, or the catalog entry's own id. This catches aliases like
`github/claude-3-7-sonnet` (vendor `github`, empty family) and guarantees a real
Claude request can never be diverted to the non-Claude shim, even if catalog
metadata (wrongly) advertised a `/responses` endpoint for a Claude model. A
non-Claude model absent from the catalog (endpoint unconfirmable) also stays on
the passthrough — the shim never diverts what it can't classify.

## The C1 streaming model: buffer tools, emit atomically

The load-bearing correctness property of both streaming synthesizers is how
tool-call blocks are emitted. **Every tool call's arguments are BUFFERED and its
Anthropic block is emitted ATOMICALLY** — `content_block_start` → a single
`input_json_delta` carrying the full assembled args → `content_block_stop` — at
that tool's OWN terminal, at its own distinct block index:

- **Responses**: the terminal is the tool's `output_item.done` (or an
  end-of-stream flush for a dangling item). The authoritative full arguments from
  `.done` / `function_call_arguments.done` OVERWRITE the accumulated deltas
  (Copilot can send a corrupted/partial delta stream).
- **Chat**: there is no per-tool `.done`, so args accumulate per array index and
  all buffered tools flush atomically at end-of-stream in numeric-index order.
  Malformed/truncated arg JSON degrades to `{}` via `parseToolArgs` rather than
  shipping bytes the client can't parse at `content_block_stop`.

Only an open TEXT or THINKING block is ever force-closed on a type switch; a
sibling tool block is never closed by another. Anthropic block indices are
assigned at emit time so they stay monotonic on the wire regardless of upstream
item interleaving.

**Why (the parallel-tool-args-lost bug).** Copilot's `/responses` emits *all*
`output_item.added` events for a batch of parallel tool calls BEFORE the first
`function_call_arguments.delta` of any of them. A naive synthesizer that opened
and emitted a tool block at `added` time would ship it with empty args and then
have nowhere to put the later deltas — every parallel tool after the first would
lose its arguments. Buffering per stable key and emitting at the per-tool terminal
is what makes parallel/interleaved tool calls each keep their full args at
distinct block indices. The chat path carries the same lesson forward (parallel
tools keep distinct indices, never clobbering a shared pointer).

## Contract dependency + deferred latent items

The egress correctness above rests on a **contract with Copilot's stream
ordering**: within a single output item, upstream events arrive sequentially, and
the ONLY batching that occurs is the parallel-tool `output_item.added` burst that
C1 explicitly handles. Concretely, the synthesizer assumes it will see a text
item's deltas, then its `done`; a reasoning item's deltas, then its `done`
(carrying the encrypted signature); a tool item's `added`, its arg deltas, then
its `done` — in that per-item order.

If Copilot ever violated that ordering — e.g. interleaving a second item's events
between a text item's last delta and its `done`, or delivering a reasoning item's
`encrypted_content` after its block was already closed by a type switch — a
**text-tail or a reasoning `signature_delta` could be silently lost** (the block
would already be closed, and the emitter cannot retract or reopen a closed block
on a streamed protocol). Two independent labs reviewed this and confirmed it is
contract-gated and does **not** occur against Copilot today; the buffered-tool
design already neutralizes the one batching case that does occur.

**Blast radius** if the contract were violated: a dropped text suffix or a missing
`thinking` signature on affected turns — a content-fidelity regression, not a
crash or a lifecycle/leak bug (the stream still terminates cleanly). The empirical
backstop is the Phase 5 live end-to-end suite that exercises the four target
models against real Copilot, which is where a real-world ordering change would
surface.

## Fields

- **`stop_sequences` → `stop` (best-effort).** Forwarded to both endpoints
  (`assembleResponsesPayload` sets `payload.stop`; `parsedToChatPayload` sets
  `payload.stop`). Both endpoints ACCEPT the field without a 400 (live-verified
  HTTP 200), but they don't honor it equally: `/chat/completions` (the Gemini
  path) genuinely honors `stop` and truncates generation at the sequence, while
  `/responses` (the gpt path) accepts the field but **silently ignores** it (gpt
  output was observed not truncating at the stop sequence) — a Copilot
  Responses-API limitation, not a shim bug. Forwarding is still the right call:
  nothing 400s, the chat path works, and it's low-impact because Claude Code
  rarely sends `stop_sequences`. Do not rely on stop-sequence truncation on the
  gpt path.
- **`tool_choice.disable_parallel_tool_use: true` → `parallel_tool_calls: false`.**
  Forwarded to both endpoints, and ONLY as `false` (the disable signal); when the
  flag is absent the field is omitted entirely — the shim never sends
  `parallel_tool_calls: true`. Copilot accepts the field on both endpoints
  (live-verified HTTP 200).
- Both fields are **omitted-by-default** on the shared assembler, so the
  worker-agent hot path (which never sets them) produces a byte-identical payload
  to before.
- **`max_output_tokens` is clamped UP to 16 on the `/responses` path.** Copilot's
  `/responses` hard-requires `max_output_tokens >= 16` (a positive sub-16 value
  400s: `Invalid 'max_output_tokens': integer below minimum value. Expected a
  value >= 16, but got 1 instead.` — verified live on gpt-5.5 and gpt-5.3-codex),
  whereas Anthropic's `/v1/messages` allows any `max_tokens >= 1`. So the shim
  raises a sub-16 `max_tokens` (`1..15`) up to `16`
  (`RESPONSES_MIN_MAX_OUTPUT_TOKENS` in `responses-request.ts`); `>= 16` and
  `undefined` pass through untouched. **Rationale:** avoid a 400 on an
  otherwise-valid low request; Claude Code never sends `< 16` in practice.
  **Trade-off:** for a `max_tokens: 1..15` request the model may emit up to 16
  tokens, so Anthropic's "at most N" upper bound is not strictly honored below 16
  — a small possible over-run vs the client's cap. This applies ONLY to the
  `/responses` path (gpt); the `/chat/completions` path (gemini) has no such
  minimum and forwards `max_tokens` verbatim (Copilot accepts small values,
  live-verified HTTP 200), so chat/gemini are unaffected.
- **Streaming usage rides the terminal chunk.** Copilot emits token usage on the
  stream unprompted (no `stream_options.include_usage` needed — live-verified):
  the `/responses` synthesizer reads it off `response.completed` /
  `response.incomplete`, and the chat synthesizer max-accumulates it from any
  chunk (typically the trailing `choices`-empty frame). Usage is reported to the
  client in the final `message_delta` (input/output/cache-read tokens).

## Model gaps (inherent Copilot limits, not shim bugs)

These are properties of the upstream models as Copilot serves them, surfaced
honestly rather than papered over:

- **Gemini has no `xhigh` reasoning tier.** A thinking budget that buckets to
  `xhigh` clamps down to `high` via the model's `reasoning_effort` allowlist. This
  is a clamp, not a shim failure.
- **Gemini has no `structured_outputs`.** The chat path never emits
  `response_format` / a JSON schema; neither Gemini model advertises the
  capability, and the neutral IR carries no structured-output info anyway (the
  handler strips `output_config` before the shim is reached).
- **`gpt-5.3-codex` is a 400k-context model, not 1M.** Its window is smaller than
  `gpt-5.5`'s; plan long sessions accordingly.
- **PDFs / `document` blocks work on the gpt/`/responses` path, not gemini/`/chat`.** An
  Anthropic base64 or URL `document` block maps to a Responses `input_file` (base64 →
  `file_data` data URI, verified: gpt-5.5 reads the PDF) — but Copilot's
  `/chat/completions` rejects file content parts (HTTP 400), so on the Gemini path a
  document degrades to a brief newline-delimited inline text note (`[document "<name>"
  attached but not supported for this model]`) rather than being dropped or 400ing.
  Text/content-source documents are folded into a text part and work on both paths.
  **Verification caveat:** the base64 `document` → `input_file.file_data` mapping is
  LIVE-verified (gpt-5.5 reads the PDF); the URL-source `document` → `input_file.file_url`
  mapping is UNIT-tested only, not live-verified against Copilot.
- **The "1M variant" is a misconception for these models.** Unlike Opus (whose 1M
  context is unlocked via a separate `[1m]`-decorated slug on enterprise tiers),
  the 1M window for `gpt-5.5` and the Gemini models is **native to the base
  slug** — there is no `-1m` sibling to select, and none is needed.

## Phase 3: native model selection (gateway cache-seed)

Phase 3 (`src/lib/server-setup.ts`) makes the four target models selectable in
Claude Code's `/model` picker WITHOUT a network round-trip and without touching
the Claude tier defaults.

**Mechanism** (verified against installed Claude Code 2.1.201). The only Claude
Code env lever that adds MORE THAN ONE selectable picker row is gateway model
discovery. Its picker builder reads a cache file at
`<CLAUDE_CONFIG_DIR>/cache/gateway-models.json` (schema
`{baseUrl: string, fetchedAt: number, models: [{id, display_name?}]}`) and, when
discovery is enabled and the base URL is non-`api.anthropic.com` (both true for
the proxy), maps each cached model to a picker row. Critically:

- The cache-**READ** path applies **NO id filter** — the `/^(claude|anthropic)/i`
  filter lives ONLY on the network-**FETCH** path. So a pre-seeded cache can carry
  the real Copilot ids (`gpt-5.5`, `gemini-3.1-pro-preview`, …) directly; no
  `claude-*` alias and no `/v1/models` normalization is needed. Selecting a row
  sends that real id, which `resolveModel` exact-matches and the shim routes.
- The read path **APPENDS** these rows; it does not replace the opus/sonnet/haiku
  tier rows (seeded via `ANTHROPIC_DEFAULT_*` / `ANTHROPIC_MODEL` /
  `ANTHROPIC_SMALL_FAST_MODEL`), which stay untouched.

So Phase 3 (1) writes the seed via `seedGatewayModelCache` (atomic temp-file +
rename, so a concurrent Claude Code read never sees torn JSON) and (2) enables
`CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY`. The enable is conditional and
presence-guarded:

- Only the subset of the four models actually present in the live Copilot catalog
  is seeded (`nativeSelectableModelsInCatalog`) — license tiers differ, so a
  missing model is silently dropped and lesser tiers see the unchanged picker.
- Discovery is turned on ONLY when the seed actually landed AND neither the parent
  env nor the in-function `vars` already set the key (a user value always wins).
- When no target is in the catalog, any prior seed is removed
  (`clearGatewayModelCache`) so a user-pinned discovery flag can't surface stale
  rows.

**Why this is safe** (and why the network-fetch path is still NOT trusted). The
historical reason discovery was left off is that its network fetch would discover
Copilot's dotted `claude-*` slugs, which don't match Claude Code's dashed
capability registry and would silently degrade advanced tool use. Phase 3 doesn't
change that verdict: the network fetch is **permanently blocked** here (the proxy
always sets `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`, and the fetch never reads
the synthetic OAuth credential), so it can never overwrite the seed. The seed is
authoritative for the session, and it contains ONLY these four non-Claude ids. The
capability-mapping hazard lived entirely on the fetch path, which stays closed.

**Display labels only / context accounting.** The cache schema is `{id,
display_name?}` per model — there is no per-model context-window field, so a
selected row uses Claude Code's default context window. This is safe
under-accounting: it compacts earlier than the real 1M/400k window, never
overflows it.

**Version-coupling caveat.** The cache path and schema are Claude Code internals,
verified against build 2.1.201. This is graceful-degradation-coupled: if a future
Claude Code build changes the cache path or schema, the seed is simply ignored and
the picker rows don't appear — the models still work via explicit selection
(`github-router claude -m <id>`), and nothing breaks. Every failure in the seed
path is swallowed; a missing picker row must never break launch.
