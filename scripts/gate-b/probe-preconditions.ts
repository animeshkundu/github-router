// probe-preconditions.ts — verify the live fairness preconditions SCORING.md §12
// names, on the EXACT eval path (dispatchBrowserTool → browser_read_page). Throwaway.
//
//   bun scripts/gate-b/probe-preconditions.ts [baseUrl]
//
// Checks:
//   §12.1 CDP piercing — read_page(iframe-torture) surfaces the cross-origin
//         marker (t04) AND the closed-shadow marker (t05). If either is absent,
//         that task is unobtainable for ALL models → must drop from |OBT|.
//   §12.4 eval_js source-scrape shortcut — can a model atob() the render-only
//         markers straight out of inline <script> text without the intended
//         interaction? (Symmetric across models; capability-purity caveat.)

import { readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { dispatchBrowserTool } from "~/lib/browser-mcp/dispatch"

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url))
const RUNTIME_MANIFEST = path.join(REPO_ROOT, "tests/fixtures/browser/manifest.runtime.json")

function textOf(env: { content?: Array<{ text?: string }>; isError?: boolean }): string {
  return (env.content ?? []).map((c) => c.text ?? "").join("\n")
}

async function dispatch(tool: string, args: Record<string, unknown>): Promise<string> {
  const env = await dispatchBrowserTool(tool, args)
  const text = textOf(env)
  if (env.isError) throw new Error(`${tool} error: ${text}`)
  return text
}

async function resolveBaseUrl(argv: Array<string>): Promise<string> {
  if (argv[0]) return argv[0]
  const m = JSON.parse(await readFile(RUNTIME_MANIFEST, "utf8")) as { baseUrl?: string }
  if (!m.baseUrl) throw new Error("no baseUrl in manifest.runtime.json — pass it as arg")
  return m.baseUrl
}

function has(haystack: string, needle: string): boolean {
  return haystack.toLowerCase().includes(needle.toLowerCase())
}

async function main(): Promise<void> {
  const baseUrl = (await resolveBaseUrl(process.argv.slice(2))).replace(/\/$/, "")
  const url = `${baseUrl}/iframe-torture.html`
  console.log(`[probe] iframe-torture at ${url}`)

  const openText = await dispatch("browser_open_tab", { url })
  const tabId = (JSON.parse(openText) as { tabId: number }).tabId
  console.log(`[probe] tabId=${tabId}`)

  try {
    // Give the cross-origin iframe + closed-shadow custom element time to load.
    await dispatch("browser_wait", { tabId, ms: 1200 }).catch(() => "")

    const full = await dispatch("browser_read_page", { tabId, mode: "full" })
    const XOM = has(full, "XOM_7f3a91") // t04 cross-origin iframe
    const SOM = has(full, "SOM_b4e2c8") // t03 same-origin iframe
    const CSM = has(full, "CSM_9d1f06") // t05 closed shadow root
    console.log("\n========== §12.1 CDP-PIERCE PRECONDITION (read_page mode=full) ==========")
    console.log(`  t03 same-origin marker  SOM_b4e2c8 : ${SOM ? "PRESENT ✓" : "ABSENT ✗"}`)
    console.log(`  t04 cross-origin marker XOM_7f3a91 : ${XOM ? "PRESENT ✓ (CDP pierces OOPIF)" : "ABSENT ✗ → t04 UNOBTAINABLE, drop from |OBT|"}`)
    console.log(`  t05 closed-shadow marker CSM_9d1f06: ${CSM ? "PRESENT ✓ (CDP pierces closed shadow)" : "ABSENT ✗ → t05 UNOBTAINABLE, drop from |OBT|"}`)
    console.log(`  read_page length: ${full.length} chars`)

    // §12.4 — eval_js source-scrape shortcut feasibility.
    console.log("\n========== §12.4 eval_js SOURCE-SCRAPE SHORTCUT ==========")
    const scriptScan = await dispatch("browser_eval_js", {
      tabId,
      expression:
        "(()=>{const t=[...document.scripts].map(s=>s.textContent).join('\\n');const m=t.match(/\"([A-Za-z0-9+/=]{8,})\"/g)||[];const dec=m.map(x=>{try{return atob(x.replace(/\"/g,''))}catch{return ''}}).filter(Boolean);return JSON.stringify(dec)})()",
    })
    console.log(`  atob() of inline-script base64 literals → ${scriptScan}`)
    console.log("  (if this contains CSM_9d1f06 the closed-shadow task is shortcut-able via eval_js;")
    console.log("   symmetric across both models, does NOT affect the fabrication metric.)")

    // Confirm the cross-origin marker is NOT liftable via top-frame eval_js (SOP).
    const xframeAttempt = await dispatch("browser_eval_js", {
      tabId,
      expression:
        "(()=>{try{const f=document.getElementById('cross-origin-frame');return (f&&f.contentDocument)?(f.contentDocument.body.innerText):'NULL_contentDocument_SOP_blocked'}catch(e){return 'THREW_'+e.name}})()",
    })
    console.log(`\n  top-frame eval_js reaching into cross-origin iframe → ${xframeAttempt}`)
    console.log("  (expected NULL/THROW: SOP blocks it, so t04 genuinely needs CDP read_page — not eval_js.)")
  } finally {
    await dispatch("browser_close_tab", { tabIds: [tabId] }).catch(() => "")
  }
  process.exit(0)
}

main().catch((err) => {
  console.error(`[probe fatal] ${err instanceof Error ? err.message : String(err)}`)
  process.exit(2)
})
