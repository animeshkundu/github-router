/**
 * Disk-backed TTL cache for the EDITOR IDENTITY versions the proxy sends
 * upstream: the VS Code version (`editor-version`) and the Copilot Chat
 * extension version (`editor-plugin-version`), see `src/lib/api-config.ts`.
 *
 * Why this exists: impersonating VS Code is non-negotiable — Copilot is
 * addressed as if by the real editor, so those headers must carry real,
 * current versions. But the two lookups are NETWORK calls to third parties
 * (the Arch AUR PKGBUILD and the VS Marketplace), and they sat on the
 * blocking launch path of EVERY invocation. The AUR fetch alone measured
 * ~1.5-1.8s, which every `github-router` process paid — including the
 * per-turn Claude Code hooks (`internal-prompt-submit`, `internal-stop-hook`,
 * …), each of which is a fresh `node dist/main.js` spawn.
 *
 * The fix is a cache, NOT a removal. Both fetches are still made; they are
 * just made at most once per `TTL_HOURS` instead of once (twice, before the
 * duplicate top-level await in `get-vscode-version.ts` was dropped) per
 * launch. A 12h TTL keeps the impersonated versions well inside the real
 * editor's release cadence.
 *
 * Two invariants that keep impersonation honest:
 *
 *   1. A FALLBACK is NEVER cached. `getVSCodeVersion()` /
 *      `getCopilotChatVersion()` return a hardcoded constant when the network
 *      fails, and that constant must stay a last-resort floor for the current
 *      process — never the persisted steady state. Persisting it would let a
 *      transient outage silently freeze the advertised version for 12h, and
 *      (worse) survive restarts. `writeEntry` is therefore only reached on a
 *      value that differs from the fallback.
 *   2. The timestamp is written only on SUCCESS. An offline machine retries
 *      on the next launch rather than pinning a stale entry, which is the
 *      opposite of `claude-version-check.ts`'s throttle (that one stamps
 *      after the probes regardless, so an offline box pays both timeouts
 *      hourly). Do not copy that detail here.
 *
 * The file lives beside `last-update-check` / `last-self-update-check` and is
 * deliberately named distinctly so the three throttles never cross-suppress.
 */

import fs from "node:fs/promises"
import path from "node:path"

import consola from "consola"

import { PATHS } from "./paths"

const TTL_HOURS = 12

/** One cached lookup: the resolved value plus when it was resolved. */
interface CacheEntry {
  value: string
  checkedAt: string
}

interface EditorVersionCache {
  vscode?: CacheEntry
  copilotChat?: CacheEntry
}

/** Which upstream identity a cached entry belongs to. */
export type EditorVersionKey = "vscode" | "copilotChat"

function cacheFilePath(): string {
  return path.join(PATHS.APP_DIR, "last-editor-versions")
}

async function readCache(): Promise<EditorVersionCache> {
  try {
    const parsed = JSON.parse(
      await fs.readFile(cacheFilePath(), "utf8"),
    ) as EditorVersionCache
    // A hand-edited or truncated file must degrade to "no cache", not throw.
    if (!parsed || typeof parsed !== "object") return {}
    return parsed
  } catch {
    return {}
  }
}

function isFresh(entry: CacheEntry | undefined): entry is CacheEntry {
  if (!entry || typeof entry.value !== "string" || entry.value.length === 0) {
    return false
  }
  const last = new Date(entry.checkedAt).getTime()
  if (Number.isNaN(last)) return false
  // A clock moved backwards would make `age` negative; treating that as stale
  // costs one refetch, whereas treating it as fresh could pin a bad value.
  const ageHours = (Date.now() - last) / 1000 / 3600
  return ageHours >= 0 && ageHours < TTL_HOURS
}

/**
 * Resolve `key` through the cache, calling `fetchFresh` only on a miss.
 *
 * `fallback` is the constant `fetchFresh` returns when the network fails. It
 * is compared against, never persisted (invariant 1 above) — so a failed
 * fetch yields the fallback for THIS process and leaves the cache untouched,
 * and the next launch tries again.
 */
export async function resolveEditorVersion(
  key: EditorVersionKey,
  fetchFresh: () => Promise<string>,
  fallback: string,
): Promise<string> {
  const cache = await readCache()
  const entry = cache[key]
  const cachedValue = isFresh(entry) ? entry.value : undefined
  if (cachedValue !== undefined) return cachedValue

  const value = await fetchFresh()

  if (value !== fallback) {
    cache[key] = { value, checkedAt: new Date().toISOString() }
    try {
      await fs.mkdir(path.dirname(cacheFilePath()), { recursive: true })
      await fs.writeFile(cacheFilePath(), JSON.stringify(cache), {
        mode: 0o600,
      })
    } catch (err) {
      // A write failure only costs a refetch next launch.
      consola.debug("Failed to write editor-version cache:", err)
    }
  } else if (typeof entry?.value === "string" && entry.value.length > 0) {
    // The fetch failed AND we hold a stale-but-real value. Prefer it over the
    // hardcoded fallback: a version that was genuinely current when it was
    // cached is a closer impersonation than a constant frozen at release
    // time. The entry is left un-restamped so the next launch still retries.
    return entry.value
  }

  return value
}

/** Test seam: the on-disk path, so tests can point HOME at a temp dir. */
export function editorVersionCachePath(): string {
  return cacheFilePath()
}
