// Hands-on smoke test for the browser-mcp surface. Drives the same
// wire path a real Claude session would use (the bridge's localhost
// WebSocket with bearer-token auth), against Playwright's Chrome for
// Testing with the extension loaded. Prints one line per probe so we
// can read the actual server responses, not just pass/fail.

import { existsSync } from "node:fs"

import { chromium } from "playwright"

import { bridgeBundlePath } from "../src/lib/browser-mcp/native-host-installer"
import {
  createTestProfileDir,
  installNmhManifest,
  launchBrowserWithExtension,
  pollBridgeJson,
  startFixtureServer,
  wsClient,
} from "../tests/browser-mcp/_harness"

const ANSI_BOLD = "\x1b[1m"
const ANSI_GREEN = "\x1b[32m"
const ANSI_RED = "\x1b[31m"
const ANSI_DIM = "\x1b[2m"
const ANSI_RESET = "\x1b[0m"

let pass = 0
let fail = 0

function probe(name: string, ok: boolean, detail = "") {
  const tag = ok ? `${ANSI_GREEN}PASS${ANSI_RESET}` : `${ANSI_RED}FAIL${ANSI_RESET}`
  if (ok) pass++
  else fail++
  console.log(`  [${tag}] ${name}${detail ? `  ${ANSI_DIM}${detail}${ANSI_RESET}` : ""}`)
}

async function main(): Promise<void> {
  console.log(`${ANSI_BOLD}browser-mcp hands-on smoke test${ANSI_RESET}`)
  console.log(`${ANSI_DIM}Drives Playwright's Chrome for Testing with the freshly-built extension + bridge.${ANSI_RESET}\n`)

  if (!existsSync(bridgeBundlePath())) {
    console.error(`bridge bundle missing at ${bridgeBundlePath()} — run \`bun run build\` first`)
    process.exit(1)
  }

  void chromium  // keep the import live across the harness call

  console.log(`${ANSI_BOLD}== setup ==${ANSI_RESET}`)
  const userDataDir = createTestProfileDir()
  const nmh = installNmhManifest({ userDataDir })
  console.log(`  ${ANSI_DIM}NMH manifest written to ${nmh.manifestPaths.length} locations${ANSI_RESET}`)
  console.log(`  ${ANSI_DIM}Launcher: ${nmh.launcherPath}${ANSI_RESET}`)

  const fixtures = await startFixtureServer()
  console.log(`  ${ANSI_DIM}Fixture server at ${fixtures.base}${ANSI_RESET}`)

  const browser = await launchBrowserWithExtension({ userDataDir })
  console.log(`  ${ANSI_DIM}Chromium launched, extension loaded${ANSI_RESET}`)

  const info = await pollBridgeJson(20_000)
  console.log(`  ${ANSI_DIM}Bridge ready at 127.0.0.1:${info.port} (pid ${info.pid})${ANSI_RESET}`)

  const ws = await wsClient(info)
  console.log(`  ${ANSI_DIM}WebSocket connected${ANSI_RESET}\n`)

  try {
    console.log(`${ANSI_BOLD}== happy path (a model walks an actual page) ==${ANSI_RESET}`)

    const ping = await ws.call("__ping__", {})
    probe("__ping__ liveness", ping.ok && (ping.data as { pong: boolean }).pong === true,
      `extension_version=${(ping.data as { extension_version: string })?.extension_version}`)

    const url = `${fixtures.base}/page.html`
    const opened = await ws.call("browser_open_tab", { url })
    const tabId = (opened.data as { tabId: number }).tabId
    probe("browser_open_tab opens fixture URL", opened.ok && typeof tabId === "number",
      `tabId=${tabId}, finalUrl=${(opened.data as { finalUrl: string }).finalUrl}`)

    const tabs = await ws.call("browser_list_tabs", {})
    const t = (tabs.data as { tabs: Array<{ id: number; url: string }> }).tabs.find((x) => x.id === tabId)
    probe("browser_list_tabs sees the new tab", !!t, `${t?.url}`)

    const read = await ws.call("browser_read_page", { tabId })
    const data = read.data as { text: string; elements: Array<{ ref: string; role: string; name: string }> }
    probe("browser_read_page returns text + element refs",
      data.text.includes("READ_PAGE_MARKER") && data.elements.length >= 3,
      `text=${data.text.length}B, elements=${data.elements.length}`)

    const linkRef = data.elements.find((e) => e.role === "a")?.ref
    probe("read_page exposes anchor as ref", !!linkRef, `ref=${linkRef}`)

    const shot = await ws.call("browser_screenshot", { tabId })
    const img = shot.data as { contentType: string; dataBase64: string }
    probe("browser_screenshot returns PNG bytes",
      shot.ok && img.contentType === "image/png" && img.dataBase64.startsWith("iVBORw"),
      `${img.dataBase64.length}B of base64`)

    const fillRes = await ws.call("browser_fill", { tabId, selector: "#in", value: "hello from smoke test" })
    probe("browser_fill sets input value", fillRes.ok)
    const verify = await ws.call("browser_eval_js", { tabId, expression: 'document.getElementById("in").value' })
    probe("browser_eval_js reads back the value",
      verify.ok && (verify.data as { result: string }).result === "hello from smoke test")

    const clickRes = await ws.call("browser_click", { tabId, ref: linkRef })
    probe("browser_click follows link by ref",
      clickRes.ok && (clickRes.data as { navigated: boolean }).navigated === true)

    const evRes = await ws.call("browser_eval_js", { tabId, expression: "1 + 2 * 3" })
    probe("browser_eval_js arithmetic",
      evRes.ok && (evRes.data as { result: number }).result === 7)

    await ws.call("browser_eval_js", { tabId, expression: 'document.body.style.height = "3000px"' })
    const scrollRes = await ws.call("browser_scroll", { tabId, target: "pixels", pixels: 400 })
    probe("browser_scroll by pixels",
      scrollRes.ok && (scrollRes.data as { scrollY: number }).scrollY > 0,
      `scrollY=${(scrollRes.data as { scrollY: number }).scrollY}`)

    const waited = await ws.call("browser_wait", {
      tabId,
      until: "selector",
      selector: "body",
      timeoutMs: 2000,
    })
    probe("browser_wait until=selector",
      waited.ok && (waited.data as { ok: boolean }).ok === true)

    console.log()
    console.log(`${ANSI_BOLD}== edge cases ==${ANSI_RESET}`)

    const blockedSettings = await ws.call("browser_open_tab", { url: "chrome://settings" })
    probe("chrome://settings blocked",
      blockedSettings.ok && (blockedSettings.data as { blocked: boolean }).blocked === true,
      (blockedSettings.data as { reason?: string }).reason ?? "")

    const blockedFlags = await ws.call("browser_navigate", {
      tabId,
      action: "goto",
      url: "chrome://flags",
    })
    probe("chrome://flags blocked",
      blockedFlags.ok && (blockedFlags.data as { blocked: boolean }).blocked === true)

    const blockedExtensions = await ws.call("browser_open_tab", { url: "edge://extensions" })
    probe("edge://extensions blocked (cross-browser regex)",
      blockedExtensions.ok && (blockedExtensions.data as { blocked: boolean }).blocked === true)

    const devtools = await ws.call("browser_open_tab", { url: "about:blank" })
    probe("about:blank allowed (regression check for over-blocking)",
      devtools.ok && typeof (devtools.data as { tabId: number }).tabId === "number")

    const badRef = await ws.call("browser_click", { tabId, ref: "e999-does-not-exist" })
    probe("click on non-existent ref fails with clear error",
      !badRef.ok && /element not found/i.test(badRef.error || ""),
      badRef.error)

    const badTabId = await ws.call("browser_screenshot", { tabId: 999999 })
    probe("screenshot on non-existent tabId fails with error",
      !badTabId.ok && (badTabId.error || "").length > 0,
      (badTabId.error || "").slice(0, 80))

    const noArgs = await ws.call("browser_click", { tabId })
    probe("click without ref or selector returns clear error",
      !noArgs.ok && /ref or selector/i.test(noArgs.error || ""),
      noArgs.error)

    const syntaxErr = await ws.call("browser_eval_js", { tabId, expression: "this is not valid js (((" })
    const synData = syntaxErr.data as { error?: string }
    probe("eval_js with syntax error returns {error} not crash",
      syntaxErr.ok && typeof synData.error === "string",
      synData.error?.slice(0, 80))

    const consoleProbe = await ws.call("browser_console_logs", { tabId })
    probe("browser_console_logs returns an entries array (attach lazy ok)",
      consoleProbe.ok && Array.isArray((consoleProbe.data as { entries: unknown[] }).entries))

    await ws.call("browser_eval_js", {
      tabId,
      expression: 'console.log("smoke marker"); console.warn("warn marker")',
    })
    await new Promise((r) => setTimeout(r, 300))
    const consoleDrain = await ws.call("browser_console_logs", { tabId })
    const entries = (consoleDrain.data as { entries: Array<{ level: string; text: string }> }).entries
    probe("console_logs captures the two markers",
      consoleDrain.ok && entries.some((e) => e.text.includes("smoke marker")),
      `${entries.length} entries`)

    const netProbe = await ws.call("browser_network_log", { tabId })
    probe("browser_network_log returns entries array",
      netProbe.ok && Array.isArray((netProbe.data as { entries: unknown[] }).entries))

    const closed = await ws.call("browser_close_tab", { tabIds: [tabId] })
    probe("browser_close_tab removes the tab",
      closed.ok && (closed.data as { closed: number }).closed === 1)

    console.log()
    console.log(`${ANSI_BOLD}== summary ==${ANSI_RESET}`)
    console.log(`  ${pass} pass, ${fail} fail`)
    if (fail > 0) {
      console.log(`  ${ANSI_RED}${fail} probe(s) failed${ANSI_RESET}`)
    } else {
      console.log(`  ${ANSI_GREEN}all probes passed${ANSI_RESET}`)
    }
  } finally {
    ws.close()
    await browser.cleanup()
    fixtures.close()
    nmh.uninstall()
  }

  process.exit(fail > 0 ? 1 : 0)
}

main().catch((err) => {
  console.error(`${ANSI_RED}smoke test crashed:${ANSI_RESET}`, err)
  process.exit(2)
})
