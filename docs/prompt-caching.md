# Prompt caching

github-router preserves caller-owned cache controls and adds mechanisms
designed to avoid unnecessary cache invalidation. Whether these mechanisms
produce a measurable cost benefit against Copilot is tracked separately by a
live evidence harness described below; this document describes the mechanism
and its honest limits, not a universal measured result.

| Provider / route | Router behavior |
|---|---|
| Claude `/v1/messages` passthrough | Preserve caller `cache_control` placement. Never rewrite a caller policy. Entirely caller-controlled; the router adds nothing here, and its effect (if any) is measured separately, not assumed. |
| Router-owned Claude calls | For a stable prefix at or above a conservative byte floor, mark the last non-deferred tool and/or the stable system boundary — each eligibility check is independent (see below). Hard maximum: two markers, well under Anthropic's own four-marker-per-request ceiling. |
| GPT-5.6 `/responses` REUSABLE-PREFIX calls (peer/advisor/worker-tool/browser-compressor prefixes reused verbatim across many discrete calls) | Use explicit mode with a stable system breakpoint, opaque hashed key, and 30-minute TTL. |
| GPT-5.6 `/responses` growing-conversation calls (translated Claude Code main loop, worker-agent loop) | Provider-managed automatic caching only — explicit mode is deliberately NOT applied here (see below). |
| GPT-5.5 / older GPT / Codex | Provider-managed automatic caching only. |
| Gemini Chat | Provider-managed automatic caching only. |
| Grok Responses | Provider-managed automatic caching only. |
| Public OpenAI-compatible routes | Caller-owned fields pass through; the router does not synthesize policy. |

GPT-5.6 explicit caching is applied ONLY to `"reusable-prefix"`-workload
calls: reusable peer/advisor prefixes, worker-tool calls, and
browser-compressor prefixes. It is omitted for short prefixes, one-shot
requests, and — see the next paragraph — every growing-conversation call.
Disable it with `GH_ROUTER_DISABLE_GPT56_EXPLICIT_CACHE=1`.

**`"conversation"` workload is UNCONDITIONALLY excluded from GPT-5.6 explicit
caching — a live-verified regression, not a design preference.** The
translated Claude Code main loop and the worker-agent loop both pass
`workload: "conversation"` for their (growing, multi-turn) message history.
Marking only the stable system block with an explicit breakpoint measured
substantially worse than leaving caching provider-managed and implicit:
explicit mode is a distinct caching
strategy from Copilot's provider-managed automatic caching, not an addition to
it, so turning it on for a request marks only the bytes an explicit
breakpoint names and the REST of that request's prefix — here, the entire
un-marked growing message history — stops receiving automatic prefix-growth
caching too. Measured on `gpt-6-sol` with explicit mode force-enabled for a
conversation workload: turn 1 (cold) `input_tokens=27038, cache_write=2031,
cache_read=0`; turn 2 `input_tokens=27054, cache_read=2031`; turn 3
`input_tokens=27071, cache_read=2031` — the ~2k-token system block cached once
and never grew, while the other ~25k tokens of accumulating history were
recomputed from scratch on every single turn. Conversation-workload calls now
rely entirely on Copilot's own provider-managed automatic caching, which (per
the fixed-prefix case in the row above) is not itself disabled by anything
this router does.

Router-owned Claude marking is limited to internal calls and can be disabled
with `GH_ROUTER_DISABLE_CLAUDE_CACHE_POLICY=1`. There used to be a third,
message-level marking path for a `"conversation"` workload; it was removed
because no production caller ever passed that workload to the Claude policy
(every call site passes `"reusable-prefix"`), so the path was unreachable dead
code rather than a feature anything exercised.

**Eligibility is a conservative byte guard, not a token count.** Both the
Claude and the GPT-5.6 Responses policies decide whether a prefix is "big
enough to mark" by comparing its UTF-8 byte length (never `.length`, which
counts UTF-16 code units and undercounts anything outside the BMP) against a
fixed floor. This is deliberately synchronous and does not tokenize: a real
tokenizer's chars/token ratio varies by content (CJK text carries more tokens
per byte than ASCII prose; a long run of a repeated character or whitespace
carries far fewer tokens per byte than either, since BPE merges long runs into
very few tokens), so no fixed byte threshold can guarantee the true token count
clears any given model's real per-model minimum for every possible input. The
floor is chosen so ordinary system prompts and tool schemas reliably qualify
while genuinely small prefixes never spend a marker for no benefit — it is not
a claim of token-level precision on the Claude or the Responses side. On the
Claude side, the tool breakpoint and the system breakpoint are checked
SEPARATELY (the tool breakpoint only caches the tools prefix; the system
breakpoint caches tools+system), so a large system prompt behind tiny tools
doesn't also spend a marker on a tools breakpoint too small to matter, and vice
versa.

Set `GH_ROUTER_LOG_CACHE=1` to log component hashes/lengths and the first
changed prefix component. Prompt text, tool arguments, cache keys, paths, and
user identifiers are never logged.

**Per-request cache accounting.** The standard per-request summary line
(`logRequest`) surfaces `cache:r<read>/w<write>` whenever either is nonzero.
Every route normalizes `usage` to DISJOINT input buckets before logging or
forwarding: the OpenAI-shaped routes (`/v1/chat/completions`, `/v1/responses`)
and the non-Claude `/v1/messages` shim through `normalizeOpenAIUsage`, native
Claude `/v1/messages` (streaming and non-streaming alike) through
`normalizeAnthropicUsageInPlace` in `src/lib/anthropic-usage.ts`.

**Upstreams differ on whether `input_tokens` includes the cached prefix, and
both shapes have been measured in real traffic.** In the INCLUSIVE shape
(OpenAI semantics inside an Anthropic-shaped object) `input_tokens` is the
total prompt and `cache_read_input_tokens` is a detail of that total; in the
EXCLUSIVE shape (the Anthropic contract) `input_tokens` is the uncached
remainder only. Anthropic clients, and Claude Code's context meter, sum the
three input buckets as if they were disjoint, so forwarding an inclusive
figure counts the cached prefix twice.

Inclusive, measured: session `ec65e3f9` (Standard, `claude-opus-5-5`, native
passthrough) reported turn 1 `input 55,931 / read 0`, turn 2 `input 56,423 /
read 55,808` across an exchange whose entire new payload was under 2 KB — a
198-char user message and two tool results totalling ~1 KB. Exclusive
semantics would require ~56,300 new tokens between those turns; inclusive
predicts +492, which is what happened. Session `c1e87ec0` corroborates
(62,451/0 → 66,699/66,176), and the `--localurl` endpoint is inclusive too
(session `a1ab11a5`: turn 2 `input 74,547 / read 74,496` after a 72-char
assistant text and a 41-char user message).

Exclusive, measured: an advisor-off capture of the same native Copilot route
on 2026-11-05 (`claude-opus-5-5`) reported `message_start input_tokens=2
cache_creation_input_tokens=66,941` and `message_delta input_tokens=4
cache_read_input_tokens=66,600 cache_creation_input_tokens=392`. `input 2`
next to a 66,941-token cache write only parses under the exclusive reading, so
the native path is not reliably inclusive across sessions.

The raw wire shape was captured on both egresses on 2026-11-05, using the
opt-in `GH_ROUTER_LOG_ANTHROPIC_USAGE_FRAMES=1` diagnostic (one
`[anthropic-usage]` line per `message_start` / `message_delta` with the four
numeric usage keys only — no prompt text, no payloads, no identifiers). Both
delivered `input_tokens` and the cache buckets on the SAME record, the
terminal `message_delta`. A real `-m local` run through the proxy against an
LM Studio-backed gateway produced cold `message_start input_tokens=43,105 …
cache_read=0` / `message_delta input_tokens=45,585 … cache_read=0`, then warm
`message_delta input_tokens=45,620 cache_read_input_tokens=45,440`; the
client-visible result usage was `inputTokens: 180, cacheReadInputTokens:
45,440`. Without the rewrite that meter would read 91,060 for a 45,620-token
prompt. The diagnostic stays in the product because the rewrite depends on an
unversioned upstream detail: if the fields ever split across frames the
rewrite silently becomes a no-op, and these lines are the only signal. It
rides on the rewrite transform, so it is silent when
`GH_ROUTER_DISABLE_ANTHROPIC_USAGE_NORMALIZE` is set.

The compaction symptom was then reproduced and cleared end to end. A real
`-m local` session was run with `CLAUDE_CODE_AUTO_COMPACT_WINDOW=100000`
(the client floors the value to 100,000, putting its reactive trigger at
100,000 - 20,000 - 13,000 = 67,000 tokens) over three turns whose true prompt
was ~45.7K. With the rewrite DISABLED the client read 45,577 then
45,649 + 45,568 = 91,217, and Claude Code emitted
`compact_boundary { trigger: "auto", pre_tokens: 91,247, post_tokens: 1,572 }`
on the second turn, replacing a live ~45.7K-token conversation with a 1.6K
summary. With the rewrite ENABLED the same shape read 45,586, then
53 + 45,568 = 45,621 and 88 + 45,568 = 45,656, and no compaction fired. That
`pre_tokens` at twice the real content is the thrash this fixes: the
compaction itself is correct arithmetic on a number that was doubled.

The consequence is not cosmetic. Claude Code computes context size as
`input + cache_creation + cache_read + output` and auto-compacts at
`min(modelWindow, CLAUDE_CODE_AUTO_COMPACT_WINDOW) - min(maxOutput, 20_000) -
13_000` (167,000 for a 200K window). A session carrying a 74.5K-token static
prefix reads ~149K on a warm turn, so right after a compaction that leaves 15K
of live context the meter is already at ~164K of 167K and refills in two or
three turns — exactly the "Autocompact is thrashing" report against session
`a1ab11a5`.

The rewrite mirrors `normalizeOpenAIUsage`:
`input_tokens = max(0, input_tokens - cache_read - cache_creation)`. It no-ops
on a cold turn (no cache, where both conventions agree) and no-ops when
`input_tokens < cached` — a shape impossible under inclusive semantics and the
exact shape a conformant Anthropic upstream reports on a warm turn (`input 26`
alongside `cache_read 97,304`). That guard is what lets the rewrite run
unconditionally on both egresses. On the streaming path the same rule runs as
a byte transform in `relayAnthropicStream`, buffering to SSE record
terminators so a record split across chunk boundaries is never corrupted, and
re-emitting every record that needs no correction byte-identically; the AIC
tap still sees the ORIGINAL upstream bytes, because it must reflect what
upstream billed rather than what was rewritten. The advisor loop normalizes the
lead-turn usage it re-emits on its synthesized terminal `message_delta` for the
same reason.

The residual ambiguity is an exclusive upstream whose uncached remainder
exceeds its cached prefix (`input >= cached`): it is misread as inclusive and
under-reported by the cached total. That takes a single turn adding more new
tokens than the whole cached prefix, and it applies to either egress, since
the native path has been measured exclusive. The error direction is the safe
one — the meter under-reads, so the client compacts later rather than earlier.
`GH_ROUTER_DISABLE_ANTHROPIC_USAGE_NORMALIZE=1` disables the rewrite for an
upstream whose shape the guard cannot discriminate.

Cache accounting remains a per-request observability signal, not a claim about
the effectiveness of any policy in this document. Live evidence from a
controlled native-Claude probe: a cold turn on a fresh prefix reported
`cache_creation_input_tokens: 7566, cache_read_input_tokens: 0`; the
immediately following warm turn on the same prefix reported
`cache_creation_input_tokens: 44, cache_read_input_tokens: 7566` — the prior
write became a read. (That probe used a synthetic body, which Copilot reports
with disjoint buckets — see the probe caveat in
[`copilot-compat-matrix.md`](copilot-compat-matrix.md). Real Claude Code
traffic on the same route has been measured in both shapes, as above.)

The native Claude non-streaming `in:` figure sums the three normalized buckets
(`anthropicTotalInputTokens`), because Anthropic's `input_tokens` alone is only
the NEW (uncached) portion — unlike OpenAI's inclusive total. Forwarding it
alone would understate a warm-cache turn's real prompt size, sometimes
drastically: a live warm-cache turn measured `input_tokens: 26` alongside
`cache_read_input_tokens: 97304` (the real prompt was ~97k tokens, not 26).

Two accounting-correctness fixes underneath this: (1) the chat-completions and
`/responses` handlers now gate `normalizeOpenAIUsage` on the RAW upstream
`usage` field's presence rather than on `!isStreaming` alone —
`normalizeOpenAIUsage(undefined)` intentionally returns a defined all-zero
object (so its own callers never need an extra null-check), which previously
meant a non-streaming response with no `usage` at all logged a confident `0`
instead of falling back to the pre-request tokenizer estimate
(chat-completions) or omitting the `in:` field entirely (`/responses`, which
has no such fallback). (2) `usageDetails` (in `prompt-cache.ts`) now picks the
first genuinely POSITIVE candidate across its priority-ranked field list
instead of `??`-chaining them — a provider surface that always populates a
nested detail with an explicit `0` placeholder no longer shadows a
real, positive count reported only at a lower-priority (e.g. top-level)
field; when every candidate really is zero, the result is a real `0`, not a
dropped field.

Web-search placement and rollback controls are documented in
[`web-search.md`](web-search.md). Compatibility evidence is recorded in
[`copilot-compat-matrix.md`](copilot-compat-matrix.md).

## Live measurement harness (`scripts/probe-prompt-cache.ts`)

The table above and `src/lib/prompt-cache.ts`'s policy are claims about what
the router *does*; they are not, by themselves, evidence that a real
multi-turn Claude Code session actually gets a warm cache read back from
Copilot. `scripts/probe-prompt-cache.ts` is an opt-in harness that measures
that empirically, against the REAL launcher and the REAL installed Claude
Code CLI (not a hand-built `/v1/messages` payload).

### Invocation

```bash
GH_ROUTER_RUN_CACHE_PROBE=1 bun run probe:cache
```

Without the env var it prints instructions and exits 0 — it is never run
implicitly, and running it costs real Copilot budget. Useful config knobs
(all optional; see the header comment in the script for the full list):

```bash
GH_ROUTER_RUN_CACHE_PROBE=1 \
GH_ROUTER_CACHE_PROBE_TRIALS=5 \
GH_ROUTER_CACHE_PROBE_TIMEOUT_MS=300000 \
GH_ROUTER_CACHE_PROBE_MAX_BUDGET_USD=0.50 \
bun run probe:cache
```

### What it does

For `claude-opus-5.5`, `claude-haiku-4.5`, every GPT-5.6 tier
(`gpt-6-sol`, `gpt-6.1-sol`, `gpt-5.6-terra`, `gpt-6-luna`), `grok-4.7`,
`gemini-3.8-flash`, and
the highest-context `grok-4.6*` catalog sibling (resolved from the LIVE
Copilot catalog, never hardcoded — see `selectCacheProbeTargets` in
`src/lib/cache-probe.ts`), sequentially (concurrency 1, no automatic
retries):

- **Controlled trials** (default 3): spawn `bun run ./src/main.ts claude -m
  <model> ... -- --print --input-format stream-json --output-format
  stream-json --verbose --no-session-persistence --tools "" --strict-mcp-config
  --system-prompt <deterministic prefix>`, feed 2+ user turns as JSONL lines
  over stdin in ONE process, and parse each top-level `result.usage` event.
  Translated models carry zero placeholders in `assistant.message.usage`; their
  terminal result carries the real per-turn totals. Turns are sent one at a time,
  after the prior result arrives. The first turn carries a fresh random salt
  prepended to a large deterministic system prompt, so separate trials cannot
  share the full controlled prefix; tools and all MCP servers
  are disabled so only the model call itself varies. Prefix size is
  per-provider (`systemPrefixCharsFor`): 6,000 chars by default — comfortably
  above this repo's own 4,096-byte `MIN_CACHEABLE_PREFIX_BYTES` local
  guard (`src/lib/prompt-cache.ts`) and, for this deterministic natural-language
  filler, measured above Anthropic's cacheable-prefix floor — and
  40,000 chars for Gemini/Grok, whose implicit-cache floor measured higher
  live. The predecessor Gemini Flash generation cached nothing at 6,000 chars
  but cached cleanly at ~40,000; that empirical result is a conservative
  baseline for 3.8, not a newly run 3.8 measurement. Haiku 4.5 also uses the
  larger prefix because its cacheable-prefix floor is materially higher than
  current Opus models.
- **One authentic trial per native-Claude target**: default toolset, default
  system prompt (no `--bare`/`--safe-mode`), salted first turn, prompt text
  instructs the model not to call tools (tools remain technically available,
  so a tool round-trip is still possible — that shows up as an AMBIGUOUS
  verdict rather than being silently absorbed into the cold/warm split).
- **One growing-history trial**, any `gpt-5.6*` catalog id: several turns
  (default 4), each appending its OWN fresh deterministic chunk on top of
  Claude Code's own append-only in-session transcript. This exists because a
  fixed two-turn trial cannot distinguish "the whole growing conversation is
  cached" from "only the static system prompt is cached" — live measurement
  found exactly the latter on a real 27k-token conversation (warm turns
  reporting `cache_read≈2k` against `input≈27k`, i.e. a coverage ratio
  around 7%, while `cache_read_input_tokens` stayed comfortably nonzero the
  whole time). A bare positivity check would have PASSed that.

### Verdict

`computeCacheProbeVerdict` (`src/lib/cache-probe.ts`) computes, per trial, a
per-turn cache-coverage ratio: for each warm turn, its own
`(cache_read_input_tokens + cache_creation_input_tokens) / (input_tokens +
cache_creation_input_tokens + cache_read_input_tokens)` — both reads and writes
avoid fully uncached processing; deliberately NOT divided by the (possibly much
smaller) cold turn's total, which is exactly what would make the
system-prompt-only failure mode above read as near-100% coverage. The mean
across warm turns must reach `DEFAULT_CACHE_PROBE_PASS_RATIO` (0.9) to PASS.
That threshold sits between the ~0.94-0.999 measured on a native multi-turn
Claude session (whole growing transcript genuinely cached) and the ~0.07
measured on the system-prompt-only failure mode, so it separates the two
without being so tight that ordinary per-turn token-count noise flips the
verdict.

Oracle class (`cacheOracleClassFor`) governs what an ABSENT cache field
means: for native Claude and the gpt-5.6 family ("strict"), Copilot is
expected to report cache usage reliably, so absent fields or a
below-threshold ratio are both FAIL. For Gemini/Grok/anything else
("provider-managed"), missing cache fields are INCONCLUSIVE. When fields are
present, the harness records the observed reuse and requires a nonzero warm
read, but does not impose the 90% Claude/GPT target because the provider owns
its implicit-cache chunking and threshold policy.

A run whose child process times out, exits non-zero, or reports a different
number of `assistant` usage events than the number of turns sent (usually an
extra API call, e.g. a tool round-trip in the authentic trial) is reported
as AMBIGUOUS, never laundered into a PASS/FAIL. **This harness itself** never
auto-retries such a trial — a rerun gets a fresh salt, same as any other
trial. That claim does not cover the router's transparent pre-first-byte
upstream retry; see Proof limitations below.

### Overall verdict and process exit code

`computeCacheProbeRollup` rolls up every trial that ran for a model —
controlled, authentic, and growing-history together — into one model verdict.
`computeCacheProbeExitDecision` then examines every individual trial across
all models. Any `FAIL` or `AMBIGUOUS` sets `process.exitCode = 1`; an
`INCONCLUSIVE`-only run exits 0 but prints and records an explicit warning, so
"not measurable" cannot be mistaken for "passed."

### Output

A timestamped JSON evidence artifact is written to
`~/.local/share/github-router/cache-probe/cache-probe-<timestamp>.json` (or
`GH_ROUTER_CACHE_PROBE_OUTPUT` — not tracked by git either way). It records
the resolved commit SHA, installed Claude CLI version, router version,
resolved catalog targets (including grok's ACTUAL advertised context window,
labelled honestly rather than assumed 1M — the live catalog currently
advertises 500k for `grok-4.6`), per-trial raw usage samples, and verdicts.
It deliberately does NOT record prompt text, credentials, device/session
ids, or any raw user data — only synthetic salts, char counts, and numeric
usage fields.

### Proof limitations

- This measures one account, one moment, one machine's network path — not a
  guarantee that holds at every point in time or for every request shape.
- The controlled trials disable tools and MCP for a clean signal; real
  Claude Code sessions run with tools and the full peer-MCP surface, whose
  own token cost could shift where a provider's cache breakpoint falls. The
  authentic and growing-history trials partially cover this gap but are not
  exhaustive.
- `cacheCoverageRatio` is a coarse, per-turn signal, not a claim about an
  exact cacheable-prefix/suffix boundary — it cannot say WHICH bytes were
  reused, only how much of the turn's total input was.
- Gemini/Grok absent-metric INCONCLUSIVE results say nothing about whether
  caching happened; they only say the provider didn't report it through this
  wire path.
- No claim is made that a universal exact-suffix cache-reuse bound holds
  across providers or over time; catalog models, backends, and their
  provider-side cache policies can change without this repo's knowledge.
- **Hidden upstream retries can contaminate a "cold" turn.** The router may
  transparently retry a 429/5xx/network failure before the first response byte.
  If an earlier attempt reached the provider cache before failing, Claude Code
  still emits one assistant event and the harness cannot currently distinguish
  that pre-warmed identity. A future version can correlate attempt telemetry;
  current evidence records this as a limitation.

Pure parsing/verdict/catalog-selection logic (`parseCacheProbeAssistantUsage`,
`computeCacheProbeVerdict`, `selectCacheProbeTargets`, `systemPrefixCharsFor`,
etc.) lives in `src/lib/cache-probe.ts` and is unit-tested in
`tests/cache-probe.test.ts` with no live model call, no child process, and no
network access.
