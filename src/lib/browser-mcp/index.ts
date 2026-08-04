import { dispatchBrowserTool } from "./dispatch"
import {
  ResultShapeError,
  SchemaValidationError,
  extractStructured,
  pickElement,
  pickElementVisual,
  pickMatchingElements,
  type PageSnapshot,
} from "./compressor"
import { decompose } from "./decompose"
import { observePage } from "./observe"
import { planCompoundReplan } from "./planner"

import type { NonPersonaMcpTool } from "~/lib/peer-mcp-personas"
import type { McpImageBlock, McpToolResult } from "~/lib/attachments"

/**
 * Helper for compound tools (`browser_find` / `browser_act` /
 * `browser_extract`): fetch the page snapshot via the existing
 * primitive dispatcher and unwrap the JSON text envelope. Compound
 * tools all start from a snapshot, so a single helper keeps the
 * unwrap logic in one place.
 */
async function fetchSnapshot(
  tabId: number,
  signal?: AbortSignal,
): Promise<PageSnapshot> {
  const env = await dispatchBrowserTool(
    "browser_read_page",
    { tabId, mode: "summary" },
    signal,
  )
  if (env.isError) {
    throw new Error("browser_read_page returned an error envelope; bridge / extension not ready")
  }
  const text = env.content?.[0]?.text
  if (typeof text !== "string") {
    throw new Error("browser_read_page returned no text content")
  }
  return JSON.parse(text) as PageSnapshot
}

function toolEnvelope(
  data: unknown,
  isError?: boolean,
): McpToolResult {
  const text = typeof data === "string" ? data : JSON.stringify(data, null, 2)
  return isError ? { content: [{ type: "text", text }], isError: true } : { content: [{ type: "text", text }] }
}

/**
 * Browser-control MCP tools (`browser_*`). All entries route through
 * `dispatchBrowserTool()` which (1) runs the bridge-layer URL policy
 * check, (2) runs the install-check pre-flight (returning structured
 * install_required JSON when the bridge or extension isn't ready),
 * and (3) opens a WS to the bridge, sends the tool call, awaits the
 * response with a per-tool timeout.
 *
 * Each entry carries a browser capability tag so `browserToolsEnabled()`
 * in `src/routes/mcp/handler.ts` drops them at both list-time and
 * call-time when the operator hasn't opted in via `--browse` or
 * `GH_ROUTER_ENABLE_BROWSE=1`.
 *
 * NAMING: the `toolNameHttp` here is the WIRE name (`browser_*`) that each
 * handler dispatches to the extension. `peer-mcp-personas.ts` strips the
 * `browser_` prefix when spreading these into `NON_PERSONA_MCP_TOOLS` so
 * the MCP-facing name is bare (`mcp__browser__navigate`) while the wire
 * name stays `browser_navigate` — do NOT rename the literals below or the
 * installed extension breaks. The `group` field is injected at that spread
 * (hence `Omit<…, "group">` here).
 *
 * v1 surface: 19 tools (Phases 3 + 4a + 4b + humanlike input v2).
 */
export const BROWSER_TOOLS: ReadonlyArray<Omit<NonPersonaMcpTool, "group">> = Object.freeze([
  {
    toolNameHttp: "browser_list_tabs",
    description:
      "Lists open tabs across all browser windows. It takes no input and returns each tab's id, URL, title, active flag, and window id. The returned tab ids are the inputs used by tab-scoped browser tools, especially for pre-existing tabs that were not opened by browser_open_tab. It is a power-tier discovery tool for tab selection and inventory, not a page-content reader or navigation tool.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {},
    },
    capability: "browser_power",
    async handler(args: Record<string, unknown>, signal?: AbortSignal) {
      return dispatchBrowserTool("browser_list_tabs", args, signal)
    },
  },
  {
    toolNameHttp: "browser_open_tab",
    description:
      "Opens a URL in a new browser tab, or navigates the currently active tab when reuseActive is true, then waits briefly for the tab load state to reach complete. It takes a URL and optional reuseActive flag, and returns the tab id, final URL, and a synthetic statusCode load flag where 200 means the tab reported complete and 0 means it did not. The statusCode is not the page's HTTP response code, so a loaded 404 page can still return 200. Use this to establish a tab before other browser tools; blocked URLs return {blocked, reason}, including browser settings/preferences/extensions/flags pages, file:// by default, and extension options/popup pages, while devtools:// is allowed.",
    inputSchema: {
      type: "object",
      required: ["url"],
      additionalProperties: false,
      properties: {
        url: {
          type: "string",
          description:
            "URL to load. Browser-internal settings, preferences, extensions, flags, password/management pages, extension options/popup pages, and file:// URLs by default are blocked before dispatch.",
        },
        reuseActive: {
          type: "boolean",
          description:
            "When true, navigates the currently active tab instead of opening a new tab. Default false. Use browser_navigate when you already know the target tab id.",
        },
      },
    },
    capability: "browser",
    async handler(args: Record<string, unknown>, signal?: AbortSignal) {
      return dispatchBrowserTool("browser_open_tab", args, signal)
    },
  },
  {
    toolNameHttp: "browser_close_tab",
    description:
      "Closes one or more browser tabs by id. It takes a non-empty tabIds array, usually obtained from browser_list_tabs, and returns {closed: N} after requesting Chrome to remove those tabs. This is a power-tier tab lifecycle tool for cleanup or closing known throwaway tabs. Avoid using it when the user may still need a tab, and prefer leaving the tab open if the id was not freshly discovered or created for the current task.",
    inputSchema: {
      type: "object",
      required: ["tabIds"],
      additionalProperties: false,
      properties: {
        tabIds: {
          type: "array",
          items: { type: "number" },
          description: "Non-empty array of tab ids to close, usually from browser_list_tabs or browser_open_tab.",
        },
      },
    },
    capability: "browser_power",
    async handler(args: Record<string, unknown>, signal?: AbortSignal) {
      return dispatchBrowserTool("browser_close_tab", args, signal)
    },
  },
  {
    toolNameHttp: "browser_navigate",
    description:
      "Navigates an existing tab by going to a URL, moving back or forward in history, or reloading. It takes a tab id plus an action, with url required only for action='goto', and returns {finalUrl, statusCode} for completed navigation or {blocked, reason} for a policy-blocked URL. The statusCode is a synthetic load-complete flag, not the page's HTTP response code. Use this when the target tab already exists; use browser_open_tab to create a new tab, and expect the same URL policy blocks as open_tab, including browser-internal pages, file:// by default, and extension options/popup pages.",
    inputSchema: {
      type: "object",
      required: ["tabId", "action"],
      additionalProperties: false,
      properties: {
        tabId: { type: "number", description: "Tab id from browser_list_tabs or browser_open_tab." },
        action: {
          type: "string",
          enum: ["goto", "back", "forward", "reload"],
          description: "Navigation action: goto a URL, go back, go forward, or reload the current page.",
        },
        url: { type: "string", description: "URL to load when action='goto'. Ignored for back, forward, and reload." },
        hard: {
          type: "boolean",
          description: "Reload only: when true, bypasses cache like Ctrl+Shift+R. Default false.",
        },
      },
    },
    capability: "browser",
    async handler(args: Record<string, unknown>, signal?: AbortSignal) {
      return dispatchBrowserTool("browser_navigate", args, signal)
    },
  },
  {
    toolNameHttp: "browser_screenshot",
    description:
      "Captures a screenshot of the visible area of a tab and returns it as an image you can actually look at, plus a small text envelope of capture metadata. It takes a tab id, an optional format (PNG default, JPEG for smaller bytes), and an optional JPEG quality. The tab must be active in its window, so this tool auto-activates the tab if needed and that changes which tab is focused. If a capture is rejected for exceeding a model's image-size limit, the most reliable lever is a smaller browser window; PNG is usually SMALLER than JPEG for ordinary UI and text pages, so switching format is not a dependable way to shrink one. JPEG plus a low quality helps mainly for photographic or dense-colour content. Use screenshot for visual layout, canvas, SVG, maps, or image-only regions; prefer browser_observe when page text and actionable state are enough.",
    inputSchema: {
      type: "object",
      required: ["tabId"],
      additionalProperties: false,
      properties: {
        tabId: { type: "number", description: "Tab id from browser_list_tabs or browser_open_tab." },
        format: {
          type: "string",
          enum: ["png", "jpeg"],
          description: "Image format for the returned screenshot. Default 'png'; use 'jpeg' when smaller image bytes are preferable.",
        },
        quality: {
          type: "number",
          minimum: 1,
          maximum: 100,
          description:
            "JPEG quality 1-100 (ignored for PNG). Only meaningful with format='jpeg'. Note JPEG is often LARGER than PNG for flat UI screenshots — measured on a plain documentation page, PNG 35553 bytes vs JPEG q30 40599 bytes at the same viewport — so reach for it for photographic content, not as a general size lever.",
        },
      },
    },
    capability: "browser",
    async handler(args: Record<string, unknown>, signal?: AbortSignal) {
      return dispatchBrowserTool("browser_screenshot", args, signal)
    },
  },
  {
    toolNameHttp: "browser_read_page",
    description:
      "Returns a compressed page snapshot for a tab: visible text, interactive elements with refs, viewport metadata, and visualSurfaces for canvas or SVG regions that need vision. It takes a tab id and optional mode, and each element includes a ref plus bbox in CSS viewport pixels, the same coordinate space used by browser_mouse, browser_drag, and scroll at-pointer. Refs persist across snapshots of the same document until navigation or DOM replacement, and are a better input to follow-up actions than brittle CSS selectors. Use read_page when enumeration, coordinates, refs, or raw snapshot structure are needed; prefer browser_act or browser_find for intent-driven interaction, browser_observe for a short natural-language page summary, and browser_screenshot for visual pixels.",
    inputSchema: {
      type: "object",
      required: ["tabId"],
      additionalProperties: false,
      properties: {
        tabId: { type: "number", description: "Tab id from browser_list_tabs or browser_open_tab." },
        mode: {
          type: "string",
          enum: ["summary", "full"],
          description: "Snapshot scope. Default 'summary' focuses on viewport-visible text and elements; 'full' asks for a broader page-wide snapshot. The default CDP extractor caps around 500 elements and 32 KiB text, with legacy fallback caps possibly lower or higher by mode.",
        },
      },
    },
    capability: "browser_power",
    async handler(args: Record<string, unknown>, signal?: AbortSignal) {
      return dispatchBrowserTool("browser_read_page", args, signal)
    },
  },
  {
    toolNameHttp: "browser_scroll",
    description:
      "Scrolls a tab or a scrollable region inside a tab. It takes a tab id, target mode, and mode-specific fields for page top/bottom, pixel deltas, element centering, or wheel scrolling at a pointer. The at-pointer path dispatches a real wheel event at a ref, selector, or CSS viewport coordinate, which is the path for chat panes, infinite lists, and modal bodies with their own scroll containers. Use browser_act with action='scroll_into_view' or intent mode for simple element reveal; use browser_scroll when page-level movement, precise deltas, or sub-container wheel scrolling are needed.",
    inputSchema: {
      type: "object",
      required: ["tabId", "target"],
      additionalProperties: false,
      properties: {
        tabId: { type: "number", description: "Tab id from browser_list_tabs or browser_open_tab." },
        target: {
          type: "string",
          enum: ["top", "bottom", "pixels", "element", "at-pointer"],
          description: "Scroll target mode: page top, page bottom, pixel delta, element centering, or wheel event at a pointer.",
        },
        pixels: {
          type: "number",
          description: "Pixel delta when target='pixels'. Positive scrolls down and negative scrolls up.",
        },
        ref: {
          type: "string",
          description: "Element ref. For target='element', the element is centered; for target='at-pointer', the element bbox center becomes the wheel position.",
        },
        selector: {
          type: "string",
          description: "CSS selector fallback when no ref is available. For target='at-pointer', resolves to the element bbox center.",
        },
        x: {
          type: "number",
          description: "Pointer x in CSS viewport pixels for target='at-pointer'. Pair with y. Exactly one of ref, selector, or x+y is required for at-pointer.",
        },
        y: {
          type: "number",
          description: "Pointer y in CSS viewport pixels for target='at-pointer'. Pair with x.",
        },
        deltaX: {
          type: "number",
          description: "Wheel delta x in CSS pixels for target='at-pointer'. Default 0. Clamped to absolute value 10000.",
        },
        deltaY: {
          type: "number",
          description: "Wheel delta y in CSS pixels for target='at-pointer'. Positive scrolls down. Default 0. Clamped to absolute value 10000; at least one of deltaX or deltaY must be non-zero.",
        },
        force: {
          type: "boolean",
          description: "For target='at-pointer', skips the pre-wheel elementFromPoint hit-test. Default false. Set true only when an overlay covers the target but forwards wheel events.",
        },
      },
    },
    capability: "browser_power",
    async handler(args: Record<string, unknown>, signal?: AbortSignal) {
      return dispatchBrowserTool("browser_scroll", args, signal)
    },
  },
  {
    toolNameHttp: "browser_keyboard",
    description:
      "Sends a discrete key or chord to the focused element or browser via CDP Input.dispatchKeyEvent. It takes a tab id and a keys string such as 'Control+L', 'Command+L', 'Enter', 'Escape', or 'ArrowDown', and returns the extension dispatch result. Browser-level shortcuts such as Ctrl+T and Ctrl+W actually fire because this uses chrome.debugger input rather than synthetic DOM events. Use keyboard for shortcuts and non-printable control keys; prefer browser_type for literal text entry into a focused field and browser_act with action='fill' for plain form values.",
    inputSchema: {
      type: "object",
      required: ["tabId", "keys"],
      additionalProperties: false,
      properties: {
        tabId: { type: "number", description: "Tab id from browser_list_tabs or browser_open_tab." },
        keys: {
          type: "string",
          description: "Key or chord. Join modifiers with '+', using Control, Ctrl, Alt, Shift, Meta, Command, or Cmd. A single named key such as Enter or Escape is also valid.",
        },
      },
    },
    capability: "browser_power",
    async handler(args: Record<string, unknown>, signal?: AbortSignal) {
      return dispatchBrowserTool("browser_keyboard", args, signal)
    },
  },
  {
    toolNameHttp: "browser_wait",
    description:
      "Waits for a tab condition without mutating the page. It takes a tab id, an until mode, and the matching operand: a CSS selector for element appearance, a JavaScript regex string for URL matching, or networkIdle for the heuristic of tab status complete plus 500 ms quiet. It returns {ok: true, elapsedMs} on success and {ok: false, reason: 'timeout'} when the condition is not reached before the timeout. Use wait after navigation or actions that trigger asynchronous rendering; do not use it as a page reader, and prefer browser_observe or browser_read_page when the task is to inspect current content.",
    inputSchema: {
      type: "object",
      required: ["tabId", "until"],
      additionalProperties: false,
      properties: {
        tabId: { type: "number", description: "Tab id from browser_list_tabs or browser_open_tab." },
        until: {
          type: "string",
          enum: ["selector", "url", "networkIdle"],
          description: "Condition to wait for: selector, URL regex match, or network-idle heuristic.",
        },
        selector: { type: "string", description: "CSS selector required when until='selector'." },
        urlPattern: { type: "string", description: "JavaScript regex source string required when until='url'." },
        timeoutMs: {
          type: "number",
          description: "Maximum wait in milliseconds. Default 10000, hard cap 60000.",
        },
      },
    },
    capability: "browser_power",
    async handler(args: Record<string, unknown>, signal?: AbortSignal) {
      return dispatchBrowserTool("browser_wait", args, signal)
    },
  },
  {
    toolNameHttp: "browser_eval_js",
    description:
      "Evaluates a JavaScript expression in the tab's main world, equivalent to typing in the DevTools console. It takes a tab id, expression, and optional timeout, awaits promises returned by the expression, and returns {result} or {error}. The expression can read or mutate the page, storage, cookies, or location, so this is the power-tier escape hatch for behaviors the structured browser tools do not cover. Prefer dedicated tools for navigation, clicking, filling, extraction, diagnostics, and screenshots; note that URL policy checks only apply directly to browser_open_tab and browser_navigate, while extension-side navigation blocking still applies to many browser-internal pages.",
    inputSchema: {
      type: "object",
      required: ["tabId", "expression"],
      additionalProperties: false,
      properties: {
        tabId: { type: "number", description: "Tab id from browser_list_tabs or browser_open_tab." },
        expression: {
          type: "string",
          description: "JavaScript expression to evaluate. Size should stay small for reliability, but no schema length cap is enforced. Top-level await is not supported; wrap async work in (async () => ...)().",
        },
        timeoutMs: {
          type: "number",
          description: "Maximum evaluation time in milliseconds. Default 5000, hard cap 30000.",
        },
      },
    },
    capability: "browser_power",
    async handler(args: Record<string, unknown>, signal?: AbortSignal) {
      return dispatchBrowserTool("browser_eval_js", args, signal)
    },
  },
  {
    toolNameHttp: "browser_download",
    description:
      "Triggers a browser download from a direct URL and waits for the extension's completion signal. It takes a tab id for association, source='url', the URL, and optional saveAs path, then returns {downloadId, path, bytes, mimeType} when Chrome reports the download complete. The file lands in Chrome's default Downloads directory unless saveAs provides a relative filename or subdirectory, and conflicts are auto-uniquified by the browser. Use this for known direct download URLs; it does not click page links, and the extension currently waits up to 60 seconds internally, so downloads that finish after 60 seconds can report timeout even though the outer wire budget is larger.",
    inputSchema: {
      type: "object",
      required: ["tabId", "url"],
      additionalProperties: false,
      properties: {
        tabId: { type: "number", description: "Tab id for association and logging; the download itself is window-scoped, not tab-scoped." },
        source: {
          type: "string",
          enum: ["url"],
          description: "Download source. Only 'url' is supported in v1; click-then-wait is not on this surface.",
        },
        url: { type: "string", description: "Direct URL to download. No schema length cap is enforced." },
        saveAs: {
          type: "string",
          description: "Optional relative filename or subdirectory under Downloads. Chrome enforces download-path restrictions and auto-uniquifies conflicts.",
        },
      },
    },
    capability: "browser_power",
    async handler(args: Record<string, unknown>, signal?: AbortSignal) {
      return dispatchBrowserTool("browser_download", args, signal)
    },
  },
  {
    toolNameHttp: "browser_mouse",
    description:
      "Moves, clicks, double-clicks, presses, or releases the mouse through real CDP Input.dispatchMouseEvent calls. It takes a tab id, action, exactly one target form (ref, selector, or x+y CSS viewport coordinates), and optional button, trajectory, and force settings. Use mouse for hover-to-reveal menus, canvas/map/image-map clicks, event.isTrusted checks, precise coordinate targeting, or low-level press/release sequences that browser_act cannot express. Prefer browser_act for ordinary element clicks and fills; by default ref/selector targets are hit-tested with elementFromPoint and fail with target_obscured unless force is true.",
    inputSchema: {
      type: "object",
      required: ["tabId", "action"],
      additionalProperties: false,
      properties: {
        tabId: { type: "number", description: "Tab id from browser_list_tabs or browser_open_tab." },
        action: {
          type: "string",
          enum: ["move", "click", "dblclick", "down", "up"],
          description: "Mouse action. move positions the cursor for hover; click sends press+release; dblclick sends two press/release cycles; down presses only; up releases only.",
        },
        ref: {
          type: "string",
          description: "Element ref from browser_read_page or browser_find. Resolves to bbox center. Exactly one of ref, selector, or x+y is required.",
        },
        selector: {
          type: "string",
          description: "CSS selector fallback. Resolves to bbox center. Exactly one of ref, selector, or x+y is required.",
        },
        x: {
          type: "number",
          description: "Target x in CSS viewport pixels. Pair with y. Use when working from a screenshot, canvas coordinate, or eval_js output.",
        },
        y: {
          type: "number",
          description: "Target y in CSS viewport pixels. Pair with x.",
        },
        button: {
          type: "string",
          enum: ["left", "right", "middle"],
          description: "Mouse button for click, dblclick, down, or up. Default 'left'. Ignored for action='move'.",
        },
        steps: {
          type: "number",
          description: "Trajectory step count. Values greater than 1 interpolate the cursor approach over multiple mouseMoved events. Default 1. Clamped to [1, 100].",
        },
        stepDelayMs: {
          type: "number",
          description: "Pause between interpolated mouseMoved events when steps is greater than 1. Default 8. Clamped to [0, 50].",
        },
        force: {
          type: "boolean",
          description: "For ref or selector targets, skips the elementFromPoint hit-test. Default false. Use only when an overlay covers the target but forwards pointer events.",
        },
      },
    },
    capability: "browser_power",
    async handler(args: Record<string, unknown>, signal?: AbortSignal) {
      return dispatchBrowserTool("browser_mouse", args, signal)
    },
  },
  {
    toolNameHttp: "browser_drag",
    description:
      "Drags from a source target to a destination target through CDP input events. It takes a tab id, one source target, one destination target, and optional button, trajectory, mode, and force settings; targets can be refs, selectors, or CSS viewport coordinates. Auto mode chooses HTML5 native drag-and-drop for draggable='true' sources, using Input.setInterceptDrags plus Input.dispatchDragEvent, and otherwise uses pointer drag events for libraries such as react-dnd, Sortable.js, and mouse-event-based handlers. Use drag for actual drag-and-drop interactions; use browser_mouse for simple clicks, hover, or isolated press/release gestures. Returns {ok: true, mode_used, from, to} so the caller can verify whether pointer or html5 ran and which coordinates were used.",
    inputSchema: {
      type: "object",
      required: ["tabId"],
      additionalProperties: false,
      properties: {
        tabId: { type: "number", description: "Tab id from browser_list_tabs or browser_open_tab." },
        fromRef: { type: "string", description: "Source element ref from browser_read_page or browser_find. Preferred when available." },
        fromSelector: { type: "string", description: "Source CSS selector fallback when no source ref is available." },
        fromX: { type: "number", description: "Source x in CSS viewport pixels. Pair with fromY." },
        fromY: { type: "number", description: "Source y in CSS viewport pixels. Pair with fromX." },
        toRef: { type: "string", description: "Destination element ref from browser_read_page or browser_find. Preferred when available." },
        toSelector: { type: "string", description: "Destination CSS selector fallback when no destination ref is available." },
        toX: { type: "number", description: "Destination x in CSS viewport pixels. Pair with toY." },
        toY: { type: "number", description: "Destination y in CSS viewport pixels. Pair with toX." },
        button: {
          type: "string",
          enum: ["left", "middle"],
          description: "Mouse button held during the drag. Default 'left'.",
        },
        steps: {
          type: "number",
          description: "Intermediate mouseMoved events from source to destination with the button held. Drag-detect libraries often need a trajectory. Default 15. Clamped to [1, 100].",
        },
        stepDelayMs: {
          type: "number",
          description: "Pause between intermediate moves in milliseconds. Default 12. Clamped to [0, 50].",
        },
        mode: {
          type: "string",
          enum: ["auto", "pointer", "html5"],
          description: "Drag mode. 'auto' is the default and picks html5 if the source has draggable='true', else pointer. Override only when auto detection chooses the wrong path.",
        },
        force: {
          type: "boolean",
          description: "Skips the pre-press elementFromPoint hit-test on the source only. Default false. The destination is used as-is.",
        },
      },
    },
    capability: "browser_power",
    async handler(args: Record<string, unknown>, signal?: AbortSignal) {
      return dispatchBrowserTool("browser_drag", args, signal)
    },
  },
  {
    toolNameHttp: "browser_type",
    description:
      "Types text into the currently focused element one character at a time via CDP Input.dispatchKeyEvent. It takes a tab id, text, and optional per-character delay; each character fires keyboard/input events, which supports autocomplete, chips, search-as-you-type fields, and handlers that listen on keydown rather than only reading element.value. Special text characters map to named keys: \\n sends Enter, \\t sends Tab, and \\b sends Backspace; other control characters below 0x20 are rejected with an actionable error. Use browser_type when real keystrokes matter, use browser_act with action='fill' for plain form-value entry, and use browser_keyboard for shortcuts or named control keys such as Control+L or Escape.",
    inputSchema: {
      type: "object",
      required: ["tabId", "text"],
      additionalProperties: false,
      properties: {
        tabId: { type: "number", description: "Tab id from browser_list_tabs or browser_open_tab. The text goes to whatever element is currently focused in that tab." },
        text: {
          type: "string",
          description: "Text to type, up to 4096 Unicode code points. Newline, tab, and backspace are dispatched as Enter, Tab, and Backspace.",
        },
        delayMs: {
          type: "number",
          description: "Pause between characters in milliseconds. Default 0. Clamped to [0, 50]. Set above 0 for debounced search-as-you-type inputs.",
        },
      },
    },
    capability: "browser_power",
    async handler(args: Record<string, unknown>, signal?: AbortSignal) {
      return dispatchBrowserTool("browser_type", args, signal)
    },
  },
  {
    toolNameHttp: "browser_diagnostics",
    description:
      "Drains buffered console messages or network responses for a tab, with filtering before the result is returned. It takes a tab id, kind='console' or 'network', and optional level, regex, and limit filters, then returns {kind, total, returned, entries}; total is the pre-filter count and returned is the post-filter limited count. The first call for a tab lazily attaches chrome.debugger, so very-early load events from before that call are missed. Use diagnostics to investigate console errors, warnings, and request URLs; do not use it as a page-content reader, and raise limit or loosen regex when returned equals the requested limit.",
    inputSchema: {
      type: "object",
      required: ["tabId", "kind"],
      additionalProperties: false,
      properties: {
        tabId: { type: "number", description: "Tab id from browser_list_tabs or browser_open_tab." },
        kind: {
          type: "string",
          enum: ["console", "network"],
          description: "Diagnostic stream to drain: console messages or network responses.",
        },
        level: {
          type: "string",
          enum: ["log", "info", "warn", "error", "debug", "all"],
          description: "Console only. Default 'all'. Ignored when kind='network'.",
        },
        regex: {
          type: "string",
          description: "Optional JavaScript regex source string. For console, matches message text; for network, matches request URL.",
        },
        limit: {
          type: "number",
          description: "Maximum entries to return after filtering. Default 100. Hard cap 1000.",
        },
      },
    },
    capability: "browser_power",
    async handler(args: Record<string, unknown>, signal?: AbortSignal) {
      const kind = args.kind === "network" ? "network" : "console"
      const tool = kind === "network" ? "browser_network_log" : "browser_console_logs"
      const tabId = typeof args.tabId === "number" ? args.tabId : undefined
      const level = typeof args.level === "string" ? args.level : "all"
      const regexStr = typeof args.regex === "string" ? args.regex : undefined
      const limit = typeof args.limit === "number" ? Math.min(1000, Math.max(1, args.limit)) : 100
      const env = await dispatchBrowserTool(tool, { tabId, level }, signal)
      if (env.isError) return env
      const text = env.content?.[0]?.text
      if (typeof text !== "string") return env
      let entries: Array<Record<string, unknown>>
      try {
        const parsed = JSON.parse(text) as unknown
        const arr = Array.isArray(parsed)
          ? parsed
          : Array.isArray((parsed as { entries?: unknown })?.entries)
            ? ((parsed as { entries: Array<unknown> }).entries)
            : []
        entries = arr.filter((e): e is Record<string, unknown> => typeof e === "object" && e !== null)
      } catch {
        return env
      }
      let filtered = entries
      if (regexStr) {
        try {
          const re = new RegExp(regexStr)
          const field = kind === "network" ? "url" : "text"
          filtered = filtered.filter((e) => {
            const v = e[field]
            return typeof v === "string" && re.test(v)
          })
        } catch {
          return toolEnvelope({ error: `invalid regex: ${regexStr}` }, true)
        }
      }
      const out = filtered.slice(0, limit)
      return toolEnvelope({ kind, total: entries.length, returned: out.length, entries: out })
    },
  },
  {
    toolNameHttp: "browser_find",
    description:
      "Finds up to 5 page elements that match a natural-language intent. It takes a tab id and intent, reads a fresh snapshot internally, and returns ranked candidates with refs, roles, names, bboxes, and match reasons when available. The returned refs can be passed to browser_act in REF mode or to low-level power tools such as browser_mouse. Use find when a specific element is needed and a short candidate list is better than the full browser_read_page snapshot; use read_page when broad enumeration or raw text/context is needed.",
    inputSchema: {
      type: "object",
      required: ["tabId", "intent"],
      additionalProperties: false,
      properties: {
        tabId: { type: "number", description: "Tab id from browser_list_tabs or browser_open_tab." },
        intent: {
          type: "string",
          description: "Natural-language description of the element to find, such as 'the search box at the top' or 'the Submit button'.",
        },
      },
    },
    // Compound tier keeps the ref producer with browser_act's ref/intent consumer.
    capability: "browser_compound",
    async handler(args: Record<string, unknown>, signal?: AbortSignal) {
      const tabId = typeof args.tabId === "number" ? args.tabId : undefined
      const intent = typeof args.intent === "string" ? args.intent : ""
      if (!tabId) return toolEnvelope({ error: "tabId required" }, true)
      if (!intent) return toolEnvelope({ error: "intent required" }, true)
      const snapshot = await fetchSnapshot(tabId, signal)
      const matches = await pickMatchingElements(snapshot, intent, signal)
      const indexed = new Map(snapshot.elements.map((e) => [e.ref, e]))
      const expanded = matches.map((m) => {
        const el = indexed.get(m.ref)
        return el
          ? { ref: m.ref, role: el.role, name: el.name, bbox: el.bbox, reason: m.reason }
          : { ref: m.ref, reason: m.reason }
      })
      return toolEnvelope({ matches: expanded })
    },
  },
  {
    toolNameHttp: "browser_act",
    description:
      "Performs a high-level click, fill, type, select, or scroll-into-view action against a tab. It has two modes: INTENT mode takes a natural-language intent and resolves the element/action internally, while REF mode takes a ref from browser_find or browser_read_page plus optional action and value for direct dispatch without a compressor round trip. Visual fallback can click canvas or SVG regions by combining screenshot analysis with a coordinate click when text-based matching fails. Use act for ordinary page interaction before reaching for browser_mouse, browser_type, browser_keyboard, or browser_scroll; single-action results include {ok, action_taken, target_ref, navigated}, multi-step intents return summary/steps fields, and visual fallback returns click_visual with x/y coordinates.",
    inputSchema: {
      type: "object",
      required: ["tabId"],
      additionalProperties: false,
      properties: {
        tabId: { type: "number", description: "Tab id from browser_list_tabs or browser_open_tab." },
        intent: {
          type: "string",
          description: "Natural-language description of the action for INTENT mode. If both intent and ref are provided, ref mode wins and intent is ignored.",
        },
        ref: {
          type: "string",
          description: "Element ref from browser_find or browser_read_page for REF mode, which dispatches directly without a compressor round trip.",
        },
        action: {
          type: "string",
          enum: ["click", "fill", "type", "select", "scroll_into_view"],
          description: "REF mode action. Defaults to 'click'. Ignored in INTENT mode, where the resolved action comes from the intent and matched element.",
        },
        value: {
          type: "string",
          description: "String value for fill, type, or select actions. In INTENT mode, this is available to the resolver when the action requires a value.",
        },
      },
    },
    // Compound tier keeps act with the compressor and ref-producing browser_find.
    capability: "browser_compound",
    async handler(args: Record<string, unknown>, signal?: AbortSignal) {
      const tabId = typeof args.tabId === "number" ? args.tabId : undefined
      if (!tabId) return toolEnvelope({ error: "tabId required" }, true)
      const refIn = typeof args.ref === "string" ? args.ref : undefined
      const intent = typeof args.intent === "string" ? args.intent : undefined
      const value = typeof args.value === "string" ? args.value : undefined
      if (!refIn && !intent) {
        return toolEnvelope({ error: "either `ref` (REF mode) or `intent` (INTENT mode) is required" }, true)
      }
      // REF mode: direct dispatch, zero compressor round-trip.
      if (refIn) {
        const actionIn = typeof args.action === "string" ? args.action : "click"
        return dispatchActionByRef(tabId, refIn, actionIn, value, signal)
      }
      // INTENT mode: decompose into atomic steps (login pattern,
      // search-and-click pattern, conjunctions, or single-step
      // fallback). Run each step through the matcher cascade
      // sequentially; on the FIRST failure of a multi-step compound,
      // surface the failed step's reason. (TODO: Phase 3c will
      // escalate the whole compound to a fast-model planner once on
      // failure rather than aborting at the first step.)
      const decomposed = decompose(intent!, value)
      if (decomposed.steps.length === 1) {
        // Single step: behaves exactly like pre-decompose browser_act.
        return runAtomicIntentStep(tabId, decomposed.steps[0].intent, decomposed.steps[0].value, signal)
      }
      // Multi-step compound: dispatch each step sequentially. Refresh
      // the snapshot between steps because each mutating action
      // invalidates the cache (Phase 1b hook). Aggregate into one
      // {ok, summary} envelope; lead model gets ONE response, not
      // one per step. On failure of any step in a multi-step
      // compound, escalate the WHOLE compound to the fast-model
      // replanner ONCE (Phase 3c) — bounds worst-case cost to one
      // fast-model call regardless of step count or compound depth.
      const summaries: string[] = []
      let navigated = false
      const completedSteps: typeof decomposed.steps = []
      for (let i = 0; i < decomposed.steps.length; i++) {
        const step = decomposed.steps[i]
        const env = await runAtomicIntentStep(tabId, step.intent, step.value, signal)
        const stepText = env.content?.[0]?.text
        let stepResult: Record<string, unknown> = {}
        if (typeof stepText === "string") {
          try { stepResult = JSON.parse(stepText) as Record<string, unknown> } catch { /* keep empty */ }
        }
        if (env.isError || stepResult.ok === false) {
          // Phase 3c: planner replan. Fetch a fresh snapshot of the
          // page state at the failure point, ask the fast model to
          // produce a revised step list, dispatch each replanned
          // step through the cascade. Strict cost cap: ONE planner
          // call per compound, no recursion (the replanned-step
          // failure path surfaces a clean error to the lead model).
          try {
            const failureReason = String(stepResult.error ?? "unknown")
            const freshSnapshot = await fetchSnapshot(tabId, signal)
            const replan = await planCompoundReplan({
              originalIntent: intent!,
              originalValue: value,
              completedSteps,
              failedStep: step,
              failureReason,
              snapshot: freshSnapshot,
            }, signal)
            if (replan.steps.length === 0) {
              return toolEnvelope({
                ok: false,
                summary: `compound step ${i + 1}/${decomposed.steps.length} failed and planner declined: ${replan.reasoning || failureReason}`,
                template: decomposed.template,
                steps_completed: i,
                failed_step: step.intent,
                planner_reasoning: replan.reasoning,
              }, true)
            }
            // Dispatch each replanned step. NO recursive replan on
            // failure here — the lead model gets a clean error if
            // the replan also fails.
            const replanSummaries: string[] = []
            for (let j = 0; j < replan.steps.length; j++) {
              const rstep = replan.steps[j]
              const renv = await runAtomicIntentStep(tabId, rstep.intent, rstep.value, signal)
              const rtext = renv.content?.[0]?.text
              let rresult: Record<string, unknown> = {}
              if (typeof rtext === "string") {
                try { rresult = JSON.parse(rtext) as Record<string, unknown> } catch { /* keep empty */ }
              }
              if (renv.isError || rresult.ok === false) {
                return toolEnvelope({
                  ok: false,
                  summary: `compound failed at original step ${i + 1}, planner replan also failed at step ${j + 1}/${replan.steps.length}: ${String(rresult.error ?? "unknown")}`,
                  template: decomposed.template,
                  steps_completed: i,
                  failed_step: rstep.intent,
                  planner_reasoning: replan.reasoning,
                }, true)
              }
              if (typeof rresult.action_taken === "string") {
                replanSummaries.push(`${rresult.action_taken} (${rstep.intent})`)
              }
              if (rresult.navigated === true) navigated = true
            }
            return toolEnvelope({
              ok: true,
              summary: `compound recovered via planner (${replan.reasoning}): ${replanSummaries.join(" → ")}`,
              template: decomposed.template,
              steps_completed: i + replan.steps.length,
              navigated,
              planner_used: true,
              planner_reasoning: replan.reasoning,
            })
          } catch (replanErr) {
            return toolEnvelope({
              ok: false,
              summary: `compound step ${i + 1}/${decomposed.steps.length} failed; planner errored: ${replanErr instanceof Error ? replanErr.message : String(replanErr)}`,
              template: decomposed.template,
              steps_completed: i,
              failed_step: step.intent,
            }, true)
          }
        }
        if (typeof stepResult.action_taken === "string") {
          summaries.push(`${stepResult.action_taken} (${step.intent})`)
        }
        if (stepResult.navigated === true) navigated = true
        completedSteps.push(step)
      }
      return toolEnvelope({
        ok: true,
        summary: decomposed.successSummary ?? summaries.join(" → "),
        template: decomposed.template,
        steps_completed: decomposed.steps.length,
        navigated,
      })
    },
  },
  {
    toolNameHttp: "browser_observe",
    description:
      "Produces a short natural-language description of the current page's user-actionable state, including visible forms, buttons, links, and content sections. It takes a tab id and optional intent focus, then returns a 2-4 sentence summary plus whether visualSurfaces such as canvas or SVG are present. Use observe before browser_act when the page state is unknown, or after navigation to confirm what loaded. Prefer observe over screenshot when text and controls are enough; switch to browser_screenshot for visual layout or canvas/SVG details, and use browser_read_page when raw refs, bboxes, or element lists are needed.",
    inputSchema: {
      type: "object",
      required: ["tabId"],
      additionalProperties: false,
      properties: {
        tabId: { type: "number", description: "Tab id from browser_list_tabs or browser_open_tab." },
        intent: {
          type: "string",
          description: "Optional natural-language focus for the summary, such as 'describe the form' or 'what is in the sidebar'.",
        },
      },
    },
    capability: "browser_compound",
    async handler(args: Record<string, unknown>, signal?: AbortSignal) {
      const tabId = typeof args.tabId === "number" ? args.tabId : undefined
      const intent = typeof args.intent === "string" ? args.intent : undefined
      if (!tabId) return toolEnvelope({ error: "tabId required" }, true)
      const snapshot = await fetchSnapshot(tabId, signal)
      const result = await observePage(snapshot, intent, signal)
      return toolEnvelope(result)
    },
  },
  {
    toolNameHttp: "browser_extract",
    description:
      "Extracts structured data from the current page into a JSON object matching the provided schema. It takes a tab id, a schema or schema-shaped descriptor, and a plain-language instruction; the inner compressor reads the page snapshot and returns only the typed object rather than the raw element list. Use extract when the desired output shape is known, such as rows of {title, author, url}; use browser_observe for a prose overview and browser_read_page when the lead model needs raw refs, bboxes, or page text. Bad schemas or wrong-shape compressor results are returned as fixable error envelopes so the caller can simplify the schema or clarify the instruction.",
    inputSchema: {
      type: "object",
      required: ["tabId", "schema", "instruction"],
      additionalProperties: false,
      properties: {
        tabId: { type: "number", description: "Tab id from browser_list_tabs or browser_open_tab." },
        schema: {
          description: "JSON schema, or a schema-shaped descriptor, for the desired output shape.",
        },
        instruction: {
          type: "string",
          description: "Plain-language extraction instruction, such as 'the visible PR list' or 'all product cards with price and URL'.",
        },
      },
    },
    capability: "browser_compound",
    async handler(args: Record<string, unknown>, signal?: AbortSignal) {
      const tabId = typeof args.tabId === "number" ? args.tabId : undefined
      const instruction = typeof args.instruction === "string" ? args.instruction : ""
      const schema = args.schema
      if (!tabId) return toolEnvelope({ error: "tabId required" }, true)
      if (!instruction) return toolEnvelope({ error: "instruction required" }, true)
      if (!schema) return toolEnvelope({ error: "schema required" }, true)
      const snapshot = await fetchSnapshot(tabId, signal)
      try {
        const extracted = await extractStructured(snapshot, schema, instruction, signal)
        return toolEnvelope(extracted)
      } catch (err) {
        // Surface compressor validation errors as clean isError envelopes
        // instead of leaking through as raw exceptions. Caller sees the
        // exact reason (bad schema vs wrong-shape result) and can fix
        // the call.
        if (err instanceof SchemaValidationError) {
          return toolEnvelope({ error: `invalid schema: ${err.message}` }, true)
        }
        if (err instanceof ResultShapeError) {
          return toolEnvelope({ error: `extraction produced wrong shape: ${err.message}` }, true)
        }
        throw err
      }
    },
  },
])

// ---------------------------------------------------------------------
// Compound-tool helpers
// ---------------------------------------------------------------------

/**
 * Run a single atomic intent step: fetch snapshot, run matcher
 * cascade (via pickElement), visual fallback on no-match, dispatch
 * the resolved action. Returns the standard MCP envelope.
 *
 * Pulled out of `browser_act`'s handler so the compound-intent loop
 * (decompose path) can call it per-step without duplicating the
 * snapshot + visual-fallback logic.
 */
async function runAtomicIntentStep(
  tabId: number,
  intent: string,
  value: string | undefined,
  signal?: AbortSignal,
): Promise<McpToolResult> {
  const snapshot = await fetchSnapshot(tabId, signal)
  const picked = await pickElement(snapshot, intent, signal, value)
  if (!picked.ref || picked.confidence < 0.5) {
    // No text-based match. Try visual fallback if a canvas / svg is in view.
    const surfaces = snapshot.visualSurfaces
    if (surfaces && surfaces.length > 0) {
      const shotEnv = await dispatchBrowserTool("browser_screenshot", { tabId, format: "png" }, signal)
      if (shotEnv.isError) {
        return toolEnvelope({ ok: false, error: "no text match; screenshot for visual fallback failed", picked }, true)
      }
      // The dispatcher hands back a real image block, so the pixels are read
      // straight off it. This used to JSON.parse the text envelope to recover
      // `dataBase64` — a round-trip that existed only because the envelope was
      // text-only, and which is now impossible to get wrong.
      const shot = shotEnv.content.find((b): b is McpImageBlock => b.type === "image")
      if (!shot) {
        return toolEnvelope({ ok: false, error: "no text match; screenshot returned no image" }, true)
      }
      const visual = await pickElementVisual(shot.data, shot.mimeType, intent, surfaces, signal)
      if (visual.confidence < 0.5) {
        return toolEnvelope({ ok: false, error: "no element matched intent (text + visual)", picked, visual }, true)
      }
      // Coord click via browser_mouse.
      const clickEnv = await dispatchBrowserTool(
        "browser_mouse",
        { tabId, action: "click", x: visual.x, y: visual.y, force: true },
        signal,
      )
      if (clickEnv.isError) return clickEnv
      return toolEnvelope({
        ok: true,
        action_taken: "click_visual",
        x: visual.x,
        y: visual.y,
        confidence: visual.confidence,
        reason: visual.reason,
      })
    }
    return toolEnvelope({ ok: false, error: "no element matched intent", picked }, true)
  }
  // Text-based match found. Dispatch.
  return dispatchActionByRef(tabId, picked.ref, picked.action, picked.value ?? value, signal)
}

/**
 * Dispatch an action against a known ref via the appropriate primitive.
 * Shared between REF mode and INTENT-mode-text-match in `browser_act`.
 * Returns an MCP envelope (text content + optional isError).
 */
async function dispatchActionByRef(
  tabId: number,
  ref: string,
  action: string,
  value: string | undefined,
  signal?: AbortSignal,
): Promise<McpToolResult> {
  let env: McpToolResult
  switch (action) {
    case "click":
      env = await dispatchBrowserTool("browser_click", { tabId, ref }, signal)
      break
    case "fill":
      env = await dispatchBrowserTool("browser_fill", { tabId, ref, value }, signal)
      break
    case "type":
      // browser_type targets the focused element; click ref first to focus.
      await dispatchBrowserTool("browser_click", { tabId, ref }, signal)
      env = await dispatchBrowserTool("browser_type", { tabId, text: value ?? "" }, signal)
      break
    case "select":
      env = await dispatchBrowserTool("browser_fill", { tabId, ref, value }, signal)
      break
    case "scroll_into_view":
      env = await dispatchBrowserTool("browser_scroll", { tabId, target: "element", ref }, signal)
      break
    default:
      return toolEnvelope({ ok: false, error: `unknown action: ${action}` }, true)
  }
  if (env.isError) return env
  const innerText = env.content?.[0]?.text
  let parsed: Record<string, unknown> = {}
  if (typeof innerText === "string") {
    try { parsed = JSON.parse(innerText) as Record<string, unknown> } catch { /* keep empty */ }
  }
  return toolEnvelope({
    ok: true,
    action_taken: action,
    target_ref: ref,
    navigated: typeof parsed.navigated === "boolean" ? parsed.navigated : undefined,
  })
}
