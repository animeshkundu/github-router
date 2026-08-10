# Multimodal: images through the proxy, and the capability register

How images reach a model, where they used to be dropped, and the guard that
catches the next capability we forget to plumb.

See [`../CLAUDE.md`](../CLAUDE.md) for the project overview and
[`unsupported-features.md`](unsupported-features.md) for the *different*
category: Anthropic surfaces Copilot genuinely cannot serve.

## The distinction that motivates this file

`unsupported-features.md` documents things Copilot cannot do. Those degrade
loudly and on purpose. This file documents the opposite failure: **Copilot
serves a capability, the catalog advertises it, and one of our own layers
silently drops it.** An audit found six of those at once. Every model in every
review lane reports `vision: true`, and yet:

- `browser_screenshot` returned its PNG as base64 inside a JSON *text* block —
  the caller never saw the image and paid ~130x the tokens of a native image
  block for the privilege;
- the browse worker had the same loss, despite a prompt telling it to "SEE the
  page";
- worker tool results dropped every non-text part;
- the worker's `read` returned a PNG as U+FFFD mojibake;
- the peer critics had no way to accept an image at all;
- and `limits.vision.max_prompt_images` was enforced locally, even though it
  understated the upstream ceiling for most models and could fatally reject
  replayed history.

## What it costs to get this wrong

Base64 tokenizes at **~1.46 characters per token** under o200k (measured with
this repo's own encoder, not estimated):

| PNG | base64 | tokens | vs. a native image block (~1.1–1.6k) |
|---|---|---|---|
| 50 KB | 67 KB | 47k | ~30x |
| 200 KB | 267 KB | 187k | ~130x |
| 500 KB | 667 KB | 469k | ~330x |

One defect, two symptoms: outright upstream rejection above ~200 KB on
200k-context models, and a 30–330x token multiplier on every model including the
large-window ones. There is no benign regime for a real screenshot.

## How an image reaches a model

```
producer                       transport                      model
────────                       ─────────                      ─────
browser_screenshot ─┐
worker `read`       ├─→ MCP image block ─→ tool_result ─┐
browse screenshot  ─┘                                    │
                                                         ├─→ preflight ─→ wire
peer `imagePaths`  ────────────→ read + encoded here ────┘
```

**Producers.** `src/lib/attachments.ts` defines the `text | image` MCP result
union plus content-based identification. Identification is always by MAGIC
BYTES, never by file extension or a declared `media_type`: a declared type is a
caller assertion, the payload is what upstream will actually decode.

**Transport.** A tool-output wire item cannot carry an image on any endpoint. So
images extracted from a tool result are re-emitted as a synthetic follow-up user
message — the pattern the Anthropic shim has always used
(`anthropic-request.ts`), now mirrored on both worker paths (`stream-fn.ts`).
That follow-up is built at REQUEST-ASSEMBLY time and never written back to
worker state, so an image is not re-sent on every subsequent turn.

**The grouping is load-bearing, not cosmetic.** Images accumulate across a
CONTIGUOUS RUN of tool results and flush once, after the last of them:

```
tool A, tool B, user(imgA, imgB)      correct
tool A, user(imgA), tool B, user(imgB)   rejected by the provider
```

Fanning each tool result out to `[tool, user]` independently reads naturally and
is wrong: providers require the tool messages answering one assistant turn to be
contiguous, so the interjected user message orphans the following tool message
and the request is rejected outright. Any change here must keep parallel tool
calls adjacent; `tests/multimodal-producers.test.ts` asserts the exact role
sequence on both endpoints.

**Preflight.** `src/lib/vision-preflight.ts` runs once, on the fully assembled
payload, immediately before transport serialization (`createResponses` /
`createChatCompletions`). One chokepoint rather than per-adapter checks, because
images arrive through more paths than is obvious — top-level blocks, nested
`tool_result`s, the synthetic follow-up, replayed history, peer attachments —
and any adapter that forgets one fails silently.

### Preflight policy

| Situation | Behaviour |
|---|---|
| Model absent from the catalog | **Allow.** No basis to judge; upstream stays authoritative. Mirrors `modelSupportsEndpoint`. |
| Model present, `supports.vision` not true | Replace every image in place with a short text note and suppress `copilot-vision-request`. |
| Vision supported, limits absent | Apply the 3 MiB per-image size floor. There is no image-count floor. |
| Count over a learned upstream ceiling | Prune to the ceiling, keeping the most recent images and replacing the rest in place with notes. |
| Decoded size over `max_prompt_image_size` | Replace that image in place with a note. Decoded, not base64 length. |
| `media_type` absent | Replace that image in place with a note. It is never defaulted. |
| Declared type disagrees with the bytes | Replace that image in place with a note naming both. |
| Type not in `supported_media_types` | Replace that image in place with a note listing what the model accepts. |

The preflight never rejects a whole request. A fatal check against replayed
history would be fatal on every retry, because the caller cannot edit that
history. It is still deliberately not fail-open at the image level: bytes the
proxy knows are malformed are not sent. Every dropped image is replaced in
place with a stable text note, and each drop emits a warn-level log naming the
model and reason. Notes carry no ordinal or running total, so replaying the
transcript does not invalidate the prompt-cache prefix.

Image cardinality belongs to upstream. There is no local count rejection from
`max_prompt_images`. When upstream rejects for too many images, the proxy reads
the ceiling from its message, retains the most recent images up to that ceiling,
and retries once. An unparseable or second rejection is forwarded unchanged. The
learned ceiling is retained by model id only for the current process, so later
requests prune proactively without hardcoding or persisting a catalog value.

### Measured image ceilings (live API, 2026-08-10)

| Model group | Catalog says | Upstream reality |
|---|---:|---|
| `claude-opus-4.6` / `4.7` / `4.8` / `5` | 1 | >= 32; `claude-opus-5` verified at 128 |
| `claude-sonnet-4.6` / `5`, `claude-haiku-4.5` | 5 | >= 32 |
| `gpt-5.3-codex`, `gpt-5.4`, `gpt-5.4-mini`, `gpt-5.5`, `gpt-5.6-luna` / `sol` / `terra`, `gpt-5-mini` | 1 | 50 exactly |
| `gpt-4.1`, `gpt-4.1-2025-04-14`, `gpt-4o-2024-05-13` | 1 | >= 32 |
| `gemini-3.1-pro-preview`, `gemini-3.5-flash`, `gemini-3.6-flash` | 10 | 10, enforced exactly |
| `grok-4.5` | 1 | Count untested: rejects a 1x1 PNG as too small (minimum-dimension rule) |
| `gpt-4o` | 1 | Count untested: rejects PNG with "image media type not supported" |

These measurements covered all 23 vision-capable models on one machine and one
Copilot Enterprise account. They are evidence, not configuration: the design
does not depend on the values holding because it learns a ceiling from upstream
rather than hardcoding one. Upstream also enforces rules the proxy does not
model, including minimum pixel dimensions and per-model media-type support.
The per-image 3 MiB size check remains. Practical consequence: do not choose a
lane from the catalog's image-count field; the first over-ceiling request for a
model pays one upstream round trip, and later requests for that model prune
proactively.

## Peer-critic attachments (`imagePaths`)

The persona schema takes **paths, not base64**. Base64 would push megabytes
through the MCP boundary and into the caller's context — the exact cost the
screenshot fix removes — and would trip the `predictedTooLong` pre-flight. The
proxy reads and encodes server-side; caller and proxy are the same host.

Because this is a second file-reading path, it must not weaken the first. Every
path goes through `confineToWorkspaceResult` — the same chokepoint the worker's
`read`/`glob`/`grep` use — giving workspace confinement, `realpathSync.native()`
symlink resolution, the credential-shaped denylist, and rejection of UNC, device
and drive-relative Windows paths. On top of that, content identification adds a
second barrier: a file is only sent if its leading bytes are a supported image,
so a `.env` renamed to `shot.png` is refused even if it somehow passed
confinement.

Be precise about how much that second barrier is worth. It inspects only the
HEADER, so a file that begins with a valid PNG signature and carries arbitrary
data after it would pass. That is a real limitation, but not a meaningful
escalation: constructing such a file needs write access, and a caller with write
access already has `bash` and can exfiltrate directly. The check stops the
realistic case — a model pointing at a credential file, by mistake or via prompt
injection — not a determined adversary who can already write to disk. Workspace
confinement and the denylist remain the primary controls; this is defence in
depth.

## Byte budgets

Images are cheap in tokens and expensive in bytes, and they accumulate.
`capToolResultText` used to return early whenever the TEXT was under budget —
which meant an all-image result (`textBytes === 0`) was never examined at all.
It now also applies a per-result image budget (10 images / 12 MiB) and **says
what it dropped**: a model shown three of five screenshots with no indication
will reason confidently about a set it never saw.

`browser_screenshot` takes `format: "jpeg"` plus a `quality` (1–100). Be careful
what you promise about it: measured back-to-back at the same viewport on a plain
documentation page, **PNG was 35,553 bytes and JPEG q30 was 40,599** — JPEG was
14% LARGER. PNG's run-length compression wins on the flat colour that dominates
UI screenshots, and JPEG adds noise to exactly those regions. The knob is real
and useful for photographic or dense-colour content, but it is NOT a dependable
way to shrink a UI capture, and the tool description says so rather than sending
the model the wrong way. The dependable lever for an oversized capture is a
smaller browser window.

## The capability register

`src/lib/catalog-capability-register.ts` classifies every field of
`ModelSupports` / `ModelLimits`. It exists because finding six of these by hand
does not stop the seventh.

Every classification is **checked**, not asserted:

- **exhaustiveness** — field names are parsed out of `get-models.ts`, so a new
  field fails CI until someone classifies it in a reviewable diff;
- **ENFORCED** — a test MUTATES the field in a catalog fixture and asserts a
  different observable outcome. Reading a field is not enforcing it;
  `const _ = supports.vision` would satisfy a grep and enforce nothing;
- **CONSUMED** — the parent-qualified path is provably read outside the
  pretty-printer;
- **DISPLAY_ONLY** — the path appears *only* in the pretty-printer;
- **the ratchet** — `UNCLASSIFIED_CEILING` bounds the DISPLAY_ONLY + UNUSED
  population. Without it, the cheapest way to green CI when a new unenforced
  capability ships is to add it as UNUSED with a sentence of prose, which is the
  failure being guarded and which no test can falsify.

The matcher is parent-qualified (`supports.parallel_tool_calls`, not
`parallel_tool_calls`) because several capability names collide with wire fields
of the same name, and a leaf-only search counts the wire field as evidence for
the capability.

There is also a self-test asserting the checker finds a path that is genuinely
read and does not find one that is not. An earlier version shelled out to a
child process that threw on every call and returned a sentinel, so both the
DISPLAY_ONLY and CONSUMED suites passed without reading a single file. A check
that cannot fail proves nothing.

### The drift alert

The register only catches an event *we* cause, decided by the same person
filling it in. `getModels()` parses the catalog with a bare
`as ModelsResponse` cast — no runtime validation — so a capability GitHub ships
that we never typed arrives, sits on the object, and is invisible to every
type-driven check.

`scripts/check-catalog-drift.ts` compares the live catalog's capability KEY SET
against `tests/fixtures/catalog-capability-keys.json`. Keys, not values: values
churn constantly and would make it noise. It runs on a **schedule, not as a
merge gate** (`.github/workflows/catalog-drift.yml`) — it needs the network and
a token, and a network-dependent blocking check fails for reasons unrelated to
the diff under review, which is how blocking checks end up disabled. The offline
half (exhaustiveness, ratchet, fixture/register consistency) runs on every PR.

## Response-direction losses fixed alongside

Found by the same audit, in the other direction:

- **A truncated worker stream reported success.** `fetch-event-stream`'s
  `events()` returns cleanly on a premature EOF rather than throwing, so a cut
  connection was indistinguishable from a finished one. The Anthropic egress has
  guarded this since it shipped; `stream-fn.ts` never did, and synthesized
  `{type:"done", reason:"stop"}`. Both worker paths now track their terminal
  marker (`[DONE]` / `response.completed`) and fail loudly, preserving whatever
  partial text did arrive.
- **Refusals rendered as empty successful messages.** `message.refusal` /
  `delta.refusal` are siblings of `content`, so reading only `content` produced
  an empty message. Now surfaced as text.
- **`content_filter` mapped to `end_turn`**, making a safety block
  indistinguishable from a normal completion. Now Anthropic's `refusal`
  stop_reason on the shim, and a distinct terminal error on the worker path.

## Known gaps, deliberately not closed here

- **`document` / PDF blocks are dropped inside a `tool_result`** though handled
  at top level. Excluded because it was the only item with no cited failure
  behind it, and it would drag the preflight, probe inventory and media-type
  surface from images to documents. PDF on the chat path degrading to a text
  note is separate, deliberate, and already probed both ways.
- **`limits.max_output_tokens` has a default-fill but no ceiling**, so an
  explicitly oversized `max_tokens` passes through.
- **`bucketEffort` uses hardcoded 2000/8000/24000 thresholds** and never
  consults `min/max_thinking_budget`.
- **The image gate is header-only.** `detectImageMimeType` reads a signature,
  so a file with a valid image header and arbitrary appended data passes. Real
  DLP semantics would mean decoding and re-encoding the image to strip trailing
  payload; that is a new dependency and was judged out of scope, since producing
  such a file already requires write access. See the threat-model note above.
- **`src/lib/tokenizer.ts` costs an `image_url` part as
  `encode(url).length + 85`.** The `+85` assumes a short remote URL; for a
  `data:` URL it tokenizes the entire base64 payload, so local token estimates
  for inline images are wrong by orders of magnitude.
- **No drop-path logging anywhere in `src/lib/anthropic-translate/`** — six
  consola calls total, none about dropped content.
