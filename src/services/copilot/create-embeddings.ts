import { copilotHeaders, copilotBaseUrl } from "~/lib/api-config"
import { HTTPError } from "~/lib/error"
import { UPSTREAM_FETCH_TIMEOUT_MS } from "~/lib/port"
import { state } from "~/lib/state"
import { tryRefreshAndRetry } from "~/lib/token"
import { fetchWithTransientRetry } from "~/lib/upstream-retry"

export const createEmbeddings = async (payload: EmbeddingRequest) => {
  if (!state.copilotToken) throw new Error("Copilot token not found")

  const body = JSON.stringify(payload)

  // This was the one Copilot client outside the shared retry layer: a bare
  // `fetch` with no retry, no timeout and no signal, so a transient 429/5xx or
  // a network blip failed the caller outright and a hung socket hung forever.
  //
  // Same composition every sibling uses (see `get-models.ts`): the 401-refresh
  // path nests INSIDE the transient retry — 401 refreshes once and is never
  // retried by the transient layer, while 429/5xx/network get bounded backoff.
  // Safe to replay: the request body is a plain string and the response is
  // consumed whole, so a re-issue cannot duplicate streamed output.
  //
  // The timeout is opt-in via `UPSTREAM_FETCH_TIMEOUT_MS` (default 0/disabled,
  // matching the streaming paths); embeddings are non-streaming and bounded,
  // so there is no long-completion case for it to truncate.
  const response = await fetchWithTransientRetry(
    () =>
      tryRefreshAndRetry(
        () =>
          fetch(`${copilotBaseUrl(state)}/embeddings`, {
            method: "POST",
            headers: copilotHeaders(state),
            body,
            ...(UPSTREAM_FETCH_TIMEOUT_MS > 0
              ? { signal: AbortSignal.timeout(UPSTREAM_FETCH_TIMEOUT_MS) }
              : {}),
          }),
        "/embeddings",
      ),
    { label: "/embeddings" },
  )

  if (!response.ok) throw new HTTPError("Failed to create embeddings", response)

  return (await response.json()) as EmbeddingResponse
}

export interface EmbeddingRequest {
  input: string | Array<string>
  model: string
}

export interface Embedding {
  object: string
  embedding: Array<number>
  index: number
}

export interface EmbeddingResponse {
  object: string
  data: Array<Embedding>
  model: string
  usage: {
    prompt_tokens: number
    total_tokens: number
  }
}
