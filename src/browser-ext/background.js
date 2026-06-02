// background.js — MV3 service worker for the github-router browser
// bridge. Plain JavaScript: service workers don't need a bundler when
// there are no external imports. Chrome / Edge load this file directly
// from the unpacked extension dir.
//
// Lifecycle: Chrome starts the service worker on demand (when a
// chrome.runtime event fires) and may tear it down between events. All
// long-lived state must be persisted to chrome.storage; the native-
// messaging port itself is recovered lazily on first dispatcher request.
//
// Wire protocol (length-prefixed JSON over native messaging, framing
// handled by chrome.runtime.connectNative):
//
//   request:  { id, tool, args }
//   response: { id, ok: true,  data }
//          or { id, ok: false, error, code? }
//
// The bridge re-emits the same frames over its localhost WebSocket so
// the github-router dispatcher doesn't need to translate.

const NATIVE_HOST_NAME = "com.githubrouter.browser"

// ---------------------------------------------------------------------
// Navigation policy — list of URL patterns blocked from open / navigate.
// Mirrored in src/lib/browser-mcp/policy.ts (defense in depth).
// ---------------------------------------------------------------------

const BLOCKED_URL_RE =
  /^(chrome|edge|brave|opera|vivaldi):\/\/(settings|preferences|extensions|policy|management|password|flags|flag-descriptions)/i
const BLOCKED_VIEW_SOURCE_RE =
  /^view-source:(chrome|edge):\/\/(settings|extensions)/i

function isBlockedUrl(url) {
  if (typeof url !== "string") return false
  if (BLOCKED_URL_RE.test(url)) return true
  if (BLOCKED_VIEW_SOURCE_RE.test(url)) return true
  // Allow devtools://, chrome://newtab, about:blank, data:, https:, http:
  return false
}

// ---------------------------------------------------------------------
// Tool handlers — every browser_* tool the github-router /mcp surface
// exposes maps to one entry here. Phase 4a ships 6 (open_tab,
// close_tab, list_tabs, navigate, screenshot, read_page).
// ---------------------------------------------------------------------

async function toolListTabs() {
  const tabs = await chrome.tabs.query({})
  return {
    tabs: tabs.map((t) => ({
      id: t.id,
      url: t.url,
      title: t.title,
      active: t.active,
      windowId: t.windowId,
    })),
  }
}

async function toolOpenTab(args) {
  const url = args.url
  if (typeof url !== "string" || url.length === 0) {
    throw new Error("browser_open_tab: url is required")
  }
  if (isBlockedUrl(url)) {
    return {
      blocked: true,
      reason:
        "browser-internal pages (settings / preferences / extensions / flags) are not accessible to the browser MCP",
    }
  }
  const reuse = args.reuseActive === true
  let tabId
  let finalUrl
  if (reuse) {
    const [active] = await chrome.tabs.query({ active: true, currentWindow: true })
    if (!active || typeof active.id !== "number") {
      throw new Error("browser_open_tab: no active tab to reuse")
    }
    const updated = await chrome.tabs.update(active.id, { url })
    tabId = updated && updated.id
    finalUrl = (updated && updated.url) || url
  } else {
    const created = await chrome.tabs.create({ url })
    tabId = created.id
    finalUrl = created.url || url
  }
  if (typeof tabId !== "number") {
    throw new Error("browser_open_tab: failed to create or update tab")
  }
  // Wait for the page to finish loading (or hit a 15s ceiling).
  await waitForTabComplete(tabId, 15000)
  const t = await chrome.tabs.get(tabId)
  return {
    tabId,
    finalUrl: t.url || finalUrl,
    statusCode: t.status === "complete" ? 200 : 0,
  }
}

async function toolCloseTab(args) {
  const tabIds = Array.isArray(args.tabIds) ? args.tabIds : []
  if (tabIds.length === 0) {
    throw new Error("browser_close_tab: tabIds[] is required")
  }
  await chrome.tabs.remove(tabIds.filter((n) => typeof n === "number"))
  return { closed: tabIds.length }
}

async function toolNavigate(args) {
  const tabId = typeof args.tabId === "number" ? args.tabId : undefined
  const action = args.action
  const url = args.url
  if (!tabId) throw new Error("browser_navigate: tabId is required")
  if (action === "goto") {
    if (typeof url !== "string") throw new Error("browser_navigate: url required for goto")
    if (isBlockedUrl(url)) {
      return {
        blocked: true,
        reason:
          "browser-internal pages (settings / preferences / extensions / flags) are not accessible to the browser MCP",
      }
    }
    await chrome.tabs.update(tabId, { url })
  } else if (action === "back") {
    await chrome.tabs.goBack(tabId)
  } else if (action === "forward") {
    await chrome.tabs.goForward(tabId)
  } else if (action === "reload") {
    await chrome.tabs.reload(tabId, { bypassCache: !!args.hard })
  } else {
    throw new Error(`browser_navigate: unknown action ${String(action)}`)
  }
  await waitForTabComplete(tabId, 15000)
  const t = await chrome.tabs.get(tabId)
  return { finalUrl: t.url, statusCode: t.status === "complete" ? 200 : 0 }
}

async function toolScreenshot(args) {
  const tabId = typeof args.tabId === "number" ? args.tabId : undefined
  const format = args.format === "jpeg" ? "jpeg" : "png"
  // captureVisibleTab needs the tab's windowId, not the tab id.
  let windowId
  if (tabId) {
    const tab = await chrome.tabs.get(tabId)
    windowId = tab.windowId
    if (!tab.active) {
      // Must activate the tab to capture it (captureVisibleTab is
      // window-scoped, snapshots the active tab of the named window).
      await chrome.tabs.update(tabId, { active: true })
      // Tiny pause so the renderer has a chance to paint after activation.
      await sleep(150)
    }
  }
  const dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format })
  // dataUrl: "data:image/png;base64,...."
  const m = /^data:([^;]+);base64,(.*)$/.exec(dataUrl)
  if (!m) throw new Error("browser_screenshot: captureVisibleTab returned unexpected shape")
  return { contentType: m[1], dataBase64: m[2] }
}

async function toolReadPage(args) {
  const tabId = typeof args.tabId === "number" ? args.tabId : undefined
  if (!tabId) throw new Error("browser_read_page: tabId is required")
  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      // Element refs: every interactive element gets an id we return to
      // the caller; subsequent click/fill calls reference these refs
      // instead of brittle CSS selectors. Refs are stable for the
      // lifetime of a single read_page snapshot.
      const interactive = "a, button, input, select, textarea, [role='button'], [role='link'], [role='checkbox']"
      const els = Array.from(document.querySelectorAll(interactive))
      const elements = els.slice(0, 200).map((el, i) => {
        const ref = `e${i + 1}`
        el.setAttribute("data-gh-router-ref", ref)
        const rect = el.getBoundingClientRect()
        return {
          ref,
          role: el.getAttribute("role") || el.tagName.toLowerCase(),
          name:
            (el.getAttribute("aria-label") ||
              el.textContent ||
              el.getAttribute("value") ||
              el.getAttribute("placeholder") ||
              "")
              .trim()
              .slice(0, 200),
          bbox: [Math.round(rect.x), Math.round(rect.y), Math.round(rect.width), Math.round(rect.height)],
        }
      })
      // Page text: innerText is roughly what a user reads. Cap at
      // 256 KiB to keep the response tractable.
      const MAX = 256 * 1024
      let text = document.body ? document.body.innerText : ""
      if (text.length > MAX) text = text.slice(0, MAX)
      // Viewport metadata so the model can correlate CSS-px bbox to
      // device-px pixels in browser_screenshot (device_px = css_px * dpr).
      const viewport = {
        width: window.innerWidth,
        height: window.innerHeight,
        devicePixelRatio: window.devicePixelRatio,
        scrollX: window.scrollX,
        scrollY: window.scrollY,
      }
      return { text, elements, viewport }
    },
  })
  if (!result || typeof result.result !== "object") {
    throw new Error("browser_read_page: scripting.executeScript returned nothing")
  }
  return result.result
}

// ---------------------------------------------------------------------
// Phase 4b tools — input / interaction / diagnostics
// ---------------------------------------------------------------------

async function toolClick(args) {
  const tabId = typeof args.tabId === "number" ? args.tabId : undefined
  const ref = typeof args.ref === "string" ? args.ref : null
  const selector = typeof args.selector === "string" ? args.selector : null
  const button = args.button === "right" ? "right" : "left"
  const clickCount = typeof args.clickCount === "number" ? args.clickCount : 1
  if (!tabId) throw new Error("browser_click: tabId is required")
  if (!ref && !selector) throw new Error("browser_click: ref or selector is required")
  const before = await chrome.tabs.get(tabId)
  const urlBefore = before.url
  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    func: (ref, selector, button, clickCount) => {
      const sel = ref ? `[data-gh-router-ref="${ref}"]` : selector
      const el = document.querySelector(sel)
      if (!el) return { ok: false, error: `element not found: ${sel}` }
      // Use native .click() for left-button (handles default action,
      // form submission, etc); MouseEvent for right-click context menus.
      if (button === "right") {
        for (let i = 0; i < clickCount; i++) {
          el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2 }))
        }
      } else {
        for (let i = 0; i < clickCount; i++) el.click()
      }
      return { ok: true }
    },
    args: [ref, selector, button, clickCount],
  })
  if (!result || !result.result || !result.result.ok) {
    throw new Error(`browser_click: ${result?.result?.error ?? "execution failed"}`)
  }
  // Brief settle window so clicks that trigger navigation surface in
  // the response. 300ms is enough to catch immediate-redirect clicks
  // without significantly slowing the tool's tail latency.
  await sleep(300)
  const after = await chrome.tabs.get(tabId)
  return { ok: true, navigated: after.url !== urlBefore }
}

async function toolFill(args) {
  const tabId = typeof args.tabId === "number" ? args.tabId : undefined
  const ref = typeof args.ref === "string" ? args.ref : null
  const selector = typeof args.selector === "string" ? args.selector : null
  const value = args.value
  const clearFirst = args.clearFirst !== false
  const pressEnter = args.pressEnter === true
  if (!tabId) throw new Error("browser_fill: tabId is required")
  if (!ref && !selector) throw new Error("browser_fill: ref or selector is required")
  if (typeof value === "undefined") throw new Error("browser_fill: value is required")
  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    func: (ref, selector, value, clearFirst, pressEnter) => {
      const sel = ref ? `[data-gh-router-ref="${ref}"]` : selector
      const el = document.querySelector(sel)
      if (!el) return { ok: false, error: `element not found: ${sel}` }
      const tag = el.tagName.toLowerCase()
      const type = (el.getAttribute("type") || "").toLowerCase()
      try { el.focus() } catch { /* ignore */ }
      if (tag === "select") {
        el.value = String(value)
        el.dispatchEvent(new Event("change", { bubbles: true }))
      } else if (type === "checkbox" || type === "radio") {
        el.checked = !!value
        el.dispatchEvent(new Event("change", { bubbles: true }))
      } else {
        if (clearFirst) {
          // React-style controlled inputs override .value setter, so go
          // through the native setter so React's onChange fires.
          const proto = tag === "textarea" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
          const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set
          if (setter) setter.call(el, "")
          else el.value = ""
        }
        const proto = tag === "textarea" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
        const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set
        if (setter) setter.call(el, String(value))
        else el.value = String(value)
        el.dispatchEvent(new InputEvent("input", { bubbles: true, data: String(value) }))
        el.dispatchEvent(new Event("change", { bubbles: true }))
        if (pressEnter) {
          el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, bubbles: true }))
          el.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", code: "Enter", keyCode: 13, bubbles: true }))
          try { el.form?.requestSubmit?.() } catch { /* ignore */ }
        }
      }
      return { ok: true }
    },
    args: [ref, selector, value, clearFirst, pressEnter],
  })
  if (!result || !result.result || !result.result.ok) {
    throw new Error(`browser_fill: ${result?.result?.error ?? "execution failed"}`)
  }
  return { ok: true }
}

async function toolScroll(args) {
  const tabId = args.tabId
  const target = args.target
  assertTabId("browser_scroll", tabId)
  const pixels = Number.isFinite(args.pixels) ? args.pixels : 0
  const ref = typeof args.ref === "string" ? args.ref : null
  if (!["top", "bottom", "pixels", "element", "at-pointer"].includes(target)) {
    throw new Error(`browser_scroll: target must be top|bottom|pixels|element|at-pointer, got ${String(target)}`)
  }
  if (target === "at-pointer") {
    // Wheel scroll a sub-region at a pointer location. Necessary for
    // chat windows / infinite-scroll lists / modal bodies that have
    // their own scroll container and ignore window.scrollTo. The wheel
    // event bubbles through the scroll-container ancestor at the
    // pointer location, so positioning the cursor on the right region
    // is what makes it scroll instead of the outer window.
    const selector = typeof args.selector === "string" ? args.selector : null
    const x = Number.isFinite(args.x) ? args.x : undefined
    const y = Number.isFinite(args.y) ? args.y : undefined
    assertSingleTarget("browser_scroll(at-pointer)", ref, selector, x, y)
    const deltaX = clampNum(Number.isFinite(args.deltaX) ? args.deltaX : 0, -10_000, 10_000)
    const deltaY = clampNum(Number.isFinite(args.deltaY) ? args.deltaY : 0, -10_000, 10_000)
    if (deltaX === 0 && deltaY === 0) {
      throw new Error("browser_scroll(at-pointer): at least one of deltaX / deltaY must be non-zero")
    }
    const force = args.force === true
    const pos = await resolveMouseTarget(tabId, ref, selector, x, y)
    if (pos.hitTest && !pos.hitTest.isTarget && !force) {
      throw new Error(`target_obscured: topmost is ${pos.hitTest.topmost || pos.hitTest.note}`)
    }
    return await withTabInputLock(tabId, async () => {
      await attachDebuggerOnce(tabId)
      // Position the cursor first so the wheel event lands on the
      // right scroll-container ancestor.
      await chrome.debugger.sendCommand({ tabId }, "Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: pos.x, y: pos.y,
        button: "none", buttons: 0, modifiers: 0, pointerType: "mouse",
      })
      await chrome.debugger.sendCommand({ tabId }, "Input.dispatchMouseEvent", {
        type: "mouseWheel",
        x: pos.x, y: pos.y,
        deltaX, deltaY,
        button: "none", buttons: 0, modifiers: 0, pointerType: "mouse",
      })
      return { ok: true, scrolled: { x: pos.x, y: pos.y, deltaX, deltaY } }
    })
  }
  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    func: (target, pixels, ref) => {
      if (target === "top") window.scrollTo(0, 0)
      else if (target === "bottom") window.scrollTo(0, document.body.scrollHeight)
      else if (target === "pixels") window.scrollBy(0, pixels)
      else if (target === "element" && ref) {
        const el = document.querySelector(`[data-gh-router-ref="${ref}"]`)
        if (el) el.scrollIntoView({ behavior: "auto", block: "center" })
      }
      return { scrollY: window.scrollY, pageHeight: document.body.scrollHeight }
    },
    args: [target, pixels, ref],
  })
  return { ok: true, scrollY: result.result.scrollY, pageHeight: result.result.pageHeight }
}

async function toolKeyboard(args) {
  const tabId = typeof args.tabId === "number" ? args.tabId : undefined
  const keys = typeof args.keys === "string" ? args.keys : undefined
  if (!tabId) throw new Error("browser_keyboard: tabId is required")
  if (!keys) throw new Error("browser_keyboard: keys (string) is required")
  // Parse "Control+L" → modifiers ["control"] + key "L".
  const parts = keys.split("+")
  const key = parts.pop()
  const mods = parts.map((p) => p.toLowerCase())
  let bits = 0
  if (mods.includes("control") || mods.includes("ctrl")) bits |= 2
  if (mods.includes("alt")) bits |= 1
  if (mods.includes("shift")) bits |= 8
  if (mods.includes("meta") || mods.includes("cmd") || mods.includes("command")) bits |= 4
  // chrome.debugger.Input.dispatchKeyEvent is the only way to simulate
  // real keystrokes that browser shortcuts (Ctrl+L, etc) actually
  // observe. KeyboardEvent dispatched from JS doesn't trigger them.
  //
  // We attach via the shared attachDebuggerOnce helper (and do NOT
  // detach in finally). Detaching here would also tear down the
  // console / network buffers from browser_console_logs and
  // browser_network_log, since those rely on the SAME debugger
  // attachment. The attach stays for the tab's lifetime — chrome's
  // "is being controlled" banner is the visible cost, accepted in
  // exchange for cross-tool composability.
  return await withTabInputLock(tabId, async () => {
    await attachDebuggerOnce(tabId)
    const winVK = key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0
    await chrome.debugger.sendCommand({ tabId }, "Input.dispatchKeyEvent", {
      type: "keyDown",
      modifiers: bits,
      key,
      text: key.length === 1 ? key : undefined,
      windowsVirtualKeyCode: winVK,
    })
    await chrome.debugger.sendCommand({ tabId }, "Input.dispatchKeyEvent", {
      type: "keyUp",
      modifiers: bits,
      key,
      windowsVirtualKeyCode: winVK,
    })
    return { ok: true }
  })
}

// ---------------------------------------------------------------------
// Humanlike input v2: browser_mouse, browser_drag, browser_type, browser_locate
// ---------------------------------------------------------------------
// All four are CDP-driven (Input.dispatchMouseEvent / Input.dispatchKeyEvent),
// share the per-tab input mutex (withTabInputLock), and inherit the
// hardened attachDebuggerOnce. resolveMouseTarget centralises ref /
// selector / (x,y) → bbox-center resolution AND the elementFromPoint
// hit-test so all three coordinate-driven tools refuse to act on
// occluded targets by default (force:true bypass).

const BUTTON_BITS = { left: 1, right: 2, middle: 4 }

function clampNum(v, min, max) {
  const n = typeof v === "number" ? v : Number(v)
  if (!Number.isFinite(n)) return min
  return Math.max(min, Math.min(max, n))
}

// Per-tab input mutex. CDP mouse / keyboard state is global per
// attachment, so two parallel browser_mouse / browser_drag / browser_type
// calls on the same tab would interleave and corrupt each other (one
// call's mouseMoved would land mid-drag of another). The global
// MAX_INFLIGHT_TOOLS_CALL=8 cap doesn't help — it's global, not per-tab.
// This mutex is per-tab, layered on top.
const tabInputLockTails = new Map() // tabId → Promise (tail of the lock chain)

async function withTabInputLock(tabId, fn) {
  const previousTail = tabInputLockTails.get(tabId) || Promise.resolve()
  let release
  const myTurn = new Promise((r) => { release = r })
  const newTail = previousTail.then(() => myTurn)
  tabInputLockTails.set(tabId, newTail)
  await previousTail
  try {
    return await fn()
  } finally {
    release()
    // GC the Map entry only if no later caller chained on top of us.
    // If they did, the tail has been replaced; leave it alone.
    if (tabInputLockTails.get(tabId) === newTail) {
      tabInputLockTails.delete(tabId)
    }
  }
}

async function dispatchMouseEvent(tabId, type, x, y, button, buttons, clickCount) {
  await chrome.debugger.sendCommand({ tabId }, "Input.dispatchMouseEvent", {
    type, x, y, button, buttons, clickCount, modifiers: 0, pointerType: "mouse",
  })
}

// Resolve ref / selector / (x,y) → { x, y, draggable?, hitTest? }.
// hitTest carries elementFromPoint topmost-element identity so the
// caller can decide whether the target is actually clickable or is
// occluded by an overlay (default behavior: refuse with target_obscured
// unless force:true).
// Resolve ref / selector / (x,y) → { x, y, draggable?, hitTest? }.
// hitTest carries elementFromPoint topmost-element identity so the
// caller can decide whether the target is actually clickable or is
// occluded by an overlay (default behavior: refuse with target_obscured
// unless force:true). Exclusivity (exactly ONE of ref / selector /
// (x,y)) is checked by the caller — see assertSingleTarget.
async function resolveMouseTarget(tabId, ref, selector, x, y) {
  if (Number.isFinite(x) && Number.isFinite(y)) {
    // Coordinate mode: no target identity, no hit-test (we don't know
    // which element the caller expects to hit).
    return { x: Math.round(x), y: Math.round(y), draggable: false, hitTest: null }
  }
  if (!ref && !selector) {
    throw new Error("target required: provide ref, selector, or both x and y")
  }
  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    func: (ref, selector) => {
      const sel = ref
        ? `[data-gh-router-ref="${typeof CSS !== "undefined" && CSS.escape ? CSS.escape(ref) : ref.replace(/["\\]/g, "\\$&")}"]`
        : selector
      const el = document.querySelector(sel)
      if (!el) return { error: `element not found: ${sel}` }
      const rect = el.getBoundingClientRect()
      const cx = Math.round(rect.x + rect.width / 2)
      const cy = Math.round(rect.y + rect.height / 2)
      const inView = cx >= 0 && cy >= 0 && cx <= window.innerWidth && cy <= window.innerHeight
      const draggable = el.draggable === true
      if (!inView) {
        return {
          x: cx, y: cy, draggable,
          hitTest: { isTarget: false, note: "target center off-viewport" },
        }
      }
      const top = document.elementFromPoint(cx, cy)
      // isTarget: only accept when topmost IS the element, or topmost
      // is a DESCENDANT of the element (clicking the child bubbles to
      // the target). Do NOT accept top.contains(el) — that would be
      // true whenever the topmost falls through to a parent (e.g. when
      // el has pointer-events:none, or is fully covered by a sibling
      // and elementFromPoint walks up to the container). That's
      // exactly the "obscured" case we want to flag.
      const isTarget = !!top && (top === el || el.contains(top))
      let topmost = "(none)"
      if (top) {
        const id = top.id ? "#" + top.id : ""
        const cls = top.className && typeof top.className === "string" ? "." + top.className.split(/\s+/).filter(Boolean).slice(0, 2).join(".") : ""
        topmost = `${top.tagName.toLowerCase()}${id}${cls}`
      }
      return {
        x: cx, y: cy, draggable,
        hitTest: { isTarget, topmost },
      }
    },
    args: [ref || null, selector || null],
  })
  if (!result || !result.result) {
    throw new Error("target resolution failed: scripting.executeScript returned nothing")
  }
  if (result.result.error) throw new Error(result.result.error)
  return result.result
}

// Validate that exactly one target descriptor is provided. The model
// must not silently win one over another — if both ref and (x,y) are
// passed, throw rather than silently picking. `prefix` is the tool /
// arg-group name for the error message.
function assertSingleTarget(prefix, ref, selector, x, y) {
  const hasRef = !!ref
  const hasSel = !!selector
  const xSet = x !== undefined
  const ySet = y !== undefined
  if (xSet !== ySet) {
    throw new Error(`${prefix}: x and y must be provided together`)
  }
  const hasCoords = xSet && ySet
  const sources = (hasRef ? 1 : 0) + (hasSel ? 1 : 0) + (hasCoords ? 1 : 0)
  if (sources === 0) {
    throw new Error(`${prefix}: provide one of ref, selector, or (x, y)`)
  }
  if (sources > 1) {
    throw new Error(`${prefix}: pass exactly one of ref, selector, or (x, y) — not multiple`)
  }
}

function assertTabId(prefix, tabId) {
  if (!Number.isInteger(tabId) || tabId < 0) {
    throw new Error(`${prefix}: tabId must be a non-negative integer`)
  }
}

async function toolMouse(args) {
  const tabId = args.tabId
  const action = args.action
  assertTabId("browser_mouse", tabId)
  if (!["move", "click", "dblclick", "down", "up"].includes(action)) {
    throw new Error(`browser_mouse: action must be move|click|dblclick|down|up, got ${String(action)}`)
  }
  const buttonRaw = typeof args.button === "string" ? args.button : "left"
  if (!["left", "right", "middle"].includes(buttonRaw)) {
    throw new Error(`browser_mouse: button must be left|right|middle, got ${buttonRaw}`)
  }
  const button = buttonRaw
  const buttonBits = BUTTON_BITS[button]
  const steps = Math.round(clampNum(args.steps ?? 1, 1, 100))
  const stepDelayMs = Math.round(clampNum(args.stepDelayMs ?? 8, 0, 50))
  const force = args.force === true
  const ref = typeof args.ref === "string" ? args.ref : null
  const selector = typeof args.selector === "string" ? args.selector : null
  const x = Number.isFinite(args.x) ? args.x : undefined
  const y = Number.isFinite(args.y) ? args.y : undefined
  assertSingleTarget("browser_mouse", ref, selector, x, y)

  const target = await resolveMouseTarget(tabId, ref, selector, x, y)
  if (target.hitTest && !target.hitTest.isTarget && !force) {
    throw new Error(
      `target_obscured: topmost is ${target.hitTest.topmost || target.hitTest.note}. Pass force:true to bypass.`,
    )
  }

  return await withTabInputLock(tabId, async () => {
    await attachDebuggerOnce(tabId)
    // Interpolated approach: synthesise an origin point a bit away from
    // the target and walk N steps in. We don't track a real cursor
    // position across calls (MV3 SW dormancy would silently wipe it);
    // the synthetic approach still fires the expected mouseMoved
    // sequence for libraries that need a trajectory.
    const path = steps > 1 ? interpolateApproach(target.x, target.y, steps) : [{ x: target.x, y: target.y }]
    for (let i = 0; i < path.length; i++) {
      await dispatchMouseEvent(tabId, "mouseMoved", path[i].x, path[i].y, "none", 0, 1)
      if (i < path.length - 1 && stepDelayMs > 0) await sleep(stepDelayMs)
    }
    if (action === "move") {
      return { ok: true, position: { x: target.x, y: target.y } }
    }
    if (action === "down") {
      await dispatchMouseEvent(tabId, "mousePressed", target.x, target.y, button, buttonBits, 1)
      return { ok: true }
    }
    if (action === "up") {
      await dispatchMouseEvent(tabId, "mouseReleased", target.x, target.y, button, 0, 1)
      return { ok: true }
    }
    if (action === "click") {
      await dispatchMouseEvent(tabId, "mousePressed", target.x, target.y, button, buttonBits, 1)
      await dispatchMouseEvent(tabId, "mouseReleased", target.x, target.y, button, 0, 1)
      return { ok: true }
    }
    // dblclick: two press/release cycles with incrementing clickCount.
    // A single press/release with clickCount:2 is NOT a real double-click;
    // browsers expect two single clicks in quick succession with the
    // clickCount on the second one bumped to 2, which is what fires the
    // `dblclick` event.
    await dispatchMouseEvent(tabId, "mousePressed", target.x, target.y, button, buttonBits, 1)
    await dispatchMouseEvent(tabId, "mouseReleased", target.x, target.y, button, 0, 1)
    await dispatchMouseEvent(tabId, "mousePressed", target.x, target.y, button, buttonBits, 2)
    await dispatchMouseEvent(tabId, "mouseReleased", target.x, target.y, button, 0, 2)
    return { ok: true }
  })
}

function interpolateApproach(targetX, targetY, steps) {
  // Synthetic origin: ~50px to the left and ~20px above the target so
  // the first mouseMoved is a small approach rather than a teleport.
  // Clamp to 0 so we never dispatch a negative-coordinate event near
  // the viewport edge (some site code defensively bails on negative
  // clientX/Y; some CDP versions reject outright).
  const originX = Math.max(0, targetX - 50)
  const originY = Math.max(0, targetY - 20)
  const path = []
  for (let i = 1; i <= steps; i++) {
    const t = i / steps
    path.push({
      x: Math.round(originX + (targetX - originX) * t),
      y: Math.round(originY + (targetY - originY) * t),
    })
  }
  return path
}

async function toolDrag(args) {
  const tabId = args.tabId
  assertTabId("browser_drag", tabId)
  const buttonRaw = typeof args.button === "string" ? args.button : "left"
  if (!["left", "middle"].includes(buttonRaw)) {
    throw new Error(`browser_drag: button must be left|middle, got ${buttonRaw}`)
  }
  const button = buttonRaw
  const buttonBits = BUTTON_BITS[button]
  const steps = Math.round(clampNum(args.steps ?? 15, 1, 100))
  const stepDelayMs = Math.round(clampNum(args.stepDelayMs ?? 12, 0, 50))
  const force = args.force === true
  const modeRaw = typeof args.mode === "string" ? args.mode : "auto"
  if (!["auto", "pointer", "html5"].includes(modeRaw)) {
    throw new Error(`browser_drag: mode must be auto|pointer|html5, got ${modeRaw}`)
  }

  const fromRef = typeof args.fromRef === "string" ? args.fromRef : null
  const fromSelector = typeof args.fromSelector === "string" ? args.fromSelector : null
  const fromX = Number.isFinite(args.fromX) ? args.fromX : undefined
  const fromY = Number.isFinite(args.fromY) ? args.fromY : undefined
  assertSingleTarget("browser_drag.from", fromRef, fromSelector, fromX, fromY)
  const toRef = typeof args.toRef === "string" ? args.toRef : null
  const toSelector = typeof args.toSelector === "string" ? args.toSelector : null
  const toX = Number.isFinite(args.toX) ? args.toX : undefined
  const toY = Number.isFinite(args.toY) ? args.toY : undefined
  assertSingleTarget("browser_drag.to", toRef, toSelector, toX, toY)

  const from = await resolveMouseTarget(tabId, fromRef, fromSelector, fromX, fromY)
  const to = await resolveMouseTarget(tabId, toRef, toSelector, toX, toY)
  if (from.hitTest && !from.hitTest.isTarget && !force) {
    throw new Error(
      `target_obscured: drag source topmost is ${from.hitTest.topmost || from.hitTest.note}. Pass force:true to bypass.`,
    )
  }
  const mode = modeRaw === "auto" ? (from.draggable ? "html5" : "pointer") : modeRaw

  return await withTabInputLock(tabId, async () => {
    await attachDebuggerOnce(tabId)
    if (mode === "html5") {
      await dragHtml5(tabId, from, to, button, buttonBits, steps, stepDelayMs)
    } else {
      await dragPointer(tabId, from, to, button, buttonBits, steps, stepDelayMs)
    }
    return { ok: true, mode_used: mode, from: { x: from.x, y: from.y }, to: { x: to.x, y: to.y } }
  })
}

async function dragPointer(tabId, from, to, button, buttonBits, steps, stepDelayMs) {
  // Pointer-event-based DnD (react-dnd, Sortable.js, mouse-event-driven
  // drag handlers). Hold the button (buttons:buttonBits) throughout the
  // intermediate mouseMoved events — without that bit set, pointer-event
  // handlers see pointermove with buttons:0 and abort drag tracking.
  //
  // Safety: track pressed state. If ANY dispatch between mousePressed
  // and mouseReleased throws (CDP timeout / target crash / nav / invalid
  // coords), the finally block must still release the button — CDP mouse
  // state is global per attachment, so a stuck press would poison every
  // subsequent click on this tab. The per-tab mutex doesn't help; the
  // renderer-side state survives.
  await dispatchMouseEvent(tabId, "mouseMoved", from.x, from.y, "none", 0, 1)
  let pressed = false
  try {
    await dispatchMouseEvent(tabId, "mousePressed", from.x, from.y, button, buttonBits, 1)
    pressed = true
    for (let i = 1; i <= steps; i++) {
      const t = i / steps
      const x = Math.round(from.x + (to.x - from.x) * t)
      const y = Math.round(from.y + (to.y - from.y) * t)
      await chrome.debugger.sendCommand({ tabId }, "Input.dispatchMouseEvent", {
        type: "mouseMoved", x, y, button, buttons: buttonBits, modifiers: 0, pointerType: "mouse",
      })
      if (i < steps && stepDelayMs > 0) await sleep(stepDelayMs)
    }
    await dispatchMouseEvent(tabId, "mouseReleased", to.x, to.y, button, 0, 1)
    pressed = false
  } finally {
    if (pressed) {
      try {
        await dispatchMouseEvent(tabId, "mouseReleased", to.x, to.y, button, 0, 1)
      } catch {
        // Swallow — don't mask the original error. A second failure here
        // means the tab is in worse trouble than a stuck button.
      }
    }
  }
}

async function dragHtml5(tabId, from, to, button, buttonBits, steps, stepDelayMs) {
  // HTML5 native DnD (draggable="true" elements). Raw CDP mouse events
  // CAN'T trigger Chromium's native dragstart pipeline — the only path
  // is Input.setInterceptDrags(true) + Input.dispatchDragEvent. We
  // press + move a few times to trigger drag-detect, capture the
  // DragData via the dragIntercepted event, then dispatch dragEnter /
  // dragOver / drop to the destination.
  //
  // Safety: same stuck-button concern as dragPointer. Track `pressed`
  // and release in finally. Additionally, if the dragIntercepted event
  // never arrives within the deadline, throw instead of silently
  // returning ok:true — the model would otherwise reason from a
  // phantom-new-state. Caller (toolDrag) can fall back to pointer mode.
  let intercepted = null
  const listener = (source, method, params) => {
    if (source.tabId !== tabId) return
    if (method === "Input.dragIntercepted" && params && params.data) {
      intercepted = params.data
    }
  }
  chrome.debugger.onEvent.addListener(listener)
  let pressed = false
  try {
    await chrome.debugger.sendCommand({ tabId }, "Input.setInterceptDrags", { enabled: true })
    await dispatchMouseEvent(tabId, "mouseMoved", from.x, from.y, "none", 0, 1)
    await dispatchMouseEvent(tabId, "mousePressed", from.x, from.y, button, buttonBits, 1)
    pressed = true
    // A handful of intermediate moves to trigger drag-detect heuristics
    // (Chromium fires dragstart after ~5px of movement with the button held).
    const startMoves = Math.min(5, steps)
    for (let i = 1; i <= startMoves; i++) {
      const t = (i / startMoves) * 0.3 // partial progress toward dest
      const x = Math.round(from.x + (to.x - from.x) * t)
      const y = Math.round(from.y + (to.y - from.y) * t)
      await chrome.debugger.sendCommand({ tabId }, "Input.dispatchMouseEvent", {
        type: "mouseMoved", x, y, button, buttons: buttonBits, modifiers: 0, pointerType: "mouse",
      })
      if (stepDelayMs > 0) await sleep(stepDelayMs)
    }
    // Wait for the dragIntercepted event (up to 1s). Without this we
    // wouldn't have the DragData payload to send to dispatchDragEvent.
    const deadline = Date.now() + 1_000
    while (!intercepted && Date.now() < deadline) {
      await sleep(20)
    }
    if (!intercepted) {
      // Source isn't actually html5-draggable, or page called
      // event.preventDefault() on dragstart, or drag-detect heuristic
      // didn't fire. DO NOT silently report success — the model would
      // reason from a phantom state. Throw so toolDrag's caller knows
      // to retry with mode:"pointer".
      throw new Error("drag_failed: Input.dragIntercepted never arrived within 1s — source may not be html5-draggable or dragstart was prevented. Retry with mode:\"pointer\".")
    }
    await chrome.debugger.sendCommand({ tabId }, "Input.dispatchDragEvent", {
      type: "dragEnter", x: to.x, y: to.y, data: intercepted,
    })
    await chrome.debugger.sendCommand({ tabId }, "Input.dispatchDragEvent", {
      type: "dragOver", x: to.x, y: to.y, data: intercepted,
    })
    await chrome.debugger.sendCommand({ tabId }, "Input.dispatchDragEvent", {
      type: "drop", x: to.x, y: to.y, data: intercepted,
    })
    await dispatchMouseEvent(tabId, "mouseReleased", to.x, to.y, button, 0, 1)
    pressed = false
  } finally {
    chrome.debugger.onEvent.removeListener(listener)
    if (pressed) {
      try {
        await dispatchMouseEvent(tabId, "mouseReleased", to.x, to.y, button, 0, 1)
      } catch {
        // Swallow — don't mask the original error.
      }
    }
    try {
      await chrome.debugger.sendCommand({ tabId }, "Input.setInterceptDrags", { enabled: false })
    } catch {
      // Ignore — turning intercept off on a fresh attach is harmless.
    }
  }
}

async function toolType(args) {
  const tabId = args.tabId
  assertTabId("browser_type", tabId)
  const textRaw = typeof args.text === "string" ? args.text : undefined
  if (typeof textRaw !== "string") throw new Error("browser_type: text (string) is required")
  if (textRaw.length > 4096) {
    throw new Error("browser_type: text exceeds 4096-character limit")
  }
  // Normalize CRLF / lone CR to LF so Windows-origin clipboard text and
  // HTTP-response text don't throw the "invalid control char U+000D"
  // rejection downstream. Models pasting from any source should "just
  // work" — the user's intent for "\r\n" is unambiguously a newline.
  const text = textRaw.replace(/\r\n?/g, "\n")
  const delayMs = Math.round(clampNum(args.delayMs ?? 0, 0, 50))
  // Validate: reject control chars not in our whitelist. \n, \t, \b are
  // remapped to named keys (Enter / Tab / Backspace). \r is already
  // normalized to \n above. Other control chars (< 0x20) have no key
  // mapping and would produce junk events; reject up front so the model
  // can route them through browser_keyboard.
  for (const ch of text) {
    const code = ch.codePointAt(0)
    if (code === undefined) continue
    if (code < 0x20 && code !== 0x0A && code !== 0x09 && code !== 0x08) {
      const hex = code.toString(16).toUpperCase().padStart(4, "0")
      throw new Error(
        `invalid_text: control char U+${hex} not supported. browser_type whitelist: \\n=Enter, \\t=Tab, \\b=Backspace, \\r normalized to \\n. Use browser_keyboard for other control sequences.`,
      )
    }
  }
  return await withTabInputLock(tabId, async () => {
    await attachDebuggerOnce(tabId)
    let count = 0
    for (const ch of text) {
      const code = ch.codePointAt(0)
      let key, codeStr, vkc, sendText
      if (code === 0x0A) {
        key = "Enter"; codeStr = "Enter"; vkc = 13; sendText = undefined
      } else if (code === 0x09) {
        key = "Tab"; codeStr = "Tab"; vkc = 9; sendText = undefined
      } else if (code === 0x08) {
        key = "Backspace"; codeStr = "Backspace"; vkc = 8; sendText = undefined
      } else {
        key = ch
        codeStr = deriveKeyCode(ch)
        vkc = ch.length === 1 ? ch.toUpperCase().charCodeAt(0) : 0
        sendText = ch
      }
      // Correct CDP recipe: keyDown WITH text fires keydown + keypress +
      // input together. Do NOT also send a separate `char` event — that
      // would double-fire keypress/input on most sites.
      const downParams = {
        type: "keyDown",
        key,
        code: codeStr || undefined,
        modifiers: 0,
        windowsVirtualKeyCode: vkc,
      }
      if (sendText !== undefined) downParams.text = sendText
      await chrome.debugger.sendCommand({ tabId }, "Input.dispatchKeyEvent", downParams)
      await chrome.debugger.sendCommand({ tabId }, "Input.dispatchKeyEvent", {
        type: "keyUp",
        key,
        code: codeStr || undefined,
        modifiers: 0,
        windowsVirtualKeyCode: vkc,
      })
      count++
      if (delayMs > 0) await sleep(delayMs)
    }
    return { ok: true, chars: count }
  })
}

function deriveKeyCode(ch) {
  // Best-effort code field. Sufficient for sites that check event.code
  // for ASCII printable chars. Non-ASCII falls back to empty string.
  if (/^[a-zA-Z]$/.test(ch)) return "Key" + ch.toUpperCase()
  if (/^[0-9]$/.test(ch)) return "Digit" + ch
  if (ch === " ") return "Space"
  const map = {
    "-": "Minus", "=": "Equal", "[": "BracketLeft", "]": "BracketRight",
    "\\": "Backslash", ";": "Semicolon", "'": "Quote", ",": "Comma",
    ".": "Period", "/": "Slash", "`": "Backquote",
  }
  return map[ch] || ""
}

async function toolLocate(args) {
  const tabId = args.tabId
  const ref = typeof args.ref === "string" ? args.ref : null
  const selector = typeof args.selector === "string" ? args.selector : null
  assertTabId("browser_locate", tabId)
  if (!ref && !selector) throw new Error("browser_locate: ref or selector is required")
  if (ref && selector) throw new Error("browser_locate: pass exactly one of ref or selector, not both")
  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    func: (ref, selector) => {
      const viewport = {
        width: window.innerWidth,
        height: window.innerHeight,
        devicePixelRatio: window.devicePixelRatio,
        scrollX: window.scrollX,
        scrollY: window.scrollY,
      }
      const sel = ref
        ? `[data-gh-router-ref="${typeof CSS !== "undefined" && CSS.escape ? CSS.escape(ref) : ref.replace(/["\\]/g, "\\$&")}"]`
        : selector
      const el = document.querySelector(sel)
      if (!el) return { found: false, viewport }
      const rect = el.getBoundingClientRect()
      const cx = Math.round(rect.x + rect.width / 2)
      const cy = Math.round(rect.y + rect.height / 2)
      const style = getComputedStyle(el)
      const visible =
        rect.width > 0 && rect.height > 0
        && style.display !== "none"
        && style.visibility !== "hidden"
        && parseFloat(style.opacity || "1") > 0
      const inView = cx >= 0 && cy >= 0 && cx <= window.innerWidth && cy <= window.innerHeight
      let topmostAtCenter = null
      if (inView) {
        const top = document.elementFromPoint(cx, cy)
        // Same hit-test rule as resolveMouseTarget: target IS topmost
        // or contains it as a descendant. Ancestor-containment (top
        // contains el) is FALSE here because that's the obscured case.
        const isTarget = !!top && (top === el || el.contains(top))
        const topRef = top && top.getAttribute ? top.getAttribute("data-gh-router-ref") : null
        topmostAtCenter = {
          isTarget,
          tag: top ? top.tagName.toLowerCase() : null,
          refOrSelector: topRef || null,
        }
      }
      return {
        found: true,
        bbox: [Math.round(rect.x), Math.round(rect.y), Math.round(rect.width), Math.round(rect.height)],
        center: [cx, cy],
        inView,
        visible,
        pointerEvents: style.pointerEvents,
        topmostAtCenter,
        viewport,
      }
    },
    args: [ref || null, selector || null],
  })
  if (!result || typeof result.result !== "object") {
    throw new Error("browser_locate: scripting.executeScript returned nothing")
  }
  return result.result
}

async function toolWait(args) {
  const tabId = typeof args.tabId === "number" ? args.tabId : undefined
  const until = args.until
  const selector = typeof args.selector === "string" ? args.selector : undefined
  const urlPattern = typeof args.urlPattern === "string" ? args.urlPattern : undefined
  const timeoutMs = Math.min(typeof args.timeoutMs === "number" ? args.timeoutMs : 10000, 60000)
  if (!tabId) throw new Error("browser_wait: tabId is required")
  if (!["selector", "url", "networkIdle"].includes(until)) {
    throw new Error(`browser_wait: until must be selector|url|networkIdle, got ${String(until)}`)
  }
  const start = Date.now()
  const deadline = start + timeoutMs
  while (Date.now() < deadline) {
    if (until === "selector") {
      if (!selector) throw new Error("browser_wait: selector required when until=selector")
      const [r] = await chrome.scripting.executeScript({
        target: { tabId },
        func: (s) => !!document.querySelector(s),
        args: [selector],
      })
      if (r && r.result) return { ok: true, elapsedMs: Date.now() - start }
    } else if (until === "url") {
      if (!urlPattern) throw new Error("browser_wait: urlPattern required when until=url")
      const t = await chrome.tabs.get(tabId)
      try {
        if (new RegExp(urlPattern).test(t.url || "")) {
          return { ok: true, elapsedMs: Date.now() - start }
        }
      } catch (e) {
        throw new Error(`browser_wait: invalid urlPattern regex: ${e.message}`)
      }
    } else {
      // networkIdle — heuristic: status === "complete" + a 500ms quiet window.
      const t = await chrome.tabs.get(tabId)
      if (t.status === "complete") {
        await sleep(500)
        const t2 = await chrome.tabs.get(tabId)
        if (t2.status === "complete") return { ok: true, elapsedMs: Date.now() - start }
      }
    }
    await sleep(200)
  }
  return { ok: false, reason: "timeout", elapsedMs: Date.now() - start }
}

async function toolEvalJs(args) {
  const tabId = typeof args.tabId === "number" ? args.tabId : undefined
  const expression = typeof args.expression === "string" ? args.expression : undefined
  const timeoutMs = Math.min(typeof args.timeoutMs === "number" ? args.timeoutMs : 5000, 30000)
  if (!tabId) throw new Error("browser_eval_js: tabId is required")
  if (!expression) throw new Error("browser_eval_js: expression (string) is required")
  // chrome.debugger.Runtime.evaluate is equivalent to typing in the
  // DevTools console — runs in the page's main world, supports arbitrary
  // expression strings (MV3 CSP blocks eval/Function in the SW context).
  //
  // Shares the per-tab debugger attach with browser_console_logs and
  // browser_network_log — we attach but DO NOT detach in finally, because
  // detaching would clear those tools' lazy-attached event buffers.
  await attachDebuggerOnce(tabId)
  const r = await chrome.debugger.sendCommand({ tabId }, "Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
    timeout: timeoutMs,
    userGesture: true,
  })
  if (r.exceptionDetails) {
    return { error: r.exceptionDetails.text || r.exceptionDetails.exception?.description || "Runtime exception" }
  }
  // Strip {type, value} wrapper from returnByValue → just the value.
  return { result: r.result?.value }
}

async function toolDownload(args) {
  const url = typeof args.url === "string" ? args.url : undefined
  const saveAs = typeof args.saveAs === "string" ? args.saveAs : undefined
  const source = args.source || "url"
  if (source !== "url") {
    throw new Error("browser_download: only source='url' supported in v1; source='click' awaits Phase 5")
  }
  if (!url) throw new Error("browser_download: url is required when source='url'")
  const downloadId = await chrome.downloads.download({
    url,
    filename: saveAs,
    conflictAction: "uniquify",
  })
  // Wait for the download to reach a terminal state (complete or
  // interrupted). 60s ceiling matches the dispatcher's per-tool default.
  const finalState = await new Promise((resolve) => {
    const listener = (delta) => {
      if (delta.id !== downloadId) return
      if (delta.state?.current === "complete") {
        chrome.downloads.onChanged.removeListener(listener)
        resolve("complete")
      } else if (delta.state?.current === "interrupted") {
        chrome.downloads.onChanged.removeListener(listener)
        resolve("interrupted")
      }
    }
    chrome.downloads.onChanged.addListener(listener)
    setTimeout(() => {
      chrome.downloads.onChanged.removeListener(listener)
      resolve("timeout")
    }, 60_000)
  })
  if (finalState !== "complete") {
    throw new Error(`browser_download: download ${finalState}`)
  }
  const [info] = await chrome.downloads.search({ id: downloadId })
  return {
    downloadId,
    path: info?.filename,
    bytes: info?.fileSize,
    mimeType: info?.mime,
  }
}

// ---------------------------------------------------------------------
// Debugger-backed event capture (console + network)
// ---------------------------------------------------------------------
// Both browser_console_logs and browser_network_log need chrome.debugger
// attached BEFORE the events of interest fire. We attach lazily on the
// first call for a given tabId and keep an in-memory ring buffer per
// tab; subsequent calls drain the buffer. Buffers are capped to avoid
// runaway memory growth on long-lived tabs.

const consoleBuffers = new Map()   // tabId → Array<{level, text, ts, sourceUrl, line}>
const networkBuffers = new Map()   // tabId → Array<{url, method, status, requestHeaders, responseHeaders, ts}>
const attachedTabs = new Set()
const MAX_BUFFER_ENTRIES = 1000

async function attachDebuggerOnce(tabId, opts) {
  // navigator.locks serializes concurrent attach attempts after MV3 SW
  // respawn (when the in-memory attachedTabs Set is wiped but Chrome may
  // have kept the underlying CDP attachment alive past the SW death).
  // Without this lock, two parallel tool calls would both call
  // chrome.debugger.attach and the loser would throw
  // "Another debugger is already attached to this target".
  //
  // The "already attached" branch is subtle: "already attached" can mean
  // (a) WE attached and the SW just lost the cache, OR (b) DevTools /
  // another extension owns the session and we DON'T. Don't blindly trust
  // (a) — that would poison the cache and every subsequent sendCommand
  // would fail with cryptic CDP errors. Prove ownership with a no-op
  // Runtime.evaluate; only cache on success.
  await navigator.locks.request(`browser-mcp:debugger-attach:${tabId}`, async () => {
    if (!attachedTabs.has(tabId)) {
      let mustVerifyOwnership = false
      try {
        await chrome.debugger.attach({ tabId }, "1.3")
      } catch (err) {
        const msg = err && err.message ? err.message : String(err)
        const alreadyAttached = /already attached/i.test(msg) || /already debugging/i.test(msg)
        if (!alreadyAttached) throw err
        // "Already attached" — could be us (Chrome kept the attachment
        // past our SW death) or another debugger (DevTools open, etc.).
        // Don't cache yet; verify below.
        mustVerifyOwnership = true
      }
      if (mustVerifyOwnership) {
        try {
          await chrome.debugger.sendCommand({ tabId }, "Runtime.evaluate", {
            expression: "1", returnByValue: true,
          })
          // sendCommand succeeded → we own the attachment. Safe to cache.
        } catch {
          throw new Error(
            "browser-mcp: chrome.debugger reports attached but we do not own the session — likely DevTools is open on this tab (or another extension is debugging). Close DevTools and retry.",
          )
        }
      }
      attachedTabs.add(tabId)
    }
    if (opts?.console && !consoleBuffers.has(tabId)) {
      consoleBuffers.set(tabId, [])
      await chrome.debugger.sendCommand({ tabId }, "Runtime.enable")
    }
    if (opts?.network && !networkBuffers.has(tabId)) {
      networkBuffers.set(tabId, [])
      await chrome.debugger.sendCommand({ tabId }, "Network.enable")
    }
  })
}

chrome.debugger.onEvent.addListener((source, method, params) => {
  const tabId = source.tabId
  if (typeof tabId !== "number") return
  if (method === "Runtime.consoleAPICalled") {
    const buf = consoleBuffers.get(tabId)
    if (!buf) return
    const text = (params.args || [])
      .map((a) => (a.value !== undefined ? String(a.value) : (a.description || JSON.stringify(a))))
      .join(" ")
    buf.push({ level: params.type, text, ts: params.timestamp, stackTrace: undefined })
    if (buf.length > MAX_BUFFER_ENTRIES) buf.shift()
  } else if (method === "Network.responseReceived") {
    const buf = networkBuffers.get(tabId)
    if (!buf) return
    buf.push({
      url: params.response?.url,
      method: params.response?.requestHeaders?.[":method"] || "GET",
      status: params.response?.status,
      mimeType: params.response?.mimeType,
      ts: Date.now(),
    })
    if (buf.length > MAX_BUFFER_ENTRIES) buf.shift()
  }
})

chrome.debugger.onDetach.addListener((source) => {
  if (typeof source.tabId === "number") {
    attachedTabs.delete(source.tabId)
    consoleBuffers.delete(source.tabId)
    networkBuffers.delete(source.tabId)
    tabInputLockTails.delete(source.tabId)
  }
})

// Clean per-tab state on tab close. attachedTabs / consoleBuffers /
// networkBuffers are also cleaned by debugger.onDetach above (Chrome
// detaches on tab close), but doing it here too is cheap and protects
// against listener ordering surprises. tabInputLockTails is NOT
// cleaned by onDetach in some scenarios (the lock-chain Map can leak
// if a drag was in flight when the tab closed); cover it here.
chrome.tabs.onRemoved.addListener((tabId) => {
  attachedTabs.delete(tabId)
  consoleBuffers.delete(tabId)
  networkBuffers.delete(tabId)
  tabInputLockTails.delete(tabId)
})

async function toolConsoleLogs(args) {
  const tabId = typeof args.tabId === "number" ? args.tabId : undefined
  const level = typeof args.level === "string" ? args.level : "all"
  if (!tabId) throw new Error("browser_console_logs: tabId is required")
  await attachDebuggerOnce(tabId, { console: true })
  // Give the debugger a moment to start capturing if just attached.
  const buf = consoleBuffers.get(tabId) || []
  const drained = buf.slice()
  consoleBuffers.set(tabId, [])
  const filtered = level === "all" ? drained : drained.filter((e) => e.level === level)
  return { entries: filtered }
}

async function toolNetworkLog(args) {
  const tabId = typeof args.tabId === "number" ? args.tabId : undefined
  if (!tabId) throw new Error("browser_network_log: tabId is required")
  await attachDebuggerOnce(tabId, { network: true })
  const buf = networkBuffers.get(tabId) || []
  const drained = buf.slice()
  networkBuffers.set(tabId, [])
  return { entries: drained }
}

const TOOL_HANDLERS = {
  __ping__: () => ({
    pong: true,
    extension_version: chrome.runtime.getManifest().version,
  }),
  browser_list_tabs: toolListTabs,
  browser_open_tab: toolOpenTab,
  browser_close_tab: toolCloseTab,
  browser_navigate: toolNavigate,
  browser_screenshot: toolScreenshot,
  browser_read_page: toolReadPage,
  browser_click: toolClick,
  browser_fill: toolFill,
  browser_scroll: toolScroll,
  browser_keyboard: toolKeyboard,
  browser_wait: toolWait,
  browser_eval_js: toolEvalJs,
  browser_download: toolDownload,
  browser_console_logs: toolConsoleLogs,
  browser_network_log: toolNetworkLog,
  browser_mouse: toolMouse,
  browser_drag: toolDrag,
  browser_type: toolType,
  browser_locate: toolLocate,
}

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

function waitForTabComplete(tabId, timeoutMs) {
  return new Promise((resolve) => {
    let done = false
    const finish = () => {
      if (done) return
      done = true
      chrome.tabs.onUpdated.removeListener(listener)
      resolve()
    }
    const listener = (id, info) => {
      if (id === tabId && info.status === "complete") finish()
    }
    chrome.tabs.onUpdated.addListener(listener)
    // Also check current state synchronously — the page may already be
    // complete by the time we register the listener.
    chrome.tabs.get(tabId).then((t) => {
      if (t && t.status === "complete") finish()
    }).catch(() => {})
    setTimeout(finish, timeoutMs)
  })
}

// ---------------------------------------------------------------------
// Native messaging glue
// ---------------------------------------------------------------------

let nativePort

function connectBridge() {
  if (nativePort) return nativePort
  const port = chrome.runtime.connectNative(NATIVE_HOST_NAME)
  port.onMessage.addListener((msg) => {
    handleBridgeRequest(msg, port).catch((err) => {
      console.error("[browser-bridge] dispatch crashed:", err)
    })
  })
  port.onDisconnect.addListener(() => {
    const reason = chrome.runtime.lastError ? chrome.runtime.lastError.message : "(no message)"
    console.warn("[browser-bridge] native port disconnected:", reason)
    nativePort = undefined
  })
  nativePort = port
  return port
}

async function handleBridgeRequest(req, port) {
  if (!req || typeof req.id !== "string" || typeof req.tool !== "string") return
  const handler = TOOL_HANDLERS[req.tool]
  if (!handler) {
    port.postMessage({ id: req.id, ok: false, error: `unknown tool: ${req.tool}`, code: "unknown_tool" })
    return
  }
  try {
    const data = await handler(req.args || {})
    port.postMessage({ id: req.id, ok: true, data })
  } catch (err) {
    port.postMessage({ id: req.id, ok: false, error: err && err.message ? err.message : String(err) })
  }
}

chrome.runtime.onInstalled.addListener(() => {
  try { connectBridge() } catch (err) { console.warn("[browser-bridge] onInstalled connect failed:", err) }
})
chrome.runtime.onStartup.addListener(() => {
  try { connectBridge() } catch (err) { console.warn("[browser-bridge] onStartup connect failed:", err) }
})

// Top-level eager connect. SW only runs background.js when an event
// fires (install / startup / message / alarm / tab change), but once
// it does, this top-level call attempts the native-messaging
// connection immediately. Idempotent — connectBridge() short-circuits
// if a port is already open. Wrapped in try/catch so a failure here
// can't break event-listener registration above.
try {
  connectBridge()
} catch (err) {
  console.warn("[browser-bridge] eager connect failed:", err)
}

// Tab-update listener: guarantees the SW wakes up whenever any tab
// navigates, which is the most reliable wake-up signal in MV3.
// Without this, the SW may stay dormant until the user explicitly
// interacts with the extension UI.
chrome.tabs.onUpdated.addListener(() => {
  try { connectBridge() } catch (err) { console.warn("[browser-bridge] onUpdated connect failed:", err) }
})

// Defense in depth — webNavigation listener catches in-page-initiated
// navigations (JS-driven redirects, meta-refresh, anchor clicks the
// model didn't go through browser_navigate for). Tool-initiated paths
// already pre-check via isBlockedUrl() / the bridge-layer policy.ts,
// so this is the safety net for navigations the bridge can't see.
//
// On match: cancel the navigation by routing the tab back to
// about:blank, AND log a console.error so browser_console_logs can
// surface "the model tried to navigate to a blocked URL" on the next
// drain. The cancel happens via chrome.tabs.update — there's no
// onBeforeNavigate "cancel" API in MV3.
chrome.webNavigation.onBeforeNavigate.addListener((details) => {
  if (details.frameId !== 0) return  // only top-level frame
  if (isBlockedUrl(details.url)) {
    try {
      chrome.tabs.update(details.tabId, { url: "about:blank" })
    } catch (err) {
      console.warn("[browser-bridge] could not cancel blocked nav:", err)
    }
    console.error(`[browser-bridge] policy_blocked: ${details.url}`)
  }
})
