// probe-dump.ts — dump the raw read_page envelope + diagnostics to determine
// whether the CDP pierce extractor ran (truncated.diag present, frames>1) or
// fell back to legacy. Throwaway forensics.
import { readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { dispatchBrowserTool } from "~/lib/browser-mcp/dispatch"

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url))
const RUNTIME_MANIFEST = path.join(REPO_ROOT, "tests/fixtures/browser/manifest.runtime.json")

function textOf(env: { content?: Array<{ text?: string }>; isError?: boolean }): string {
  return (env.content ?? []).map((c) => c.text ?? "").join("\n")
}
async function dispatch(tool: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
  const env = await dispatchBrowserTool(tool, args)
  return { text: textOf(env), isError: env.isError === true }
}

async function main(): Promise<void> {
  const m = JSON.parse(await readFile(RUNTIME_MANIFEST, "utf8")) as { baseUrl: string }
  const url = `${m.baseUrl.replace(/\/$/, "")}/iframe-torture.html`
  const open = await dispatch("browser_open_tab", { url })
  const tabId = (JSON.parse(open.text) as { tabId: number }).tabId
  console.log(`tabId=${tabId} url=${url}`)
  try {
    await dispatch("browser_wait", { tabId, ms: 1500 })
    // diagnostics
    const diag = await dispatch("browser_diagnostics", { tabId })
    console.log("\n===== browser_diagnostics =====")
    console.log(diag.text.slice(0, 2000))

    const rp = await dispatch("browser_read_page", { tabId, mode: "full" })
    console.log("\n===== read_page mode=full (raw envelope) =====")
    console.log(rp.text)
    // Parse + summarize
    try {
      const snap = JSON.parse(rp.text) as Record<string, unknown>
      const tr = snap.truncated as Record<string, unknown> | undefined
      console.log("\n===== summary =====")
      console.log("keys:", Object.keys(snap).join(","))
      console.log("truncated:", JSON.stringify(tr))
      console.log("text field length:", typeof snap.text === "string" ? (snap.text as string).length : "n/a")
      console.log("elements:", Array.isArray(snap.elements) ? (snap.elements as unknown[]).length : "n/a")
      const cdpRan = tr && typeof (tr as { diag?: unknown }).diag === "object"
      console.log(`CDP extractor ran: ${cdpRan ? "YES (truncated.diag present)" : "NO → legacy fallback"}`)
    } catch (e) {
      console.log("parse error:", e instanceof Error ? e.message : String(e))
    }
  } finally {
    await dispatch("browser_close_tab", { tabIds: [tabId] }).catch(() => ({ text: "", isError: false }))
  }
  process.exit(0)
}
main().catch((e) => { console.error("fatal", e); process.exit(2) })
