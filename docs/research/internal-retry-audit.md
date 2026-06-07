# Internal upstream retry audit

**Question:** When an internal upstream call fails *transiently* (HTTP 5xx like
the "upstream is sick" 502s, 429 rate-limit, network reset/timeout), does
github-router retry it — or does a single transient failure fail the whole tool
call? The user expects internal calls to retry.

**Verdict (one line):** Almost nothing retries on transient failures. The only
shared "retry" helper (`tryRefreshAndRetry`) retries **only on 401** (token
refresh), not on 5xx / 429 / network. The single genuine transient retry in the
codebase is in web-search (`postMcp`, one retry on `status >= 500` only). Every
peer-critic call, the advisor, every `stand_in` model call, the worker loop, and
the user passthrough fail the whole operation on the first transient upstream error.

Read-only audit. No code was modified.

---

## Per-call-site retry table

| # | Call site | file:line | Retries transient? | Attempts | Backoff | Triggers | Idempotent / safe to retry? | Abort + slot aware? |
|---|-----------|-----------|--------------------|----------|---------|----------|------------------------------|---------------------|
| 1 | Peer-critic dispatch `dispatchModelCall` / `callPersona` | `src/routes/mcp/handler.ts:690-779`, `788-812` | **NO** | 1 | none | — | Yes (non-streaming completion; `stream:false`) | Threads `signal`; slot held by `handleToolsCall:1028-1119` |
| 2 | advisor `runAdvisor` | `src/services/advisor/advisor.ts:363-490` | **NO** | 1 | none | — | Yes (non-streaming `stream:false` for both `/responses` and `/messages`) | Threads `signal`; checks `signal.aborted` |
| 3a | `stand_in` per-model upstream call | `src/lib/stand-in.ts:282-303` (`callAndParse`) | **NO** (upstream error → `VoteFailure`) | 1 | none | — | Yes (non-streaming) | Threads `signal` |
| 3b | `stand_in` parse-repair retry | `src/lib/stand-in.ts:308-324` | only on **parse failure**, not transient | 1 extra | none | malformed JSON, not 5xx/429 | n/a | Threads `signal`; itself can fail on a transient |
| 4 | worker stream loop | `src/lib/worker-agent/stream-fn.ts:155-347`, engine `src/lib/worker-agent/engine.ts:155-194` | **NO** | 1 | none | — | **Streaming** — naive retry would duplicate output | Threads `options.signal`; encodes error as terminal `error` event |
| 5a | passthrough `/v1/messages` | `src/routes/messages/handler.ts:307` → `create-messages.ts:55-99` | **NO** (only 401 via `tryRefreshAndRetry`) | 1 | none | 401 only | **Streaming** (user-facing) | `AbortSignal.timeout` + caller signal |
| 5b | passthrough `/v1/responses` | `src/routes/responses/handler.ts:76` → `create-responses.ts:11-83` | **NO** (only 401) | 1 | none | 401 only | **Streaming** (user-facing) | same |
| 5c | passthrough `/v1/chat/completions` | `src/routes/chat-completions/handler.ts:92` → `create-chat-completions.ts:11-96` | **NO** (only 401) | 1 | none | 401 only | **Streaming** (user-facing) | same |
| 5d | `/responses/compact` | `src/routes/responses/handler.ts:404-410` | **NO** (only 401) | 1 | none | 401 only | Yes (non-streaming) | same |
| 6a | Copilot token exchange `getCopilotToken` | `src/services/github/get-copilot-token.ts:32-40` | **NO** | 1 | none | — | Yes (GET) | bare `fetch`, no signal |
| 6b | token refresh `refreshCopilotToken` | `src/lib/token.ts:50-97` | **NO** (interval-driven only) | 1 | 5s/30s *cooldowns* (not retries) | — | Yes | n/a; swallows error on failure |
| 6c | `tryRefreshAndRetry` (shared helper) | `src/lib/token.ts:109-122` | **401 ONLY** — not transient | 1 | none | `status === 401` | Yes | re-invokes `request()` callback |
| 6d | models catalog `getModels` | `src/services/copilot/get-models.ts:5-13` | **NO** | 1 | none | — | Yes (GET) | bare `fetch`, no signal |
| 6e | web search `searchWeb` / `postMcp` | `src/services/copilot/web-search.ts:102-120`, `122-302` | **PARTIAL** | 1 retry **per POST** on `status >= 500` | fixed 500ms (`sleep(500)`) | `res.status >= 500` ONLY (no 429, no network throw) | Yes (idempotent search) | Threads `signal`; `MAX_SEARCHES_PER_SECOND` throttle |
| 6f | github `getGitHubUser` / `getDeviceCode` / `getCopilotUsage` | `get-user.ts:6`, `get-device-code.ts:10`, `get-copilot-usage.ts:6` | **NO** | 1 | none | — | Yes (GET) | bare `fetch` |
| 6g | device-code poll `pollAccessToken` | `src/services/github/poll-access-token.ts` | loops by design (OAuth pending), **not** transient-aware | n | fixed `interval+1`s | `authorization_pending` / `slow_down` | n/a (auth flow) | n/a |

**Shared fetch layer (call site #7):** There is **no central retry layer**. Each
call site does a bare `fetch`. The three streaming clients
(`create-messages` / `create-responses` / `create-chat-completions`) share *one*
pattern — `doFetch()` composed with `AbortSignal.timeout(UPSTREAM_FETCH_TIMEOUT_MS)`
+ caller signal via `AbortSignal.any`, wrapped in `tryRefreshAndRetry` — but that
wrapper's only retry is the 401 token refresh (`token.ts:113-121`). `UPSTREAM_FETCH_TIMEOUT_MS`
(default **0** = no fetch-phase cap, `src/lib/port.ts:197`; body reads are bounded
by `UPSTREAM_INACTIVITY_TIMEOUT_MS` = 5 min, `port.ts:213`) is a per-attempt
deadline, not a retry budget.
A `ripgrep` for `retry|backoff|exponential|jitter` across `src/` returns no retry
utility (the matches are token-refresh cooldowns, the web-search single retry, the
rate-limit throttle, and the device-code poll).

---

## Correctness-bug list (transient-failure misclassifications)

These are the cases where a transient 502/429/reset is not just an unretried
resilience gap, but is *mislabeled* as a different, terminal condition — so the
user-visible outcome is wrong, not merely fragile.

### BUG 1 (worst) — `stand_in` counts a transient upstream failure as a missing/invalid vote, silently altering or downgrading the verdict

`callAndParse` (`stand-in.ts:282-303`) wraps the upstream call in try/catch and
turns *any* exception — including a one-off 502 or a network reset — into
`{ error: "upstream_error" }`. Downstream, `successfulR1`/`successfulR2`
(`stand-in.ts:178`, `233`) **filter those failures out** before aggregation.

Concrete failure scenarios (cap = 8 is irrelevant here; the bug is in
classification, not concurrency):

- **Verdict downgrade.** Two models agree on option A, the third 502s once. With
  3 real votes this is `consensus`; with the failed model dropped it's a 2-of-2
  → still reported, but the `confidence` and `notes` no longer reflect the third
  model, and the `meanConfidence >= 0.8` short-circuit (`stand-in.ts:195-206`) may
  not fire — changing whether round 2 even runs.
- **Forced `no_consensus`.** If two of three models hit a transient blip in the
  same round, `successfulR1.length < 2` (`stand-in.ts:210`) or
  `successfulR2.length < 2` (`stand-in.ts:234`) trips and the tool returns
  `verdict: "no_consensus"` / `recommendation: null` — i.e. "the models couldn't
  agree, defer to the user" — when in reality the models never failed to agree;
  the *network* failed. The away-mode user reads a false "no consensus".
- The phrasing matters: it is **not** literally "treated as abstain" (an abstain
  is a successful null-choice `Vote`; a transient is a `VoteFailure` excluded from
  the tally). But the *effect* is worse than abstain — a transient failure can both
  block consensus and remove a real signal, with no retry to recover it.

Note the existing `stand-in.ts:308-324` retry is a **schema-repair** retry (re-ask
with "return only JSON"), not a transient retry — and that second call can itself
die on a transient with no further recovery.

**Severity: Important-to-Critical.** `stand_in`'s entire value is a faithful 3-lab
signal for an absent user; a transient blip silently corrupting the verdict
defeats the tool's purpose. It is the single most consequential misclassification
because the wrong output looks authoritative.

### BUG 2 — peer-critic / advisor transient failure surfaces as a terminal tool error with no retry

A 502 from `dispatchModelCall` propagates as an exception to `handleToolsCall`'s
catch (`handler.ts:1090-1117`), which returns `isError: true` with text
`persona <name> failed: <message>`. The model sees a hard failure for what was a
one-off upstream blip. The advisor path is similar: `runAdvisor` throws, the
caller (`advisor.ts:986-998`) synthesizes `[Advisor unavailable: ...]` inline.
These are not *mis*classifications (a failed call is a failed call), but they are
the resilience gap the user is asking about — the natural backpressure comment at
`handler.ts:66-82` assumes the *429* is the backpressure mechanism, yet a 429 is
exactly a transient that a short backoff would usually clear.

**Severity: Important.** Correct error type, but no retry where retry is safe
(non-streaming, idempotent completions).

### BUG 3 — web-search retry is incomplete (5xx only; misses 429 and network throws)

`postMcp` (`web-search.ts:115-119`) retries once on `res.status >= 500`, but a
**429** rate-limit (`res.status === 429`, the single most common transient on a
busy Copilot tenant) is **not** retried, and a network-level `fetch` rejection
(reset/`ECONNRESET`/timeout) throws straight out of `postMcp` before the
`res.status` check is ever reached, so it is **not** retried either. The retry it
does have is correctly placed and abort-aware, just too narrow.

**Severity: Suggestion-to-Important.** Existing partial retry should be widened
to 429 + network, ideally folded into the shared helper below.

---

## Recommendation: a shared abort-aware retry helper

### Where it goes (single source of truth)

Add `fetchWithTransientRetry` to **`src/lib/token.ts`** (or a new
`src/lib/upstream-retry.ts`) and have it **compose with**, or **replace**,
`tryRefreshAndRetry` so the 401-refresh semantics are preserved. The three
streaming clients already centralize their `doFetch` + signal composition, so this
is the natural seam. Critically, it must keep the existing 401 → `refreshCopilotToken`
behavior — drop that and the no-401 invariant / `forwardError` 401→503 remap
(`src/lib/error.ts`) regresses.

### Proposed signature

```ts
interface TransientRetryOpts {
  request: () => Promise<Response>   // re-buildable per attempt (picks up refreshed token)
  routePath: string                  // for logs, matches tryRefreshAndRetry
  signal?: AbortSignal               // caller cancel — abort wins over retry
  attempts?: number                  // default 3 (1 try + 2 retries)
  retryStatuses?: ReadonlyArray<number>  // default [429, 500, 502, 503, 504]
  retryNetworkErrors?: boolean       // default true (ECONNRESET / ETIMEDOUT / fetch reject)
  baseDelayMs?: number               // default 250
  maxDelayMs?: number                // default 4000
  refreshOn401?: boolean             // default true — preserves tryRefreshAndRetry
}
async function fetchWithTransientRetry(o: TransientRetryOpts): Promise<Response>
```

### Policy

- **Attempts:** 3 total (1 + 2 retries). Bounded so one tool call can never hold
  its inflight slot indefinitely (slot held across retries at
  `handler.ts:1028-1119`).
- **Backoff:** exponential with full jitter —
  `delay = random(0, min(maxDelayMs, baseDelayMs * 2^attempt))`. With
  base=250, max=4000 the worst case is ~250ms + ~4s ≈ under 5s of added latency
  across two retries, comfortably inside the SSE-heartbeat path and the worker
  budget.
- **Triggers:** retry on `429` + `5xx` (`500/502/503/504`) + network rejections
  (`ECONNRESET`, `ETIMEDOUT`, `fetch` TypeError). **Never** retry other `4xx`
  (400/401-after-refresh/403/404/422) — those are deterministic and a retry just
  burns budget. `401` is special-cased into the existing refresh-once path.
- **Abort-aware:** the inter-attempt sleep must be cancellable — wake on
  `signal` abort and re-throw `AbortError` immediately rather than sleeping out
  the full backoff. Check `signal.aborted` before each attempt. Honor
  `Retry-After` header when present (cap to `maxDelayMs`).
- **Idempotency:** safe because every adopting call site is a **non-streaming,
  side-effect-free completion** (`stream: false`) or an idempotent GET. The
  helper must only be used where the body has not yet been streamed to a consumer.

### Which call sites adopt it (non-streaming, safe)

1. `dispatchModelCall` (#1) — peer critics, the highest-traffic internal path.
2. `runAdvisor` (#2) — both `/responses` and `/messages` branches (`stream:false`).
3. `stand_in`'s `callAndParse` per-model call (#3) — **this fixes BUG 1.** Wrap
   the `dispatchModelCall` so a transient is *retried* before it can ever become a
   `VoteFailure` that corrupts the verdict. Keep the parse-repair retry as a
   distinct, second layer.
4. web-search `postMcp` (#6e) — replace the ad-hoc `status >= 500` single retry;
   fixes BUG 3 (adds 429 + network).
5. token exchange `getCopilotToken` (#6a) and `getModels` (#6d) — startup-path
   GETs; a transient here currently aborts launch / leaves the catalog empty.
6. The non-streaming `/responses/compact` (#5d) and any other `stream:false`
   passthrough.

### Which streaming sites are EXCLUDED (and why)

Naive retry on a streaming path **duplicates output** — once SSE bytes have
reached the consumer, re-issuing the request replays `message_start` + content
the client already rendered. Exclude:

- **User passthrough** `/v1/messages`, `/v1/responses`, `/v1/chat/completions`
  (#5a/b/c). The right move here is **pre-first-byte retry only**: the
  `create-*` clients already separate the `fetch` (which 5xx's before any body is
  read) from the `events(response)` stream hand-off. Retry is safe **only** in the
  window between `doFetch()` returning a non-ok response and the
  `payload.stream` branch handing `events()` to the caller — i.e. retry the
  `!response.ok` 5xx/429 case, never after `events()` is consumed. After the first
  SSE byte, leave recovery to the client (it owns the conversation and can re-send).
- **Worker stream loop** (#4, `stream-fn.ts`). Same reasoning. A pre-first-byte
  retry could live in `runStreamLoop` *before* the `for await (const evt of
  sseStream)` loop begins (the `createChatCompletions` call at
  `stream-fn.ts:176-194` is the retryable window); once the loop has pushed any
  `text_delta`, a retry would double the worker's output. Lower priority — the Pi
  agent loop already re-prompts on a terminal `error` event, so the worker has a
  coarse-grained recovery the user paths lack.

### Net effect

The away-mode `stand_in` correctness bug (BUG 1) and the silent peer/advisor
fragility (BUG 2) are fixed by routing the four non-streaming model dispatchers
through one bounded, jittered, abort-aware helper. The user-facing streams stay
correct (no duplicate output) by limiting them to pre-first-byte retry, which the
`create-*` clients' fetch/stream split already makes clean to implement.
