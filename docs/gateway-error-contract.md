# Claude Code gateway error contract

How the proxy tells Claude Code *why* an upstream request was rejected, so the
client can run its own recovery instead of stranding the session.
See [`../CLAUDE.md`](../CLAUDE.md) for project overview.

## The problem this solves

Claude Code recovers from an upstream rejecting a capability by matching
`status === 400` (plus one 413 variant) against **the upstream's own error
wording**. A gateway that replaces the error body — which this proxy does, both
to normalize shapes and to avoid relaying upstream infra detail — hides exactly
the wording the client needs.

Claude Code's own bundled contract for gateway implementers states the
obligation and the remedy:

> before replacing a `400` or `413` body, classify the upstream's message and,
> when it matches a class below, make your envelope's `error.message` the stable
> token `capability_rejected: <class>` — the client matches the token exactly as
> it would the wording, and the session self-heals instead of stranding. A
> message matching no class gets your generic copy.

## Verified client behaviour (build 2.1.251)

Two independent matchers feed the same recovery, so satisfying either is
sufficient:

```js
// token matcher: substring, with a right-boundary check so a class cannot be
// read as the prefix of a longer identifier
function W(n,e){ /* n.indexOf("capability_rejected: " + e), next char not [A-Za-z0-9_:.-] */ }

// wording matcher: lowercased substring on the ORIGINAL upstream phrasing
function c(n){ let e = n.toLowerCase()
  return e.includes("prompt is too long")
      || e.includes("input is too long for requested model") }

// the predicate the recovery path actually calls
function IZ(e){ return JBn(e.message) || wd(e.message, "prompt_too_long") }
//                     ^ wording           ^ token
```

The proxy emits **both**: the token is the documented contract, the wording is
the older independently-matched path, and neither costs anything. A canary
(`tests/canaries/overflow-contract.test.ts`) pins both against the installed
build, because either could be reworded in a release and our side would fail
silently.

## What the proxy emits today

`forwardError` (`src/lib/error.ts`) classifies via `classifyOverflow` and builds
the envelope with `buildCapabilityRejectedMessage`:

```json
{ "type": "error",
  "error": { "type": "invalid_request_error",
             "message": "capability_rejected: prompt_too_long (prompt is too long: <upstream>)" } }
```

| Class | Emitted when | Client recovery |
|---|---|---|
| `prompt_too_long` | 413, or a 400 matching `CONTEXT_OVERFLOW_SUBSTRINGS` | reactive compaction, then retry the turn; `/compact` additionally retries its own summary up to 3 times, dropping older message groups |
| `max_tokens_context_overflow` | ``input length and `max_tokens` exceed context limit`` | lower `max_tokens` and retry, keeping history |

### The bug this fixed

Copilot rejects an oversized prompt with
`Your input exceeds the context window of this model.` on a **400**. Claude
Code's classifier consults its `"context window"` test **only on a 413**, so
that 400 matched no class, produced no canonical error, and triggered no
recovery. `/compact` then re-sent the same oversized conversation and failed
identically, leaving the session unrecoverable. Adding
`"exceeds the context window"` to `CONTEXT_OVERFLOW_SUBSTRINGS` is what makes
the classification fire; emitting the token is what keeps it firing if Copilot
rewords.

## Classes not yet adopted

The contract defines more classes than the two above. Several correspond to
recoveries this repo currently hand-rolls, and routing them through the client
instead would be strictly better — the client knows how to modify and retry its
own request, the proxy is guessing:

| Class | Where we hand-roll it today |
|---|---|
| `thinking_signature` | `repairKnownThinkingHistory` (`src/routes/messages/handler.ts`) |
| `image_block` / `document_block` / `media_budget` | `src/lib/vision-preflight.ts` prune-and-learn retry |
| `effort_unsupported` | `translateThinking` clamping in `src/routes/messages/handler.ts` |
| `mid_conv_system` / `cache_control_field` | `sanitizeCacheControl` / strip rules |
| `beta_header:<value>` | `EXPLICITLY_STRIPPED_BETA_PREFIXES` in `src/lib/beta-headers.ts` |

Adopting them is deliberate follow-up work, not part of the overflow fix. Note
the ordering rule: classes are checked in the order the contract lists them, and
a wording matching more than one row takes the earlier row. Classify
conservatively — the contract is explicit that a wrong token triggers the wrong
client recovery, which is worse than the generic copy.
