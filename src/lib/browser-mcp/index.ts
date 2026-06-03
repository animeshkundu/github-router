import { dispatchBrowserTool } from "./dispatch"

import type { NonPersonaMcpTool } from "~/lib/peer-mcp-personas"

/**
 * Browser-control MCP tools (`browser_*`). All entries route through
 * `dispatchBrowserTool()` which (1) runs the bridge-layer URL policy
 * check, (2) runs the install-check pre-flight (returning structured
 * install_required JSON when the bridge or extension isn't ready),
 * and (3) opens a WS to the bridge, sends the tool call, awaits the
 * response with a per-tool timeout.
 *
 * Each entry carries `capability: "browser"` so `browserToolsEnabled()`
 * in `src/routes/mcp/handler.ts` drops them at both list-time and
 * call-time when the operator hasn't opted in via `--browse` or
 * `GH_ROUTER_ENABLE_BROWSE=1`.
 *
 * v1 surface: 19 tools (Phases 3 + 4a + 4b + humanlike input v2).
 */
export const BROWSER_TOOLS: ReadonlyArray<NonPersonaMcpTool> = Object.freeze([
  {
    toolNameHttp: "browser_list_tabs",
    description:
      "List all open tabs across all browser windows. Returns each tab's id (used by other browser_* tools), URL, title, active flag, and window id.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {},
    },
    capability: "browser",
    async handler(args: Record<string, unknown>, signal?: AbortSignal) {
      return dispatchBrowserTool("browser_list_tabs", args, signal)
    },
  },
  {
    toolNameHttp: "browser_open_tab",
    description:
      "Open a URL in a new browser tab and wait for the page to finish loading. Returns the new tab's id, final URL after redirects, and HTTP status. Refuses to navigate to browser-internal settings / preferences / extensions / flags pages (returns {blocked: true, reason}); devtools://* is allowed.",
    inputSchema: {
      type: "object",
      required: ["url"],
      additionalProperties: false,
      properties: {
        url: {
          type: "string",
          description:
            "The URL to load. Maximum 8 KB. Settings / preferences / extensions / flags pages are blocked.",
        },
        reuseActive: {
          type: "boolean",
          description:
            "When true, navigate the currently active tab instead of opening a new one. Default false.",
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
    description: "Close one or more tabs by tab id.",
    inputSchema: {
      type: "object",
      required: ["tabIds"],
      additionalProperties: false,
      properties: {
        tabIds: {
          type: "array",
          items: { type: "number" },
          description: "Array of tab ids to close (from browser_list_tabs).",
        },
      },
    },
    capability: "browser",
    async handler(args: Record<string, unknown>, signal?: AbortSignal) {
      return dispatchBrowserTool("browser_close_tab", args, signal)
    },
  },
  {
    toolNameHttp: "browser_navigate",
    description:
      "Navigate an existing tab: goto a URL, go back, go forward, or reload. Same URL-blocking policy as browser_open_tab.",
    inputSchema: {
      type: "object",
      required: ["tabId", "action"],
      additionalProperties: false,
      properties: {
        tabId: { type: "number", description: "Tab id from browser_list_tabs / browser_open_tab." },
        action: {
          type: "string",
          enum: ["goto", "back", "forward", "reload"],
          description: "The navigation action.",
        },
        url: { type: "string", description: "Required when action=goto. Max 8 KB." },
        hard: {
          type: "boolean",
          description: "Reload only: bypass cache (Ctrl+Shift+R behavior). Default false.",
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
      "Capture a PNG screenshot of the visible area of a tab. Returns base64-encoded image bytes plus contentType. The tab must be active in its window; this tool auto-activates if needed.",
    inputSchema: {
      type: "object",
      required: ["tabId"],
      additionalProperties: false,
      properties: {
        tabId: { type: "number", description: "Tab id from browser_list_tabs / browser_open_tab." },
        format: {
          type: "string",
          enum: ["png", "jpeg"],
          description: "Image format. Default 'png'.",
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
      "Compressed page snapshot for the model: visible text, interactive elements with stable refs, viewport metadata, and (when present) `visualSurfaces` listing canvas / svg regions that need vision. Each element entry carries `bbox: [x, y, w, h]` in CSS viewport pixels (same coord space as browser_mouse / drag / scroll-at-pointer). Refs (e.g. `e42`) are stable for the lifetime of one read_page snapshot and are the preferred input to follow-up actions over brittle CSS selectors. The `viewport` block (`width`, `height`, `devicePixelRatio`, `scrollX`, `scrollY`) lets you map CSS-px bbox to device-px pixels for browser_screenshot. Mode controls what ships back: `summary` (default, ~5-15 KB) returns only viewport-visible elements/text and drops nameless non-interactive nodes; `full` returns up to 200 elements + 256 KiB of innerText (the legacy behavior — use only when you need off-screen content unscrolled). PREFER browser_act / browser_find for intent-driven interaction; read_page is the lower-level snapshot when you need to enumerate.",
    inputSchema: {
      type: "object",
      required: ["tabId"],
      additionalProperties: false,
      properties: {
        tabId: { type: "number", description: "Tab id from browser_list_tabs / browser_open_tab." },
        mode: {
          type: "string",
          enum: ["summary", "full"],
          description: "Snapshot scope. Default 'summary' returns viewport-visible elements + text capped at 20 KiB. 'full' returns up to 200 interactive elements page-wide + 256 KiB of innerText.",
        },
      },
    },
    capability: "browser",
    async handler(args: Record<string, unknown>, signal?: AbortSignal) {
      return dispatchBrowserTool("browser_read_page", args, signal)
    },
  },
  {
    toolNameHttp: "browser_click",
    description:
      "Click an element by ref (from a prior browser_read_page) or CSS selector. Returns {ok, navigated} where navigated=true if the URL changed within ~300ms of the click.",
    inputSchema: {
      type: "object",
      required: ["tabId"],
      additionalProperties: false,
      properties: {
        tabId: { type: "number" },
        ref: { type: "string", description: "Element ref from browser_read_page (preferred)." },
        selector: { type: "string", description: "CSS selector (fallback when no ref)." },
        button: { type: "string", enum: ["left", "right"], description: "Mouse button. Default 'left'." },
        clickCount: { type: "number", description: "Number of times to click. Default 1." },
      },
    },
    capability: "browser",
    async handler(args: Record<string, unknown>, signal?: AbortSignal) {
      return dispatchBrowserTool("browser_click", args, signal)
    },
  },
  {
    toolNameHttp: "browser_fill",
    description:
      "Type into an input / textarea, select from a dropdown, or toggle a checkbox / radio. Dispatches native input and change events so React-style controlled inputs see the value.",
    inputSchema: {
      type: "object",
      required: ["tabId", "value"],
      additionalProperties: false,
      properties: {
        tabId: { type: "number" },
        ref: { type: "string", description: "Element ref from browser_read_page (preferred)." },
        selector: { type: "string", description: "CSS selector (fallback when no ref)." },
        value: {
          description:
            "The value to set. String for inputs / textareas / select option value. Boolean for checkbox / radio. Max 1 MB.",
        },
        clearFirst: {
          type: "boolean",
          description: "Clear the input before typing (default true). No effect on select / checkbox.",
        },
        pressEnter: {
          type: "boolean",
          description:
            "After typing, dispatch Enter keydown / keyup and call form.requestSubmit if available. Default false.",
        },
      },
    },
    capability: "browser",
    async handler(args: Record<string, unknown>, signal?: AbortSignal) {
      return dispatchBrowserTool("browser_fill", args, signal)
    },
  },
  {
    toolNameHttp: "browser_scroll",
    description:
      "Scroll a tab. Five modes: top / bottom of the page, by an absolute pixel delta, to a specific element (by ref), or wheel-scroll a sub-region at a pointer location ('at-pointer' — the path that works for chat windows / infinite-scroll lists / modal bodies that don't respond to window.scrollTo because they have their own scroll container).",
    inputSchema: {
      type: "object",
      required: ["tabId", "target"],
      additionalProperties: false,
      properties: {
        tabId: { type: "number" },
        target: {
          type: "string",
          enum: ["top", "bottom", "pixels", "element", "at-pointer"],
          description: "Scroll target type.",
        },
        pixels: {
          type: "number",
          description: "Pixel delta when target=pixels. Positive scrolls down, negative scrolls up.",
        },
        ref: {
          type: "string",
          description: "Element ref. For target=element, scrolls so the element is centered. For target=at-pointer, resolves to the bbox center as the wheel position.",
        },
        selector: {
          type: "string",
          description: "CSS selector. For target=at-pointer, fallback when no ref. Resolves to bbox center.",
        },
        x: {
          type: "number",
          description: "Pointer x (CSS viewport px) for target=at-pointer. Pair with y. Exactly one of (ref, selector, or x+y) is required for at-pointer.",
        },
        y: {
          type: "number",
          description: "Pointer y (CSS viewport px) for target=at-pointer. Pair with x.",
        },
        deltaX: {
          type: "number",
          description: "Wheel delta x (CSS px) for target=at-pointer. Default 0. Clamped to |10000|.",
        },
        deltaY: {
          type: "number",
          description: "Wheel delta y (CSS px) for target=at-pointer. Positive scrolls down. Default 0. Clamped to |10000|. At least one of deltaX/deltaY must be non-zero.",
        },
        force: {
          type: "boolean",
          description: "Skip the pre-wheel elementFromPoint hit-test for target=at-pointer. Default false. Set true when an overlay covers the target but forwards wheel events.",
        },
      },
    },
    capability: "browser",
    async handler(args: Record<string, unknown>, signal?: AbortSignal) {
      return dispatchBrowserTool("browser_scroll", args, signal)
    },
  },
  {
    toolNameHttp: "browser_keyboard",
    description:
      "Send a keystroke or chord to the focused element. Use 'Control+L' / 'Command+L' for browser shortcuts, single characters for typing. Uses chrome.debugger so browser-level shortcuts (Ctrl+T, Ctrl+W, etc) actually fire.",
    inputSchema: {
      type: "object",
      required: ["tabId", "keys"],
      additionalProperties: false,
      properties: {
        tabId: { type: "number" },
        keys: {
          type: "string",
          description: "Key or chord. Modifiers (Control, Alt, Shift, Meta / Command) joined with '+'. Example: 'Control+L'.",
        },
      },
    },
    capability: "browser",
    async handler(args: Record<string, unknown>, signal?: AbortSignal) {
      return dispatchBrowserTool("browser_keyboard", args, signal)
    },
  },
  {
    toolNameHttp: "browser_wait",
    description:
      "Wait for an element to appear (until='selector'), the tab URL to match a regex (until='url'), or the network to go idle (until='networkIdle' - heuristic: tab status complete + 500ms quiet). Returns {ok: true, elapsedMs} on success, {ok: false, reason: 'timeout'} on miss.",
    inputSchema: {
      type: "object",
      required: ["tabId", "until"],
      additionalProperties: false,
      properties: {
        tabId: { type: "number" },
        until: {
          type: "string",
          enum: ["selector", "url", "networkIdle"],
          description: "What to wait for.",
        },
        selector: { type: "string", description: "CSS selector when until=selector." },
        urlPattern: { type: "string", description: "JS regex (string form) when until=url." },
        timeoutMs: {
          type: "number",
          description: "Max wait. Default 10000, hard cap 60000.",
        },
      },
    },
    capability: "browser",
    async handler(args: Record<string, unknown>, signal?: AbortSignal) {
      return dispatchBrowserTool("browser_wait", args, signal)
    },
  },
  {
    toolNameHttp: "browser_eval_js",
    description:
      "Evaluate a JavaScript expression in the tab's main world (equivalent to typing in the DevTools console). Returns {result} or {error}. Awaits promises returned by the expression. Single narrowly-named escape hatch for behaviors the other tools don't cover.",
    inputSchema: {
      type: "object",
      required: ["tabId", "expression"],
      additionalProperties: false,
      properties: {
        tabId: { type: "number" },
        expression: {
          type: "string",
          description: "JS expression. Max 100 KB. Top-level await NOT supported - wrap in (async () => ...)().",
        },
        timeoutMs: {
          type: "number",
          description: "Max evaluation time. Default 5000, hard cap 30000.",
        },
      },
    },
    capability: "browser",
    async handler(args: Record<string, unknown>, signal?: AbortSignal) {
      return dispatchBrowserTool("browser_eval_js", args, signal)
    },
  },
  {
    toolNameHttp: "browser_download",
    description:
      "Trigger a download by URL and wait for it to complete. Returns {downloadId, path, bytes, mimeType}. The file lands in Chrome's default Downloads dir unless saveAs is given.",
    inputSchema: {
      type: "object",
      required: ["tabId", "url"],
      additionalProperties: false,
      properties: {
        tabId: { type: "number", description: "Tab id is logged but the download itself is window-scoped, not tab-scoped." },
        source: {
          type: "string",
          enum: ["url"],
          description: "Download source. Only 'url' supported in v1; click-then-wait awaits Phase 5.",
        },
        url: { type: "string", description: "Direct URL to download. Max 8 KB." },
        saveAs: {
          type: "string",
          description: "Optional filename / relative subdir under Downloads. Conflicts auto-uniquify.",
        },
      },
    },
    capability: "browser",
    async handler(args: Record<string, unknown>, signal?: AbortSignal) {
      return dispatchBrowserTool("browser_download", args, signal)
    },
  },
  {
    toolNameHttp: "browser_console_logs",
    description:
      "Drain console messages a tab has emitted since the last call. The first call for a tab attaches chrome.debugger and starts capturing, so very-early-load messages from before the first call are missed; subsequent calls return everything since the previous drain. Buffer is capped at 1000 entries per tab.",
    inputSchema: {
      type: "object",
      required: ["tabId"],
      additionalProperties: false,
      properties: {
        tabId: { type: "number" },
        level: {
          type: "string",
          enum: ["log", "info", "warn", "error", "debug", "all"],
          description: "Filter by console level. Default 'all'.",
        },
      },
    },
    capability: "browser",
    async handler(args: Record<string, unknown>, signal?: AbortSignal) {
      return dispatchBrowserTool("browser_console_logs", args, signal)
    },
  },
  {
    toolNameHttp: "browser_network_log",
    description:
      "Drain network responses a tab has received since the last call. Same lazy-attach + cap-1000 behavior as browser_console_logs. Returns request URL, method, status, mime type, and timestamp per entry.",
    inputSchema: {
      type: "object",
      required: ["tabId"],
      additionalProperties: false,
      properties: {
        tabId: { type: "number" },
      },
    },
    capability: "browser",
    async handler(args: Record<string, unknown>, signal?: AbortSignal) {
      return dispatchBrowserTool("browser_network_log", args, signal)
    },
  },
  {
    toolNameHttp: "browser_mouse",
    description:
      "Move / click / hover / press / release the mouse via real CDP input events (Input.dispatchMouseEvent). Use this when you need behavior that synthetic .click() can't trigger: hover-to-reveal menus, canvas / map / image-map clicks, sites that check event.isTrusted, or precise coordinate targeting. Target with ref (from browser_read_page), CSS selector, or (x, y) in CSS viewport pixels — exactly one. action='move' is the hover (single mouseMoved fires :hover and pointerover reliably). action='dblclick' sends two press/release cycles with incrementing clickCount (a real double-click, not one cycle with clickCount=2). By default the target is hit-tested with elementFromPoint and the call fails with `target_obscured` if the topmost element isn't the target or a descendant — pass force:true to bypass when you know an overlay forwards events.",
    inputSchema: {
      type: "object",
      required: ["tabId", "action"],
      additionalProperties: false,
      properties: {
        tabId: { type: "number" },
        action: {
          type: "string",
          enum: ["move", "click", "dblclick", "down", "up"],
          description: "What to do. move=position cursor (hover). click=press+release. dblclick=two press+release with clickCount 1 then 2. down=press only. up=release only.",
        },
        ref: {
          type: "string",
          description: "Element ref from browser_read_page (preferred). Resolves to bbox center. Exactly one of ref / selector / (x+y) required.",
        },
        selector: {
          type: "string",
          description: "CSS selector (fallback). Resolves to bbox center.",
        },
        x: {
          type: "number",
          description: "Target x in CSS viewport pixels. Pair with y. Use when working from a screenshot or eval_js output.",
        },
        y: {
          type: "number",
          description: "Target y in CSS viewport pixels. Pair with x.",
        },
        button: {
          type: "string",
          enum: ["left", "right", "middle"],
          description: "Mouse button for click / dblclick / down / up. Default 'left'. Ignored for action=move.",
        },
        steps: {
          type: "number",
          description: "Humanlike trajectory. >1 interpolates the cursor approach over N mouseMoved events. Default 1 (teleport). Clamped to [1, 100].",
        },
        stepDelayMs: {
          type: "number",
          description: "Pause between interpolated mouseMoved events when steps > 1. Default 8. Clamped to [0, 50].",
        },
        force: {
          type: "boolean",
          description: "Skip the pre-click elementFromPoint hit-test (ref/selector mode only). Default false.",
        },
      },
    },
    capability: "browser",
    async handler(args: Record<string, unknown>, signal?: AbortSignal) {
      return dispatchBrowserTool("browser_mouse", args, signal)
    },
  },
  {
    toolNameHttp: "browser_drag",
    description:
      "Drag from a source to a destination. Auto-detects whether to use HTML5 native DnD (for elements with draggable='true', via CDP Input.setInterceptDrags + Input.dispatchDragEvent — the only path that triggers Chromium's native dragstart pipeline) or pointer-based DnD (for react-dnd / Sortable.js / mouse-event-based drag handlers — via CDP mouse events with buttons:1 held throughout). Each of from/to can be a ref (preferred), a CSS selector, or x+y coordinates. Returns { ok: true, mode_used: 'pointer'|'html5' } so you can verify which path ran.",
    inputSchema: {
      type: "object",
      required: ["tabId"],
      additionalProperties: false,
      properties: {
        tabId: { type: "number" },
        fromRef: { type: "string", description: "Source ref from browser_read_page (preferred)." },
        fromSelector: { type: "string", description: "Source CSS selector (fallback)." },
        fromX: { type: "number", description: "Source x in CSS viewport pixels. Pair with fromY." },
        fromY: { type: "number", description: "Source y in CSS viewport pixels. Pair with fromX." },
        toRef: { type: "string", description: "Destination ref from browser_read_page (preferred)." },
        toSelector: { type: "string", description: "Destination CSS selector (fallback)." },
        toX: { type: "number", description: "Destination x in CSS viewport pixels. Pair with toY." },
        toY: { type: "number", description: "Destination y in CSS viewport pixels. Pair with toX." },
        button: {
          type: "string",
          enum: ["left", "middle"],
          description: "Mouse button held during drag. Default 'left'.",
        },
        steps: {
          type: "number",
          description: "Intermediate mouseMoved events from→to with the button held. Drag-detect libraries need a trajectory to fire. Default 15. Clamped to [1, 100].",
        },
        stepDelayMs: {
          type: "number",
          description: "Pause between intermediate moves. Default 12. Clamped to [0, 50].",
        },
        mode: {
          type: "string",
          enum: ["auto", "pointer", "html5"],
          description: "Drag mode. 'auto' (default) picks html5 if the source has draggable='true', else pointer. Override only when auto detection misses.",
        },
        force: {
          type: "boolean",
          description: "Skip the pre-press elementFromPoint hit-test on the source. Default false.",
        },
      },
    },
    capability: "browser",
    async handler(args: Record<string, unknown>, signal?: AbortSignal) {
      return dispatchBrowserTool("browser_drag", args, signal)
    },
  },
  {
    toolNameHttp: "browser_type",
    description:
      "Type a string into the currently-focused element per-keystroke via CDP Input.dispatchKeyEvent. Each character fires keydown + keypress + input — this is the tool for keystroke-driven autocomplete, chips, search-as-you-type, and any site whose handlers listen on keydown rather than just reading element.value. For plain form-value entry use browser_fill (faster, sets value directly). For chord shortcuts (Control+L, etc) use browser_keyboard. Special characters in text: \\n→Enter, \\t→Tab, \\b→Backspace (dispatched as the named key, not as a literal control char). Other control chars (< 0x20) are rejected with an actionable error. Uppercase letters come from the natural code point — event.shiftKey is false but the typed value is correct.",
    inputSchema: {
      type: "object",
      required: ["tabId", "text"],
      additionalProperties: false,
      properties: {
        tabId: { type: "number" },
        text: {
          type: "string",
          description: "The text to type. Max 4096 chars. Iterates as Unicode code points (surrogate pairs handled correctly).",
        },
        delayMs: {
          type: "number",
          description: "Pause between characters. Default 0. Clamped to [0, 50]. Set > 0 when typing into search-as-you-type inputs that debounce.",
        },
      },
    },
    capability: "browser",
    async handler(args: Record<string, unknown>, signal?: AbortSignal) {
      return dispatchBrowserTool("browser_type", args, signal)
    },
  },
  {
    toolNameHttp: "browser_locate",
    description:
      "Resolve a single ref or selector to bounding box + hit-test metadata, without a full browser_read_page snapshot. Cheap — one in-page script call. Returns bbox (CSS viewport px), center, inView (bbox intersects viewport), visible (display/visibility/opacity > 0 and bbox > 0), computed pointer-events, viewport metadata, and topmostAtCenter (is the element at the bbox center actually this target, or is it occluded by an overlay?). Use this before browser_mouse / browser_drag to detect overlay-occluded targets, or to check whether something scrolled out of view.",
    inputSchema: {
      type: "object",
      required: ["tabId"],
      additionalProperties: false,
      properties: {
        tabId: { type: "number" },
        ref: {
          type: "string",
          description: "Element ref from browser_read_page (preferred). Exactly one of ref / selector required.",
        },
        selector: {
          type: "string",
          description: "CSS selector (fallback).",
        },
      },
    },
    capability: "browser",
    async handler(args: Record<string, unknown>, signal?: AbortSignal) {
      return dispatchBrowserTool("browser_locate", args, signal)
    },
  },
])
