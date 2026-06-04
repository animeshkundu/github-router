// snapshot-cdp.js — CDP `Accessibility.getFullAXTree` based extractor.
//
// Why CDP over the in-page DOM walker:
// - Cross-origin iframes: chrome.scripting.executeScript can't enter
//   them by default (Stripe checkout, OAuth widgets, embedded payment
//   forms). CDP's Page.getFrameTree enumerates all frames including
//   OOPIFs; Accessibility.getFullAXTree({frameId}) returns each
//   frame's a11y tree.
// - Platform-computed accessible name: handles aria-labelledby chains,
//   <label for>, fieldset/legend, button-inside-link cases the
//   hand-rolled `nameOf` walker misses.
// - Real ignored state: Chrome's a11y tree marks nodes that screen
//   readers skip (display:none, aria-hidden, role=presentation). We
//   filter those upfront instead of guessing visibility from bbox.
//
// The extractor produces a PageSnapshot matching snapshot-types.ts.
// Falls through to the legacy DOM-walker extractor when CDP attach
// fails (enterprise DeveloperToolsAvailability=2, DevTools already
// open on the tab, etc.).

const ELEMENT_CAP = 500            // total elements across all frames
const PER_FRAME_CAP = 200          // per-frame element cap
const TEXT_CAP = 32 * 1024         // viewport-visible text cap
const VS_MIN = 100                 // visualSurface min width / height
const CAPTURE_TIMEOUT_MS = 8000    // whole-snapshot wall-clock cap

// Roles we consider "interactive enough to bother surfacing." A
// liberal allowlist; the matcher cascade scores candidates further.
const INTERESTING_ROLES = new Set([
  "button", "link", "checkbox", "radio", "switch", "tab", "menuitem",
  "menuitemcheckbox", "menuitemradio", "option", "treeitem",
  "textbox", "searchbox", "combobox", "spinbutton", "slider",
  "listbox", "listitem", "tablist", "tabpanel",
  "dialog", "alertdialog", "navigation", "main", "form", "search",
  "region", "complementary", "banner", "contentinfo", "article",
  "heading",
])

const LANDMARK_ROLES = new Set([
  "dialog", "alertdialog", "navigation", "main", "form", "search",
  "region", "complementary", "banner", "contentinfo",
])

const INTERACTIVE_LEAF_ROLES = new Set([
  "button", "link", "checkbox", "radio", "switch", "tab", "menuitem",
  "menuitemcheckbox", "menuitemradio", "option", "treeitem",
  "textbox", "searchbox", "combobox", "spinbutton", "slider",
])

/**
 * Extract a page snapshot via CDP. Throws on attach failure or
 * whole-capture timeout — caller falls back to the legacy extractor.
 *
 * `attachDebugger` and `sendCommand` are passed in so this module
 * stays decoupled from the SW-global debugger state in background.js;
 * makes the extractor unit-testable with a mock CDP later.
 */
export async function extractSnapshotCDP(tabId, opts, deps) {
  const mode = opts?.mode === "full" ? "full" : "summary"
  const attachDebugger = deps?.attachDebugger
  const sendCommand = deps?.sendCommand
  if (typeof attachDebugger !== "function" || typeof sendCommand !== "function") {
    throw new Error("snapshot-cdp: missing attachDebugger / sendCommand deps")
  }
  await attachDebugger(tabId, { accessibility: true })

  // Race against a whole-capture wall-clock budget so a slow
  // upstream can't hang the dispatcher.
  let timedOut = false
  const timer = setTimeout(() => { timedOut = true }, CAPTURE_TIMEOUT_MS)
  try {
    const tab = await chrome.tabs.get(tabId)
    const viewport = await captureViewport(tabId, sendCommand)
    // DOM.getDocument must be called before DOM.pushNodesByBackendIdsToFrontend
    // can resolve anything — DOM.enable alone does NOT materialize the
    // protocol-side node tree, which is the gotcha that bit the first
    // implementation (1597 AX nodes, 0 resolved). pierce:true crosses
    // into shadow roots and iframe content documents in one round-trip.
    try {
      await sendCommand(tabId, "DOM.getDocument", { depth: -1, pierce: true })
    } catch {
      // Best-effort — getDocument can fail on detached / about:blank
      // frames; pushNodes calls below will throw cleanly per-frame.
    }
    const frameTree = await sendCommand(tabId, "Page.getFrameTree", {})
    const frames = flattenFrameTree(frameTree.frameTree)
    let truncatedElements = false
    let framesSkipped = 0
    const elements = []
    const refCounter = { next: 1 }
    const usedRefs = new Set()
    const diag = { frames: frames.length, axNodes: 0, interesting: 0, resolved: 0, withRef: 0 }
    for (const frame of frames) {
      if (timedOut) break
      if (elements.length >= ELEMENT_CAP) {
        truncatedElements = true
        break
      }
      try {
        const frameElements = await extractFrameElements({
          tabId,
          frame,
          parentFrameOffset: frame.offset,
          isTopFrame: frame === frames[0],
          mode,
          viewport,
          remainingCap: ELEMENT_CAP - elements.length,
          refCounter,
          usedRefs,
          sendCommand,
          diag,
        })
        elements.push(...frameElements)
      } catch {
        framesSkipped++
        // Per-frame failure (cross-origin OOPIF refusing the call,
        // detached frame, sandbox restriction) is logged but not
        // fatal. The top frame's failure WOULD be fatal, but its
        // attach already succeeded so an enable failure is rare.
      }
    }
    const text = await extractVisibleText(tabId, sendCommand).catch(() => "")
    const truncatedText = text.length >= TEXT_CAP
    const visualSurfaces = await extractVisualSurfaces(tabId, sendCommand).catch(() => [])
    const out = {
      mode,
      tabId,
      url: tab.url,
      title: tab.title,
      capturedAt: Date.now(),
      viewport,
      text: text.slice(0, TEXT_CAP),
      elements,
      truncated: {
        elements: truncatedElements,
        text: truncatedText,
        framesSkipped,
        diag,
      },
    }
    if (visualSurfaces.length > 0) out.visualSurfaces = visualSurfaces
    return out
  } finally {
    clearTimeout(timer)
  }
}

function flattenFrameTree(node, out, parentOffset) {
  if (!out) out = []
  if (!node) return out
  const frame = node.frame || node
  const offset = parentOffset ?? { x: 0, y: 0 }
  out.push({
    frameId: frame.id,
    url: frame.url,
    parentId: frame.parentId,
    offset,
  })
  if (Array.isArray(node.childFrames)) {
    for (const child of node.childFrames) {
      // Child offset relative to top frame: we'd need each iframe
      // element's bbox to transform. Skipping for now — bbox of
      // elements inside child frames is iframe-local CSS pixels.
      // The matcher cascade still resolves them by ref via
      // data-gh-router-ref; the bbox is best-effort.
      flattenFrameTree(child, out, offset)
    }
  }
  return out
}

async function captureViewport(tabId, sendCommand) {
  try {
    const layoutMetrics = await sendCommand(tabId, "Page.getLayoutMetrics", {})
    const v = layoutMetrics.cssVisualViewport ?? layoutMetrics.visualViewport ?? {}
    return {
      width: Math.round(v.clientWidth ?? v.width ?? 0),
      height: Math.round(v.clientHeight ?? v.height ?? 0),
      devicePixelRatio: v.scale ?? 1,
      scrollX: Math.round(v.pageX ?? 0),
      scrollY: Math.round(v.pageY ?? 0),
    }
  } catch {
    return { width: 0, height: 0, devicePixelRatio: 1, scrollX: 0, scrollY: 0 }
  }
}

async function extractFrameElements({
  tabId, frame, parentFrameOffset, isTopFrame, mode, viewport,
  remainingCap, refCounter, usedRefs, sendCommand, diag,
}) {
  const cap = Math.min(PER_FRAME_CAP, remainingCap)
  const params = isTopFrame ? {} : { frameId: frame.frameId }
  const result = await sendCommand(tabId, "Accessibility.getFullAXTree", params)
  const nodes = Array.isArray(result.nodes) ? result.nodes : []
  if (diag) diag.axNodes += nodes.length
  // Pre-pass: collect landmark nodes by AXNode id so leaf nodes can
  // attribute their ancestry without walking the whole tree.
  const landmarkByAxId = new Map()
  for (const n of nodes) {
    const role = n.role?.value
    if (role && LANDMARK_ROLES.has(role) && !n.ignored) {
      landmarkByAxId.set(n.nodeId, n)
    }
  }
  // Parent map for ancestry walks.
  const parentById = new Map()
  for (const n of nodes) {
    if (Array.isArray(n.childIds)) {
      for (const cid of n.childIds) parentById.set(cid, n.nodeId)
    }
  }
  function landmarksOf(axId) {
    const refs = []
    let cur = parentById.get(axId)
    while (cur !== undefined && refs.length < 4) {
      if (landmarkByAxId.has(cur)) {
        const lm = landmarkByAxId.get(cur)
        const r = lm._ghRouterRef
        if (r) refs.push(r)
      }
      cur = parentById.get(cur)
    }
    return refs
  }
  // Filter to interesting + has backendDOMNodeId; cap per-frame.
  const interesting = nodes.filter((n) => {
    if (n.ignored) return false
    const role = n.role?.value
    if (!role || !INTERESTING_ROLES.has(role)) return false
    if (typeof n.backendDOMNodeId !== "number") return false
    return true
  }).slice(0, cap)
  if (diag) diag.interesting += interesting.length
  // Resolve backendDOMNodeIds to frontend nodeIds in one batch.
  const backendIds = interesting.map((n) => n.backendDOMNodeId)
  let nodeIds = []
  if (backendIds.length > 0) {
    try {
      const resolved = await sendCommand(tabId, "DOM.pushNodesByBackendIdsToFrontend", {
        backendNodeIds: backendIds,
      })
      nodeIds = Array.isArray(resolved.nodeIds) ? resolved.nodeIds : []
      if (diag) diag.resolved += nodeIds.filter((n) => n).length
    } catch {
      // DOM.pushNodes can fail per-frame on cross-origin. Best-effort.
    }
  }
  const out = []
  for (let i = 0; i < interesting.length; i++) {
    const ax = interesting[i]
    const nodeId = nodeIds[i]
    if (!nodeId) continue
    // Read existing ref or mint new one.
    let ref
    try {
      const attrs = await sendCommand(tabId, "DOM.getAttributes", { nodeId })
      ref = attrFromList(attrs.attributes, "data-gh-router-ref")
    } catch {
      ref = undefined
    }
    if (!ref || !/^e\d+$/.test(ref)) {
      while (usedRefs.has(`e${refCounter.next}`)) refCounter.next++
      ref = `e${refCounter.next}`
      refCounter.next++
      usedRefs.add(ref)
      try {
        await sendCommand(tabId, "DOM.setAttributeValue", {
          nodeId, name: "data-gh-router-ref", value: ref,
        })
      } catch {
        // Read-only doc or shadow boundary; skip this element.
        continue
      }
    } else {
      usedRefs.add(ref)
    }
    ax._ghRouterRef = ref
    // Get bbox via DOM.getBoxModel. Best-effort; off-screen / detached
    // nodes throw.
    let bbox = [0, 0, 0, 0]
    try {
      const box = await sendCommand(tabId, "DOM.getBoxModel", { nodeId })
      const m = box.model
      if (m && Array.isArray(m.border) && m.border.length >= 4) {
        // border is [x1,y1, x2,y1, x2,y2, x1,y2] — 8 numbers
        const x = m.border[0]
        const y = m.border[1]
        const w = m.width
        const h = m.height
        bbox = [
          Math.round(x + parentFrameOffset.x),
          Math.round(y + parentFrameOffset.y),
          Math.round(w),
          Math.round(h),
        ]
      }
    } catch {
      // ignore
    }
    // Skip elements with zero-size bbox in summary mode — they're
    // hidden by display:none-ish parent or detached.
    if (mode === "summary" && bbox[2] === 0 && bbox[3] === 0) continue
    // Skip elements outside the viewport in summary mode (top-frame
    // coord space). Skip when bbox is unknown (0,0,0,0) too.
    if (mode === "summary" && !inViewport(bbox, viewport) && bbox.some((n) => n !== 0)) continue
    const role = ax.role?.value || "generic"
    const name = (ax.name?.value || "").trim().slice(0, 200)
    const description = (ax.description?.value || "").trim().slice(0, 200)
    const valueStr = (ax.value?.value !== undefined && ax.value?.value !== null)
      ? String(ax.value.value).trim().slice(0, 200)
      : ""
    // Drop unnamed leaf interactive elements in summary mode (a
    // <button> with no accessible name is noise).
    if (mode === "summary" && !name && INTERACTIVE_LEAF_ROLES.has(role)) continue
    const entry = {
      ref,
      role,
      bbox,
      frameId: frame.frameId,
    }
    if (!isTopFrame) entry.isInIframe = true
    if (name) entry.name = name
    if (description) entry.description = description
    if (valueStr) entry.value = valueStr
    // State flags from AXNode.properties — Chrome surfaces these in
    // a strongly-typed bag distinct from the generic value field.
    const props = ax.properties
    if (Array.isArray(props)) {
      for (const p of props) {
        const k = p.name
        const v = p.value?.value
        if (k === "disabled" && v) entry.disabled = true
        else if (k === "focused" && v) entry.focused = true
        else if (k === "checked" && v !== undefined && v !== false) {
          entry.checked = v === "mixed" ? "mixed" : Boolean(v)
        }
        else if (k === "expanded" && v !== undefined) entry.expanded = Boolean(v)
        else if (k === "selected" && v) entry.selected = true
        else if (k === "pressed" && v !== undefined && v !== false) entry.pressed = Boolean(v)
        else if (k === "hidden" && v) entry.hidden = true
        else if (k === "required" && v) entry.required = true
        else if (k === "readonly" && v) entry.readonly = true
        else if (k === "invalid" && v) entry.invalid = v === true ? true : String(v)
        else if (k === "editable" && v) entry.editable = true
        else if (k === "level" && typeof v === "number") entry.level = v
      }
    }
    // Landmark ancestry (ref-chain up to 4 deep).
    const lm = landmarksOf(ax.nodeId)
    if (lm.length > 0) entry.landmarks = lm
    out.push(entry)
    if (diag) diag.withRef++
  }
  return out
}

function inViewport(bbox, viewport) {
  const [x, y, w, h] = bbox
  return x < viewport.width && y < viewport.height && x + w > 0 && y + h > 0
}

function attrFromList(attrList, name) {
  if (!Array.isArray(attrList)) return undefined
  for (let i = 0; i < attrList.length; i += 2) {
    if (attrList[i] === name) return attrList[i + 1]
  }
  return undefined
}

async function extractVisibleText(tabId, sendCommand) {
  // Single Runtime.evaluate call into the page's main world to grab
  // viewport-visible text. Same logic as the legacy extractor.
  const expr = `
    (function() {
      const out = [];
      let total = 0;
      const CAP = ${TEXT_CAP};
      const root = document.body || document.documentElement;
      if (!root) return "";
      const tw = document.createTreeWalker(root, 4);
      const vp = { w: window.innerWidth, h: window.innerHeight };
      function inV(r) { return r.bottom > 0 && r.right > 0 && r.top < vp.h && r.left < vp.w; }
      let n;
      while ((n = tw.nextNode())) {
        const p = n.parentElement;
        if (!p) continue;
        const t = p.tagName ? p.tagName.toLowerCase() : "";
        if (t === "script" || t === "style" || t === "noscript") continue;
        const r = p.getBoundingClientRect();
        if (!inV(r)) continue;
        const s = (n.textContent || "").replace(/\\s+/g, " ").trim();
        if (!s) continue;
        if (total + s.length + 1 > CAP) { out.push(s.slice(0, Math.max(0, CAP - total))); break; }
        out.push(s);
        total += s.length + 1;
      }
      return out.join("\\n");
    })()
  `
  const res = await sendCommand(tabId, "Runtime.evaluate", {
    expression: expr,
    returnByValue: true,
  })
  return res?.result?.value ?? ""
}

async function extractVisualSurfaces(tabId, sendCommand) {
  // Find canvas / svg of non-trivial size in viewport. Runtime.evaluate
  // is the cheapest path; AX tree doesn't surface canvas/svg directly.
  const expr = `
    (function() {
      const out = [];
      const vp = { w: window.innerWidth, h: window.innerHeight };
      function inV(r) { return r.bottom > 0 && r.right > 0 && r.top < vp.h && r.left < vp.w; }
      const els = document.querySelectorAll("canvas, svg");
      let counter = 1;
      for (const el of els) {
        const r = el.getBoundingClientRect();
        if (r.width < ${VS_MIN} || r.height < ${VS_MIN}) continue;
        if (!inV(r)) continue;
        let ref = el.getAttribute("data-gh-router-ref");
        if (!ref) { ref = "v" + counter++; el.setAttribute("data-gh-router-ref", ref); }
        out.push({
          ref,
          kind: el.tagName.toLowerCase(),
          bbox: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)],
        });
      }
      return out;
    })()
  `
  const res = await sendCommand(tabId, "Runtime.evaluate", {
    expression: expr,
    returnByValue: true,
  })
  return Array.isArray(res?.result?.value) ? res.result.value : []
}
