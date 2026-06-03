// policy.ts — bridge-layer URL block for tool-initiated nav.
//
// This regex is INTENTIONALLY WIDER than the extension-side regex in
// src/browser-ext/background.js. The bridge-side check only fires for
// browser_open_tab / browser_navigate tool calls (see
// preflightUrlPolicy below), so it can safely include `extensions`
// without locking the human user out of their own admin page. The
// extension-side check fires for ALL top-level navigations including
// user-typed URL bar entries (webNavigation.onBeforeNavigate doesn't
// distinguish initiator), so it must exclude `extensions` to preserve
// human access.
//
// Net result:
//   - model tool-navigates to chrome://extensions → blocked here
//   - user types chrome://extensions in URL bar → allowed
//   - in-page JS does window.location = "chrome://extensions" →
//     allowed (we accept this narrow surface to keep the extension
//     listener simple; opening the page grants no privilege)

const BLOCKED_URL_RE =
  /^(chrome|edge|brave|opera|vivaldi):\/\/(settings|preferences|extensions|policy|management|password|flags|flag-descriptions)/i

const BLOCKED_VIEW_SOURCE_RE =
  /^view-source:(chrome|edge):\/\/(settings|extensions)/i

const BLOCKED_OPTIONS_HTML_RE =
  /^(chrome|edge)-extension:\/\/.*\/(options|popup)\.html/i

const FILE_URL_RE = /^file:/i

export interface PolicyVerdict {
  blocked: boolean
  reason?: string
}

export function checkUrlPolicy(url: unknown): PolicyVerdict {
  if (typeof url !== "string" || url.length === 0) {
    return { blocked: false }
  }
  if (BLOCKED_URL_RE.test(url) || BLOCKED_VIEW_SOURCE_RE.test(url)) {
    return {
      blocked: true,
      reason:
        "Browser-internal pages (settings / preferences / extensions / flags / passwords) are not accessible to the browser MCP. devtools:// is allowed.",
    }
  }
  if (BLOCKED_OPTIONS_HTML_RE.test(url)) {
    return {
      blocked: true,
      reason:
        "Extension options / popup pages are not accessible to the browser MCP.",
    }
  }
  if (FILE_URL_RE.test(url) && process.env.GH_ROUTER_BROWSER_ALLOW_FILE_URLS !== "1") {
    return {
      blocked: true,
      reason:
        "file:// URLs are blocked by default. Set GH_ROUTER_BROWSER_ALLOW_FILE_URLS=1 to enable.",
    }
  }
  return { blocked: false }
}

/**
 * Tools whose arguments include URL fields the bridge-layer policy
 * applies to. Other tools (screenshot, click, etc.) operate on a tabId
 * the model already opened, so the URL was already vetted at open time.
 */
export interface UrlPolicyArgs {
  url?: unknown
}

/**
 * Extract URL fields from a tool call's arguments. Returns the first
 * URL that violates policy, or undefined if all clear. Currently checks
 * the `url` field (used by browser_open_tab + browser_navigate).
 */
export function preflightUrlPolicy(
  toolName: string,
  args: UrlPolicyArgs,
): PolicyVerdict {
  if (toolName !== "browser_open_tab" && toolName !== "browser_navigate") {
    return { blocked: false }
  }
  return checkUrlPolicy(args.url)
}
