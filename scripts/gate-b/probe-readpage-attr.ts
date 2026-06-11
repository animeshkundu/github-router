// probe-readpage-attr.ts — does read_page surface TOP-FRAME markers (t10) and
// POST-INTERACTION content (t07 after clicking Accept)? Settles whether the
// widespread fabrication is read_page failing or the model not gathering.
import { readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { dispatchBrowserTool } from "~/lib/browser-mcp/dispatch"

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url))
const RM = path.join(REPO_ROOT, "tests/fixtures/browser/manifest.runtime.json")
const tx = (e: { content?: Array<{ text?: string }> }) => (e.content ?? []).map((c) => c.text ?? "").join("\n")
const d = async (t: string, a: Record<string, unknown>) => tx(await dispatchBrowserTool(t, a))
const has = (h: string, n: string) => h.toLowerCase().includes(n.toLowerCase())

async function main(): Promise<void> {
  const m = JSON.parse(await readFile(RM, "utf8")) as { baseUrl: string; crossOriginBaseUrl: string }
  const base = m.baseUrl.replace(/\/$/, ""); const xo = m.crossOriginBaseUrl.replace(/\/$/, "")

  // t10: cross-origin-frame.html loaded directly — XOM is top-frame text.
  const t10tab = (JSON.parse(await d("browser_open_tab", { url: `${xo}/cross-origin-frame.html` })) as { tabId: number }).tabId
  await d("browser_wait", { tabId: t10tab, ms: 600 }).catch(() => "")
  const rp10 = await d("browser_read_page", { tabId: t10tab, mode: "full" })
  console.log(`t10 read_page surfaces XOM_7f3a91 (top-frame text): ${has(rp10, "XOM_7f3a91") ? "YES ✓ (model fabrication = laziness, not read_page)" : "NO ✗ (read_page broken even for top-frame text)"} | len=${rp10.length}`)
  await d("browser_close_tab", { tabIds: [t10tab] }).catch(() => "")

  // t07: blocker — read before + after clicking Accept.
  const t07tab = (JSON.parse(await d("browser_open_tab", { url: `${base}/blocker.html` })) as { tabId: number }).tabId
  await d("browser_wait", { tabId: t07tab, ms: 400 }).catch(() => "")
  const before = await d("browser_read_page", { tabId: t07tab, mode: "full" })
  console.log(`t07 BEFORE click: WALL present=${has(before, "WALL_e51d72")} acceptLabel present=${has(before, "Accept all")} len=${before.length}`)
  // Click via eval_js (deterministic) to simulate the model dismissing the gate.
  await d("browser_eval_js", { tabId: t07tab, expression: "document.getElementById('accept-all').click(); 'clicked'" }).catch(() => "")
  await d("browser_wait", { tabId: t07tab, ms: 400 }).catch(() => "")
  const after = await d("browser_read_page", { tabId: t07tab, mode: "full" })
  console.log(`t07 AFTER click: WALL_e51d72 present=${has(after, "WALL_e51d72") ? "YES ✓" : "NO ✗"} len=${after.length}`)
  await d("browser_close_tab", { tabIds: [t07tab] }).catch(() => "")
  process.exit(0)
}
main().catch((e) => { console.error("fatal", e); process.exit(2) })
