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
 * v1 surface: 15 tools (Phases 3 + 4a + 4b).
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
      "Extract rendered page text plus the list of interactive elements (refs, roles, names, bounding boxes). Element refs returned here are intended as the input to a follow-up browser_click / browser_fill / browser_scroll — preferred over CSS selectors because refs are stable across dynamic class names. Text is capped at 256 KiB.",
    inputSchema: {
      type: "object",
      required: ["tabId"],
      additionalProperties: false,
      properties: {
        tabId: { type: "number", description: "Tab id from browser_list_tabs / browser_open_tab." },
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
      "Scroll a tab to the top, to the bottom, by a pixel amount, or to a specific element by ref.",
    inputSchema: {
      type: "object",
      required: ["tabId", "target"],
      additionalProperties: false,
      properties: {
        tabId: { type: "number" },
        target: {
          type: "string",
          enum: ["top", "bottom", "pixels", "element"],
          description: "Scroll target type.",
        },
        pixels: {
          type: "number",
          description: "Pixel delta when target=pixels. Positive scrolls down, negative scrolls up.",
        },
        ref: {
          type: "string",
          description: "Element ref when target=element. Scrolls so the element is centered in the viewport.",
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
])
