# Prompt and token caching: VS Code Copilot, Copilot CLI, and github-router

**Status:** research record; bounded non-policy follow-up applied below
**Lookup date:** 2026-09-01
**Scope:** provider-side prompt/prefix caching, cache-control and breakpoints, prompt-prefix stability, local session persistence, compaction, model-specific behavior, and safe improvements for `github-router`.

The companion HTML presentation is [`prompt-cache-upstream-comparison.html`](prompt-cache-upstream-comparison.html).

## Executive conclusion

Caching in these systems is three different mechanisms:

1. **Prefix construction and hygiene.** The client chooses the byte order and contents of tools, instructions, history, and the current turn. A change early in the rendered request can invalidate later reusable content.
2. **Provider-side prompt/KV caching.** The upstream model service reuses a matching prefix or a marked cache boundary. `cache_control`, `prompt_cache_options`, `prompt_cache_breakpoint`, and `prompt_cache_key` are request controls. They are not local copies of provider KV state.
3. **Local session persistence.** Transcripts, tool results, plans, checkpoints, model identifiers, and cache-expiry metadata can survive a process restart. Restoring those records does not prove that the provider cache is warm.

The strongest conclusion about cross-session behavior is therefore:

> A resumed session restores local history, but must be treated as provider-cache cold until provider-reported usage demonstrates a warm read.

The evidence does **not** support a blanket cache-control change. VS Code has a mature, public, provider-aware implementation. Copilot CLI's internal request builder is closed, so its current request construction cannot be verified from the public CLI repository. `github-router` already has an important conservative distinction: explicit Responses caching is used for discrete reusable-prefix calls, while growing conversations remain provider-managed after a measured regression showed that a static system-only breakpoint can reduce useful history reuse.

---

## Evidence and version pins

### `github-router`

- Repository baseline: commit `8253216`.
- Package version at the research baseline before the safe follow-up: `0.3.303`; current working-tree version after the follow-up: `0.3.304`.
- Relevant local source and test paths are listed throughout this document.
- Existing design record: [`docs/prompt-caching.md`](../prompt-caching.md).
- Existing companion HTML record: [`docs/research/prompt-cache-upstream-comparison.html`](prompt-cache-upstream-comparison.html).

### VS Code

The former [`microsoft/vscode-copilot-chat`](https://github.com/microsoft/vscode-copilot-chat) repository is archived. Current Copilot implementation lives in the VS Code repository.

- Reproducible stable release pin: VS Code `1.135.0`, commit [`08d4889f9ec4a1685d257b9b95de036c8e1ce1e5`](https://github.com/microsoft/vscode/commit/08d4889f9ec4a1685d257b9b95de036c8e1ce1e5).
- Latest public source inspected for post-release changes: commit [`eb84d8148027eb14978437cab306074c5be3cac2`](https://github.com/microsoft/vscode/commit/eb84d8148027eb14978437cab306074c5be3cac2), source package version `1.137.0` at lookup time.
- Relevant source paths were checked at the public tip unless a stable release is explicitly named.

### Copilot CLI

- Stable release: [`v1.0.82`](https://github.com/github/copilot-cli/releases/tag/v1.0.82), commit [`024bf28728f3cc82365e0143f44d071ebafbce4d`](https://github.com/github/copilot-cli/commit/024bf28728f3cc82365e0143f44d071ebafbce4d), published 2026-08-29.
- Latest public prerelease checked: [`v1.0.83-0`](https://github.com/github/copilot-cli/releases/tag/v1.0.83-0), commit [`be82101e70f0253b57519bebb9cc9d0f6dfb2ed2`](https://github.com/github/copilot-cli/commit/be82101e70f0253b57519bebb9cc9d0f6dfb2ed2), published 2026-08-31.
- The locally installed CLI reported `1.0.74`, so it was not used as evidence for current release behavior.

---

## 1. VS Code Copilot implementation

### 1.1 Rolling cache-breakpoint allocation

Source: [`extensions/copilot/src/extension/intents/node/cacheBreakpoints.ts`](https://github.com/microsoft/vscode/blob/eb84d8148027eb14978437cab306074c5be3cac2/extensions/copilot/src/extension/intents/node/cacheBreakpoints.ts).

The public implementation defines `MaxCacheBreakpoints = 4` and `addCacheBreakpoints(messages, apiType)`.

The algorithm:

1. Removes breakpoint markers from messages unsupported by the selected API.
2. Counts existing markers and allocates the remaining capacity.
3. Scans recent messages backward.
4. Prefers the newest tool result in a contiguous tool-result group, current user content, and assistant messages without tool calls.
5. Falls back to leading system/user content if capacity remains.

The source comment describes the intended prompt order as:

```text
system
custom instructions
global context
history
current user message and context
current tool-call rounds
```

The same comment explicitly says that a new turn generally incurs a cache miss because the previous current-turn content moves relative to the current user boundary. During a tool loop, the previous tool result can remain a cache hit. These are source comments describing the expected provider behavior, not a local KV-cache implementation.

API-specific eligibility is important:

- For `apiType === "responses"`, assistant messages are not marked. Text, image, document, and opaque `input_text`, `input_image`, and `input_file` blocks are eligible.
- For other API types, assistant content can be eligible. The accepted opaque types include the Chat/Anthropic-shaped `text`, `image_url`, `input_audio`, `file`, and `refusal` forms.

Tests at [`extensions/copilot/src/extension/intents/node/test/cacheBreakpoints.spec.ts`](https://github.com/microsoft/vscode/blob/eb84d8148027eb14978437cab306074c5be3cac2/extensions/copilot/src/extension/intents/node/test/cacheBreakpoints.spec.ts) cover API-specific supported content, removal of unsupported markers, and preservation of supported markers.

### 1.2 Anthropic Messages API markers and TTL

Source: [`extensions/copilot/src/platform/endpoint/node/messagesApi.ts`](https://github.com/microsoft/vscode/blob/eb84d8148027eb14978437cab306074c5be3cac2/extensions/copilot/src/platform/endpoint/node/messagesApi.ts).

`createMessagesRequestBody` converts the internal raw representation to Anthropic `system` and `messages` blocks, then applies cache markers. The relevant helpers are:

- `clearAllCacheControl` at approximately lines 586-604: deletes existing system/message marker fields before recomputation.
- `addToolsAndSystemCacheControl` at approximately lines 606-634: marks the last non-deferred tool and final system block.
- `addMessagesApiCacheControl` at approximately lines 636-676: marks the last cacheable block in each of the two most recent cacheable messages.

The normal marker is:

```json
{ "type": "ephemeral" }
```

When extended TTL gates pass, the marker is:

```json
{ "type": "ephemeral", "ttl": "1h" }
```

The source comments state that the default path uses the provider's normal five-minute ephemeral behavior and that the one-hour form requires an Anthropic beta header. The one-hour path is separately gated by model family, experiment state, `ChatLocation.Agent`, and non-subagent status. Short-lived subagent requests are excluded from the extended TTL path.

The internal marker representation is defined in [`endpointTypes.ts`](https://github.com/microsoft/vscode/blob/eb84d8148027eb14978437cab306074c5be3cac2/extensions/copilot/src/platform/endpoint/common/endpointTypes.ts):

```ts
CustomDataPartMimeTypes.CacheControl = 'cache_control';
CacheType = 'ephemeral';
```

The built-in Anthropic converter maps that internal sentinel to Anthropic `cache_control`; it is not a public VS Code API. VS Code issue [#313920](https://github.com/microsoft/vscode/issues/313920) and the July 2026 fixes show why unsupported BYOK providers must fail closed rather than receive an internal marker they cannot consume.

### 1.3 OpenAI Responses API mode, key, and compaction

Source: [`extensions/copilot/src/platform/endpoint/node/responsesApi.ts`](https://github.com/microsoft/vscode/blob/eb84d8148027eb14978437cab306074c5be3cac2/extensions/copilot/src/platform/endpoint/node/responsesApi.ts).

The request body can contain:

```json
"prompt_cache_options": {
  "mode": "explicit"
}
```

or:

```json
"prompt_cache_options": {
  "mode": "implicit"
}
```

The capability helper [`modelSupportCacheBreakPoints`](https://github.com/microsoft/vscode/blob/eb84d8148027eb14978437cab306074c5be3cac2/extensions/copilot/src/platform/endpoint/common/chatModelCapabilities.ts#L333-L340) currently returns `isGpt56(model)`. The public implementation therefore does not treat every OpenAI-compatible model as eligible for explicit Responses breakpoints.

Internal cache markers become:

```json
"prompt_cache_breakpoint": {
  "mode": "explicit"
}
```

on the immediately preceding supported content block. Assistant output and function-call items are deliberately not marked. The relevant conversion is `rawContentToResponsesContentList` in `responsesApi.ts`.

An optional cache key is emitted only when its experiment is enabled and a conversation ID exists:

```ts
body.prompt_cache_key = `${options.conversationId}:${endpoint.family}`;
```

The same request sets `store: false`. The key is therefore a provider-facing association/control value. The source does not establish that reusing the key after a process restart guarantees a provider cache hit or that it stores prompt bytes locally.

Responses compaction is a separate protocol. `getResponsesApiCompactionThreshold` uses approximately:

```ts
Math.floor(endpoint.modelMaxPromptTokens * 0.9)
```

with a 50,000-token fallback. The body can include:

```json
"context_management": [
  {
    "type": "compaction",
    "compact_threshold": 900000
  }
]
```

The converter also reconstructs `previous_response_id` and round-trips encrypted compaction items. These are provider/API continuation mechanisms, not proof of cache persistence across independent sessions.

### 1.4 Prefix stability and dynamic context placement

Source: [`extensions/copilot/src/extension/prompts/node/agent/agentPrompt.tsx`](https://github.com/microsoft/vscode/blob/eb84d8148027eb14978437cab306074c5be3cac2/extensions/copilot/src/extension/prompts/node/agent/agentPrompt.tsx).

The first-turn customizations index is snapshotted and reused. When the current value differs, the live value is rendered as a drift block in the latest user message rather than rewriting the system prompt. The source comment identifies this as protection for the system-prompt cache.

This is a high-value pattern for the proxy:

- freeze stable system material;
- move changing state toward the tail;
- do not rewrite the stable prefix merely to reflect per-turn state.

The Copilot CLI prompt adapter in [`copilotCLIPrompt.tsx`](https://github.com/microsoft/vscode/blob/eb84d8148027eb14978437cab306074c5be3cac2/extensions/copilot/src/extension/prompts/node/agent/copilotCLIPrompt.tsx) puts the user request first and conditionally appends reminder, attachment, edited-file context, and a repeated query tag. Its comment says frozen content should be used when available, but the shown resolver renders current request variables and edited-file events. Resource rendering uses `Promise.all` and pushes into a shared array. The source does not establish deterministic completion-order insertion for multiple resources. This is a stability risk to probe, not proof that every live request is unstable.

### 1.5 Cache Explorer and usage evidence

Cache Explorer is a diagnostic view, not a request transformer. Source: [`chatDebugCacheExplorerView.ts`](https://github.com/microsoft/vscode/blob/eb84d8148027eb14978437cab306074c5be3cac2/src/vs/workbench/contrib/chat/browser/chatDebug/chatDebugCacheExplorerView.ts).

It reads recorded model-turn events and displays:

- provider-reported `inputTokens` and `cachedTokens`;
- cache percentage and uncached remainder;
- request model, duration, timestamp, and request group;
- system, tools, request-options, and message differences;
- the first likely divergence point between adjacent requests.

It does not modify request options, prompts, tools, continuation IDs, or cache settings.

### 1.6 Local transcript and cache status persistence

VS Code persists conversation transcripts separately from provider cache state. The Copilot extension's [`sessionTranscriptService.ts`](https://github.com/microsoft/vscode/blob/eb84d8148027eb14978437cab306074c5be3cac2/extensions/copilot/src/extension/chat/vscode-node/sessionTranscriptService.ts) writes JSONL records for session starts, user/assistant messages, tool calls/results, and turn boundaries.

Agent Host persists a small prompt-cache status slot. [`sessionState.ts`](https://github.com/microsoft/vscode/blob/eb84d8148027eb14978437cab306074c5be3cac2/src/vs/platform/agentHost/common/state/sessionState.ts#L1395-L1422) defines:

```ts
{
  modelId: string;
  cacheExpiresAt: string;
}
```

under `_meta["vscode.promptCache"]`. [`agentHostPromptCache.ts`](https://github.com/microsoft/vscode/blob/eb84d8148027eb14978437cab306074c5be3cac2/src/vs/platform/agentHost/node/agentHostPromptCache.ts) reads and writes this metadata and avoids a write when the two fields are unchanged. It does not store prompt content, provider cache keys, or KV tensors. The expiry notification code schedules local UI behavior from `cacheExpiresAt`; it does not enforce provider eviction.

The official [Cache Explorer documentation](https://code.visualstudio.com/docs/agents/agent-troubleshooting/cache-explorer) says providers reuse a matching request prefix, that caches expire after inactivity, and that changing model, reasoning effort, context size, tools, or MCP servers can rebuild the cache. It does not specify a contractual TTL, cache capacity, tenant scope, eviction algorithm, or cross-process provider-cache guarantee.

---

## 2. Copilot CLI: public evidence and limits

### 2.1 The current CLI request builder is not public

The public [`github/copilot-cli`](https://github.com/github/copilot-cli) repository currently exposes documentation, changelog, installer, and workflow files. Its recursive tree has no CLI `src/`, `lib/`, request-builder, prompt-assembly, or test directory. The executable release artifact is the remaining implementation surface, but reverse-engineering a binary does not provide a stable source-level contract.

The public [`github/copilot-sdk`](https://github.com/github/copilot-sdk) is useful but is a transport/session layer, not the closed CLI's provider prompt builder. The Node SDK call chain is:

```text
CopilotClient.createSession / resumeSession
  -> session.create / session.resume JSON-RPC
CopilotSession.send
  -> session.send JSON-RPC
optional requestHandler
  -> llmInference.setProvider
  -> httpRequestStart/httpRequestChunk frames
  -> createCopilotRequestAdapter
  -> buildFetchRequest
  -> sendRequest
```

The SDK's `buildFetchRequest` reconstructs opaque request-body chunks and does not parse and reserialize the JSON body. That verifies that this bridge is not the source of canonicalization in an intercepted request. It does not show how the closed CLI produced the bytes.

### 2.2 Provider cache controls visible through issue/changelog evidence

CLI issue [#4185](https://github.com/github/copilot-cli/issues/4185) reports Anthropic `cache_control` breakpoints and a historical five-marker failure when `--add-dir` was used. The v1.0.73 changelog records the related Anthropic subagent fix. The issue also reports no equivalent `cache_control` field on GPT subagent requests.

This is useful evidence that the CLI has had provider-specific cache-control handling, but it does not establish current v1.0.82 or v1.0.83-0 marker placement, TTL, or exact request shape.

Open issue [#3808](https://github.com/github/copilot-cli/issues/3808) requests explicit Anthropic breakpoints, configurable five-minute/one-hour TTL, and cache status reporting. Its open status indicates that these are not a documented public CLI contract. It does not prove that no private implementation exists.

### 2.3 Session persistence and compaction

The public SDK session-persistence documentation states that resumable state can live under:

```text
~/.copilot/session-state/{sessionId}/
```

and includes conversation history, tool-call results, planning state, checkpoints, and session artifacts. Provider/API keys and in-memory tool state are not persisted. A resumed session can therefore reconstruct the prompt without restoring provider KV state.

The public CLI context-management documentation says:

- automatic summarization begins at approximately 80% context usage;
- a buffer is reserved near approximately 95%;
- `/compact` starts manual compaction;
- old history is replaced by a summary while original instructions and current plan state are retained;
- compaction creates numbered checkpoints.

Those are local/session context-management semantics. The docs do not specify provider cache TTL or cross-process provider-cache reuse.

The SDK protocol models cache-read/write usage, model IDs, cache expiration, and usage checkpoints. These fields are accounting/status metadata, not serialized provider KV state.

### 2.4 History reserialization warning

Open issue [#4500](https://github.com/github/copilot-cli/issues/4500) reports that a BYOK OpenAI Responses completion-nudge path rebuilt the whole `input` array from parsed state instead of replaying prior items byte-for-byte. The reporter measured cached tokens falling from 114,688 to 5,632 on a 100K-token conversation.

This report is not proof of a current v1.0.83-0 defect:

- it concerns CLI 1.0.79;
- no current public request-builder source is linked;
- no linked fix or maintainer confirmation establishes present behavior.

It is nevertheless a concrete failure mode for any proxy that reparses and reserializes growing history. It should be included in the proxy's replay regression matrix.

### 2.5 What remains unverified

Public material does not establish:

- current CLI cache-marker placement;
- current CLI cache TTL selection;
- whether normal CLI requests set `prompt_cache_key`;
- exact JSON serialization/canonicalization in current releases;
- whether provider cache state survives CLI shutdown and resume;
- whether a session ID is also a provider cache key;
- universal behavior across Claude, GPT, Gemini, and Grok models.

---

## 3. `github-router` baseline

The baseline below describes the pre-follow-up tree at commit `8253216` and package version `0.3.303`; the applied, non-policy follow-up is listed in §6.

### 3.1 Current policy matrix

The local design record and implementation establish this policy:

| Route/workload | Current behavior | Evidence status |
|---|---|---|
| Native Claude `/v1/messages` public passthrough | Preserve caller-owned `cache_control`; do not synthesize a router policy. | Source-backed in [`src/routes/messages/handler.ts`](../../src/routes/messages/handler.ts) and beta policy docs. |
| Router-owned Claude calls | Mark the last non-deferred tool and/or stable system boundary, each independently gated by a 4,096 UTF-8-byte floor; at most two markers. | Source-backed in [`src/lib/prompt-cache.ts`](../../src/lib/prompt-cache.ts). |
| GPT-5.6 `/responses`, `reusable-prefix` | Add explicit mode, stable breakpoint, opaque hashed key, and `ttl: "30m"` when eligible. | Source-backed; compatibility probe ID is referenced by the helper. |
| GPT-5.6 `/responses`, growing `conversation` | Leave explicit mode off and rely on Copilot provider-managed behavior. | Source-backed policy plus local live regression measurement. |
| GPT-5.5, older GPT, Codex | Provider-managed behavior only. | Source-backed policy; provider effectiveness needs measurement. |
| Gemini Chat and Grok Responses | Provider-managed behavior only; absent cache counters are inconclusive in the probe. | Source-backed policy and honest probe semantics. |
| Public OpenAI-compatible routes | Caller-owned fields pass through; no router-generated policy. | Source-backed boundary. |

### 3.2 The growing-history safeguard

`applyResponsesCachePolicy` in [`src/lib/prompt-cache.ts`](../../src/lib/prompt-cache.ts) intentionally excludes `workload: "conversation"`.

The local design record [`docs/prompt-caching.md`](../prompt-caching.md) records a controlled gpt-5.6-sol experiment in which explicit marking of only a roughly 2K-token stable system block produced:

- cold turn: approximately 27K input tokens, around 2K cache write;
- warm turns: around 2K cache read while around 25K of accumulating history was recomputed each turn.

The measured failure was not a total cache miss. A test that only asserted a nonzero warm read would have passed it. The probe instead calculates per-warm-turn coverage:

```text
(cache_read_input_tokens + cache_creation_input_tokens)
/ (input_tokens + cache_creation_input_tokens + cache_read_input_tokens)
```

The documented strict target is a 0.90 mean for native Claude and GPT-5.6 trials. This correctly distinguishes whole-growing-history reuse from a small static-prefix hit. The exception should remain until a new measurement demonstrates a better policy.

### 3.3 Request assembly and replay identity

The shared [`src/services/copilot/responses-request.ts`](../../src/services/copilot/responses-request.ts) builder is used by both the Anthropic translation shim and worker Responses traffic. It maps neutral messages, images/documents, tools, effort, stop sequences, and parallel-tool policy into one Responses shape.

The translated Claude main loop passes `workload: "conversation"`, so it does not receive the reusable-prefix explicit policy. Discrete peer/advisor/worker-tool/browser-compressor calls can pass `workload: "reusable-prefix"`.

`responsesCacheKey` hashes:

- namespace;
- resolved model;
- workload;
- optional scope;
- stable prefix;
- tools.

It intentionally excludes dynamic/user messages. This is a router-owned key convention, not evidence about Copilot's internal namespace. Endpoint, catalog revision, and backend identity are also not included, so those dimensions should not be changed speculatively. Their relevance belongs in the measurement plan.

`resolveModelInBody` in [`src/routes/messages/handler.ts`](../../src/routes/messages/handler.ts) reparses and serializes only when resolution, thinking translation, sanitization, or another body change is needed. Preserving an unchanged public body is important: unconditional canonicalization can change prefix bytes even when semantics are equivalent.

### 3.4 Usage accounting and observability

`normalizeOpenAIUsage` in [`src/lib/prompt-cache.ts`](../../src/lib/prompt-cache.ts) converts inclusive OpenAI input totals into disjoint uncached, cache-read, and cache-write buckets.

Native Anthropic usage already separates:

- `input_tokens`;
- `cache_read_input_tokens`;
- `cache_creation_input_tokens`.

The router's request log sums the disjoint buckets for total input. The local design record gives a controlled native-Claude example in which a cold prefix reported a cache write and the immediately following warm prefix reported a matching cache read.

`GH_ROUTER_LOG_CACHE=1` logs bounded component hashes and byte lengths, not prompt contents, cache keys, paths, or user identifiers. This diagnoses structural drift but does not yet provide durable per-model cache ratios, effective cache cost, TTL, or latency correlation.

The catalog parser in [`src/services/copilot/get-models.ts`](../../src/services/copilot/get-models.ts) reads context, prompt, output, endpoint, reasoning, vision, and billing token-price fields, including cache-related price fields. The worker catalog view in [`src/lib/worker-agent/model-resolve.ts`](../../src/lib/worker-agent/model-resolve.ts) intentionally exposes only the ordinary input/output price observations; cache-price field semantics remain unverified and are not surfaced to the model. Worker usage mapping still does not retain all cache TTL metadata; the route-level request log now retains and displays positive provider-reported TTL values on supported non-streaming OpenAI-shaped responses.

Worker context management is structural and send-time:

- [`src/lib/worker-agent/context-budget.ts`](../../src/lib/worker-agent/context-budget.ts) sizes thresholds from the effective input ceiling (the stricter valid context/prompt metadata) and has a 128K fallback;
- [`src/lib/worker-agent/compaction.ts`](../../src/lib/worker-agent/compaction.ts) clones before pruning and preserves tool-call/result pairing;
- [`src/lib/worker-agent/stream-fn.ts`](../../src/lib/worker-agent/stream-fn.ts) applies a request-boundary guard.

Worker agents do not attach Pi's durable JSONL session backend, so worker transcripts and cache statistics are not durable across worker restarts.

### 3.5 Existing tests and probe

Relevant local tests include:

- [`tests/prompt-cache.test.ts`](../../tests/prompt-cache.test.ts): usage normalization, GPT-5.6 policy, Claude marker placement, byte floors, caller-owned markers, and no conversation-level explicit marking.
- [`tests/cache-probe.test.ts`](../../tests/cache-probe.test.ts): target selection, strict/provider-managed verdicts, and growing-history coverage.
- [`tests/worker-agent-context-mgmt.test.ts`](../../tests/worker-agent-context-mgmt.test.ts): model-window budgets, cloning, pairing preservation, truncation, and fallback behavior.
- [`tests/anthropic-translate-request.test.ts`](../../tests/anthropic-translate-request.test.ts): translated conversations and request-field forwarding.
- [`tests/messages-handler.test.ts`](../../tests/messages-handler.test.ts): native Claude cache usage and total-input accounting.

The live harness is [`scripts/probe-prompt-cache.ts`](../../scripts/probe-prompt-cache.ts), invoked only with:

```bash
GH_ROUTER_RUN_CACHE_PROBE=1 bun run probe:cache
```

It uses synthetic prompts, fresh salts between trials, sequential turns, and per-model verdict classes. Strict native Claude/GPT targets require cache usage fields and a coverage threshold. Gemini/Grok or other providers with absent fields are reported as inconclusive rather than passed. The harness documents limitations including single-account/time sampling, disabled tools in controlled trials, inability to identify the exact reused boundary, and hidden pre-first-byte retries that can warm a cold trial.

---

## 4. Direct comparison

| Dimension | VS Code Copilot | Copilot CLI | `github-router` |
|---|---|---|---|
| Anthropic markers | Public rolling allocation up to four; normal ephemeral and gated one-hour TTL. | `cache_control` is visible in issue evidence; current placement and TTL are not public. | Caller controls preserved; router-owned internal calls use at most two bounded markers. |
| Responses explicit mode | Public mode field and marker conversion; explicit capability currently gated to GPT-5.6. | Current builder closed; public evidence insufficient. | Explicit fields only for discrete GPT-5.6 reusable-prefix calls. |
| Cache key | Optional `conversationId:endpoint.family` behind an experiment; `store: false`. | Not established. SDK session ID is not proof of a provider key. | Opaque hash over model/workload/scope/stable prefix/tools for owned reusable-prefix calls. |
| Stable-prefix construction | Snapshots customization state and moves drift into a later user block; separates non-deferred tools first. | Closed request path; issue #4500 warns about one older replay path. | Separates dynamic/stable material, preserves unchanged public bodies where possible, and has opt-in component signatures. |
| Local persistence | JSONL transcripts plus `_meta["vscode.promptCache"]` status/expiry metadata. | `~/.copilot/session-state` history, tool results, plans, checkpoints, artifacts. | Claude history directories are shared through config mirroring; worker transcripts are in memory. |
| Provider-cache survival after restart | Not established. | Not established. | Not established; resumed state is treated as cold until usage proves otherwise. |
| Compaction | Responses provider compaction plus local summarized history. | Summary replacement and checkpoints. | Structural worker compaction; translated Responses compaction forwarding remains unprobed. |
| Effectiveness telemetry | Cache Explorer uses cached-token counters and prompt-signature diffs. | `/usage`, OpenTelemetry, and SDK usage checkpoints expose accounting/status. | Per-request counters, cache probe, and signature logger; durable price/TTL/model analytics incomplete. |

---

## 5. Evidence classification

| Claim type | Examples in this record |
|---|---|
| **Implemented and enabled** | `github-router`'s growing-conversation exclusion; VS Code's marker conversion and cache-option construction; local transcript/session persistence code; the follow-up's effective input ceiling and scoped TTL observation. |
| **Implemented but gated** | VS Code one-hour Anthropic TTL; VS Code Responses explicit mode and cache key; `github-router` GPT-5.6 reusable-prefix policy. |
| **Emitted, upstream acceptance measured or partially measured** | Router Responses explicit fields on the compatibility probe; native Claude usage counters and the documented controlled warm-read example. |
| **Documented only** | Provider prefix matching and inactivity expiry where no source-level TTL/eviction contract is provided; Copilot CLI compaction thresholds. |
| **Issue-reported / historical** | CLI #4185's five-marker failure and CLI #4500's history reserialization/cache drop. |
| **Unverified** | Cross-process provider KV survival; universal provider TTL; current closed CLI request-builder behavior; whether cache keys are sufficient across sessions. |

---

## 6. Safe improvements versus probe-gated work

This section is an assessment boundary, not an approval to emit new request fields.

### Safe to consume or preserve now

1. **Keep the growing-history exception.** It is backed by a local controlled measurement and prevents a static explicit breakpoint from suppressing useful provider-managed growth.
2. **Keep preserving caller-owned public bodies and cache layouts.** This avoids an unnecessary serialization change and respects caller/provider-specific policy.
3. **Keep stable material before dynamic material.** The shared Responses builder already has a `dynamicInstructions` tail concept; future prompt changes should follow it.
4. **Keep usage buckets disjoint.** OpenAI inclusive totals must not be added to cached-token buckets a second time; native Anthropic counters must be summed only where the API defines them as disjoint.
5. **Keep absent provider metrics inconclusive.** A provider that does not expose cache counters cannot be treated as a measured miss or pass by counter inspection alone.
6. **Keep cache diagnostics bounded and redacted.** Component hashes and byte lengths are useful; raw prompt text, credentials, cache keys, and user identifiers do not belong in routine logs.

These are maintenance constraints already reflected in the code and do not require a production request-shape change.

### Candidate improvements requiring repository audit and tests

The following are promising, but should be implemented only after checking the current branch and adding focused tests:

1. **Catalog-driven explicit-cache capability.** Replace the fixed GPT-5.6 ID set only if the live catalog exposes a reliable explicit-cache capability with endpoint/model semantics. Otherwise retain the allowlist and make additions compatibility-probe gated.
2. **Cache economics in worker diagnostics.** Carry valid `cache_price`, `cache_read_price`, `cache_write_price`, and `cache_ttl_seconds` into bounded diagnostic data. Do not expose them in every model-facing worker result unless a caller can act on them.
3. **Worker prompt ceiling.** Compare worker context budgeting against both `max_context_window_tokens` and `max_prompt_tokens`; use the stricter known ceiling while preserving the unknown-metadata fallback. This is a safety/accounting change, not a cache marker change.
4. **Replay-byte regression coverage.** Add tests that prove unchanged history remains byte-stable across model resolution, nudge, retry, and translation paths. A test should compare the overlapping serialized request prefix after removing only intentionally moving marker fields.
5. **Responses compaction probe.** Test Copilot acceptance and stream/continuation semantics for `context_management` before adding it to the translated shim.
6. **Per-model effectiveness ledger.** Store bounded numeric observations for cache reads/writes, total input, TTL, model, endpoint, and latency. Keep prompt bodies and user data out of the ledger and label provider-missing fields as unknown.

### Improvements safely consumed in this follow-up

The branch audit applied only changes that do not broaden provider request policy:

- Worker model resolution and catalog inspection use the same stricter valid input ceiling: `min(max_context_window_tokens, max_prompt_tokens)` when both are present, or whichever valid limit exists. A valid prompt limit is also usable when the total-window field is absent; invalid limits preserve the existing fallback behavior.
- Request logs now carry a positive provider-reported `cache_ttl_seconds` observation and append `ttl:<seconds>s` beside the cache read/write counters on supported non-streaming OpenAI-shaped responses. Streaming responses and native Anthropic routes may omit this metadata and remain unknown. The router does not infer or synthesize it; only positive finite TTL values are retained for the summary.
- Cache-price fields are intentionally not exposed in the model-facing worker catalog until the live field semantics are verified.
- The compatibility matrix and probe registry now say the GPT-5.6 explicit shape is for `reusable-prefix` calls only, matching the measured growing-history exclusion.
- Focused verification passed: 227 tests across six cache/worker files, TypeScript typecheck, and full lint. Package version was bumped from `0.3.303` to `0.3.304`.
- The family-validation harness was then hardened without changing production policy: missing OpenAI-shaped cache buckets now remain `UNAVAILABLE_OPENAI` rather than being mislabeled as a total mismatch, and incomplete pairs preserve independently computed output equivalence. Focused tests passed 72/72, followed by the full two-lane suite and the isolated Windows mirror suite.

These changes preserve the existing growing-conversation provider-managed policy and do not add a new upstream body field or header.

### 6.1 Family validation results

The final tie-inclusive happy-path run used plan hash `13b76578942edd358cdd5fa846a65d939c769828ea5efb11bbe1da0266834fb5` and completed all 48 calls without a cap violation. A separate 32-call edge run also completed without a cap violation, for 80 live model calls total. Results are within-model and use documented default-tier rates only for indicative arithmetic:

| Family and candidate | Valid repetitions | Result | Observation |
|---|---:|---|---|
| OpenAI / GPT-5.6 Luna | 3/3 | `VALIDATED_REUSE_POLICY_INCONCLUSIVE` | Policy reuse 95.7156% (95.72% rounded) versus control reuse 95.7130% (95.71% rounded); this effectively tied result did not demonstrate an incremental router-policy benefit over upstream automatic caching. |
| Anthropic / Claude Haiku 4.5 | 3/3 | `VALIDATED_POLICY_IMPROVEMENT` | Policy reuse 99.35% and control reuse 0%; the existing explicit marking was supported. |
| Google / Gemini 3.6 and 3.7 Flash | 0/6 | `INCONCLUSIVE` | Matching `OK` outputs and warm cached-token observations, but Chat responses omitted cache-write telemetry. Missing counters were not treated as zero. |
| xAI / Grok 4.5 and 4.6 | 0/6 | `INCONCLUSIVE` | Matching `OK` outputs and warm cached-token observations, but the catalog-selected Responses route in this run omitted cache-write telemetry; some cold turns also showed cached tokens. |

The edge run used plan hash `ae23b42dfe05d8e834735028a878f14f3c08661a71c5ff9f9fa1878ed93a7a25` and completed without a cap violation for Luna and Haiku. The sub-threshold guard, conversation no-op, early-prefix perturbation, and suffix-only mutation were all `EXPECTED` for both candidates. These observations do not establish fresh-process cache survival, streaming/non-streaming parity, near-ceiling behavior, or actual invoice savings.

The Google/xAI artifact initially labeled absent cache-write tuples `INVALID_OPENAI`; that was a harness label collapse, not evidence of a total-token arithmetic failure. The harness now reserves `INVALID_OPENAI` for malformed supplied counters or a genuine reported-total mismatch and uses `UNAVAILABLE_OPENAI` for missing structural telemetry. It still leaves those families inconclusive because a missing write bucket prevents complete exclusive accounting and contamination checks.

All results remain one-account, one-time observations. No cross-family cost ranking, actual billed-dollar claim, or provider-policy broadening follows from them.

### Not safe to consume without new evidence

- Applying explicit Responses caching to all models.
- Applying the static system-only breakpoint to growing conversations.
- Assuming Anthropic, GPT, Gemini, and Grok share TTL, key, or breakpoint semantics.
- Assuming `conversationId`, `prompt_cache_key`, or a local session ID restores provider KV state after restart.
- Globally sorting or reserializing caller-owned JSON to make it “canonical.”
- Adding a router-side prompt/KV cache intended to restore provider state.
- Treating latency alone as proof of a cache hit.

---

## 7. Required direct-versus-proxy measurement matrix

Run with the same account, model, endpoint, payload shape, and timing where possible. Capture credentials and user data only in redacted/ephemeral diagnostics.

| Case | Controlled difference | Required observation | Interpretation |
|---|---|---|---|
| Exact repeat | Same model, endpoint, tools, system, history, suffix | Provider cached-token or billing signal | Establishes warm reuse when the provider reports it. |
| Changed suffix | Only final user text changes | Earlier prefix remains reusable | Detects early dynamic injection or full-history rebuild. |
| Changed early prefix | One system/tool byte changes | Coverage falls at/after the change | Confirms prefix sensitivity. |
| Growing tool loop | Append one tool result, preserve all prior bytes | Reuse grows or provider exposes its own rolling boundary | Distinguishes useful growth from static-only caching. |
| Process restart/resume | Restore local history and same logical session | History restoration separately from provider warm signal | Never infer provider persistence from local resume. |
| Model switch | Same history, different model | Local history may persist; cache coverage resets | Confirms model-scoped cache boundary. |
| Idle gap | Same prefix after controlled intervals | Expiry/TTL where reported | Do not hard-code an interval without a contract. |
| Streaming/non-streaming | Same payload, transport mode changed | Usage and request fields remain interpretable | Detects usage-shape and retry differences. |
| Tools/MCP change | Add/remove/reorder one tool | Cache boundary and request bytes | Measures the cost of tool-set drift. |

The existing `probe:cache` harness covers much of this matrix. It should be extended only where a missing dimension answers a concrete policy question, and every new request field must also follow the compatibility-probe rule in `CLAUDE.md`.

---

## 8. Compatibility and regression obligations

Any production request-shape change must satisfy the repository rules:

1. Add a row to `scripts/probe-copilot-compat.sh` for every new emitted field, header, body shape, or tool type.
2. Add the corresponding accept/reject expectation to `docs/copilot-compat-matrix.md`.
3. For a strip-rule change, add an end-to-end probe showing the user-facing behavior enabled by the strip and reference that probe from the code comment.
4. Preserve the stream lifecycle regression requirement for every changed `enqueue`, `close`, or `reader.read` path.
5. Run focused tests first, then the full Windows-first test matrix before declaring the change complete.
6. Include a package patch bump for any production PR.

For caching specifically, the minimum regression assertions should cover:

- caller-owned marker layout is unchanged;
- public passthrough bodies remain raw when no transformation is needed;
- `conversation` Responses payloads do not receive reusable-prefix explicit fields;
- reusable-prefix payloads receive fields only on supported models and only above the eligibility guard;
- OpenAI usage totals and cached buckets remain disjoint;
- malformed/absent usage remains unknown or zero according to the existing contract, never a fabricated cache hit;
- translation preserves stable/dynamic system placement;
- replay paths do not rewrite unchanged historical items unnecessarily.

---

## 9. Source index

### VS Code implementation and docs

- [`cacheBreakpoints.ts`](https://github.com/microsoft/vscode/blob/eb84d8148027eb14978437cab306074c5be3cac2/extensions/copilot/src/extension/intents/node/cacheBreakpoints.ts)
- [`messagesApi.ts`](https://github.com/microsoft/vscode/blob/eb84d8148027eb14978437cab306074c5be3cac2/extensions/copilot/src/platform/endpoint/node/messagesApi.ts)
- [`responsesApi.ts`](https://github.com/microsoft/vscode/blob/eb84d8148027eb14978437cab306074c5be3cac2/extensions/copilot/src/platform/endpoint/node/responsesApi.ts)
- [`chatModelCapabilities.ts#modelSupportCacheBreakPoints`](https://github.com/microsoft/vscode/blob/eb84d8148027eb14978437cab306074c5be3cac2/extensions/copilot/src/platform/endpoint/common/chatModelCapabilities.ts#L333-L340)
- [`agentPrompt.tsx`](https://github.com/microsoft/vscode/blob/eb84d8148027eb14978437cab306074c5be3cac2/extensions/copilot/src/extension/prompts/node/agent/agentPrompt.tsx)
- [`copilotCLIPrompt.tsx`](https://github.com/microsoft/vscode/blob/eb84d8148027eb14978437cab306074c5be3cac2/extensions/copilot/src/extension/prompts/node/agent/copilotCLIPrompt.tsx)
- [`chatDebugCacheExplorerView.ts`](https://github.com/microsoft/vscode/blob/eb84d8148027eb14978437cab306074c5be3cac2/src/vs/workbench/contrib/chat/browser/chatDebug/chatDebugCacheExplorerView.ts)
- [`agentHostPromptCache.ts`](https://github.com/microsoft/vscode/blob/eb84d8148027eb14978437cab306074c5be3cac2/src/vs/platform/agentHost/node/agentHostPromptCache.ts)
- [`sessionState.ts`](https://github.com/microsoft/vscode/blob/eb84d8148027eb14978437cab306074c5be3cac2/src/vs/platform/agentHost/common/state/sessionState.ts#L1395-L1422)
- [Cache Explorer documentation](https://code.visualstudio.com/docs/agents/agent-troubleshooting/cache-explorer)
- [Getting more from each token](https://github.blog/ai-and-ml/github-copilot/getting-more-from-each-token-how-copilot-improves-context-handling-and-model-routing/)

### Copilot CLI and SDK

- [CLI v1.0.82](https://github.com/github/copilot-cli/releases/tag/v1.0.82)
- [CLI v1.0.83-0](https://github.com/github/copilot-cli/releases/tag/v1.0.83-0)
- [CLI issue #4185](https://github.com/github/copilot-cli/issues/4185)
- [CLI issue #4500](https://github.com/github/copilot-cli/issues/4500)
- [CLI issue #3808](https://github.com/github/copilot-cli/issues/3808)
- [CLI context management](https://docs.github.com/en/copilot/concepts/agents/copilot-cli/context-management)
- [SDK session persistence](https://github.com/github/copilot-sdk/blob/main/docs/features/session-persistence.md)
- [Copilot SDK](https://github.com/github/copilot-sdk)

### `github-router`

- [`src/lib/prompt-cache.ts`](../../src/lib/prompt-cache.ts)
- [`src/services/copilot/responses-request.ts`](../../src/services/copilot/responses-request.ts)
- [`src/services/copilot/create-responses.ts`](../../src/services/copilot/create-responses.ts)
- [`src/services/copilot/get-models.ts`](../../src/services/copilot/get-models.ts)
- [`src/routes/messages/handler.ts`](../../src/routes/messages/handler.ts)
- [`src/lib/worker-agent/context-budget.ts`](../../src/lib/worker-agent/context-budget.ts)
- [`src/lib/worker-agent/stream-fn.ts`](../../src/lib/worker-agent/stream-fn.ts)
- [`tests/prompt-cache.test.ts`](../../tests/prompt-cache.test.ts)
- [`tests/cache-probe.test.ts`](../../tests/cache-probe.test.ts)
- [`scripts/probe-prompt-cache.ts`](../../scripts/probe-prompt-cache.ts)
- [`docs/prompt-caching.md`](../prompt-caching.md)
- [`docs/copilot-compat-matrix.md`](../copilot-compat-matrix.md)

---

## Research boundary

This record is based on public source, official documentation, public issue/changelog evidence, and the repository's existing local measurements. Provider cache internals, eviction, tenant scope, exact TTL, and cross-process KV survival remain provider-owned unless a live usage signal or official contract establishes them. The upstream source investigation itself changed no production code; the later bounded follow-up is recorded in the safe-improvements section above.
