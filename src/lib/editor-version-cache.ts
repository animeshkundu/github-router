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
 * Serializes the read-modify-write below.
 *
 * `setupAndServe` resolves both keys concurrently (`Promise.all`). Without
 * this, both callers would `readCache()` into their OWN object, spend ~1.5s in
 * their network fetch, and then write that stale object back — so whichever
 * finished last would clobber the other's entry, and one of the two versions
 * would re-fetch on every launch forever.
 *
 * The chain also re-reads immediately before mutating, so the write is against
 * current disk state rather than the snapshot taken before the fetch.
 */
let writeChain: Promise<void> = Promise.resolve()

function serializeWrite(fn: () => Promise<void>): Promise<void> {
  const next = writeChain.then(fn, fn)
  // Never let a rejection poison the chain for later writers.
  writeChain = next.catch(() => {})
  return next
}

/**
 * Resolve `key` through the cache, calling `fetchFresh` only on a miss.
 *
 * `fetchFresh` signals failure by returning `undefined` — NOT by returning the
 * fallback constant. Inferring failure from `value === fallback` would break
 * exactly when the live version happens to equal the hardcoded constant, which
 * is the normal state right after someone bumps that constant to the
 * then-current version: the entry would never be written and every launch
 * would pay the ~1.5s fetch forever, silently defeating the cache.
 *
 * `fallback` is returned when the lookup fails and no usable cached value
 * exists. It is never persisted (invariant 1 above), so a transient outage
 * cannot freeze the version we impersonate.
 */
export async function resolveEditorVersion(
  key: EditorVersionKey,
  fetchFresh: () => Promise<string | undefined>,
  fallback: string,
): Promise<string> {
  const entry = (await readCache())[key]
  const cachedValue = isFresh(entry) ? entry.value : undefined
  if (cachedValue !== undefined) return cachedValue

  const fetched = await fetchFresh()

  if (fetched !== undefined && fetched.length > 0) {
    await serializeWrite(async () => {
      // Re-read INSIDE the chain: another key's write may have landed while
      // this one was in its fetch, and that entry must survive.
      const cache = await readCache()
      cache[key] = { value: fetched, checkedAt: new Date().toISOString() }
      try {
        await fs.mkdir(path.dirname(cacheFilePath()), { recursive: true })
        await fs.writeFile(cacheFilePath(), JSON.stringify(cache), {
          mode: 0o600,
        })
      } catch (err) {
        // A write failure only costs a refetch next launch.
        consola.debug("Failed to write editor-version cache:", err)
      }
    })
    return fetched
  }

  // The lookup failed. A stale-but-real cached value beats the hardcoded
  // constant: a version that was genuinely current when it was cached is a
  // closer impersonation than one frozen at release time. Left un-restamped,
  // so the next launch still retries.
  if (typeof entry?.value === "string" && entry.value.length > 0) {
    return entry.value
  }
  return fallback
}

/** Test seam: the on-disk path, so tests can point HOME at a temp dir. */
export function editorVersionCachePath(): string {
  return cacheFilePath()
}
