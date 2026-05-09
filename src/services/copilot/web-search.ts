import consola from "consola"
import { events } from "fetch-event-stream"
import { z } from "zod"

import { copilotBaseUrl, copilotVersion } from "~/lib/api-config"
import { HTTPError } from "~/lib/error"
import { state } from "~/lib/state"
import { sleep } from "~/lib/utils"

export interface WebSearchResult {
  content: string
  references: Array<{ title: string; url: string }>
}

const RpcSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.number().optional(),
  result: z
    .object({
      content: z
        .array(z.object({ type: z.literal("text"), text: z.string() }))
        .optional(),
      isError: z.boolean().optional(),
    })
    .optional(),
  error: z
    .object({ code: z.number(), message: z.string() })
    .optional(),
})

const InnerSchema = z.object({
  text: z.object({
    value: z.string(),
    // Upstream sometimes returns `null` instead of an absent field for the
    // no-results case. `.nullable().optional()` accepts undefined, null,
    // and a real array; readers must `?? []` before iterating.
    annotations: z
      .array(
        z.object({
          url_citation: z
            .object({ title: z.string(), url: z.string() })
            .optional(),
        }),
      )
      .nullable()
      .optional(),
  }),
  bing_searches: z.array(z.unknown()).nullable().optional(),
})

const MAX_SEARCHES_PER_SECOND = 3
let searchTimestamps: Array<number> = []

// Single-flight chain serializes throttle checks. Without this, two
// concurrent searches can both read the timestamp array, both filter,
// both skip the await, and both push — doubling the QPS the throttle
// is supposed to enforce.
let throttleChain: Promise<void> = Promise.resolve()

async function throttleSearch(): Promise<void> {
  const myTurn = throttleChain.then(async () => {
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
  })
  throttleChain = myTurn.catch(() => {
    // errors don't break the chain — next caller starts fresh
  })
  return myTurn
}

function mcpHeaders(sid?: string): Record<string, string> {
  if (!state.githubToken) {
    throw new Error(
      "GitHub token missing — re-run auth flow. Web search uses the GitHub PAT (not the Copilot token); the on-disk token at ~/.local/share/github-router/github_token must be present.",
    )
  }
  // Match the GitHubCopilotChat/<version> User-Agent the rest of the
  // router sends (see api-config.ts:32). Sending "github-router/<version>"
  // breaks the VS-Code-stealth posture and broadcasts our identity to the
  // MCP server.
  const headers: Record<string, string> = {
    Authorization: `Bearer ${state.githubToken}`,
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    "X-MCP-Host": "copilot-cli",
    "X-MCP-Toolsets": "web_search",
    "Mcp-Protocol-Version": "2025-06-18",
    "user-agent": `GitHubCopilotChat/${copilotVersion(state)}`,
  }
  if (sid) headers["Mcp-Session-Id"] = sid
  return headers
}

async function postMcp(
  body: unknown,
  sid?: string,
  retry = true,
): Promise<Response> {
  const url = `${copilotBaseUrl(state)}/mcp`
  const res = await fetch(url, {
    method: "POST",
    headers: mcpHeaders(sid),
    body: JSON.stringify(body),
  })
  if (!res.ok && retry && res.status >= 500) {
    await sleep(500)
    return postMcp(body, sid, false)
  }
  return res
}

export async function searchWeb(query: string): Promise<WebSearchResult> {
  await throttleSearch()
  consola.info(`Web search (MCP): "${query.slice(0, 80)}"`)

  const callId = Math.floor(Math.random() * 1_000_000_000)
  let sid: string | undefined

  try {
    // 1. initialize
    const initRes = await postMcp({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        // Identify as the Copilot Chat extension, mirroring the User-Agent
        // and editor-plugin-version we send on every other request.
        clientInfo: {
          name: "GitHubCopilotChat",
          version: copilotVersion(state),
        },
      },
    })
    if (!initRes.ok) {
      consola.error("MCP initialize failed", initRes.status)
      throw new HTTPError("MCP initialize failed", initRes)
    }
    sid = initRes.headers.get("mcp-session-id") ?? undefined
    if (!sid) {
      throw new HTTPError(
        "MCP initialize: missing Mcp-Session-Id header",
        initRes,
      )
    }

    // 2. notifications/initialized — server returns 202 (no body)
    const notifRes = await postMcp(
      { jsonrpc: "2.0", method: "notifications/initialized" },
      sid,
    )
    if (!notifRes.ok && notifRes.status !== 202) {
      consola.error("MCP notifications/initialized failed", notifRes.status)
      throw new HTTPError("MCP notifications/initialized failed", notifRes)
    }

    // 3. tools/call web_search — SSE stream of JSON-RPC events; match by id
    const callRes = await postMcp(
      {
        jsonrpc: "2.0",
        id: callId,
        method: "tools/call",
        params: {
          name: "web_search",
          arguments: { query },
        },
      },
      sid,
    )
    if (!callRes.ok) {
      consola.error("MCP tools/call failed", callRes.status)
      throw new HTTPError("MCP tools/call failed", callRes)
    }

    let rpc: z.infer<typeof RpcSchema> | undefined
    for await (const ev of events(callRes)) {
      if (!ev.data) continue
      let parsedJson: unknown
      try {
        parsedJson = JSON.parse(ev.data)
      } catch {
        continue
      }
      const parsed = RpcSchema.safeParse(parsedJson)
      if (parsed.success && parsed.data.id === callId) {
        rpc = parsed.data
        break
      }
    }
    if (!rpc) {
      throw new HTTPError(
        "MCP tools/call: no matching response id in SSE stream",
        callRes,
      )
    }
    if (rpc.error) {
      throw new HTTPError(
        `MCP error ${rpc.error.code}: ${rpc.error.message}`,
        callRes,
      )
    }
    if (rpc.result?.isError) {
      throw new HTTPError("MCP web_search tool error", callRes)
    }

    const text = rpc.result?.content?.[0]?.text
    if (!text) {
      throw new HTTPError("MCP web_search: empty content", callRes)
    }

    let innerRaw: unknown
    try {
      innerRaw = JSON.parse(text)
    } catch (err) {
      throw new HTTPError(
        `MCP web_search: inner content not JSON: ${err instanceof Error ? err.message : String(err)}`,
        callRes,
      )
    }
    // safeParse: a raw ZodError thrown here would bypass forwardError's
    // HTTPError check and surface as a generic 500 instead of an Anthropic
    // shape error. Wrap explicitly.
    const innerParsed = InnerSchema.safeParse(innerRaw)
    if (!innerParsed.success) {
      throw new HTTPError(
        `MCP web_search: inner content shape changed (${innerParsed.error.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; ")})`,
        callRes,
      )
    }
    const inner = innerParsed.data

    const references: Array<{ title: string; url: string }> = []
    for (const ann of inner.text.annotations ?? []) {
      const cite = ann.url_citation
      if (cite && !cite.url.toLowerCase().includes("bing.com/search")) {
        references.push({ title: cite.title, url: cite.url })
      }
    }

    consola.debug(`Web search returned ${references.length} references`)
    return { content: inner.text.value, references }
  } finally {
    if (sid) {
      // Best-effort session teardown — never throw. Wrap header construction
      // in try{} too: if state.githubToken cleared between init and finally,
      // mcpHeaders(sid) throws synchronously BEFORE fetch is called and
      // .catch() never attaches, which would mask the original error.
      try {
        void fetch(`${copilotBaseUrl(state)}/mcp`, {
          method: "DELETE",
          headers: mcpHeaders(sid),
        }).catch(() => {
          // ignore
        })
      } catch {
        // mcpHeaders threw (token cleared); skip teardown
      }
    }
  }
}
