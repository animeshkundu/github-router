/**
 * Workspace file watcher for proactive index refresh (Phase 2d).
 *
 * Reports changed files (debounced, coalesced) so the indexer can refresh
 * WITHOUT waiting for the next query. Backend-agnostic: the callback
 * receives `{files, truncated}` and the indexer decides (CLI backend:
 * debounced `kickBackgroundInit`; service backend: `POST update`).
 *
 * Correctness never depends on this watcher: the on-query git delta
 * (`freshnessVerdict` + `staleFiles`) catches anything missed (dropped
 * events, unwatched dirs, inotify limits). The watcher is purely a
 * latency optimization — first query after edits is already fresh.
 *
 * Launch wiring is DELIBERATELY absent in v1: with the CLI backend every
 * refresh is a full colgrep spawn (model re-load), so proactive refresh
 * duplicates the per-search incremental update at extra CPU cost. Wiring
 * lands with the Phase 2e service backend, where updates are cheap 202s.
 * Until then this module is exercised by tests only.
 *
 * Platform notes:
 *   - darwin/win32: single recursive `fs.watch` (OS-native, cheap).
 *   - linux: recursive watch unsupported → per-directory watchers up to
 *     WATCH_DIR_CAP, created by one initial walk. New subdirectories made
 *     later are NOT picked up (documented); the on-query delta covers them.
 *     Inotify exhaustion (EMFILE/ENOSPC) degrades to unwatched, never throws.
 */

import { lstatSync, readdirSync, statSync, watch, type FSWatcher } from "node:fs"
import * as path from "node:path"

export interface WatchEvent {
  /** Workspace-relative paths (forward slashes), deduped. */
  files: Array<string>
  /** True when more changed than listed (burst cap or unwatched area). */
  truncated: boolean
}

export interface WatcherHandle {
  /** Stop watching. Idempotent. */
  close: () => void
  /** Number of directories actually watched (telemetry/tests). */
  watchedDirs: () => number
}

/**
 * Debounce: coalesce rapid LLM edits into one refresh signal.
 * Override with `GH_ROUTER_WATCH_DEBOUNCE_MS` (tests use ~50ms).
 */
function debounceMs(): number {
  const raw = Number(process.env.GH_ROUTER_WATCH_DEBOUNCE_MS)
  if (Number.isSafeInteger(raw) && raw >= 0) return raw
  return 10_000
}
/** Max files listed per signal; beyond → truncated bulk signal. */
const MAX_FILES_PER_SIGNAL = 500
/** Linux per-directory watch cap (inotify budget). */
const WATCH_DIR_CAP = 8000

const IGNORED_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "target",
  ".next",
  ".nuxt",
  "vendor",
  "__pycache__",
  ".venv",
  "venv",
])

function isIgnoredDir(name: string): boolean {
  return name.startsWith(".") && name !== ".github" && name !== ".vscode"
    ? true
    : IGNORED_DIRS.has(name)
}

function toRel(root: string, abs: string): string | null {
  const rel = path.relative(root, abs)
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) return null
  return rel.replace(/\\/g, "/")
}

/**
 * Watch `workspaceRoot` (absolute, canonical) and invoke `onChange` with
 * debounced, coalesced change sets. Never throws — setup failures degrade
 * to a live-but-empty watcher (close() still safe).
 */
export function watchWorkspace(
  workspaceRoot: string,
  onChange: (event: WatchEvent) => void,
): WatcherHandle {
  const pending = new Set<string>()
  let truncated = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let closed = false
  const watchers: Array<FSWatcher> = []

  const flush = (): void => {
    timer = undefined
    if (closed || (pending.size === 0 && !truncated)) return
    const files = [...pending].slice(0, MAX_FILES_PER_SIGNAL)
    if (pending.size > MAX_FILES_PER_SIGNAL) truncated = true
    pending.clear()
    const wasTruncated = truncated
    truncated = false
    try {
      onChange({ files, truncated: wasTruncated })
    } catch {
      // Caller errors must not kill the watcher.
    }
  }

  const schedule = (): void => {
    if (closed) return
    if (timer) return
    timer = setTimeout(flush, debounceMs())
    timer.unref?.()
  }

  const record = (absPath: string): void => {
    const rel = toRel(workspaceRoot, absPath)
    if (!rel) return
    // Skip events inside ignored dirs (belt-and-braces: the walk prunes
    // them, but renames can surface odd paths).
    const top = rel.split("/")[0]
    if (isIgnoredDir(top)) return
    if (pending.size < MAX_FILES_PER_SIGNAL) {
      pending.add(rel)
    } else {
      truncated = true
    }
    schedule()
  }

  const attach = (dir: string): void => {
    if (closed) return
    try {
      const w = watch(
        dir,
        process.platform === "linux" ? {} : { recursive: true },
        (_event, filename) => {
          if (typeof filename !== "string" || filename.length === 0) {
            // Null filename (Linux rename storms, overflow): we lost
            // precision — mark truncated so the indexer git-diffs.
            truncated = true
            schedule()
            return
          }
          record(path.join(dir, filename as string))
        },
      )
      w.on("error", () => {
        // Inotify exhaustion / permission loss: drop this watcher, keep
        // the rest. The on-query delta is the correctness net.
      })
      w.unref?.()
      watchers.push(w)
    } catch {
      // ENOSPC / EACCES / gone mid-walk: skip this subtree.
    }
  }

  try {
    if (process.platform === "linux") {
      // Manual recursion: breadth-first, pruned + capped.
      const queue: Array<string> = [workspaceRoot]
      attach(workspaceRoot)
      while (queue.length > 0 && watchers.length < WATCH_DIR_CAP && !closed) {
        const dir = queue.shift() as string
        let entries: Array<{ name: string; isDirectory: () => boolean }>
        try {
          entries = readdirSync(dir, { withFileTypes: true }) as Array<{
            name: string
            isDirectory: () => boolean
          }>
        } catch {
          continue
        }
        for (const e of entries) {
          if (!e.isDirectory() || isIgnoredDir(e.name)) continue
          const sub = path.join(dir, e.name)
          // Symlinked dirs: don't follow (scope escape + cycles).
          // lstat (not stat) detects the link; stat would follow it.
          try {
            if (lstatSync(sub, { throwIfNoEntry: false })?.isSymbolicLink()) {
              continue
            }
            if (!statSync(sub, { throwIfNoEntry: false })?.isDirectory()) continue
          } catch {
            continue
          }
          if (watchers.length >= WATCH_DIR_CAP) break
          attach(sub)
          queue.push(sub)
        }
      }
    } else {
      attach(workspaceRoot)
    }
  } catch {
    // Setup failed wholesale: return a live-but-empty handle.
  }

  return {
    close: () => {
      if (closed) return
      closed = true
      if (timer) {
        clearTimeout(timer)
        timer = undefined
      }
      for (const w of watchers) {
        try {
          w.close()
        } catch {
          // best effort
        }
      }
      watchers.length = 0
    },
    watchedDirs: () => watchers.length,
  }
}
