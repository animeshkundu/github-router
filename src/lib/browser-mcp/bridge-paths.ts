import { homedir } from "node:os"
import path from "node:path"

/**
 * Filesystem path where the browser bridge writes its discovery file
 * (`{pid, port, token, startedAt}`) and where the install-check reads
 * it from. Used by `src/browser-bridge/index.ts` (writer) AND by
 * `src/lib/browser-mcp/install-check.ts` (reader).
 *
 * MUST be a single computation. Historically the bridge special-cased
 * win32 to `%LOCALAPPDATA%\github-router` while the install-check used
 * `~/.local/share/github-router` (the canonical `PATHS.APP_DIR` from
 * `src/lib/paths.ts`, which has no win32 branch). On Windows the
 * writer and reader never met, so the install-check returned
 * `bridge_not_running` even with a healthy bridge. Centralized here so
 * the regression test in `tests/browser-bridge-discovery-path.test.ts`
 * can pin the round-trip.
 *
 * Mirrors `PATHS.APP_DIR` from `src/lib/paths.ts` (XDG-style on every
 * platform). The bridge bundle pulls this file in via tsdown's
 * relative-import bundling; no runtime dependency on `src/lib/paths.ts`
 * is introduced.
 */
export function discoveryPath(): string {
  return path.join(
    homedir(),
    ".local",
    "share",
    "github-router",
    "browser-mcp",
    "bridge.json",
  )
}
