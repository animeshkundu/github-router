import consola from "consola"

import { copilotBaseUrl, copilotHeaders } from "~/lib/api-config"
import { state } from "~/lib/state"
import { sleep } from "~/lib/utils"

export interface WebSearchResult {
  content: string
  references: Array<{ title: string; url: string }>
}

interface ThreadsResponse {
  thread_id: string
}

interface ThreadsMessageResponse {
  message: {
    content: string
    references: Array<{
      query?: string
      results?: Array<{
        title: string
        url: string
        reference_type: string
      }>
    }>
  }
}

const MAX_SEARCHES_PER_SECOND = 3
let searchTimestamps: Array<number> = []

async function throttleSearch(): Promise<void> {
  const now = Date.now()
  searchTimestamps = searchTimestamps.filter((t) => now - t < 1000)
  if (searchTimestamps.length >= MAX_SEARCHES_PER_SECOND) {
    const waitMs = 1000 - (now - searchTimestamps[0])
    if (waitMs > 0) {
      consola.debug(`Web search rate limited, waiting ${waitMs}ms`)
      await sleep(waitMs)
    }
  }
  searchTimestamps.push(Date.now())
}

function threadsHeaders(): Record<string, string> {
  return copilotHeaders(state, false, "copilot-chat")
}

async function createThread(): Promise<string> {
  const response = await fetch(`${copilotBaseUrl(state)}/github/chat/threads`, {
    method: "POST",
    headers: threadsHeaders(),
    body: JSON.stringify({}),
  })

  if (!response.ok) {
    consola.error("Failed to create chat thread", response.status)
    throw new Error(`Failed to create chat thread: ${response.status}`)
  }

  const data = (await response.json()) as ThreadsResponse
  return data.thread_id
}

async function sendThreadMessage(
  threadId: string,
  query: string,
): Promise<ThreadsMessageResponse> {
  const response = await fetch(
    `${copilotBaseUrl(state)}/github/chat/threads/${threadId}/messages`,
    {
      method: "POST",
      headers: threadsHeaders(),
      body: JSON.stringify({
        content: query,
        intent: "conversation",
        skills: ["web-search"],
        references: [],
      }),
    },
  )

  if (!response.ok) {
    consola.error("Failed to send thread message", response.status)
    throw new Error(`Failed to send thread message: ${response.status}`)
  }

  return (await response.json()) as ThreadsMessageResponse
}

export async function searchWeb(query: string): Promise<WebSearchResult> {
  if (!state.copilotToken) throw new Error("Copilot token not found")

  await throttleSearch()

  consola.info(`Web search: "${query.slice(0, 80)}"`)

  const threadId = await createThread()
  const response = await sendThreadMessage(threadId, query)

  const references: Array<{ title: string; url: string }> = []
  for (const ref of response.message.references) {
    if (ref.results) {
      for (const result of ref.results) {
        if (result.url && result.reference_type !== "bing_search") {
          references.push({ title: result.title, url: result.url })
        }
      }
    }
  }

  consola.debug(`Web search returned ${references.length} references`)

  return {
    content: response.message.content,
    references,
  }
}
