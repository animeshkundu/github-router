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
caching too. Measured on `gpt-5.6-sol` with explicit mode force-enabled for a
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
On supported non-streaming OpenAI-shaped responses (`/v1/chat/completions`,
`/v1/responses`), it also appends `ttl:<seconds>s` when the provider reports a
positive cache TTL. Streaming responses and native Anthropic routes may not
expose this metadata and remain unknown. The TTL is an observation only; the
router does not infer or synthesize it.

Worker input budgeting uses the stricter valid catalog value of
`max_context_window_tokens` and `max_prompt_tokens`, avoiding a
request-boundary estimate above the prompt ceiling on models such as Luna and
Grok. Cache-price fields are intentionally not surfaced in the model-facing
worker catalog until the live field semantics are verified.
The OpenAI-shaped usage total is first split into disjoint buckets by
`normalizeOpenAIUsage`. Native Claude `/v1/messages` (both the passthrough and
the non-Claude shim's synthesized usage) already reports
`cache_read_input_tokens` / `cache_creation_input_tokens` as disjoint buckets,
so the non-streaming handler forwards them straight through with no
normalization step. Live evidence from a controlled native-Claude probe: a
cold turn on a fresh prefix reported `cache_creation_input_tokens: 7566,
cache_read_input_tokens: 0`; the immediately following warm turn on the same
prefix reported `cache_creation_input_tokens: 44, cache_read_input_tokens:
7566` — i.e. the prior write became a read. This is a per-request
observability signal, not a claim about the effectiveness of any policy in
this document; the streaming path is a raw relay of whatever Claude Code's own
usage accounting reports and is unaffected.

The native Claude non-streaming `in:` figure sums `input_tokens +
cache_read_input_tokens + cache_creation_input_tokens`
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
first genuinely POSITIVE token-count candidate across its priority-ranked field
lists instead of `??`-chaining them — a provider surface that always populates
a nested detail with an explicit `0` placeholder no longer shadows a real,
positive count reported only at a lower-priority (e.g. top-level) field; when
every count candidate really is zero, the result is a real `0`, not a dropped
field. TTL metadata is retained only when a positive finite value is reported;
non-positive values remain omitted from the request summary.

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

For `claude-opus-5`, `claude-haiku-4.5`, every GPT-5.6 tier
(`gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`), `gemini-3.7-flash`, and
the highest-effective-input-window `grok-4.6*` catalog sibling (resolved
from the LIVE Copilot catalog, never hardcoded — see `selectCacheProbeTargets`
in `src/lib/cache-probe.ts`), sequentially (concurrency 1, no automatic
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
  live (Gemini 3.7 Flash cached nothing at 6,000 chars but cached cleanly at
  ~40,000). Haiku 4.5 also uses the larger prefix because its cacheable-prefix
  floor is materially higher than current Opus models.
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
resolved catalog targets (including grok's ACTUAL effective input window,
labelled honestly rather than assumed 1M — the live catalog currently
advertises 500k total / 372k prompt for `grok-4.6`), per-trial raw usage
samples, and verdicts.
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

## Official-family validation harness (`scripts/probe-cache-families.ts`)

The additive family harness validates the four official Copilot billing families
without changing production cache policy. Its family and default-tier rate
authority is the [official Copilot models-and-pricing table](https://docs.github.com/en/enterprise-cloud@latest/copilot/reference/copilot-billing/models-and-pricing);
the live `/models` catalog supplies only exact callable IDs, endpoint support,
policy state, limits, and ordinary-price mismatch warnings. It never fuzzy-maps
model names, uses cache-price fields as USD, or infers entitlement from catalog
restrictions. Google (Gemini 3.6/3.7 Flash) and xAI (Grok 4.5/4.6) are
same-rate ties and are skipped unless `--include-ties` is explicit.

Always stage and inspect a dry-run first. It performs catalog setup but never
invokes a model:

```bash
bun scripts/probe-cache-families.ts \\
  --dry-run --families OpenAI,Anthropic,Google,xAI
```

A live run additionally requires `--live`,
`GH_ROUTER_RUN_CACHE_PROBE=1`, the exact dry-run plan hash, and explicit
operator caps for calls, input tokens, output tokens, and wall-clock time:

```bash
GH_ROUTER_RUN_CACHE_PROBE=1 \\
GH_ROUTER_CACHE_VALIDATION_PLAN_SHA256=<dry-run-hash> \\
GH_ROUTER_CACHE_VALIDATION_MAX_CALLS=8 \\
GH_ROUTER_CACHE_VALIDATION_MAX_INPUT_TOKENS=50000 \\
GH_ROUTER_CACHE_VALIDATION_MAX_OUTPUT_TOKENS=128 \\
GH_ROUTER_CACHE_VALIDATION_MAX_WALLCLOCK_MS=120000 \\
bun scripts/probe-cache-families.ts --live \\
  --families OpenAI,Anthropic,Google,xAI
```

Run the happy path before `--edges`. A pair is publishable only when both
turns have cache telemetry, valid accounting, equivalent exact `OK` output,
and a cold cache-read contamination ratio no greater than 5%; missing fields,
pre-warmed cold turns, retries, non-equivalent output, and unreconciled totals
are inconclusive rather than cache misses or passes. Prefix fixtures are sized
per model family, including the larger implicit-cache floors measured for
Haiku, Gemini, and Grok. Artifacts retain hashes, lengths, numeric usage, and
sanitized model metadata, never raw output or request headers.

Reported savings are `INDICATIVE_UNVERIFIED`: documented-rate arithmetic for
uncached input, cached reads, cache writes when a documented rate exists, and
output. They are within-model cold/warm or policy/control comparisons only, not
cross-family rankings, invoice evidence, or proof of actual billed-dollar
savings. The control arm runs against the current proxy without the existing
router-owned cache helper, so it is not a git-commit before/after experiment.
The harness does not broaden explicit provider cache handling: growing
`conversation` workloads continue to rely on provider-managed caching.
