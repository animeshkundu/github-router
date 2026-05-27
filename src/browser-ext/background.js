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
      return { text, elements }
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
  const tabId = typeof args.tabId === "number" ? args.tabId : undefined
  const target = args.target
  const pixels = typeof args.pixels === "number" ? args.pixels : 0
  const ref = typeof args.ref === "string" ? args.ref : null
  if (!tabId) throw new Error("browser_scroll: tabId is required")
  if (!["top", "bottom", "pixels", "element"].includes(target)) {
    throw new Error(`browser_scroll: target must be top|bottom|pixels|element, got ${String(target)}`)
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
  await chrome.debugger.attach({ tabId }, "1.3")
  try {
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
  } finally {
    try { await chrome.debugger.detach({ tabId }) } catch { /* may already be detached */ }
  }
  return { ok: true }
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
  await chrome.debugger.attach({ tabId }, "1.3")
  try {
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
  } finally {
    try { await chrome.debugger.detach({ tabId }) } catch { /* may already be detached */ }
  }
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
  if (!attachedTabs.has(tabId)) {
    try { await chrome.debugger.attach({ tabId }, "1.3") } catch { /* may already be attached */ }
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
  }
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
