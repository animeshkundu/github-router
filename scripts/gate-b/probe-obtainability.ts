// probe-obtainability.ts — empirically map which markers a capable model CAN
// obtain in THIS live environment, per available tool path. Throwaway forensics.
import { readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { dispatchBrowserTool } from "~/lib/browser-mcp/dispatch"

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url))
const RUNTIME_MANIFEST = path.join(REPO_ROOT, "tests/fixtures/browser/manifest.runtime.json")

function textOf(env: { content?: Array<{ text?: string }>; isError?: boolean }): string {
  return (env.content ?? []).map((c) => c.text ?? "").join("\n")
}
async function d(tool: string, args: Record<string, unknown>): Promise<string> {
  const env = await dispatchBrowserTool(tool, args)
  return textOf(env)
}
const has = (h: string, n: string) => h.toLowerCase().includes(n.toLowerCase())

async function main(): Promise<void> {
  const m = JSON.parse(await readFile(RUNTIME_MANIFEST, "utf8")) as { baseUrl: string; crossOriginBaseUrl: string }
  const base = m.baseUrl.replace(/\/$/, "")
  const tabId = (JSON.parse(await d("browser_open_tab", { url: `${base}/iframe-torture.html` })) as { tabId: number }).tabId
  try {
    await d("browser_wait", { tabId, ms: 1500 })

    // t03 SOM via eval_js same-origin contentDocument
    const som = await d("browser_eval_js", { tabId, expression:
      "(()=>{try{const f=document.getElementById('same-origin-frame');return f.contentDocument.body.innerText}catch(e){return 'ERR_'+e.name}})()" })
    console.log(`t03 SOM via eval_js(contentDocument): ${has(som, "SOM_b4e2c8") ? "OBTAINABLE ✓" : "NO"} → ${som.slice(0,120).replace(/\n/g,' ')}`)

    // t05 CSM via eval_js atob(script) shortcut
    const csm = await d("browser_eval_js", { tabId, expression:
      "(()=>{const t=[...document.scripts].map(s=>s.textContent).join('');const m=t.match(/Q1NN[A-Za-z0-9+/=]+/);try{return m?atob(m[0]):'NO_MATCH'}catch(e){return 'ERR'}})()" })
    console.log(`t05 CSM via eval_js(atob script): ${has(csm, "CSM_9d1f06") ? "OBTAINABLE ✓ (shortcut)" : "NO"} → ${csm.slice(0,60)}`)

    // t05 CSM via closed-shadow direct (should be impossible — closed root)
    const csmClosed = await d("browser_eval_js", { tabId, expression:
      "(()=>{const h=document.getElementById('secret-host');return h&&h.shadowRoot?h.shadowRoot.textContent:'shadowRoot_is_null_closed'})()" })
    console.log(`     CSM via element.shadowRoot (closed): ${csmClosed.slice(0,80).replace(/\n/g,' ')}`)

    // t04 XOM: only via screenshot (SOP blocks eval_js). Confirm screenshot returns a PNG.
    const shotEnv = await dispatchBrowserTool("browser_screenshot", { tabId })
    const shotText = textOf(shotEnv)
    let shotBytes = 0
    try { const j = JSON.parse(shotText) as { dataBase64?: string; data?: string }; shotBytes = (j.dataBase64 ?? j.data ?? "").length } catch { shotBytes = shotText.length }
    console.log(`t04 XOM via screenshot: PNG base64 len=${shotBytes} (renders XOM_7f3a91 visibly in the cross-origin iframe; model must READ pixels)`)

    // Retry read_page a SECOND time (AX domains now enabled by prior eval_js attach)
    const rp2 = await d("browser_read_page", { tabId, mode: "full" })
    console.log(`\nread_page (2nd attempt) markers: SOM=${has(rp2,'SOM_b4e2c8')} XOM=${has(rp2,'XOM_7f3a91')} CSM=${has(rp2,'CSM_9d1f06')} len=${rp2.length}`)
  } finally {
    await d("browser_close_tab", { tabIds: [tabId] }).catch(() => "")
  }
  process.exit(0)
}
main().catch((e) => { console.error("fatal", e); process.exit(2) })
