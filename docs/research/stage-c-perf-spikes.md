# Stage C spikes: measure before refactoring the request path

Status: **complete**. Both spikes ran; both said **do not proceed yet**, for
different reasons. Recorded here so the next audit does not re-derive them.

## C.1 — Is the `/v1/messages` prologue worth refactoring?

**The claim under test.** The prologue re-parses the request body 3-4x and
re-serializes it 2-3x because its stages pass a *string* between them
(`routes/messages/handler.ts:293,303,309,327,390,524,624,704`;
`anthropic-translate/index.ts:94,217`). At 4.5 MiB that is ~28 ms of
synchronous, event-loop-blocking work ahead of the first upstream byte.

**Measured** (`bun scripts/bench-request-prologue.ts`, median of 20 trials, on
realistic Anthropic shapes — many small content blocks, not one giant string):

| body size | JSON.parse | stringify | prologue total |
|---|---|---|---|
| 40 KiB | 0.08 ms | 0.05 ms | **0.41 ms** |
| 136 KiB | 0.30 ms | 0.16 ms | **1.35 ms** |
| 520 KiB | 0.72 ms | 0.57 ms | **3.70 ms** |
| 2.1 MiB | 3.02 ms | 1.45 ms | **13.90 ms** |
| 4.5 MiB | 7.01 ms | 3.34 ms | **27.71 ms** |

**Verdict: DEFER.** The cost is real but entirely a function of body size, and
the decision needs live percentiles the repo could not produce — which turned
out to be the actual finding.

`recordBodySize()` / `bodySizeStats()` in `src/lib/request-log.ts` exist
*specifically* to answer this ("benchmarks at 4.5 MiB mean nothing if the real
p50 is 40 KiB", per their own doc comment). `bodySizeStats()` had **no caller
anywhere in `src/`** — the ring was written every request and read by nobody.
So the one measurement that gates a refactor of the most safety-critical path
in the repo was being collected and thrown away.

Fixed in this PR: `logBodySizeStats()` now prints the distribution on shutdown.
**Re-open C.1 once a few real sessions have reported their p50/p95.** At a
40 KiB p50 the whole prologue is sub-millisecond and the refactor is not worth
touching this path for; at a 2 MiB p95 it is.

Two things to carry into that work if it happens:

- The hazard is **not** performance. Today's repeated parse/stringify creates
  *object-identity barriers*; one shared mutable context lets an earlier
  stage's mutation reach later branches that currently cannot see it. That
  needs golden request-body tests across advisor on/off x passthrough/shim x
  `mcp_servers` x web search x aliases x malformed. "The integration suite
  stays green" is not sufficient.
- `injectAdvisorTool`'s fast path is **not** wasted work, despite looking
  inert. When `advisor_20260301` is present the parse+strip is *required* —
  Copilot 400s on the unknown tool type. The guard never fires in the default
  config (because `server-setup.ts:1002` injects the advisor env var), but
  nothing is wasted. Do not "optimize" it by removing the strip.

## C.2 — Can startup work move off the pre-listen path?

**The claim under test.** `server-setup.ts:366-394` awaits `ensurePaths()`
(four GC sweeps, including `fs.rm({recursive:true})` of stale `~/.claude`
mirrors — expensive on Windows) and `setupGitHubToken()` (a full
`api.github.com/user` round trip, purely to print `Logged in as <x>`) before
`serve()`.

**Verdict: RECLASSIFY, do not do it as a perf change.** Backgrounding these
wholesale is a *readiness race*, not a speedup: the CLI's first request can
then land on directory creation that has not happened (`ENOENT`), on a live
recursive `rm` of a path it is about to use, or before a token exists. A manual
smoke test cannot catch any of it — the smoke waits long enough for the
background work to finish, which is exactly why this looked safe.

If it is taken up, the split is:

- **required before listen**: directory creation, token availability;
- **not required**: the GC sweeps, the identity-display RTT.

Background only the second group, and only behind a test that issues a request
at the instant the listener opens. That is a correctness change with a latency
benefit, and should be reviewed as one.

## Not done, deliberately

Stage D (the `noUncheckedIndexedAccess` and `recommended-type-checked`
rollouts) stays out of this PR. Its premise checks out — the upstream-JSON
parse sites are `Record<string, unknown>`, not `any`, so the flag does bite —
but both are large mechanical diffs whose review value collapses when mixed
with correctness fixes. They also want the no-new-`!` policy written into the
PR that lands them, or the diff degrades into `content[0]!.text` and the
boundary ends up looking hardened without being hardened.
