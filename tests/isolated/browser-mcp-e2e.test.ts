// browser-mcp end-to-end test. Launches a real headless Chromium with
// the extension loaded, installs the NMH manifest pointing at the
// bundled bridge, opens a localhost fixture server, and exercises the
// 6 browser_* tools through the bridge's WebSocket.
//
// Lives in tests/isolated/ because it mutates real filesystem state
// (the NMH manifest under ~/Library/Application Support/Google/Chrome
// on macOS or ~/.config/google-chrome on Linux). Bun's test runner
// runs isolated/ tests in their own subprocess + serialized within the
// file, so concurrent runs of this file don't race the manifest path.
//
// Skip conditions: the test gracefully no-ops when:
//   - Running on Windows (the harness's NMH install path is POSIX-only;
//     Windows registry install is exercised by a separate unit test).
//   - The bridge bundle (`dist/browser-bridge/index.js`) doesn't exist
//     (test prints a hint to run `bun run build`).
//   - Playwright Chromium isn't installed (caller hasn't run
//     `bunx playwright install chromium`).

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { platform } from "node:os"

import { bridgeBundlePath } from "../../src/lib/browser-mcp/native-host-installer"
import {
  createTestProfileDir,
  installNmhManifest,
  launchBrowserWithExtension,
  pollBridgeJson,
  startFixtureServer,
  type WsClient,
  wsClient,
  type BridgeInfo,
  type LaunchedBrowser,
  type FixtureServer,
} from "../browser-mcp/_harness"

const shouldSkip =
  platform() === "win32"
  || !existsSync(bridgeBundlePath())
  || process.env.GH_ROUTER_RUN_BROWSER_E2E !== "1"

const reason =
  platform() === "win32"
    ? "Windows path uses registry-based NMH install (covered by unit tests, not this E2E harness)"
    : !existsSync(bridgeBundlePath())
      ? `bridge bundle missing at ${bridgeBundlePath()} — run \`bun run build\` first`
      : process.env.GH_ROUTER_RUN_BROWSER_E2E !== "1"
        ? "set GH_ROUTER_RUN_BROWSER_E2E=1 to run the browser E2E suite (skipped under the default `bun test` to avoid clashing with tests that mock os.homedir)"
        : ""

let nmh: { manifestPaths: ReadonlyArray<string>; launcherPath: string; uninstall: () => void } | undefined
let browser: LaunchedBrowser | undefined
let fixtures: FixtureServer | undefined
let bridge: BridgeInfo | undefined
let ws: WsClient | undefined

beforeAll(async () => {
  if (shouldSkip) return
  // Chrome for Testing reads NMH manifests from <userDataDir>/NativeMessagingHosts/,
  // NOT the system-wide ~/Library/Application Support/.../NativeMessagingHosts/ dirs
  // that real Chrome uses. Pre-create the profile dir so we can drop the
  // manifest into it BEFORE Chromium launches and reads from it.
  const userDataDir = createTestProfileDir()
  nmh = installNmhManifest({ userDataDir })
  fixtures = await startFixtureServer()
  browser = await launchBrowserWithExtension({ userDataDir })
  // Wait for the extension to load → connectNative → bridge.json appears.
  bridge = await pollBridgeJson(20_000)
  ws = await wsClient(bridge)
}, 60_000)

afterAll(async () => {
  try {
    ws?.close()
  } catch {
    // ignore
  }
  if (browser) await browser.cleanup()
  fixtures?.close()
  nmh?.uninstall()
}, 60_000)

describe("browser-mcp E2E (real Chromium + bridge + extension)", () => {
  test.skipIf(shouldSkip)(
    `__ping__ liveness — bridge ↔ extension round-trip`,
    async () => {
      const res = await ws!.call("__ping__", {})
      expect(res.ok).toBe(true)
      expect((res.data as { pong: boolean }).pong).toBe(true)
      expect((res.data as { extension_version: string }).extension_version).toBe(
        "0.0.1",
      )
    },
  )

  test.skipIf(shouldSkip)("browser_list_tabs returns at least one tab", async () => {
    const res = await ws!.call("browser_list_tabs", {})
    expect(res.ok).toBe(true)
    const tabs = (res.data as { tabs: Array<{ id: number; url: string }> }).tabs
    expect(Array.isArray(tabs)).toBe(true)
    expect(tabs.length).toBeGreaterThanOrEqual(1)
  })

  test.skipIf(shouldSkip)(
    "browser_open_tab opens the fixture URL and waits for load",
    async () => {
      const url = `${fixtures!.base}/page.html`
      const res = await ws!.call("browser_open_tab", { url })
      expect(res.ok).toBe(true)
      const data = res.data as { tabId: number; finalUrl: string }
      expect(typeof data.tabId).toBe("number")
      expect(data.finalUrl).toContain("page.html")
    },
  )

  test.skipIf(shouldSkip)(
    "browser_read_page returns text containing the fixture marker + interactive elements",
    async () => {
      const url = `${fixtures!.base}/page.html`
      const opened = await ws!.call("browser_open_tab", { url })
      const tabId = (opened.data as { tabId: number }).tabId
      const res = await ws!.call("browser_read_page", { tabId })
      expect(res.ok).toBe(true)
      const data = res.data as {
        text: string
        elements: Array<{ ref: string; role: string; name: string }>
      }
      expect(data.text).toContain("READ_PAGE_MARKER")
      // Fixture has a button, an input, and a link.
      expect(data.elements.length).toBeGreaterThanOrEqual(3)
      expect(data.elements.some((e) => e.role === "button")).toBe(true)
      expect(data.elements.some((e) => e.role === "input")).toBe(true)
    },
  )

  test.skipIf(shouldSkip)(
    "browser_screenshot returns a base64 PNG with non-trivial bytes",
    async () => {
      const url = `${fixtures!.base}/page.html`
      const opened = await ws!.call("browser_open_tab", { url })
      const tabId = (opened.data as { tabId: number }).tabId
      const res = await ws!.call("browser_screenshot", { tabId })
      expect(res.ok).toBe(true)
      const data = res.data as { contentType: string; dataBase64: string }
      expect(data.contentType).toBe("image/png")
      expect(data.dataBase64.length).toBeGreaterThan(100)
      // PNG magic: 89 50 4E 47 → base64 "iVBORw"
      expect(data.dataBase64.startsWith("iVBORw")).toBe(true)
    },
  )

  test.skipIf(shouldSkip)(
    "browser_navigate goto changes the tab URL",
    async () => {
      const opened = await ws!.call("browser_open_tab", { url: `${fixtures!.base}/page.html` })
      const tabId = (opened.data as { tabId: number }).tabId
      const res = await ws!.call("browser_navigate", {
        tabId,
        action: "goto",
        url: `${fixtures!.base}/page2.html`,
      })
      expect(res.ok).toBe(true)
      const data = res.data as { finalUrl: string }
      expect(data.finalUrl).toContain("page2.html")
    },
  )

  test.skipIf(shouldSkip)(
    "browser_open_tab blocks chrome://settings without navigating",
    async () => {
      const res = await ws!.call("browser_open_tab", { url: "chrome://settings" })
      expect(res.ok).toBe(true)
      const data = res.data as { blocked: boolean; reason: string }
      expect(data.blocked).toBe(true)
      // Cross-check: list_tabs shouldn't show a chrome://settings tab.
      const list = await ws!.call("browser_list_tabs", {})
      const tabs = (list.data as { tabs: Array<{ url: string }> }).tabs
      expect(tabs.some((t) => /^chrome:\/\/settings/.test(t.url))).toBe(false)
    },
  )

  test.skipIf(shouldSkip)("browser_close_tab removes the tab", async () => {
    const opened = await ws!.call("browser_open_tab", {
      url: `${fixtures!.base}/page.html`,
    })
    const tabId = (opened.data as { tabId: number }).tabId
    const closed = await ws!.call("browser_close_tab", { tabIds: [tabId] })
    expect(closed.ok).toBe(true)
    expect((closed.data as { closed: number }).closed).toBe(1)
  })

  test.skipIf(shouldSkip)(
    "browser_click follows a link by ref returned from browser_read_page",
    async () => {
      const opened = await ws!.call("browser_open_tab", { url: `${fixtures!.base}/page.html` })
      const tabId = (opened.data as { tabId: number }).tabId
      const read = await ws!.call("browser_read_page", { tabId })
      const elements = (read.data as { elements: Array<{ ref: string; role: string; name: string }> }).elements
      // Fixture page.html has an anchor "go to page 2".
      const link = elements.find((e) => e.role === "a")
      expect(link).toBeDefined()
      const clicked = await ws!.call("browser_click", { tabId, ref: link!.ref })
      if (!clicked.ok) console.error("browser_click error:", clicked.error)
      expect(clicked.ok).toBe(true)
      expect((clicked.data as { navigated: boolean }).navigated).toBe(true)
    },
  )

  test.skipIf(shouldSkip)(
    "browser_fill types into the fixture input",
    async () => {
      const opened = await ws!.call("browser_open_tab", { url: `${fixtures!.base}/page.html` })
      const tabId = (opened.data as { tabId: number }).tabId
      const filled = await ws!.call("browser_fill", {
        tabId,
        selector: "#in",
        value: "hello world",
      })
      if (!filled.ok) console.error("browser_fill error:", filled.error)
      expect(filled.ok).toBe(true)
      // Verify via eval_js so we don't trust the fill tool's self-report.
      const ev = await ws!.call("browser_eval_js", {
        tabId,
        expression: 'document.getElementById("in").value',
      })
      expect(ev.ok).toBe(true)
      expect((ev.data as { result: unknown }).result).toBe("hello world")
    },
  )

  test.skipIf(shouldSkip)(
    "browser_scroll updates window.scrollY",
    async () => {
      const opened = await ws!.call("browser_open_tab", { url: `${fixtures!.base}/page.html` })
      const tabId = (opened.data as { tabId: number }).tabId
      // First force the page to be taller than the viewport so scroll has somewhere to go.
      await ws!.call("browser_eval_js", {
        tabId,
        expression: 'document.body.style.height = "5000px"',
      })
      const scrolled = await ws!.call("browser_scroll", { tabId, target: "pixels", pixels: 500 })
      if (!scrolled.ok) console.error("browser_scroll error:", scrolled.error)
      expect(scrolled.ok).toBe(true)
      const data = scrolled.data as { scrollY: number; pageHeight: number }
      expect(data.scrollY).toBeGreaterThan(0)
    },
  )

  test.skipIf(shouldSkip)(
    "browser_eval_js returns the value of a simple expression",
    async () => {
      const opened = await ws!.call("browser_open_tab", { url: `${fixtures!.base}/page.html` })
      const tabId = (opened.data as { tabId: number }).tabId
      const ev = await ws!.call("browser_eval_js", { tabId, expression: "1 + 2 * 3" })
      expect(ev.ok).toBe(true)
      expect((ev.data as { result: number }).result).toBe(7)
    },
  )

  test.skipIf(shouldSkip)(
    "browser_wait until=selector returns when the element appears",
    async () => {
      const opened = await ws!.call("browser_open_tab", { url: `${fixtures!.base}/page.html` })
      const tabId = (opened.data as { tabId: number }).tabId
      // Inject a new element after a delay; browser_wait should pick it up.
      void ws!.call("browser_eval_js", {
        tabId,
        expression:
          'setTimeout(() => { const el = document.createElement("div"); el.id = "late-arrival"; document.body.appendChild(el); }, 500)',
      })
      const waited = await ws!.call("browser_wait", {
        tabId,
        until: "selector",
        selector: "#late-arrival",
        timeoutMs: 5000,
      })
      expect(waited.ok).toBe(true)
      const data = waited.data as { ok: boolean; elapsedMs: number }
      expect(data.ok).toBe(true)
      expect(data.elapsedMs).toBeGreaterThanOrEqual(400)
    },
  )
})

// When skipping, surface the reason so CI logs are self-documenting.
if (shouldSkip) {
  console.log(`[browser-mcp E2E] skipped: ${reason}`)
}
