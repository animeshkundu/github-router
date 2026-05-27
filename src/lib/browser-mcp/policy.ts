// policy.ts — bridge-layer URL block (defense in depth).
//
// The extension's webNavigation.onBeforeNavigate listener is the
// authoritative block: it catches both tool-initiated navigations and
// in-page-initiated ones (JS redirect, meta-refresh). The bridge layer
// adds a second, server-side check on tool arguments BEFORE the call
// forwards to the extension, so an extension regression that silently
// re-enables a dangerous URL still fails closed.
//
// Mirror this regex in src/browser-ext/background.js' isBlockedUrl to
// keep the two layers in sync. The bridge-side regex is the source of
// truth for tests; the extension regex is a duplicate-on-purpose so
// the SW doesn't need a network round-trip to know the policy.

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
