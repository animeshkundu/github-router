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

// Snapshot cache + invalidation lives in a sibling module so the
// matcher-cascade work in Phase 2 can consume it without dragging in
// the entire 1700-line background.js dispatcher.
import {
  captureSnapshot,
  invalidateSnapshot,
} from "./snapshot.js"

// ---------------------------------------------------------------------
// Navigation policy — URL patterns this extension blocks at
// webNavigation.onBeforeNavigate. This list is INTENTIONALLY NARROWER
// than the bridge-side regex in src/lib/browser-mcp/policy.ts: the
// bridge regex only fires for tool-initiated nav (browser_open_tab /
// browser_navigate) so it can safely block `extensions` without
// affecting the human user, while THIS regex fires for user-typed URL
// bar nav too and must preserve human access to chrome://extensions /
// edge://extensions (needed to reload this extension after package
// updates).
// ---------------------------------------------------------------------

// `extensions` is intentionally omitted from the extension-side regex —
// chrome.webNavigation.onBeforeNavigate fires for ALL top-level
// navigations including the user typing in the URL bar, so including it
// here would lock the user out of managing the very extension that
// loads this code (and prevent the reload arrow that auto-update falls
// back to). Bridge-side policy.ts keeps `extensions` in its regex,
// which is sufficient because the bridge regex only gates tool-
// initiated nav (browser_open_tab / browser_navigate).
const BLOCKED_URL_RE =
  /^(chrome|edge|brave|opera|vivaldi):\/\/(settings|preferences|policy|management|password|flags|flag-descriptions)/i
const BLOCKED_VIEW_SOURCE_RE = /^view-source:(chrome|edge):\/\/settings/i

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
  // Both this API and CDP Page.captureScreenshot require the browser
  // to have a real OS-level rendering surface. On Chrome-for-Testing
  // launched in plain headed mode without --headless=new, no such
  // surface exists and either path hangs indefinitely — the Playwright
  // E2E harness passes --headless=new in its args list for exactly this
  // reason. Real Chrome with a visible window has a surface and works
  // fine. If you're driving Chrome-for-Testing programmatically and
  // need screenshots, launch with `--headless=new`.
  const dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format })
  // dataUrl: "data:image/png;base64,...."
  const m = /^data:([^;]+);base64,(.*)$/.exec(dataUrl)
  if (!m) throw new Error("browser_screenshot: captureVisibleTab returned unexpected shape")
  return { contentType: m[1], dataBase64: m[2] }
}

async function toolReadPage(args) {
  const tabId = typeof args.tabId === "number" ? args.tabId : undefined
  if (!tabId) throw new Error("browser_read_page: tabId is required")
  const mode = args.mode === "full" ? "full" : "summary"
  const refresh = args.refresh === true
  // Cache wrapper. captureSnapshot reads through the per-tab cache when
  // refresh=false. Mode is part of the cache key because summary +
  // full produce different element sets — caching one and returning
  // it for the other would be a correctness bug.
  return captureSnapshot(tabId, { mode, refresh }, extractSnapshotLegacy)
}

/**
 * Legacy `document.querySelectorAll`-based extractor. Stays as the
 * default extractor until Phase 1b-CDP lands; will become the fallback
 * path when CDP attach fails (enterprise policy, DevTools open on the
 * tab, etc.). The implementation runs in the page world via
 * chrome.scripting.executeScript and returns a PageSnapshot-shaped
 * object that snapshot.captureSnapshot caches and returns to the
 * caller.
 */
async function extractSnapshotLegacy(tabId, opts) {
  const mode = opts?.mode === "full" ? "full" : "summary"
  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    func: (mode) => {
      // Stable ref attribution: every interactive element gets a
      // data-gh-router-ref attribute the model uses for subsequent
      // ref-based actions. Stable for the lifetime of one read_page.
      //
      // Traversal: descend into open shadow roots so web-component-heavy
      // UIs (e.g. modern React apps with shadow encapsulation) surface
      // their interactive elements. Cross-origin iframes are not reached
      // from in-page script — that needs CDP and is documented as a
      // future enhancement.
      const INTERACTIVE_ROLES = new Set([
        "button",
        "link",
        "textbox",
        "combobox",
        "checkbox",
        "radio",
        "switch",
        "tab",
        "menuitem",
        "option",
        "slider",
        "searchbox",
        "spinbutton",
        "treeitem",
      ])
      const INTERACTIVE_TAGS = new Set([
        "a",
        "button",
        "input",
        "select",
        "textarea",
      ])
      function isInteractive(el) {
        const role = el.getAttribute("role")
        if (role && INTERACTIVE_ROLES.has(role)) return true
        if (INTERACTIVE_TAGS.has(el.tagName.toLowerCase())) return true
        if (el.hasAttribute("contenteditable") && el.getAttribute("contenteditable") !== "false") return true
        const ti = el.getAttribute("tabindex")
        if (ti !== null && Number.parseInt(ti, 10) >= 0) return true
        return false
      }
      function nameOf(el) {
        const labelledBy = el.getAttribute("aria-labelledby")
        if (labelledBy) {
          const labelEl = document.getElementById(labelledBy)
          if (labelEl) return (labelEl.textContent || "").trim().slice(0, 200)
        }
        return (
          el.getAttribute("aria-label")
          || el.getAttribute("title")
          || (el.textContent || "")
          || el.getAttribute("value")
          || el.getAttribute("placeholder")
          || el.getAttribute("alt")
          || ""
        ).trim().slice(0, 200)
      }
      function walkDeep(root, sink) {
        // Walk every element under root, descending into open shadow
        // roots. Closed shadow roots are intentionally opaque per the
        // web spec; nothing we can do.
        // NodeFilter.SHOW_ELEMENT === 1.
        const walker = root.createTreeWalker
          ? root.createTreeWalker(root, 1)
          : document.createTreeWalker(root, 1)
        let n
        while ((n = walker.nextNode())) {
          sink.push(n)
          if (n.shadowRoot && n.shadowRoot.mode === "open") {
            walkDeep(n.shadowRoot, sink)
          }
        }
      }
      const viewport = {
        width: window.innerWidth,
        height: window.innerHeight,
        devicePixelRatio: window.devicePixelRatio,
        scrollX: window.scrollX,
        scrollY: window.scrollY,
      }
      function inViewport(rect) {
        return (
          rect.bottom > 0
          && rect.right > 0
          && rect.top < viewport.height
          && rect.left < viewport.width
          && rect.width > 0
          && rect.height > 0
        )
      }
      const allElements = []
      walkDeep(document, allElements)
      const interactive = allElements.filter(isInteractive)
      // Stable refs across snapshots: if an element already carries a
      // data-gh-router-ref from a prior snapshot, keep it. New elements
      // get the next unused counter. Result: ref `e42` refers to the
      // SAME element across reads, so model can do `read_page → click(ref)
      // → read_page` and the ref-to-element binding stays valid.
      const usedRefs = new Set()
      for (const el of interactive) {
        const existing = el.getAttribute("data-gh-router-ref")
        if (existing && /^e\d+$/.test(existing)) usedRefs.add(existing)
      }
      let nextRef = 1
      function nextFreshRef() {
        while (usedRefs.has(`e${nextRef}`)) nextRef++
        const r = `e${nextRef}`
        usedRefs.add(r)
        nextRef++
        return r
      }
      // Summary mode: viewport-visible only; drop nameless non-tag
      // elements (a div with role="button" but no aria-label is noise).
      // Full mode: keep everything, model asked for it.
      const ELEMENT_CAP = 200
      const LANDMARK_ROLES = new Set([
        "dialog", "alertdialog", "region", "navigation", "main",
        "form", "search", "complementary", "banner", "contentinfo",
      ])
      const LANDMARK_TAGS = new Set([
        "dialog", "form", "nav", "main", "header", "footer", "aside", "section",
      ])
      // Pre-mint refs for landmark ancestors so child elements can
      // cite parent refs without a second walk.
      function landmarkRefsFor(el) {
        const refs = []
        let cur = el.parentElement
        let depth = 0
        while (cur && depth < 12 && refs.length < 4) {
          const role = cur.getAttribute && cur.getAttribute("role")
          const ctag = cur.tagName && cur.tagName.toLowerCase()
          const isLandmark = (role && LANDMARK_ROLES.has(role)) || LANDMARK_TAGS.has(ctag)
          if (isLandmark) {
            let r = cur.getAttribute("data-gh-router-ref")
            if (!r || !/^e\d+$/.test(r)) {
              r = nextFreshRef()
              cur.setAttribute("data-gh-router-ref", r)
            }
            refs.push(r)
          }
          cur = cur.parentElement
          depth++
        }
        return refs
      }
      function stateFlagsFor(el, tag) {
        const flags = {}
        // disabled: prefer the property (more reliable than the attr
        // for inputs / buttons; aria-disabled covers role=button divs).
        if (el.disabled === true || el.getAttribute("aria-disabled") === "true") flags.disabled = true
        if (el.checked === true) flags.checked = true
        else if (el.indeterminate === true) flags.checked = "mixed"
        else if (el.getAttribute("aria-checked") === "true") flags.checked = true
        else if (el.getAttribute("aria-checked") === "mixed") flags.checked = "mixed"
        const aria = (name) => el.getAttribute(name)
        if (aria("aria-expanded") === "true") flags.expanded = true
        else if (aria("aria-expanded") === "false") flags.expanded = false
        if (el.selected === true || aria("aria-selected") === "true") flags.selected = true
        if (aria("aria-pressed") === "true") flags.pressed = true
        else if (aria("aria-pressed") === "false") flags.pressed = false
        if (el.required === true || aria("aria-required") === "true") flags.required = true
        if (el.readOnly === true || aria("aria-readonly") === "true") flags.readonly = true
        if (aria("aria-invalid") === "true") flags.invalid = true
        if (document.activeElement === el) flags.focused = true
        // hidden: aria-hidden takes precedence; offsetParent === null
        // covers display:none parents (NOT a reliable visibility check
        // for fixed-position elements but a reasonable cheap signal).
        if (aria("aria-hidden") === "true") flags.hidden = true
        else if (tag !== "body" && el.offsetParent === null && getComputedStyle(el).position !== "fixed") {
          flags.hidden = true
        }
        return flags
      }
      function inputExtrasFor(el, tag) {
        const out = {}
        if (tag === "input" || tag === "textarea" || tag === "select") {
          const t = (el.type || "").toLowerCase()
          if (t) out.inputType = t
        }
        const ph = el.placeholder || el.getAttribute("placeholder")
        if (ph) out.placeholder = String(ph).slice(0, 200)
        const ac = el.getAttribute("autocomplete")
        if (ac) out.autocomplete = ac
        // For inputs / textareas / select, value is the current user
        // input. Bounded so a huge textarea doesn't bloat the snapshot.
        if (typeof el.value === "string" && el.value.length > 0) {
          out.value = el.value.slice(0, 200)
        }
        return out
      }
      function attrExtrasFor(el) {
        // Surface raw attrs the matcher's L5 testid layer + L7 semantic
        // heuristic want to see. Limited to a handful — we don't want
        // to dump every attribute on every element.
        const out = {}
        const id = el.id
        if (id) out.id = id
        const testid = el.getAttribute("data-testid") || el.getAttribute("data-test-id")
          || el.getAttribute("data-test") || el.getAttribute("data-qa")
        if (testid) out.testid = testid
        const nameAttr = el.getAttribute("name")
        if (nameAttr) out.name_attr = nameAttr
        const aria = el.getAttribute("aria-label")
        if (aria) out.aria_label = aria
        return out
      }
      const elements = []
      for (const el of interactive) {
        if (elements.length >= ELEMENT_CAP) break
        const rect = el.getBoundingClientRect()
        if (mode === "summary" && !inViewport(rect)) continue
        const name = nameOf(el)
        const tag = el.tagName.toLowerCase()
        if (mode === "summary" && !name && !INTERACTIVE_TAGS.has(tag)) continue
        let ref = el.getAttribute("data-gh-router-ref")
        if (!ref || !/^e\d+$/.test(ref)) {
          ref = nextFreshRef()
          el.setAttribute("data-gh-router-ref", ref)
        }
        const entry = {
          ref,
          role: el.getAttribute("role") || tag,
          tag,
          bbox: [
            Math.round(rect.x),
            Math.round(rect.y),
            Math.round(rect.width),
            Math.round(rect.height),
          ],
        }
        if (name) entry.name = name
        // Inline state flags onto the entry. Each is omitted when
        // false / default per the snapshot-types contract.
        const flags = stateFlagsFor(el, tag)
        for (const k of Object.keys(flags)) entry[k] = flags[k]
        // Input-shaped extras (placeholder / inputType / value /
        // autocomplete) — only present for input-shaped elements.
        const inExtras = inputExtrasFor(el, tag)
        if (inExtras.inputType) entry.inputType = inExtras.inputType
        if (inExtras.placeholder) entry.placeholder = inExtras.placeholder
        if (inExtras.autocomplete) entry.autocomplete = inExtras.autocomplete
        if (inExtras.value) entry.value = inExtras.value
        // Raw attribute extras for L5 testid + L7 semantic layers.
        // Stored on a single `attrs` object to keep the top-level
        // shape stable.
        const attrExtras = attrExtrasFor(el)
        if (Object.keys(attrExtras).length > 0) entry.attrs = attrExtras
        // Landmark ancestry — up to 4 deep, dialog / form / nav / etc.
        const landmarks = landmarkRefsFor(el)
        if (landmarks.length > 0) entry.landmarks = landmarks
        elements.push(entry)
      }
      // Text extraction.
      // summary: walk text nodes whose parent is in the viewport; cap
      // at 20 KB. The model sees what a user could read without
      // scrolling. Off-screen content remains reachable via mode:"full".
      // full: 256 KiB innerText cap (legacy behavior).
      let text = ""
      if (mode === "full") {
        const MAX_FULL = 256 * 1024
        text = document.body ? document.body.innerText : ""
        if (text.length > MAX_FULL) text = text.slice(0, MAX_FULL)
      } else {
        const TEXT_CAP = 20 * 1024
        const parts = []
        let total = 0
        const root = document.body || document.documentElement
        if (root) {
          const tw = document.createTreeWalker(root, 4) // NodeFilter.SHOW_TEXT === 4
          let n
          while ((n = tw.nextNode())) {
            const parent = n.parentElement
            if (!parent) continue
            // Skip script/style content.
            const ptag = parent.tagName ? parent.tagName.toLowerCase() : ""
            if (ptag === "script" || ptag === "style" || ptag === "noscript") continue
            const pr = parent.getBoundingClientRect()
            if (!inViewport(pr)) continue
            const t = (n.textContent || "").replace(/\s+/g, " ").trim()
            if (!t) continue
            if (total + t.length + 1 > TEXT_CAP) {
              parts.push(t.slice(0, Math.max(0, TEXT_CAP - total)))
              break
            }
            parts.push(t)
            total += t.length + 1
          }
        }
        text = parts.join("\n")
      }
      // visualSurfaces: canvas + svg of non-trivial size in the
      // viewport. Signals "this region needs vision" to the lead model
      // so it knows to call browser_screenshot / let browser_act
      // auto-escalate when the text-based pickElement misses.
      const visualSurfaces = []
      const VS_MIN = 100
      const canvasNodes = allElements.filter((el) => {
        const t = el.tagName && el.tagName.toLowerCase()
        return t === "canvas" || t === "svg"
      })
      for (const el of canvasNodes) {
        const rect = el.getBoundingClientRect()
        if (rect.width < VS_MIN || rect.height < VS_MIN) continue
        if (!inViewport(rect)) continue
        let ref = el.getAttribute("data-gh-router-ref")
        if (!ref) {
          ref = `v${visualSurfaces.length + 1}`
          el.setAttribute("data-gh-router-ref", ref)
        }
        visualSurfaces.push({
          ref,
          kind: el.tagName.toLowerCase(),
          bbox: [
            Math.round(rect.x),
            Math.round(rect.y),
            Math.round(rect.width),
            Math.round(rect.height),
          ],
        })
      }
      const out = {
        mode,
        url: window.location.href,
        title: document.title,
        text,
        elements,
        viewport,
      }
      if (visualSurfaces.length > 0) out.visualSurfaces = visualSurfaces
      return out
    },
    args: [mode],
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
  // Subscribe to nav events BEFORE dispatching the click so a fast
  // click → nav transition can't race past us. Cleanup runs in
  // finally so an executeScript throw doesn't leak listeners.
  const navState = watchTabNavigation(tabId)
  try {
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
    // Accurate navigated detection via webNavigation events (replaces the
    // old 300ms URL-poll which missed slow nav and reported navigated:false
    // for clicks that DID navigate but took longer to commit). Wait up to
    // ~150ms for onBeforeNavigate to fire; if it does, then wait up to
    // ~5s for onCommitted to land. If onBeforeNavigate never fires, no
    // navigation was triggered — return immediately, no wasted latency.
    const navigated = await navState.promise
    return { ok: true, navigated }
  } finally {
    navState.cleanup()
  }
}

/**
 * Pre-subscribe to chrome.webNavigation events for an upcoming click
 * on a tab. Returns a {promise, cleanup} pair. The caller fires the
 * click AFTER calling this so the listener can never miss the
 * onBeforeNavigate that the click triggers.
 *
 * Promise resolves to:
 *   - true when onCommitted fires for tabId+frameId 0 within ~5s of
 *     an onBeforeNavigate also firing on that tab/frame, OR
 *   - false when onBeforeNavigate doesn't fire within ~150ms post-call
 *     (= no nav triggered by the click).
 *
 * cleanup() removes both listeners — caller MUST invoke from a finally
 * block to avoid leaking event subscriptions on errors.
 */
function watchTabNavigation(tabId) {
  const NO_NAV_MS = 150
  const COMMIT_MS = 5000
  let onBefore
  let onCommitted
  let resolved = false
  let noNavTimer
  let commitTimer
  const cleanup = () => {
    try { if (onBefore) chrome.webNavigation.onBeforeNavigate.removeListener(onBefore) } catch { /* ignore */ }
    try { if (onCommitted) chrome.webNavigation.onCommitted.removeListener(onCommitted) } catch { /* ignore */ }
    if (noNavTimer) clearTimeout(noNavTimer)
    if (commitTimer) clearTimeout(commitTimer)
  }
  const promise = new Promise((resolve) => {
    const settle = (v) => { if (!resolved) { resolved = true; resolve(v) } }
    onCommitted = (details) => {
      if (details.tabId === tabId && details.frameId === 0) settle(true)
    }
    onBefore = (details) => {
      if (details.tabId !== tabId || details.frameId !== 0) return
      // Nav started; switch from "did we get a nav at all" to "wait
      // for commit". If commit doesn't land in COMMIT_MS, assume the
      // nav stuck or was cancelled and report true (a nav DID start).
      if (noNavTimer) { clearTimeout(noNavTimer); noNavTimer = undefined }
      commitTimer = setTimeout(() => settle(true), COMMIT_MS)
    }
    chrome.webNavigation.onBeforeNavigate.addListener(onBefore)
    chrome.webNavigation.onCommitted.addListener(onCommitted)
    noNavTimer = setTimeout(() => settle(false), NO_NAV_MS)
  })
  return { promise, cleanup }
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

// Wall-clock cap on how long ONE input call may hold its tab's mutex,
// passed per-call (each tool sizes its own cap). Acts as a deadlock
// release valve when an in-extension hang outlives the dispatcher's
// WS-side timeout — without this cap the lock would stay held forever
// (CDP commands don't abort when the dispatcher's WS disconnects).
//
// On wedge: we force-detach `chrome.debugger` for the tab AND bump the
// tab's input generation. The detach makes all in-flight `sendCommand`
// promises in the wedged fn() reject with "Debugger is not attached"
// — without this, the wedged fn could keep dispatching stale CDP
// events (e.g. a leftover `mouseReleased`) after the next caller has
// already taken the lock and started a fresh drag, corrupting it.
// `attachedTabs` is cleared so the next caller's `attachDebuggerOnce`
// re-attaches cleanly. Cost: per-tab `consoleBuffers` /
// `networkBuffers` are dropped (their backing CDP domain is no longer
// enabled); the next `browser_console_logs` / `browser_network_log`
// call re-`Runtime.enable` / `Network.enable` and starts capturing
// fresh. A loud console.warn surfaces the wedge to forensic readers.
//
// Default cap = 60s — comfortably covers mouse/drag/scroll/keyboard
// dispatcher maxMs (30s/30s/15s/10s) plus CDP overhead. `browser_type`
// passes a larger explicit cap to accommodate its legitimately-slow
// per-keystroke max (210s + grace).
const DEFAULT_TAB_INPUT_LOCK_HOLD_CAP_MS = 60_000
const TYPE_TAB_INPUT_LOCK_HOLD_CAP_MS = 240_000

const tabInputGenerations = new Map() // tabId → number, bumped each acquire + on wedge

async function withTabInputLock(tabId, fn, holdCapMs = DEFAULT_TAB_INPUT_LOCK_HOLD_CAP_MS) {
  const previousTail = tabInputLockTails.get(tabId) || Promise.resolve()
  let release
  const myTurn = new Promise((r) => { release = r })
  const newTail = previousTail.then(() => myTurn)
  tabInputLockTails.set(tabId, newTail)
  await previousTail
  let timer
  let wedged = false
  try {
    return await Promise.race([
      fn(),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          wedged = true
          reject(new Error(
            `input_lock_wedged: held > ${holdCapMs}ms on tabId=${tabId}; force-detached debugger to abort the stuck CDP call.`,
          ))
        }, holdCapMs)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    if (wedged) {
      console.warn(`[browser-bridge] tab ${tabId} input lock wedged past ${holdCapMs}ms — force-detaching debugger`)
      // Force-detach so the wedged fn's pending sendCommand promises
      // reject and any further CDP calls it queues fail too. Without
      // this, stale events from the wedged call can interleave with
      // the next caller and corrupt drags / mouse state.
      try {
        await chrome.debugger.detach({ tabId })
      } catch {
        // already detached / tab gone — fine
      }
      attachedTabs.delete(tabId)
      // Buffers need re-enabling next time their domains attach.
      consoleBuffers.delete(tabId)
      networkBuffers.delete(tabId)
      // Bump the generation so any wedged fn() that checks before
      // its next CDP send (future tools may opt in) sees the stale
      // marker and bails out early.
      tabInputGenerations.set(tabId, (tabInputGenerations.get(tabId) || 0) + 1)
    }
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
        // Punctuation table fills in real Windows-VK values for the
        // characters whose naive `charCodeAt` would collide with
        // unrelated VK codes (e.g. '.' = 46 = VK_DELETE). Letters and
        // digits use their natural charCode (VK_A..VK_Z / VK_0..VK_9
        // happen to match). Everything else: 0, and CDP infers event
        // semantics from `key` + `text`. Without this, sites that
        // fall back to `event.keyCode` for hotkey handling would see
        // 0 for typed punctuation; with it they get the canonical VK.
        const punctVk = PUNCT_TO_VK[ch]
        if (/^[a-zA-Z0-9]$/.test(ch)) {
          vkc = ch.toUpperCase().charCodeAt(0)
        } else if (punctVk !== undefined) {
          vkc = punctVk
        } else {
          vkc = 0
        }
        codeStr = deriveKeyCode(ch)
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
  }, TYPE_TAB_INPUT_LOCK_HOLD_CAP_MS)
}

// Windows VK codes for the printable punctuation that browser_type
// needs to send. Letters and digits aren't here — their natural
// charCode happens to match VK_A..VK_Z / VK_0..VK_9 and the typing
// loop derives those inline. This table covers the unshifted AND
// shift-modified character on each US-layout punctuation key; both
// map to the same physical-key VK (the shift state is implied by the
// `text` field, and we don't dispatch a separate shift keydown).
//
// Source: Windows VK reference (learn.microsoft.com/...windows-keyboard-codes)
// — VK_OEM_* are the layout-specific punctuation codes (US-QWERTY here).
const PUNCT_TO_VK = Object.freeze({
  // Shift+number row
  "!": 49, "@": 50, "#": 51, "$": 52, "%": 53,
  "^": 54, "&": 55, "*": 56, "(": 57, ")": 48,
  // VK_OEM_1 .. VK_OEM_7 + space
  ";": 186, ":": 186,
  "=": 187, "+": 187,
  ",": 188, "<": 188,
  "-": 189, "_": 189,
  ".": 190, ">": 190,
  "/": 191, "?": 191,
  "`": 192, "~": 192,
  "[": 219, "{": 219,
  "\\": 220, "|": 220,
  "]": 221, "}": 221,
  "'": 222, '"': 222,
  " ": 32, // VK_SPACE
})

function deriveKeyCode(ch) {
  // Best-effort code field. Covers ASCII printable chars including
  // shift-modified punctuation (! → Digit1, @ → Digit2, < → Comma,
  // etc) so `event.code` reports the PHYSICAL key the char lives on
  // — sites that check `event.code === "Digit1"` for layout-aware
  // shortcuts work the same whether the user typed `1` or `!`.
  // Non-ASCII falls back to empty string.
  if (/^[a-zA-Z]$/.test(ch)) return "Key" + ch.toUpperCase()
  if (/^[0-9]$/.test(ch)) return "Digit" + ch
  if (ch === " ") return "Space"
  const map = {
    // Number-row shift partners
    "!": "Digit1", "@": "Digit2", "#": "Digit3", "$": "Digit4", "%": "Digit5",
    "^": "Digit6", "&": "Digit7", "*": "Digit8", "(": "Digit9", ")": "Digit0",
    // OEM keys (US-QWERTY)
    "-": "Minus", "_": "Minus",
    "=": "Equal", "+": "Equal",
    "[": "BracketLeft", "{": "BracketLeft",
    "]": "BracketRight", "}": "BracketRight",
    "\\": "Backslash", "|": "Backslash",
    ";": "Semicolon", ":": "Semicolon",
    "'": "Quote", '"': "Quote",
    ",": "Comma", "<": "Comma",
    ".": "Period", ">": "Period",
    "/": "Slash", "?": "Slash",
    "`": "Backquote", "~": "Backquote",
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
    // Snapshot cache: CDP-written refs survive a detach (they're DOM
    // attributes, not CDP state), but bbox/AXNode IDs become unreliable
    // because re-attach needs a fresh DOM.enable handshake. Safer to
    // invalidate and re-capture on next read.
    invalidateSnapshot(source.tabId, "debugger-detach")
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
  invalidateSnapshot(tabId, "tab-closed")
})

// Snapshot cache invalidation on top-frame navigation. The legacy ref
// scheme (data-gh-router-ref DOM attribute) does NOT survive a fresh
// document load, so a stale snapshot would return refs that resolve
// to nothing. Invalidate so the next read captures the new document.
// We intentionally do NOT invalidate on child-frame navigations — a
// click inside an iframe shouldn't bust the whole-tab snapshot. Phase
// 1b-CDP will revisit this when cross-origin iframe ref attribution
// changes the trade-off.
chrome.webNavigation.onCommitted.addListener((details) => {
  if (details.frameId === 0 && typeof details.tabId === "number") {
    invalidateSnapshot(details.tabId, "navigation")
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

// ---------------------------------------------------------------------
// Bot-challenge detection (Phase 4 auto-detect)
// ---------------------------------------------------------------------
// Listens to chrome.webRequest.onHeadersReceived for response-header
// fingerprints of major bot-protection vendors. On match: post a
// `__botDetected__` control frame to the bridge. The bridge tracks
// which tabs are flagged and the proxy dispatcher consults that state
// via /health to inject humanlike pacing for paced tabs.
//
// Signature confidence tiers:
//   HIGH (per-vendor, single-hit enables): cf-ray + 403/503, x-dd-b,
//     x-px-block, x-px-uuid, x-incapsula header on 403.
//   MEDIUM (cookie / generic — deferred to v2): _abck=*~-1~ cookie,
//     burst of 403/429 across 5 s window.
//
// False-positive guard: only fires when we actually own the
// connection to the bridge (`nativePort` set). No phantom signals
// during SW startup before the port opens.

const BOT_DETECTION_VENDORS = {
  cloudflare: (resp) => {
    if (resp.statusCode !== 403 && resp.statusCode !== 503) return null
    const cfRay = headerValue(resp.responseHeaders, "cf-ray")
    return cfRay ? { signal: "cf-ray + " + resp.statusCode, evidence: cfRay.slice(0, 60) } : null
  },
  datadome: (resp) => {
    const dd = headerValue(resp.responseHeaders, "x-dd-b")
    return dd === "1" ? { signal: "x-dd-b=1", evidence: "" } : null
  },
  perimeterx: (resp) => {
    if (headerValue(resp.responseHeaders, "x-px-block") === "1") {
      return { signal: "x-px-block=1", evidence: "" }
    }
    const pxUuid = headerValue(resp.responseHeaders, "x-px-uuid")
    if (pxUuid && (resp.statusCode === 403 || resp.statusCode === 429)) {
      return { signal: "x-px-uuid + " + resp.statusCode, evidence: pxUuid.slice(0, 36) }
    }
    return null
  },
  imperva: (resp) => {
    if (resp.statusCode !== 403) return null
    const iinfo = headerValue(resp.responseHeaders, "x-iinfo")
    return iinfo ? { signal: "x-iinfo + 403", evidence: iinfo.slice(0, 40) } : null
  },
}

function headerValue(headers, name) {
  if (!Array.isArray(headers)) return undefined
  const lower = name.toLowerCase()
  for (const h of headers) {
    if (h.name && h.name.toLowerCase() === lower) return h.value
  }
  return undefined
}

// Per-tab deduplication: a single vendor's signature firing repeatedly
// on a tab should emit ONE control frame, not one per response. Bridge
// already de-dupes by tabId on its side; we de-dupe here too to keep
// the wire quiet.
const detectedVendorsByTab = new Map() // tabId -> Set<vendor>

function emitBotDetected(tabId, vendor, signal, evidence) {
  if (typeof tabId !== "number" || tabId < 0) return
  if (!nativePort) return
  let seen = detectedVendorsByTab.get(tabId)
  if (!seen) {
    seen = new Set()
    detectedVendorsByTab.set(tabId, seen)
  }
  if (seen.has(vendor)) return
  seen.add(vendor)
  try {
    nativePort.postMessage({
      type: "__botDetected__",
      tabId,
      vendor,
      signal,
      evidence,
      ts: Date.now(),
    })
  } catch (err) {
    console.warn("[browser-bridge/bot-detect] post failed:", err)
  }
}

// MAIN frame only — sub-resource 403s on tracking pixels are common
// noise. Vendor blocks always land on the main document request.
try {
  chrome.webRequest.onHeadersReceived.addListener(
    (details) => {
      try {
        for (const [vendor, probe] of Object.entries(BOT_DETECTION_VENDORS)) {
          const hit = probe(details)
          if (hit) {
            emitBotDetected(details.tabId, vendor, hit.signal, hit.evidence)
            break
          }
        }
      } catch (err) {
        console.warn("[browser-bridge/bot-detect] probe crashed:", err)
      }
    },
    { urls: ["<all_urls>"], types: ["main_frame"] },
    ["responseHeaders"],
  )
} catch (err) {
  // webRequest permission may not be granted on some enterprise
  // policies; auto-detect just no-ops in that case.
  console.warn("[browser-bridge/bot-detect] webRequest listener registration failed:", err)
}

// Cleanup: clear vendor dedup state on navigation + tab close so a
// new document gets a fresh detection window.
chrome.webNavigation.onCommitted.addListener((details) => {
  if (details.frameId === 0 && typeof details.tabId === "number") {
    detectedVendorsByTab.delete(details.tabId)
  }
})
chrome.tabs.onRemoved.addListener((tabId) => {
  detectedVendorsByTab.delete(tabId)
})

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
  // Hello frame — lets the bridge associate this connection with a
  // version. Pre-flight on the proxy side compares this against the
  // version stamped into dist/browser-ext/manifest.json at build, and
  // triggers an auto-reload (via __reload__ control frame) when the
  // package has been updated but the loaded extension is stale.
  try {
    port.postMessage({
      type: "__hello__",
      version: chrome.runtime.getManifest().version,
    })
  } catch (err) {
    console.warn("[browser-bridge] hello frame failed:", err)
  }
  return port
}

async function handleBridgeRequest(req, port) {
  if (!req) return
  // Control frames — not regular tool dispatches. The bridge sends
  // these out-of-band; the {id, tool, args} shape doesn't apply.
  if (req.type === "__reload__") {
    // chrome.runtime.reload terminates this service worker and starts
    // a fresh one that re-reads on-disk files. Used by the proxy's
    // pre-flight when the loaded extension version doesn't match the
    // version stamped into dist/browser-ext/manifest.json.
    try {
      chrome.runtime.reload()
    } catch (err) {
      console.warn("[browser-bridge] reload failed:", err)
    }
    return
  }
  if (typeof req.id !== "string" || typeof req.tool !== "string") return
  const handler = TOOL_HANDLERS[req.tool]
  if (!handler) {
    port.postMessage({ id: req.id, ok: false, error: `unknown tool: ${req.tool}`, code: "unknown_tool" })
    return
  }
  try {
    const data = await handler(req.args || {})
    port.postMessage({ id: req.id, ok: true, data })
    // Snapshot cache invalidation for mutating actions. The matcher
    // cascade (Phase 2) dispatches against cached snapshots; a
    // successful click / fill / type / etc. likely changed the page,
    // so the cached element list is stale. Invalidate by tabId from
    // the request args; tools that don't carry a tabId (open_tab on
    // create-path, list_tabs) are not page-mutating per-tab so they
    // skip this.
    if (MUTATES_PAGE.has(req.tool)) {
      const tabId = typeof req.args?.tabId === "number" ? req.args.tabId : undefined
      if (typeof tabId === "number") {
        invalidateSnapshot(tabId, `mutation:${req.tool}`)
      }
    }
  } catch (err) {
    port.postMessage({ id: req.id, ok: false, error: err && err.message ? err.message : String(err) })
  }
}

// Tools whose successful execution likely mutates the page's DOM,
// triggering snapshot-cache invalidation for the tabId in args. Kept
// as a Set rather than per-tool flags so adding a new mutating tool
// is one line. Conservative: tools listed here MAY not mutate (e.g.
// click on a disabled button is a no-op); the cost of a spurious
// invalidate is one extra capture on next read, vs the cost of a
// stale snapshot which is silent dispatch against a vanished ref.
const MUTATES_PAGE = new Set([
  "browser_click",
  "browser_fill",
  "browser_type",
  "browser_keyboard",
  "browser_scroll",
  "browser_mouse",
  "browser_drag",
  "browser_navigate",
  "browser_eval_js",
])

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

// webNavigation.onBeforeNavigate fires for ALL top-level navigations
// — user-typed URL bar entries AND in-page-initiated nav (JS redirect,
// meta-refresh, anchor clicks). It does NOT expose transitionType, so
// we can't cheaply distinguish initiator at this stage. Consequence:
// every URL in BLOCKED_URL_RE is unreachable when this extension is
// enabled, including for the human user. `extensions` is deliberately
// excluded from BLOCKED_URL_RE to preserve user access to the page
// they need to manage this extension; bridge-side policy.ts still
// rejects tool-initiated nav there. On match: route the tab back to
// about:blank (no onBeforeNavigate cancel API in MV3) and log a
// console.error so browser_console_logs can surface it on next drain.
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
