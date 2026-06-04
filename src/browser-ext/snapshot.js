// snapshot.js — extension-side snapshot pipeline for the deterministic-
// first browser MCP refactor.
//
// Phase 1b ships the CACHE + INVALIDATION infrastructure with the legacy
// `document.querySelectorAll`-based extraction still doing the actual
// work (delegated back to background.js). Phase 1b-CDP (next commit)
// swaps the extractor for a CDP `Accessibility.getFullAXTree`-based
// implementation that auto-stitches Shadow DOM + cross-origin iframes
// and populates the rich state fields the matcher cascade needs.
//
// Public surface:
//   captureSnapshot(tabId, opts)   - extract a fresh snapshot (writes cache)
//   getCachedSnapshot(tabId)       - read-through cache, undefined on miss
//   invalidateSnapshot(tabId, reason) - clear cache for a tab
//   anyCachedSnapshots()           - cheap predicate (cache-hit early-exit)
//
// Cache invalidation is action-driven, not time-driven. Mutating tools
// (click / fill / type / keyboard / scroll / mouse / drag) flag
// `mutatesPage: true` in the dispatcher; that flag triggers an
// invalidation in the success path. Navigation + tab-close trigger
// invalidations via the listeners registered alongside the existing
// debugger.onDetach / tabs.onRemoved handlers in background.js.

const cache = new Map() // tabId -> PageSnapshot
// Debug logging is off by default. Flip via globalThis.__GH_ROUTER_DEBUG_SNAPSHOT
// = true from the extension's service-worker console for ad-hoc tracing.
// Avoids depending on process.env (not available in extension context)
// or chrome.storage (sync I/O on the hot path).
function isDebug() {
  return Boolean(globalThis.__GH_ROUTER_DEBUG_SNAPSHOT)
}

/**
 * Read-through cache lookup. Returns undefined on miss.
 */
export function getCachedSnapshot(tabId) {
  return cache.get(tabId)
}

/**
 * True if any tab currently has a cached snapshot. Used by the matcher
 * cascade's fast-path bypass — when nothing is cached, no point
 * consulting per-tab state.
 */
export function anyCachedSnapshots() {
  return cache.size > 0
}

/**
 * Drop the cache entry for a tab. `reason` is logged when the debug
 * channel is on; helps diagnose "why is my cache cold?" without a
 * breakpoint. Idempotent — calling on a missing tabId is a no-op.
 */
export function invalidateSnapshot(tabId, reason) {
  if (!cache.has(tabId)) return
  cache.delete(tabId)
  if (isDebug()) {
    console.debug(`[browser-mcp/snapshot] invalidated tab ${tabId} (${reason})`)
  }
}

/**
 * Drop every cached snapshot. Used on bridge / extension restart paths.
 */
export function clearAllSnapshots() {
  cache.clear()
}

/**
 * Capture a fresh snapshot. The extractor is passed in by the caller so
 * this module stays decoupled from the specific extraction strategy —
 * legacy DOM walker today, CDP a11y tree once Phase 1b-CDP lands. The
 * extractor function receives `(tabId, opts)` and returns a
 * `PageSnapshot`-shaped object.
 *
 * The captured snapshot is written to the cache before being returned,
 * so a follow-up `getCachedSnapshot(tabId)` in the same turn is a hit.
 * Caller passes `refresh: true` in opts to force a re-capture (the
 * snapshot is still written through the cache).
 */
export async function captureSnapshot(tabId, opts, extractor) {
  if (typeof tabId !== "number") {
    throw new Error("snapshot.captureSnapshot: tabId must be a number")
  }
  if (typeof extractor !== "function") {
    throw new Error("snapshot.captureSnapshot: extractor must be a function")
  }
  const refresh = opts?.refresh === true
  if (!refresh) {
    const cached = cache.get(tabId)
    if (cached) return cached
  }
  const snapshot = await extractor(tabId, opts)
  // Normalize: ensure tabId + capturedAt are populated even when the
  // extractor doesn't supply them, so downstream consumers can rely on
  // these without optional-chaining.
  snapshot.tabId = tabId
  snapshot.capturedAt = Date.now()
  cache.set(tabId, snapshot)
  return snapshot
}
