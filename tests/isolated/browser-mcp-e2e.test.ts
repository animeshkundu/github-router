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

  // ─────────────────────────────────────────────────────────────────────
  // Humanlike-input v2: browser_mouse / browser_drag / browser_type /
  // browser_locate plus browser_scroll(at-pointer) and browser_read_page
  // viewport block.
  // ─────────────────────────────────────────────────────────────────────

  async function openHumanlikeFixture(): Promise<number> {
    const opened = await ws!.call("browser_open_tab", {
      url: `${fixtures!.base}/humanlike.html`,
    })
    if (!opened.ok) throw new Error(`open humanlike fixture: ${opened.error}`)
    return (opened.data as { tabId: number }).tabId
  }

  test.skipIf(shouldSkip)(
    "browser_read_page exposes viewport metadata (width / dpr / scroll)",
    async () => {
      const tabId = await openHumanlikeFixture()
      const res = await ws!.call("browser_read_page", { tabId })
      expect(res.ok).toBe(true)
      const data = res.data as {
        viewport: {
          width: number; height: number; devicePixelRatio: number;
          scrollX: number; scrollY: number;
        }
      }
      expect(data.viewport).toBeDefined()
      expect(typeof data.viewport.width).toBe("number")
      expect(typeof data.viewport.height).toBe("number")
      expect(typeof data.viewport.devicePixelRatio).toBe("number")
      expect(data.viewport.devicePixelRatio).toBeGreaterThan(0)
    },
  )

  test.skipIf(shouldSkip)(
    "browser_locate returns bbox + viewport + topmostAtCenter (with overlay detection)",
    async () => {
      const tabId = await openHumanlikeFixture()
      const direct = await ws!.call("browser_locate", { tabId, selector: "#click-btn" })
      expect(direct.ok).toBe(true)
      const d = direct.data as {
        found: boolean; bbox: [number, number, number, number];
        center: [number, number]; visible: boolean; inView: boolean;
        topmostAtCenter: { isTarget: boolean };
        viewport: { devicePixelRatio: number };
      }
      expect(d.found).toBe(true)
      expect(d.visible).toBe(true)
      expect(d.inView).toBe(true)
      expect(d.bbox[2]).toBeGreaterThan(0)
      expect(d.topmostAtCenter.isTarget).toBe(true)

      // Overlay-occluded target: the cover absolutely-positioned div sits
      // ON TOP of #overlay-target's center, so topmostAtCenter.isTarget
      // should be false.
      const occluded = await ws!.call("browser_locate", { tabId, selector: "#overlay-target" })
      expect(occluded.ok).toBe(true)
      const o = occluded.data as { topmostAtCenter: { isTarget: boolean; tag: string } }
      expect(o.topmostAtCenter.isTarget).toBe(false)
    },
  )

  test.skipIf(shouldSkip)(
    "browser_mouse action=click via selector lands inside the bbox with isTrusted=true",
    async () => {
      const tabId = await openHumanlikeFixture()
      // Reset recorder
      await ws!.call("browser_eval_js", { tabId, expression: "window.__lastClick = null" })
      const clicked = await ws!.call("browser_mouse", {
        tabId,
        action: "click",
        selector: "#click-btn",
      })
      if (!clicked.ok) console.error("browser_mouse click error:", clicked.error)
      expect(clicked.ok).toBe(true)
      const ev = await ws!.call("browser_eval_js", {
        tabId,
        expression: "window.__lastClick",
      })
      expect(ev.ok).toBe(true)
      const last = (ev.data as { result: { x: number; y: number; isTrusted: boolean; target: string } | null }).result
      expect(last).not.toBeNull()
      expect(last!.target).toBe("click-btn")
      expect(last!.isTrusted).toBe(true)
      expect(last!.x).toBeGreaterThan(0)
      expect(last!.y).toBeGreaterThan(0)
    },
  )

  test.skipIf(shouldSkip)(
    "browser_mouse action=click is hit-test gated: target_obscured for overlay, force:true bypasses",
    async () => {
      const tabId = await openHumanlikeFixture()
      await ws!.call("browser_eval_js", { tabId, expression: "window.__overlayClicked = false" })
      const blocked = await ws!.call("browser_mouse", {
        tabId,
        action: "click",
        selector: "#overlay-target",
      })
      // Pre-click hit-test must refuse because the cover is on top.
      expect(blocked.ok).toBe(false)
      expect(blocked.error).toMatch(/target_obscured/)
      // force:true bypasses the hit-test. We still expect the underlying
      // element's click handler to NOT fire (the cover intercepts), but
      // the tool itself should succeed.
      const forced = await ws!.call("browser_mouse", {
        tabId,
        action: "click",
        selector: "#overlay-target",
        force: true,
      })
      expect(forced.ok).toBe(true)
    },
  )

  test.skipIf(shouldSkip)(
    "browser_mouse action=move with steps>1 produces interpolated mousemove events",
    async () => {
      const tabId = await openHumanlikeFixture()
      await ws!.call("browser_eval_js", { tabId, expression: "window.__mouseEvents = []" })
      const moved = await ws!.call("browser_mouse", {
        tabId,
        action: "move",
        x: 200,
        y: 200,
        steps: 20,
        stepDelayMs: 2,
      })
      expect(moved.ok).toBe(true)
      const ev = await ws!.call("browser_eval_js", {
        tabId,
        expression: "window.__mouseEvents.length",
      })
      expect(ev.ok).toBe(true)
      const count = (ev.data as { result: number }).result
      // We dispatched 20 mouseMoved events; the page should have seen them.
      expect(count).toBeGreaterThanOrEqual(15)
      // Check isTrusted on the events
      const trustedEv = await ws!.call("browser_eval_js", {
        tabId,
        expression: "window.__mouseEvents.every(e => e.isTrusted)",
      })
      expect((trustedEv.data as { result: boolean }).result).toBe(true)
    },
  )

  test.skipIf(shouldSkip)(
    "browser_mouse action=move reveals a CSS :hover tooltip (proves real input pipeline)",
    async () => {
      const tabId = await openHumanlikeFixture()
      await ws!.call("browser_mouse", {
        tabId,
        action: "move",
        selector: "#hover-target",
      })
      // Wait a tick for the :hover style to apply
      await ws!.call("browser_wait", {
        tabId,
        until: "networkIdle",
        timeoutMs: 600,
      })
      const ev = await ws!.call("browser_eval_js", {
        tabId,
        expression: "getComputedStyle(document.getElementById('hover-tooltip')).display",
      })
      expect(ev.ok).toBe(true)
      expect((ev.data as { result: string }).result).toBe("block")
    },
  )

  test.skipIf(shouldSkip)(
    "browser_mouse action=dblclick fires the dblclick event (two cycles, not one with clickCount:2)",
    async () => {
      const tabId = await openHumanlikeFixture()
      await ws!.call("browser_eval_js", { tabId, expression: "window.__lastDblClick = null" })
      const dbl = await ws!.call("browser_mouse", {
        tabId,
        action: "dblclick",
        selector: "#click-btn",
      })
      expect(dbl.ok).toBe(true)
      const ev = await ws!.call("browser_eval_js", {
        tabId,
        expression: "window.__lastDblClick && window.__lastDblClick.target",
      })
      expect((ev.data as { result: string | null }).result).toBe("click-btn")
    },
  )

  test.skipIf(shouldSkip)(
    "browser_drag mode=auto picks html5 for draggable=true and triggers drop with DataTransfer payload",
    async () => {
      const tabId = await openHumanlikeFixture()
      await ws!.call("browser_eval_js", {
        tabId,
        expression: "window.__dropEvents = []; window.__html5DragStarted = false",
      })
      const dragged = await ws!.call("browser_drag", {
        tabId,
        fromSelector: "#drag-source-html5",
        toSelector: "#drop-target-html5",
        steps: 10,
        stepDelayMs: 8,
      }, 20_000)
      if (!dragged.ok) console.error("browser_drag(html5) error:", dragged.error)
      expect(dragged.ok).toBe(true)
      expect((dragged.data as { mode_used: string }).mode_used).toBe("html5")
      // Verify the drop landed with the right payload
      const ev = await ws!.call("browser_eval_js", {
        tabId,
        expression: "window.__dropEvents",
      })
      const drops = (ev.data as { result: Array<{ kind: string; payload?: string }> }).result
      expect(drops.length).toBeGreaterThanOrEqual(1)
      expect(drops[0].kind).toBe("html5")
      expect(drops[0].payload).toBe("DRAGGED_PAYLOAD")
    },
  )

  test.skipIf(shouldSkip)(
    "browser_drag mode=pointer holds button across moves and triggers pointer-event drop",
    async () => {
      const tabId = await openHumanlikeFixture()
      await ws!.call("browser_eval_js", {
        tabId,
        expression: "window.__pointerDrag = { downAt: null, ups: 0, movesWithButton: 0, dropAt: null }; window.__dropEvents = []",
      })
      const dragged = await ws!.call("browser_drag", {
        tabId,
        fromSelector: "#drag-source-pointer",
        toSelector: "#drop-target-pointer",
        steps: 15,
        stepDelayMs: 6,
        mode: "pointer",
      }, 15_000)
      if (!dragged.ok) console.error("browser_drag(pointer) error:", dragged.error)
      expect(dragged.ok).toBe(true)
      expect((dragged.data as { mode_used: string }).mode_used).toBe("pointer")
      // The fixture counts pointermove events that arrived with buttons:1
      // (i.e. button held). The plan's Critical #5 — without buttons:1 the
      // page would see buttons:0 and pointer-event drag handlers would
      // abort. Assert we actually held the button across moves.
      const movesEv = await ws!.call("browser_eval_js", {
        tabId,
        expression: "window.__pointerDrag.movesWithButton",
      })
      expect((movesEv.data as { result: number }).result).toBeGreaterThanOrEqual(10)
      const dropEv = await ws!.call("browser_eval_js", {
        tabId,
        expression: "window.__pointerDrag.dropAt",
      })
      const drop = (dropEv.data as { result: { x: number; y: number } | null }).result
      expect(drop).not.toBeNull()
    },
  )

  test.skipIf(shouldSkip)(
    "browser_type fires per-keystroke keydown events with isTrusted=true (no doubling)",
    async () => {
      const tabId = await openHumanlikeFixture()
      await ws!.call("browser_eval_js", {
        tabId,
        expression: "window.__keyEvents = []; document.getElementById('text-input').value = ''; document.getElementById('text-input').focus()",
      })
      const typed = await ws!.call("browser_type", { tabId, text: "hello" })
      if (!typed.ok) console.error("browser_type error:", typed.error)
      expect(typed.ok).toBe(true)
      expect((typed.data as { chars: number }).chars).toBe(5)
      const keyEv = await ws!.call("browser_eval_js", {
        tabId,
        expression: "window.__keyEvents.length",
      })
      expect((keyEv.data as { result: number }).result).toBe(5)
      const trustedEv = await ws!.call("browser_eval_js", {
        tabId,
        expression: "window.__keyEvents.every(e => e.isTrusted)",
      })
      expect((trustedEv.data as { result: boolean }).result).toBe(true)
      const valEv = await ws!.call("browser_eval_js", {
        tabId,
        expression: "document.getElementById('text-input').value",
      })
      // The page should have received exactly "hello" — no doubled chars
      // from a stray `char` event between keyDown/keyUp.
      expect((valEv.data as { result: string }).result).toBe("hello")
    },
  )

  test.skipIf(shouldSkip)(
    "browser_type handles \\n as Enter (not a literal newline) and rejects other control chars",
    async () => {
      const tabId = await openHumanlikeFixture()
      await ws!.call("browser_eval_js", {
        tabId,
        expression: "window.__keyEvents = []; document.getElementById('text-input').value = ''; document.getElementById('text-input').focus()",
      })
      const typed = await ws!.call("browser_type", { tabId, text: "hi\n" })
      expect(typed.ok).toBe(true)
      // Page should see one Enter key event
      const enterEv = await ws!.call("browser_eval_js", {
        tabId,
        expression: "window.__keyEvents.find(e => e.key === 'Enter') ? true : false",
      })
      expect((enterEv.data as { result: boolean }).result).toBe(true)
      // Value should be "hi" (Enter on a plain text input doesn't insert
      // a newline character, it submits or is no-op)
      const valEv = await ws!.call("browser_eval_js", {
        tabId,
        expression: "document.getElementById('text-input').value",
      })
      expect((valEv.data as { result: string }).result).toBe("hi")

      // Now reject \x01
      const bad = await ws!.call("browser_type", { tabId, text: "\x01" })
      expect(bad.ok).toBe(false)
      expect(bad.error).toMatch(/invalid_text/)
    },
  )

  test.skipIf(shouldSkip)(
    "browser_type iterates Unicode code points correctly (no surrogate corruption)",
    async () => {
      const tabId = await openHumanlikeFixture()
      await ws!.call("browser_eval_js", {
        tabId,
        expression: "document.getElementById('text-input').value = ''; document.getElementById('text-input').focus()",
      })
      // "héllo" is 5 code points; the é (U+00E9) is BMP so no surrogate
      // pair. Also test an emoji which IS a surrogate pair.
      const typed = await ws!.call("browser_type", { tabId, text: "héllo" })
      expect(typed.ok).toBe(true)
      expect((typed.data as { chars: number }).chars).toBe(5)
      const valEv = await ws!.call("browser_eval_js", {
        tabId,
        expression: "document.getElementById('text-input').value",
      })
      expect((valEv.data as { result: string }).result).toBe("héllo")
    },
  )

  test.skipIf(shouldSkip)(
    "browser_type preserves punctuation — '.', ':', '-', ',', '@', '/', etc must NOT be dropped",
    async () => {
      // Regression for the bug surfaced during real-Chrome smoke test on
      // DuckDuckGo: typing 'site:github.com' yielded 'site:githubcom' because
      // '.'.charCodeAt(0) === 46 === VK_DELETE on Windows. The keyDown with
      // windowsVirtualKeyCode=46 was interpreted as a delete-key press and
      // Chromium suppressed the '.' text insertion. Same hazard for every
      // printable non-letter/digit char whose charCode collides with a VK
      // code. Fix: only derive vkc for /[a-zA-Z0-9]/, else 0 (let CDP infer).
      const tabId = await openHumanlikeFixture()
      await ws!.call("browser_eval_js", {
        tabId,
        expression: "document.getElementById('text-input').value = ''; document.getElementById('text-input').focus()",
      })
      // Realistic punctuation soup: a URL with all the trip-wire chars.
      const text = "user-name@host.example.com:8080/path?q=a&b=c"
      const typed = await ws!.call("browser_type", { tabId, text })
      expect(typed.ok).toBe(true)
      expect((typed.data as { chars: number }).chars).toBe(text.length)
      const valEv = await ws!.call("browser_eval_js", {
        tabId,
        expression: "document.getElementById('text-input').value",
      })
      // Exact match — no silently-dropped chars.
      expect((valEv.data as { result: string }).result).toBe(text)
    },
  )

  test.skipIf(shouldSkip)(
    "browser_scroll target=at-pointer wheel-scrolls a sub-region without scrolling the window",
    async () => {
      const tabId = await openHumanlikeFixture()
      await ws!.call("browser_eval_js", {
        tabId,
        expression: "document.getElementById('inner-scroller').scrollTop = 0; window.scrollTo(0, 0)",
      })
      const beforeOuter = await ws!.call("browser_eval_js", { tabId, expression: "window.scrollY" })
      const wheeled = await ws!.call("browser_scroll", {
        tabId,
        target: "at-pointer",
        selector: "#inner-scroller",
        deltaY: 300,
      })
      if (!wheeled.ok) console.error("browser_scroll(at-pointer) error:", wheeled.error)
      expect(wheeled.ok).toBe(true)
      // Give the wheel event time to be processed by the page
      await new Promise((r) => setTimeout(r, 200))
      const innerTop = await ws!.call("browser_eval_js", {
        tabId,
        expression: "document.getElementById('inner-scroller').scrollTop",
      })
      expect((innerTop.data as { result: number }).result).toBeGreaterThan(0)
      // Outer window must NOT have scrolled
      const afterOuter = await ws!.call("browser_eval_js", { tabId, expression: "window.scrollY" })
      expect((afterOuter.data as { result: number }).result).toBe(
        (beforeOuter.data as { result: number }).result,
      )
    },
  )

  test.skipIf(shouldSkip)(
    "browser_scroll(at-pointer) rejects deltaX=0 and deltaY=0",
    async () => {
      const tabId = await openHumanlikeFixture()
      const bad = await ws!.call("browser_scroll", {
        tabId,
        target: "at-pointer",
        selector: "#inner-scroller",
        deltaY: 0,
      })
      expect(bad.ok).toBe(false)
      expect(bad.error).toMatch(/non-zero/i)
    },
  )

  test.skipIf(shouldSkip)(
    "per-tab input mutex: two parallel browser_mouse calls on the same tab serialize cleanly",
    async () => {
      const tabId = await openHumanlikeFixture()
      // Fire two slow moves in parallel. Neither should error; both
      // should land. If the mutex were missing, CDP mouse state would
      // race and we'd see one fail or interleaved coords.
      const [a, b] = await Promise.all([
        ws!.call("browser_mouse", {
          tabId, action: "move", x: 100, y: 100, steps: 10, stepDelayMs: 10,
        }),
        ws!.call("browser_mouse", {
          tabId, action: "move", x: 300, y: 300, steps: 10, stepDelayMs: 10,
        }),
      ])
      expect(a.ok).toBe(true)
      expect(b.ok).toBe(true)
    },
  )

  // Regression tests for post-peer-review Critical / Important fixes.

  test.skipIf(shouldSkip)(
    "browser_mouse rejects conflicting target descriptors (ref + x,y both passed) — no silent precedence",
    async () => {
      const tabId = await openHumanlikeFixture()
      const bad = await ws!.call("browser_mouse", {
        tabId,
        action: "click",
        selector: "#click-btn",
        x: 0,
        y: 0,
      })
      expect(bad.ok).toBe(false)
      expect(bad.error).toMatch(/exactly one of/i)
    },
  )

  test.skipIf(shouldSkip)(
    "browser_mouse rejects paired-coord violation (x without y)",
    async () => {
      const tabId = await openHumanlikeFixture()
      const bad = await ws!.call("browser_mouse", {
        tabId,
        action: "click",
        x: 100,
      })
      expect(bad.ok).toBe(false)
      expect(bad.error).toMatch(/x and y must be provided together/i)
    },
  )

  test.skipIf(shouldSkip)(
    "browser_type normalizes CRLF to LF (does NOT reject \\r)",
    async () => {
      const tabId = await openHumanlikeFixture()
      await ws!.call("browser_eval_js", {
        tabId,
        expression: "window.__keyEvents = []; document.getElementById('text-input').value = ''; document.getElementById('text-input').focus()",
      })
      // \r\n must be accepted (post-fix) and dispatched as one Enter.
      const typed = await ws!.call("browser_type", { tabId, text: "hi\r\n" })
      expect(typed.ok).toBe(true)
      // Should be 3 chars (h, i, Enter from the normalized \n) — NOT 4.
      // The \r is consumed during normalization, not dispatched.
      expect((typed.data as { chars: number }).chars).toBe(3)
      // And the input.value is "hi" (Enter on a text input is no-op).
      const valEv = await ws!.call("browser_eval_js", {
        tabId,
        expression: "document.getElementById('text-input').value",
      })
      expect((valEv.data as { result: string }).result).toBe("hi")
    },
  )
})

// When skipping, surface the reason so CI logs are self-documenting.
if (shouldSkip) {
  console.log(`[browser-mcp E2E] skipped: ${reason}`)
}
