# API Reference

## OpenAI-Compatible Endpoints (Passthrough)

### POST `/v1/chat/completions` (also `/chat/completions`)
Passthrough to Copilot's `/chat/completions`. Standard OpenAI Chat Completions format.

**Request**: OpenAI Chat Completions payload (`model`, `messages`, `stream`, `tools`, etc.)
**Response**: OpenAI Chat Completions response (streaming or non-streaming)
**Models**: gpt-4.1, gpt-4o, claude-sonnet-4, o3, o4-mini, etc.
**Note**: gpt-5-codex models do NOT work on this endpoint.

### POST `/v1/responses` (also `/responses`)
Passthrough to Copilot's `/responses`. OpenAI Responses API format used by Codex CLI.

**Request**:
```json
{
  "model": "gpt-5.2-codex",
  "input": "string or array of input items",
  "instructions": "optional system prompt",
  "tools": [{"type": "function", "name": "...", "parameters": {...}}],
  "max_output_tokens": 4096,
  "temperature": 0.7,
  "stream": true
}
```

**Response** (non-streaming):
```json
{
  "id": "resp_xxx",
  "object": "response",
  "status": "completed",
  "output": [
    {"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": "..."}]}
  ],
  "usage": {"input_tokens": 20, "output_tokens": 11, "total_tokens": 31}
}
```

**Response** (streaming): SSE events with named event types:
- `response.created` -initial response skeleton
- `response.output_text.delta` -text chunk
- `response.function_call_arguments.delta` -function call argument chunk
- `response.completed` -final complete response

**Models**: gpt-5.3-codex, gpt-5.2-codex, gpt-5.1-codex-mini, gpt-5.1-codex-max, gpt-4.1, etc.

### GET `/v1/models` (also `/models`)
Returns list of available Copilot models in OpenAI format.

### POST `/v1/embeddings` (also `/embeddings`)
Passthrough to Copilot's embeddings endpoint.

---

## Anthropic-Compatible Endpoints (Passthrough)

### POST `/v1/messages`
Passthrough to Copilot's native `/v1/messages?beta=true` endpoint.

**Request**: Anthropic Messages payload (`model`, `messages`, `max_tokens`, `system`, `tools`, etc.)
**Response**: Anthropic Messages response (streaming or non-streaming)
**Streaming**: Anthropic SSE events (`message_start`, `content_block_delta`, `message_stop`, etc.)
**Models**: claude-opus-4.6-1m, claude-opus-4.6, claude-sonnet-4.6, claude-sonnet-4, etc.
**Model resolution**: `opus` → `claude-opus-4.6-1m`, `claude-opus-4-6` → `claude-opus-4.6-1m`

**Body sanitization**: `cache_control.scope` fields are stripped before forwarding (Copilot does not support the `prompt-caching-scope` beta). This enables Claude CLI 2.1.88+ compatibility.

**Beta header filtering**: The `anthropic-beta` header is filtered to a whitelist before forwarding. Default mode forwards only VS Code extension betas. Use `--extended-betas` to forward all Claude CLI betas.

### POST `/v1/messages/count_tokens`
Estimates token count for an Anthropic-format payload.

---

## Search Endpoint

### POST `/v1/search` (also `/search`)
Performs a web search using Copilot's internal search capability.

**Request**:
```json
{
  "query": "your search query"
}
```

**Response**:
```json
{
  "results": [
    { "title": "...", "url": "...", "snippet": "..." }
  ]
}
```

**Note**: The `/v1/responses` endpoint automatically injects web search results when a `web_search` tool is included in the request.

---

## Utility Endpoints

### GET `/usage`
Returns Copilot usage and quota information.

### GET `/token`
Returns the current Copilot token (useful for debugging).

### GET `/`
Health check. Returns `"Server running"`. Also responds to `HEAD /` (used by Claude CLI as pre-flight health check).

---

## Error Format

All error responses use the Anthropic SDK format:
```json
{
  "type": "error",
  "error": {
    "type": "invalid_request_error",
    "message": "Human-readable error description"
  }
}
```

Error types by HTTP status: `400` → `invalid_request_error`, `401` → `authentication_error`, `403` → `permission_error`, `404` → `not_found_error`, `429` → `rate_limit_error`, `529` → `overloaded_error`, other → `api_error`.

Unknown endpoints return a 404 in this format.

---

## Headers

All requests to Copilot include:
- `Authorization: Bearer <copilot_token>`
- `editor-version: vscode/<version>`
- `editor-plugin-version: copilot-chat/<version>`
- `user-agent: GitHubCopilotChat/<version>`
- `X-Initiator: user|agent` (based on message content)
- `copilot-vision-request: true` (when images detected in input)

For `/v1/messages` specifically:
- `openai-intent: messages-proxy` (matches VS Code extension v0.43)
- `copilot-integration-id` is suppressed (extension v0.43 behavior)
- `anthropic-version: 2023-06-01`
- `anthropic-beta: <filtered list>` (only whitelisted prefixes forwarded)
- `x-request-id` from Copilot response is forwarded to the client
