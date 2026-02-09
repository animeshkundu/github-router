# Adding New API Format Support

This guide explains how to add support for a new API format to github-router.

## Choose Your Approach

### Passthrough (Copilot supports the format natively)
If GitHub Copilot API has a native endpoint for the format, proxy requests directly.
**Example**: `/v1/chat/completions`, `/v1/responses`
**Files needed**: 3 (service + handler + route)

### Translation (Copilot doesn't support the format)
If the API format differs from what Copilot supports, translate between formats.
**Example**: `/v1/messages` (Anthropic → translated to Chat Completions)
**Files needed**: 5 (types + non-stream-translation + stream-translation + handler + route)

---

## Passthrough: Step-by-Step

### 1. Create the service file: `src/services/copilot/create-<name>.ts`

Follow the pattern in `create-chat-completions.ts` or `create-responses.ts`:

```typescript
import { events } from "fetch-event-stream"
import { copilotHeaders, copilotBaseUrl } from "~/lib/api-config"
import { HTTPError } from "~/lib/error"
import { state } from "~/lib/state"

export const createMyEndpoint = async (payload: MyPayload) => {
  if (!state.copilotToken) throw new Error("Copilot token not found")

  const headers = { ...copilotHeaders(state), "X-Initiator": "user" }

  const response = await fetch(`${copilotBaseUrl(state)}/my-endpoint`, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  })

  if (!response.ok) throw new HTTPError("Failed", response)

  if (payload.stream) return events(response)
  return (await response.json()) as MyResponse
}
```

### 2. Create the handler: `src/routes/<name>/handler.ts`

Follow `src/routes/chat-completions/handler.ts`:

```typescript
import { checkRateLimit } from "~/lib/rate-limit"
import { awaitApproval } from "~/lib/approval"
import { state } from "~/lib/state"

export async function handleMyEndpoint(c: Context) {
  await checkRateLimit(state)
  const payload = await c.req.json()
  if (state.manualApprove) await awaitApproval()
  const response = await createMyEndpoint(payload)
  // Handle streaming vs non-streaming...
}
```

### 3. Create the route: `src/routes/<name>/route.ts`

```typescript
import { Hono } from "hono"
import { forwardError } from "~/lib/error"

export const myRoutes = new Hono()
myRoutes.post("/", async (c) => {
  try { return await handleMyEndpoint(c) }
  catch (error) { return await forwardError(c, error) }
})
```

### 4. Register in `src/server.ts`

```typescript
import { myRoutes } from "./routes/<name>/route"
server.route("/<name>", myRoutes)
server.route("/v1/<name>", myRoutes)
```

### 5. (Optional) Add CLI flag in `src/start.ts`

Follow the `--claude-code` or `--codex` pattern.

---

## Translation: Step-by-Step

Follow the `/v1/messages` (Anthropic) implementation as your template:

### 1. Define types: `src/routes/<name>/<name>-types.ts`
- Request payload interface
- Response interface
- Streaming event types
- Stream state interface

### 2. Request translation: `src/routes/<name>/non-stream-translation.ts`
- `translateToOpenAI(payload)` → `ChatCompletionsPayload`
- `translateToMyFormat(response)` → `MyResponse`

### 3. Stream translation: `src/routes/<name>/stream-translation.ts`
- `translateChunkToMyEvents(chunk, state)` → `MyStreamEvent[]`

### 4-6. Handler, route, server registration (same as passthrough)

---

## Streaming Considerations

### Passthrough streaming
SSE events from Copilot forwarded directly. Explicitly construct `writeSSE()` calls:
```typescript
await stream.writeSSE({ data: chunk.data, event: chunk.event, id: chunk.id })
```

### Translation streaming
Each Chat Completions chunk must be translated to the target format's events:
```typescript
const events = translateChunkToMyEvents(chunk, streamState)
for (const event of events) {
  await stream.writeSSE({ event: event.type, data: JSON.stringify(event) })
}
```

## Testing

Create tests in `tests/` following the existing patterns:
- **Unit tests**: Mock `fetch`, validate headers, URL, payload shape
- **Schema validation**: Use Zod to validate translated payloads match expected schema
- See `tests/create-chat-completions.test.ts` and `tests/anthropic-request.test.ts`
