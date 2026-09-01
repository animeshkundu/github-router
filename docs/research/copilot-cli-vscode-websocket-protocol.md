# Copilot CLI, VS Code, and Responses WebSocket protocol research

**Research date:** 2026-09-01
**Source snapshot:** repositories and packages inspected through 2026-08-31
**Status:** Read-only research; no implementation change recommended by this document

## Executive summary

The statement that “Copilot CLI uses WebSockets for model agent loops” combines three separate layers:

1. **Copilot CLI ACP** is a JSON-RPC-style, newline-delimited protocol over stdio or TCP. It is not documented as a WebSocket protocol.
2. **VS Code Agent Host Protocol (AHP)** is a separate control-plane protocol. It uses JSON-RPC messages over WebSocket, TCP, Unix sockets, or Windows named pipes and has reconnect, subscription, replay, and snapshot behavior.
3. **Model inference** can use a persistent Responses API WebSocket to Copilot CAPI. VS Code selects it when the model catalog advertises `ws:/responses`, a conversation and turn ID are available, and the feature setting is enabled. The CLI and SDK also expose WebSocket Responses configuration for appropriate providers.

The model WebSocket request is an OpenAI Responses request sent as one JSON text frame:

```json
{
  "type": "response.create",
  "model": "gpt-5.6-sol",
  "input": [],
  "previous_response_id": "resp_123",
  "tools": [],
  "max_output_tokens": 4096,
  "initiator": "user"
}
```

The `stream` field used by HTTP Responses requests is removed. Responses stream events arrive as JSON text frames. A completed response supplies a `response.id` that VS Code may use as `previous_response_id` on a later turn.

The public material does **not** provide a complete normative specification for the CAPI WebSocket handshake, subprotocol, frame-size ceiling, idle timeout, or concurrency limit. The strongest available evidence is the current VS Code implementation, the published `@vscode/copilot-api` package, the Copilot SDK bridge, the CLI package help, and live probes against CLI `1.0.83-0`.

The current `github-router` implementation uses HTTP/SSE for model inference. Its existing WebSockets are for browser control and CloudCLI control-plane proxying. The recommended approach is to keep HTTP as the default and defer model WebSocket support, or make it an explicitly experimental, catalog-gated transport. The primary benefit of the upstream model WebSocket is stateful Responses continuation, but the router currently translates full Claude Code histories and does not maintain the additional `response.id` and history-validity state required to use that feature safely.

A significant reliability issue remains open in current VS Code source: an established model socket can emit `error` without a later `close`, leaving the active request pending and preventing the intended HTTP fallback. See [VS Code issue #331003](https://github.com/microsoft/vscode/issues/331003) and [PR #331004](https://github.com/microsoft/vscode/pull/331004).

---

## Scope and evidence

This investigation covered:

- The latest stable and prerelease Copilot CLI packages available during the investigation.
- The active Copilot SDK repository and its model-request interception bridge.
- The active VS Code source tree. The former standalone `microsoft/vscode-copilot-chat` repository is archived.
- Official ACP documentation and ACP protocol documentation.
- Current VS Code source for the CAPI Responses WebSocket manager and Agent Host Protocol.
- CLI help, changelog entries, package declarations, and live ACP probes.
- The corresponding assumptions and transport code in this repository.

Evidence levels used below:

- **Source:** behavior visible in current checked source.
- **Package:** behavior or configuration visible in a distributed package.
- **Live probe:** behavior observed from a running executable.
- **Issue:** an observed implementation defect or behavior report, not a normative contract.
- **Inference:** a conclusion derived from the preceding evidence and marked as such.

## Version snapshot

| Component | Version or revision checked | Evidence |
|---|---|---|
| Copilot CLI stable | `1.0.82` | Windows x64 release binary and npm release metadata |
| Copilot CLI prerelease | `1.0.83-0` | Windows x64 prerelease package and live probe |
| Copilot SDK main | `7a9168f` on 2026-08-31 | Repository source; `sdk-protocol-version.json` reports protocol `3` |
| VS Code main | `cf3079eec645c86ae4a61bbf71443bf15a0303ce` on 2026-08-31 | Repository source |
| `@vscode/copilot-api` package | `0.5.2` | Published package bundle |
| github-router source | `8253216891541516fdd23d96f468f7213fba5282` | Local repository snapshot; reported package version `0.3.303` |

The public Copilot CLI repository contains the launcher, documentation, changelog, and release metadata. Much of the implementation is distributed in platform packages and native binaries rather than as a complete public TypeScript/Rust source tree.

---

# 1. Three-layer protocol architecture

| Layer | Purpose | Transport | Protocol identity | WebSocket? |
|---|---|---|---|---|
| Copilot CLI ACP | External clients control a Copilot CLI agent process | stdio or TCP | ACP / JSON-RPC-style NDJSON | No documented WebSocket transport |
| VS Code AHP | VS Code Agent Host/session control plane | WebSocket, TCP, Unix socket, named pipe | VS Code Agent Host Protocol / JSON-RPC | Yes, but unrelated to model inference |
| CAPI model inference | Individual model request/response turns | HTTP/SSE or Responses WebSocket | OpenAI Responses-shaped events | Yes when capability/configuration selects it |
| Copilot SDK runtime control | SDK controls a headless CLI runtime | child-process stdio, raw TCP, FFI | SDK runtime JSON-RPC, protocol version 3 | Not the model WebSocket |

The agent loop sits above these transports:

```text
prompt
  -> model turn
  -> tool requests
  -> tool execution
  -> next model turn
  -> ...
```

A WebSocket model call transports one turn. It does not replace the agent-loop state machine. ACP and AHP control planes also do not define the CAPI model frame format.

---

# 2. Copilot CLI ACP

## 2.1 Invocation and framing

The official reference documents:

```bash
copilot --acp --stdio
copilot --acp --port 3000
```

Observed/documented properties:

- Messages are JSON-RPC-style objects delimited by newlines.
- stdio is the default selected transport.
- stdio supports one client.
- TCP binds to `127.0.0.1` by default.
- TCP supports multiple client connections.
- `--stdio` and `--port` are mutually exclusive.
- ACP can run with a configured BYOK provider without a GitHub login.
- ACP is public preview.

There is no official ACP documentation identifying WebSocket as an ACP transport.

## 2.2 Live initialization probe

A live probe against CLI `1.0.83-0` returned an initialization result with protocol version `1`:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "protocolVersion": 1,
    "agentCapabilities": {
      "loadSession": true,
      "mcpCapabilities": {
        "http": true,
        "sse": true
      },
      "promptCapabilities": {
        "image": true,
        "audio": false,
        "embeddedContext": true
      },
      "sessionCapabilities": {
        "close": {},
        "list": {}
      }
    },
    "agentInfo": {
      "name": "Copilot",
      "title": "Copilot",
      "version": "1.0.83-0"
    }
  }
}
```

A paced `session/new` probe produced:

- `session/update` configuration events.
- Available command updates.
- A session ID.
- Agent, Plan, and Autopilot modes.
- Model and reasoning-effort configuration options.
- Reasoning levels including `low`, `medium`, `high`, `xhigh`, and `max`.

The observed model list included:

```text
claude-sonnet-5
claude-opus-5
gpt-5.6-sol
gpt-5.6-terra
gpt-5.6-luna
gpt-5.5
gpt-5.4
gpt-5.3-codex
gemini-3.7-flash
gemini-3.1-pro-preview
grok-4.6
```

A malformed-method probe returned a standard JSON-RPC method error:

```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "error": {
    "code": -32601,
    "message": "\"Method not found\": bogus/method",
    "data": {
      "method": "bogus/method"
    }
  }
}
```

## 2.3 ACP loop and cancellation observations

The CLI owns the iterative model/tool loop. A model turn that produces tool requests leads to tool execution and another model turn. The SDK or ACP transport forwards events; it does not decide that the agent is finished merely because one model response ended.

The CLI exposes:

- `--max-ai-credits` for a session credit limit.
- `--max-autopilot-continues`, whose documented default is five automatic continuation messages.
- Model and reasoning-effort selection.

The exact cancellation behavior is build-sensitive. One invalid-session `session/cancel` probe against the prerelease process returned `-32601`, while ACP documentation and issue reports describe cancellation support. Test cancellation against the exact CLI build being integrated rather than assuming that the protocol documentation and binary behavior are identical.

## 2.4 What ACP does not specify

The official ACP reference does not define universal values for:

- Maximum JSON line or message size.
- Maximum model request size.
- Maximum concurrent sessions or turns.
- Automatic retry count or backoff.
- Automatic reconnect behavior.
- Backpressure semantics.
- Complete malformed-message behavior.
- A universal error taxonomy.

ACP session persistence and load/resume are not equivalent to automatic transport reconnect. A client must not infer that a newly connected ACP process will transparently resume an in-flight turn.

---

# 3. VS Code Agent Host Protocol (AHP)

AHP is VS Code's separate Agent Host/session control plane. It must not be confused with the CAPI model WebSocket.

## 3.1 Transport and authentication

The current VS Code source supports:

- WebSocket over TCP.
- TCP transports.
- Unix domain sockets.
- Windows named pipes.

The WebSocket server defaults to loopback:

```text
127.0.0.1
```

When a connection-token validator is configured, the client includes a `tkn` query parameter:

```text
ws://127.0.0.1:<port>?tkn=<connection-token>
```

The server validates all occurrences of the token parameter. Invalid URL syntax receives HTTP 400; an invalid token receives HTTP 403 during the WebSocket upgrade.

The server source is in [`src/vs/platform/agentHost/node/webSocketTransport.ts`](https://github.com/microsoft/vscode/blob/cf3079eec645c86ae4a61bbf71443bf15a0303ce/src/vs/platform/agentHost/node/webSocketTransport.ts).

## 3.2 Framing and malformed frames

AHP sends one JSON object per text WebSocket frame. The transport serializes messages with JSON and performs URI revival at the protocol layer.

The current malformed-frame policy includes:

- Parse each inbound text frame independently.
- Return JSON-RPC parse error `-32700` when the server can produce a parse-error response.
- Tolerate a limited number of malformed frames.
- Log at most five malformed frames per connection.
- Force-close after more than ten malformed frames.
- Use close code `4002` for the malformed-frame threshold in the client transport.
- Use close code `4001` for a dead send path.
- Fire the close event only once.

The shared constants are in [`transportConstants.ts`](https://github.com/microsoft/vscode/blob/cf3079eec645c86ae4a61bbf71443bf15a0303ce/src/vs/platform/agentHost/common/transportConstants.ts).

## 3.3 Protocol lifecycle

AHP supports:

- `initialize`.
- `ping`.
- `reconnect`.
- Subscription management.
- Reverse JSON-RPC requests.
- URI-addressed state channels.
- Server sequence numbers.
- Action replay.
- Snapshot recovery.

A reconnect request includes values such as:

```text
clientId
lastSeenServerSeq
subscriptions
```

When the server retains enough history, the reconnect response replays missed actions. If it cannot replay from the requested sequence, it returns fresh snapshots.

## 3.4 Automatic reconnect and liveness

The current default reconnect policy is:

```ts
{
  autoRestore: true,
  initialDelayMs: 1000,
  maxDelayMs: 30000,
  maxAttempts: 10,
}
```

On transport loss, the client:

1. Enters a reconnecting state.
2. Rejects in-flight requests bound to the dead transport.
3. Buffers eligible outgoing protocol messages.
4. Sends `reconnect` with its client ID and last server sequence.
5. Performs a fresh `initialize` if the server forgot the client.
6. Restores subscriptions and drains the outbox after recovery.

The liveness constants are:

```ts
PING_INTERVAL_MS = 5000
LIVENESS_TIMEOUT_MS = 20000
```

After five seconds without inbound traffic, the client sends an application-level ping. After the additional liveness interval without any inbound message, it force-closes the transport, allowing reconnect handling to take over.

These reconnect, replay, snapshot, and liveness rules belong to AHP. They are not evidence that the CAPI model WebSocket has equivalent behavior.

---

# 4. CAPI Responses WebSocket model transport

## 4.1 Capability and selection gate

The active VS Code source defines:

```ts
export enum ModelSupportedEndpoint {
	ChatCompletions = '/chat/completions',
	Responses = '/responses',
	WebSocketResponses = 'ws:/responses',
	Messages = '/v1/messages'
}
```

The `ws:/responses` value is a model capability identifier, not a complete URL.

VS Code's WebSocket selection requires all of the following:

- The model metadata advertises `ws:/responses`.
- The request has a conversation ID.
- The request has a turn ID.
- The Responses WebSocket configuration/experiment is enabled.

The effective source expression is:

```ts
const useWebSocket = options.useWebSocket ?? !!(
	options.turnId
	&& options.conversationId
	&& this.useWebSocketResponsesApi
	&& this._configurationService.getExperimentBasedConfig(
		ConfigKey.TeamInternal.ResponsesApiWebSocketEnabled,
		this._expService
	)
);
```

The configuration default observed in the current source is enabled.

The SDK exposes an equivalent option:

```ts
enableWebSocketResponses?: boolean
```

and a CLI environment opt-out:

```text
COPILOT_CLI_DISABLE_WEBSOCKET_RESPONSES
```

For BYOK OpenAI-compatible providers, the prerelease CLI package documents the combination:

```text
COPILOT_PROVIDER_WIRE_API=responses
COPILOT_PROVIDER_TRANSPORT=websockets
```

The provider configuration also supports a structured equivalent:

```ts
{
  type: 'openai',
  wireApi: 'responses',
  transport: 'websockets',
  baseUrl: '...'
}
```

## 4.2 URL and upgrade

The published `@vscode/copilot-api@0.5.2` package constructs the URL as:

```text
<capiBaseURL>/responses
```

With the default base URL, the observed endpoint is:

```text
https://api.githubcopilot.com/responses
```

VS Code creates a normal WebSocket connection through an Undici-based networking implementation. The client does not visibly select a separate `/v1/realtime` endpoint.

The CAPI wrapper adds an experiment-assignment header when needed and delegates connection creation to the networking layer.

## 4.3 Observed headers

The model WebSocket request assembles headers including:

```text
Authorization: Bearer <token>
X-Request-Id: <request-id>
OpenAI-Intent: <intent>
X-GitHub-Api-Version: 2025-05-01
X-Interaction-Id: <interaction-id>
X-Interaction-Type: <agent-interaction-type>
X-Agent-Task-Id: <request-id>
Copilot-Integration-Id: <integration-id>
```

Vision requests can include:

```text
Copilot-Vision-Request: true
```

These are observed implementation details, not a complete published handshake contract.

### API-version inconsistency

The current source and package contain different observed values:

| Location | Observed value |
|---|---|
| Model WebSocket header assembly in `chatMLFetcher.ts` | `2025-05-01` |
| General HTTP request construction in VS Code | `2026-01-09` |
| Published `@vscode/copilot-api@0.5.2` header mixin | `2026-08-01` |
| github-router source default | `2026-01-09` |

This inconsistency must be resolved through live compatibility probing before a new proxy implementation hardcodes a value. It is not safe to select the newest-looking value solely from source inspection.

No complete public specification was found for:

- Required upgrade headers.
- WebSocket subprotocol negotiation.
- Whether every `ws:/responses` model requires the same header set.
- Server-side idle timeout.
- Maximum frame or message size.
- Maximum concurrent requests per connection.

The examined VS Code constructor does not visibly pass a custom WebSocket subprotocol.

## 4.4 Outbound frame

VS Code removes the HTTP/SSE-only `stream` property, adds the frame type, and adds the initiator:

```ts
const { stream: _, ...rest } = body;
const message = {
	type: 'response.create' as const,
	...rest,
	initiator: options.userInitiated ? 'user' : 'agent',
};
this._ws.send(stringifyJsonBody(message));
```

The effective frame is one JSON text message. It can preserve Responses fields such as:

- `model`
- `input`
- `previous_response_id`
- `tools`
- `tool_choice`
- `max_output_tokens`
- `top_logprobs`
- `store`
- `reasoning.effort`
- `include`
- `prompt_cache_key`
- `prompt_cache_options`
- `context_management`
- `truncation`

Example:

```json
{
  "type": "response.create",
  "model": "gpt-5.6-sol",
  "input": [
    {
      "role": "user",
      "content": "Inspect the repository and summarize the failure."
    }
  ],
  "tools": [],
  "max_output_tokens": 4096,
  "reasoning": {
    "effort": "high"
  },
  "initiator": "user"
}
```

There is no separate `stream_id` in the observed JSON frame. Request IDs and turn IDs are used by the client for correlation and telemetry.

## 4.5 Inbound frames and terminal outcomes

Inbound frames are JSON text messages carrying Responses events, for example:

```json
{
  "type": "response.output_text.delta",
  "delta": "hello"
}
```

The current VS Code manager recognizes these terminal outcomes:

```text
response.completed
response.failed
response.incomplete
response.cancelled
error
```

A completed response includes a `response.id`. The manager stores that ID as the stateful marker only after a successful completion.

Binary frames are ignored by the current manager. Malformed JSON is logged/reported, but the observed manager does not necessarily settle the active request merely because a frame could not be parsed.

## 4.6 Nested CAPI errors

CAPI errors use a separate envelope:

```json
{
  "type": "error",
  "error": {
    "code": "rate_limited",
    "message": "..."
  },
  "copilot_quota_snapshots": {}
}
```

The current manager:

- Detects the nested error separately from ordinary Responses events.
- Rejects the active request.
- Calls a dedicated CAPI-error callback.
- Does not forward the nested error through the ordinary event callback.
- Does not update the stateful marker.
- Preserves optional `copilot_quota_snapshots` for higher-level quota handling.

Higher-level VS Code code maps these codes into rate-limit, quota, content-filter, not-found, bad-request, server-error, and generic-failure categories.

## 4.7 Stateful continuation

VS Code may send the latest completed response ID as:

```json
{
  "previous_response_id": "resp_previous"
}
```

It does so only when local state remains valid. The checks include:

- A marker exists in local history.
- The local history still contains the marker.
- Summary/compaction state has not invalidated the marker.
- Model and mode have not changed.
- Stateful markers have not been explicitly disabled.

If the marker is absent, stale, mismatched, invalid, or no longer compatible with local history, the client falls back to full history or disables stateful continuation for that request.

This is client-managed state, not a universal server-side conversation abstraction. A proxy that translates a fresh full transcript on every turn cannot safely add `previous_response_id` without tracking the marker, model, compaction point, and exact history represented by the marker.

## 4.8 Connection reuse and concurrency

The VS Code manager keys connections by conversation and optional connection ID. Reuse requires:

- The socket is open.
- No request is active on that connection.
- The requested model matches the connection's model.

There is one active request per connection. Starting another request while one is active supersedes the earlier request. Parallel lanes use separate connection IDs.

This should not be treated as a general multiplexed channel for arbitrary conversations or concurrent turns.

---

# 5. Model WebSocket errors and fallback

## 5.1 Manager-level behavior

The current WebSocket manager does not implement a complete reconnect loop or general retry policy. It reports terminal Responses events and nested CAPI errors to higher-level fetch code.

### Error-without-close defect

In the current source, the established-socket `error` handler records an error message, while the active request is settled by the separate `close` handler. The relevant behavior is in [`chatWebSocketManager.ts`](https://github.com/microsoft/vscode/blob/cf3079eec645c86ae4a61bbf71443bf15a0303ce/extensions/copilot/src/platform/networking/node/chatWebSocketManager.ts).

If an Electron/WebSocket runtime emits:

```text
error
```

without a later:

```text
close
```

then the current state machine can leave both the first-event promise and completion promise pending. The higher-level fetcher never sees a settled failure, so the HTTP fallback cannot begin.

[Issue #331003](https://github.com/microsoft/vscode/issues/331003) documents this behavior. [PR #331004](https://github.com/microsoft/vscode/pull/331004) proposes treating the error as a connection close, settling the active request with an abnormal-close equivalent, and closing the socket. The PR was still open/unmerged during the source check.

This is the most important observed reliability defect in the current model WebSocket path.

## 5.2 VS Code WebSocket-to-HTTP fallback

The higher-level `ChatMLFetcherImpl` can retry an eligible failed WebSocket request over HTTP. The fallback explicitly uses:

```ts
{
  useWebSocket: false,
  ignoreStatefulMarker: true,
  userInitiatedRequest: false,
  enableRetryOnError: false
}
```

The practical sequence is:

1. Observe a settled eligible WebSocket failure.
2. Disable WebSocket for the retry.
3. Ignore the stateful marker so the retry can send complete history.
4. Retry over HTTP.
5. Avoid recursively retrying the fallback as another WebSocket attempt.
6. Close the failed WebSocket connection.

Before the retry, the fetcher performs a connectivity-check sequence with delays:

```ts
[1000, 10000, 10000]
```

After three consecutive successful HTTP recoveries from WebSocket failures, the fetcher disables WebSocket use for that fetcher instance. This is an instance-level circuit breaker, not a documented permanent account-level setting.

The fallback is therefore conditional. It cannot protect a request that remains pending because of the error-without-close defect.

## 5.3 CLI model fallback

The CLI package documents a separate model-selection mechanism:

```text
continueOnAutoMode
```

Eligible rate-limit classes can trigger an automatic switch to auto mode and a retry for:

- Per-model limits.
- Weekly limits.
- Integration limits.

The documented behavior does not apply to:

- Global rate limits.
- Generic 429 errors.
- BYOK providers.

This is **model fallback**, not transport fallback. It does not imply that a failed WebSocket reconnects or changes to HTTP.

## 5.4 Ordinary HTTP fetcher fallback

VS Code also has a generic fallback among Electron fetch, Node fetch, and Node HTTP implementations. This handles local HTTP networking implementation failures and is separate from the model WebSocket-to-HTTP fallback.

The ordinary HTTP path has a 30-second request timeout and recognizes network errors including connection reset, timeout, network changed, HTTP/2 session/stream failures, and generic failed-request conditions. That behavior should not be conflated with CAPI model WebSocket reconnect.

---

# 6. Limits, quotas, and timeouts

No authoritative public document defines one universal CAPI WebSocket limit table. The following values are layer-specific observations:

| Layer | Observed value | Meaning |
|---|---:|---|
| CLI `--max-ai-credits` | Minimum shown: `30` | Soft session AI-credit cap |
| CLI Autopilot | Default: `5` | Automatic continuation messages |
| VS Code tool handling | `128` | `HARD_TOOL_LIMIT` where endpoint lacks tool search |
| VS Code ordinary HTTP networking | `30 s` | Request timeout |
| AHP liveness | `5 s` + `20 s` | Ping interval, then liveness close interval |
| AHP reconnect | `10` attempts | Automatic reconnect cap |
| AHP reconnect delay | `1 s` initial, `30 s` max | Backoff bounds |
| AHP malformed frames | More than `10` | Force-close threshold; logs capped at `5` |
| SDK `sendAndWait()` | `60 s` default | Stops waiting for `session.idle`; does not abort underlying work |
| SDK CLI startup | `30 s` | Startup timeout |
| SDK TCP connection | `10 s` | Connection timeout |
| SDK runtime shutdown | `10 s` | Shutdown wait |
| SDK disconnect | Up to `3` attempts | `100 ms`, then `200 ms` backoff |
| CAPI model WebSocket payload | Not published | No verified universal frame/message ceiling |
| CAPI model WebSocket idle timeout | Not published | No verified application-level timeout |
| CAPI model WebSocket concurrency | Not published | VS Code itself permits one active request per connection |

The CLI changelog says the Responses request-size limit was increased in version `1.0.74`, but does not publish the resulting numeric limit.

A CLI issue reports a server-side maximum of 64 characters for one particular input-item ID field. That is not evidence of a general WebSocket frame or payload limit.

Quota information can be included in CAPI error/completion handling through `copilot_quota_snapshots`, but the exact server-side quota schema and enforcement limits are not fully documented in the public model WebSocket material.

---

# 7. Copilot SDK runtime and model-request bridge

The Copilot SDK controls a headless Copilot CLI runtime over a separate JSON-RPC control protocol.

## 7.1 Runtime transports

The SDK supports:

- A child process over stdio.
- A child process with TCP.
- A URI/raw TCP connection to an existing runtime.
- In-process FFI.

The default client uses JSON-RPC stream readers and writers. The current SDK protocol version file reports version `3`.

Connection setup is approximately:

1. Start or connect to the runtime.
2. Send `connect` with an optional connection token.
3. Check protocol compatibility.
4. Fall back to `ping` for legacy runtimes that lack `connect`.
5. Reject unsupported protocol versions.

SDK-owned TCP runtimes generate a connection token when one is not supplied and pass it through `COPILOT_CONNECTION_TOKEN`. The CLI listens on loopback.

## 7.2 Provider configuration

The SDK exposes:

```ts
interface CapiSessionOptions {
  enableWebSocketResponses?: boolean;
}
```

and BYOK provider configuration with:

```ts
interface ProviderConfig {
  type?: 'openai' | 'azure' | 'anthropic';
  wireApi?: 'completions' | 'responses';
  transport?: 'http' | 'websockets';
  baseUrl: string;
}
```

Provider options include maximum prompt/output tokens, separate model and wire-model IDs, API key or bearer-token credentials, per-request bearer-token callbacks, and custom headers.

## 7.3 Model-request interception

The SDK can intercept model-layer requests over HTTP, SSE, and WebSocket. The runtime bridge uses RPC methods named:

```text
llmInference.httpRequestStart
llmInference.httpRequestChunk
```

The historical method name is HTTP-oriented, but the request-start payload includes:

```ts
transport: 'http' | 'websocket'
```

Request-start data includes:

```text
requestId
sessionId
method
url
headers
transport
agentId
parentAgentId
agentInvocationId
interactionType
```

Request chunks include:

```text
requestId
data
binary
end
cancel
cancelReason
agentInvocationId
```

When `binary` is true, the bytes are base64 encoded.

Response-start data includes:

```text
requestId
status
statusText
headers
```

Response chunks include:

```text
requestId
data
binary
end
error
```

A terminal response error carries a message and optional code.

## 7.4 WebSocket upgrade ordering

The SDK bridge starts forwarding response data immediately after the upstream WebSocket's HTTP 101 upgrade response:

```ts
await handler[kOpen]();
await ctx[kBridge].start();
```

The runtime waits for the upgrade response head before forwarding request-body chunks. Waiting for the first upstream WebSocket message would deadlock:

- The upstream waits for the request frame.
- The runtime waits for upgrade acknowledgment before sending that frame.

Any compatible proxy or interception handler must preserve this ordering.

## 7.5 Forwarding and cancellation

The default forwarder opens a WebSocket from the request URL, forwards upstream messages to the runtime, and closes on upstream close or error. The SDK maps runtime-side cancellation to an HTTP-like status `499` with code `cancelled`. Handler exceptions map to status `502`; a handler that returns without finalizing also maps to `502`.

The SDK bridge itself does not provide a general automatic retry/reconnect algorithm. Provider- and runtime-specific retry remains outside this interception layer.

A source caveat: the default JavaScript WebSocket forwarder visibly constructs the socket from the URL but does not visibly pass all request headers. Custom handlers can access the headers and should explicitly validate authentication forwarding before using the default behavior with an arbitrary third-party provider.

---

# 8. github-router compatibility assessment

## 8.1 Current local behavior

The local router currently assumes HTTP/SSE for Copilot model inference:

- `src/services/copilot/create-chat-completions.ts` forwards HTTP Chat Completions.
- `src/services/copilot/create-responses.ts` forwards HTTP Responses.
- `src/services/copilot/create-messages.ts` forwards native Anthropic Messages requests.
- `src/lib/anthropic-translate/` translates non-Claude Messages requests to HTTP Responses or HTTP Chat Completions.
- `src/lib/worker-agent/stream-fn.ts` uses HTTP model streams.
- `src/services/copilot/endpoint.ts` recognizes HTTP endpoint paths and deliberately does not treat `ws:/responses` as an HTTP Responses path.
- `src/lib/upstream-retry.ts` performs retries before visible stream bytes are exposed.
- `src/lib/stream-relay.ts` prohibits retry after streaming output has been exposed, preventing duplicate visible events.
- `src/lib/browser-mcp/` uses WebSockets for browser control, not model inference.
- `src/lib/serve/reverse-proxy.ts` uses WebSockets for CloudCLI control-plane proxying, not model inference.

There is no production CAPI model WebSocket client in the current router.

## 8.2 Recommendation

Keep HTTP/SSE as the default model transport. Do not migrate the core inference path to WebSockets based solely on the current client source.

The reasons are:

1. **The primary WebSocket benefit is not currently available to the router.** The router receives full Claude Code histories and translates them into provider-neutral requests. It does not currently maintain the per-conversation `response.id`, compaction boundary, model identity, and exact history represented by that marker.
2. **The handshake is only partially public.** The URL and frame shape are observable, but required headers, API-version choice, subprotocol behavior, payload limits, idle behavior, and server concurrency limits remain incompletely specified.
3. **The current client has a live reliability defect.** An error without a close can strand a request before the higher-level HTTP fallback runs.
4. **Lifecycle complexity is higher.** A proxy would own connection pooling, one-request-per-connection semantics, cancellation, upgrade ordering, malformed frames, consumer cancellation, and fallback without duplicating already-visible output.
5. **HTTP already has the behavior the router needs.** The router's current HTTP paths have token-recovery handling, pre-byte transient retry, stream cancellation handling, context-overflow classification, and explicit no-retry-after-output rules.

## 8.3 Safe future path

If model WebSocket support becomes necessary, implement it as an opt-in, catalog-gated transport with these constraints:

1. Enable it only for models advertising `ws:/responses`.
2. Preserve HTTP/SSE as the default and fallback.
3. Validate the exact upgrade headers and API version through a live compatibility probe.
4. Wait for HTTP 101 before sending the `response.create` frame.
5. Settle the request on both WebSocket `error` and `close`; never depend on close following error.
6. Treat malformed frames and unexpected terminal states as explicit failures.
7. Disable `previous_response_id` unless the proxy can prove marker/history continuity.
8. Fall back to HTTP before any duplicate visible stream output can be emitted.
9. Test consumer cancellation against a real Bun/Node listener, not only cooperative mocks.
10. Add compatibility-probe rows for every new header, body/frame field, and accepted/rejected error shape.
11. Add an operational circuit breaker so repeated HTTP recoveries disable WebSockets for the affected session or transport instance.
12. Log enough redacted correlation data to distinguish upgrade failure, protocol failure, server error, cancellation, and fallback.

The recommendation should be revisited if either of these conditions occurs:

- Copilot begins rejecting HTTP `/responses` for models that advertise only `ws:/responses`.
- Live measurements show a material reliability, quota, or latency advantage that justifies the additional lifecycle machinery.

---

# 9. Unresolved questions

The following remain open because the public sources do not settle them:

- What exact authentication and header set does the current CAPI WebSocket upgrade require for every Copilot model tier?
- Which `X-GitHub-Api-Version` value is authoritative for model WebSockets? Current sources show `2025-05-01`, `2026-01-09`, and `2026-08-01` in different paths/packages.
- Does CAPI negotiate a WebSocket subprotocol in environments not covered by the examined VS Code path?
- Are all catalog entries advertising `ws:/responses` wire-compatible, or are there model-specific differences?
- What are the server's maximum frame/message size, idle timeout, and connection/request concurrency limits?
- Does the server preserve `previous_response_id` state across reconnects, or must the client always fall back to full history after connection loss?
- What is the exact cancellation frame or close behavior accepted by the current CAPI service?
- Does the CLI's native WebSocket implementation differ from the SDK's JavaScript forwarding implementation in header forwarding or retry behavior?
- Does ACP cancellation behave consistently across stable and prerelease CLI builds?

These questions require targeted live probes or upstream clarification. They should not be answered by extrapolating AHP or ACP behavior onto CAPI model inference.

---

# 10. Sources

## Copilot CLI and ACP

- [Copilot CLI repository](https://github.com/github/copilot-cli)
- [Copilot CLI v1.0.82 release](https://github.com/github/copilot-cli/releases/tag/v1.0.82)
- [Copilot CLI changelog](https://github.com/github/copilot-cli/blob/main/changelog.md)
- [Official ACP server reference](https://docs.github.com/en/copilot/reference/copilot-cli-reference/acp-server)
- [ACP public-preview announcement](https://github.blog/changelog/2026-01-28-acp-support-in-copilot-cli-is-now-in-public-preview/)
- [ACP protocol overview](https://agentclientprotocol.com/protocol/v1/overview)
- [ACP transports](https://agentclientprotocol.com/protocol/v1/transports)
- [CLI issue #4233: ACP usage events](https://github.com/github/copilot-cli/issues/4233)
- [CLI issue #4555: ACP prompt/cancellation behavior](https://github.com/github/copilot-cli/issues/4555)
- [CLI issue #4561: ACP cancellation stop reason](https://github.com/github/copilot-cli/issues/4561)
- [CLI issue #4505: resumed-session input IDs](https://github.com/github/copilot-cli/issues/4505)
- [CLI issue #3594: input-item ID limit](https://github.com/github/copilot-cli/issues/3594)
- [CLI issue #1274: retry delay observations](https://github.com/github/copilot-cli/issues/1274)
- [CLI issue #4678: ACP session/new stall](https://github.com/github/copilot-cli/issues/4678)

## VS Code model WebSocket source

- [`endpointProvider.ts`](https://github.com/microsoft/vscode/blob/cf3079eec645c86ae4a61bbf71443bf15a0303ce/extensions/copilot/src/platform/endpoint/common/endpointProvider.ts)
- [`chatEndpoint.ts`](https://github.com/microsoft/vscode/blob/cf3079eec645c86ae4a61bbf71443bf15a0303ce/extensions/copilot/src/platform/endpoint/node/chatEndpoint.ts)
- [`chatWebSocketManager.ts`](https://github.com/microsoft/vscode/blob/cf3079eec645c86ae4a61bbf71443bf15a0303ce/extensions/copilot/src/platform/networking/node/chatWebSocketManager.ts)
- [`chatMLFetcher.ts`](https://github.com/microsoft/vscode/blob/cf3079eec645c86ae4a61bbf71443bf15a0303ce/extensions/copilot/src/extension/prompt/node/chatMLFetcher.ts)
- [`responsesApi.ts`](https://github.com/microsoft/vscode/blob/cf3079eec645c86ae4a61bbf71443bf15a0303ce/extensions/copilot/src/platform/endpoint/node/responsesApi.ts)
- [`nodeFetchFetcher.ts`](https://github.com/microsoft/vscode/blob/cf3079eec645c86ae4a61bbf71443bf15a0303ce/extensions/copilot/src/platform/networking/node/nodeFetchFetcher.ts)
- [`fetcherFallback.ts`](https://github.com/microsoft/vscode/blob/cf3079eec645c86ae4a61bbf71443bf15a0303ce/extensions/copilot/src/platform/networking/node/fetcherFallback.ts)
- [`networking.ts`](https://github.com/microsoft/vscode/blob/cf3079eec645c86ae4a61bbf71443bf15a0303ce/extensions/copilot/src/platform/networking/common/networking.ts)
- [`@vscode/copilot-api@0.5.2`](https://registry.npmjs.org/@vscode/copilot-api/-/copilot-api-0.5.2.tgz)

## VS Code Agent Host Protocol

- [`webSocketTransport.ts`](https://github.com/microsoft/vscode/blob/cf3079eec645c86ae4a61bbf71443bf15a0303ce/src/vs/platform/agentHost/node/webSocketTransport.ts)
- [`agentHostProtocolClient.ts`](https://github.com/microsoft/vscode/blob/cf3079eec645c86ae4a61bbf71443bf15a0303ce/src/vs/platform/agentHost/browser/agentHostProtocolClient.ts)
- [`reconnectPolicy.ts`](https://github.com/microsoft/vscode/blob/cf3079eec645c86ae4a61bbf71443bf15a0303ce/src/vs/platform/agentHost/common/reconnectPolicy.ts)
- [`transportConstants.ts`](https://github.com/microsoft/vscode/blob/cf3079eec645c86ae4a61bbf71443bf15a0303ce/src/vs/platform/agentHost/common/transportConstants.ts)
- [`sessionProtocol.ts`](https://github.com/microsoft/vscode/blob/cf3079eec645c86ae4a61bbf71443bf15a0303ce/src/vs/platform/agentHost/common/state/sessionProtocol.ts)

## SDK and current defect

- [Copilot SDK repository](https://github.com/github/copilot-sdk)
- [SDK agent-loop documentation](https://github.com/github/copilot-sdk/blob/main/docs/features/agent-loop.md)
- [SDK streaming-events documentation](https://github.com/github/copilot-sdk/blob/main/docs/features/streaming-events.md)
- [SDK session-limits documentation](https://github.com/github/copilot-sdk/blob/main/docs/features/session-limits.md)
- [SDK session-persistence documentation](https://github.com/github/copilot-sdk/blob/main/docs/features/session-persistence.md)
- [VS Code issue #331003: WebSocket error without close](https://github.com/microsoft/vscode/issues/331003)
- [VS Code PR #331004](https://github.com/microsoft/vscode/pull/331004)

## Local implementation references

- [`src/services/copilot/endpoint.ts`](../../src/services/copilot/endpoint.ts)
- [`src/services/copilot/create-responses.ts`](../../src/services/copilot/create-responses.ts)
- [`src/lib/anthropic-translate/`](../../src/lib/anthropic-translate/)
- [`src/lib/worker-agent/stream-fn.ts`](../../src/lib/worker-agent/stream-fn.ts)
- [`src/lib/upstream-retry.ts`](../../src/lib/upstream-retry.ts)
- [`src/lib/stream-relay.ts`](../../src/lib/stream-relay.ts)
- [`src/lib/browser-mcp/`](../../src/lib/browser-mcp/)
- [`src/lib/serve/reverse-proxy.ts`](../../src/lib/serve/reverse-proxy.ts)
