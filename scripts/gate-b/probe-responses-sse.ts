// probe-responses-sse.ts — capture the RAW /responses SSE event shapes the live
// gpt-5.4-mini stream emits for a forced tool call, to see why stream-fn.ts's
// argument assembly yields {} (empty args) live despite the unit-test fix.
// Throwaway forensics. Prints every event type + the fields stream-fn keys on.

import { state } from "~/lib/state"
import { setupCopilotToken, setupGitHubToken } from "~/lib/token"
import { cacheModels, cacheCopilotVersion, cacheVSCodeVersion } from "~/lib/utils"
import { ensurePaths } from "~/lib/paths"
import { createResponses } from "~/services/copilot/create-responses"
import type { ResponsesPayload } from "~/services/copilot/create-responses"

async function main(): Promise<void> {
  await ensurePaths()
  await cacheVSCodeVersion()
  await cacheCopilotVersion()
  await setupGitHubToken()
  await setupCopilotToken()
  await cacheModels()
  if (!state.copilotToken) throw new Error("no copilot token")

  const payload: ResponsesPayload = {
    model: "gpt-5.4-mini",
    stream: true,
    instructions:
      "You drive a browser. To begin you MUST call the open_tab tool with the url argument set to the page you are told to open. Always include all required arguments.",
    input: [
      { role: "user", content: "Open https://example.com/page.html in a tab. Call open_tab now with the url argument." },
    ],
    tools: [
      {
        type: "function",
        name: "open_tab",
        description: "Open a URL in a new tab.",
        parameters: {
          type: "object",
          required: ["url"],
          additionalProperties: false,
          properties: { url: { type: "string", description: "The URL to open." } },
        },
      },
    ],
    tool_choice: "auto",
    reasoning: { effort: "xhigh" },
  }

  const stream = await createResponses(payload, undefined, undefined)
  if (!stream || typeof (stream as AsyncIterable<unknown>)[Symbol.asyncIterator] !== "function") {
    throw new Error("no stream")
  }
  console.log("===== RAW /responses SSE events (gpt-5.4-mini, forced open_tab) =====")
  let n = 0
  for await (const evt of stream as AsyncIterable<{ data?: string }>) {
    const data = evt?.data
    if (data == null) continue
    if (data === "[DONE]") { console.log("[DONE]"); break }
    let ev: Record<string, unknown>
    try { ev = JSON.parse(data) as Record<string, unknown> } catch { console.log(`  (unparseable) ${data.slice(0, 120)}`); continue }
    n++
    const type = ev.type as string | undefined
    const j = (v: unknown): string => {
      const s = JSON.stringify(v)
      return s === undefined ? "undefined" : s.slice(0, 80)
    }
    // Print the fields the parser keys on for tool calls.
    const item = ev.item as Record<string, unknown> | undefined
    const parts: Array<string> = [`#${n} ${type}`]
    if (ev.output_index !== undefined) parts.push(`output_index=${j(ev.output_index)}`)
    if (ev.content_index !== undefined) parts.push(`content_index=${j(ev.content_index)}`)
    if (ev.item_id !== undefined) parts.push(`item_id=${j(ev.item_id)}`)
    if (ev.delta !== undefined) parts.push(`delta=${j(ev.delta)}`)
    if (ev.arguments !== undefined) parts.push(`arguments=${j(ev.arguments)}`)
    if (item) parts.push(`item.id=${j(item.id)} call_id=${j(item.call_id)} name=${j(item.name)}`)
    // Only print tool-relevant + structural events to keep it readable.
    if (
      type &&
      (type.includes("function_call") || type.includes("output_item") || type === "response.completed" || type === "response.created")
    ) {
      console.log("  " + parts.join("  "))
    }
  }
  process.exit(0)
}
main().catch((e) => { console.error("fatal", e instanceof Error ? e.stack : e); process.exit(2) })
