/**
 * Atomic file replacement, shared by every durable pointer this codebase keeps
 * on disk (credentials, settings, the managed-install pointer).
 *
 * Why a module: the same three-step dance — write a pretend temp beside the
 * destination, `rename` over it, retry through a transient Windows lock — had
 * been re-implemented four times (`token.ts`, `cloudagent-hook-settings.ts`,
 * `claude-md-injection.ts`, `first-mate/durable-store.ts`) with slightly
 * different retry lists. The managed installer adds a fifth and, unlike the
 * others, runs it unattended in the middle of an update where a `EPERM` is the
 * difference between "updated" and "silently did nothing". So it lives here and
 * the four existing callers keep their behaviour by delegating.
 *
 * The invariants every writer here guarantees:
 *
 *   - **no partial destination.** A reader sees either the old bytes or the new
 *     bytes. `writeFile` at the destination truncates first, so a crash, a full
 *     disk, or a kill leaves a truncated file — for `current.json` that means a
 *     launch that cannot resolve its own payload.
 *   - **durability.** The file is `fsync`ed before the rename and the parent
 *     directory after it, so a power loss cannot leave the rename in the journal
 *     with the content still in page cache. (`fsync` on a directory is a no-op
 *     on Windows, which is fine: `MoveFileExW` already journals the metadata.)
 *   - **no symlink following.** Temp names come from `randomBytes` and are
 *     created with `flag: "wx"`, so an attacker who pre-places a symlink at a
 *     predictable temp name gets `EEXIST` instead of a write through their link.
 *   - **no copy fallback.** A failed rename throws. `copyFile` follows the
 *     destination, which reintroduces exactly the symlink/hardlink escape the
 *     `wx` flag exists to prevent.
 */

import { randomBytes } from "node:crypto"
import fs from "node:fs/promises"

/**
 * Backoff for a transient Windows rename failure.
 *
 * On Windows `fs.rename` over an existing destination transiently fails with
 * `EPERM` / `EBUSY` / `EACCES` when anything else holds the destination open
 * for a moment — antivirus, the search indexer, a backup agent, an editor.
 * Nothing is wrong and the handle closes microseconds later, but without a
 * retry a scan landing on the wrong millisecond costs the user a launch.
 *
 * `server-setup`'s `claude` settings write, the credential write and the
 * CLAUDE.md injection all use this same list; keeping one copy means a future
 * Windows behaviour change is diagnosed once, not four times.
 */
export const RENAME_RETRY_DELAYS_MS = [50, 200, 500] as const

/**
 * Error codes worth retrying on read. A reader racing a rename can observe
 * `ENOENT` (the destination name is briefly unlinked on some filesystems,
 * notably when a network client replays the operation) and can observe the
 * Windows lock codes while the writer's handle is still open.
 */
const TRANSIENT_READ_CODES = new Set(["EPERM", "EBUSY", "EACCES", "ENOENT"])

function errorCode(err: unknown): string | undefined {
  const code = (err as NodeJS.ErrnoException | undefined)?.code
  return typeof code === "string" ? code : undefined
}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms)
  })

export interface RenameWithRetryOpts {
  /**
   * When set, a final failure re-reads the destination and treats a match with
   * this content as success. Use it when two writers can legitimately produce
   * identical bytes (the CLAUDE.md snippet, a settings JSON body): the losing
   * racer then does not report a spurious failure.
   *
   * Leave it undefined when the destination is a *pointer* whose value differs
   * per writer — there, a mismatched read back means somebody else won and the
   * caller genuinely needs to know.
   */
  acceptedContent?: string
  /** Override the retry list (tests). */
  delaysMs?: readonly number[]
  /**
   * Called with the last rename error when every attempt fails.
   *
   * The error cannot be part of this function's return value without changing
   * every caller's shape, and swallowing it costs real diagnosability: the
   * CLAUDE.md injection warns about "rename failed after 4 attempts" and the
   * single most useful field in that warning is WHY (EPERM from a virus
   * scanner reads very differently from EACCES from a permission mistake).
   */
  onExhausted?: (err: unknown) => void
}

/**
 * `rename(from, to)` with bounded retry through a transient Windows lock.
 *
 * Returns `true` when the rename landed (or the destination already held
 * `acceptedContent`). Returns `false` — never throws — when retries are
 * exhausted and the destination does not match; the caller decides whether that
 * is fatal (`writeFileAtomic` treats it as fatal).
 *
 * `from` is NOT cleaned up on failure: a caller holding a temp path may want to
 * inspect it, and every caller here either retries or unlinks in its own
 * `finally`. The one exception is `writeFileAtomic`, which owns its temp.
 */
export async function renameWithRetry(
  from: string,
  to: string,
  opts: RenameWithRetryOpts = {},
): Promise<boolean> {
  const delays = opts.delaysMs ?? RENAME_RETRY_DELAYS_MS
  let lastErr: unknown
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    try {
      await fs.rename(from, to)
      return true
    } catch (err) {
      lastErr = err
      if (attempt < delays.length) await sleep(delays[attempt]!)
    }
  }

  if (opts.acceptedContent !== undefined) {
    try {
      const observed = await fs.readFile(to, "utf8")
      if (observed === opts.acceptedContent) return true
    } catch {
      // Fall through to the failure result.
    }
  }

  // Not swallowed silently: every caller in this repo either warns or throws.
  // `console.debug` would be invisible under the CLI's consola setup, so the
  // error is handed to the caller to report with its own context.
  opts.onExhausted?.(lastErr)
  return false
}

/** `fsync` a directory, ignoring platforms/filesystems that refuse. */
async function fsyncDir(dir: string): Promise<void> {
  // Windows cannot open a directory as a handle; `MoveFileExW` already
  // journals the metadata there, so a failure is expected and not an error.
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined
  try {
    handle = await fs.open(dir, "r")
    await handle.sync()
  } catch {
    // Best effort: durability here is a belt, not the braces.
  } finally {
    await handle?.close().catch(() => {})
  }
}

/** `fsync` an open file handle, ignoring failures on exotic filesystems. */
async function fsyncFile(handle: Awaited<ReturnType<typeof fs.open>>): Promise<void> {
  try {
    await handle.sync()
  } catch {
    // Best effort, same reasoning as `fsyncDir`.
  }
}

export interface WriteFileAtomicOpts {
  /** Destination mode. Carried by the rename on POSIX; ignored on Windows. */
  mode?: number
  /**
   * Text written to the destination. Passing a string lets a failing rename
   * verify whether a racer already landed the same bytes.
   */
  acceptedContent?: string
  /** Override the retry list (tests). */
  delaysMs?: readonly number[]
}

/**
 * Replace `filePath` with `data` atomically: temp + fsync + rename + fsync(dir).
 *
 * Throws on failure, having removed its temp file. Never leaves a partially
 * written destination and never writes through a pre-placed symlink.
 *
 * The temp file is created in the SAME directory as the destination — a
 * cross-directory temp would make the rename a cross-device copy (`EXDEV`) on
 * any setup with a separate mount for the parent, and would stop being atomic.
 */
export async function writeFileAtomic(
  filePath: string,
  data: string | Uint8Array,
  opts: WriteFileAtomicOpts = {},
): Promise<void> {
  const tmp = `${filePath}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined
  try {
    // `writeFile` + `flag:"wx"` rather than `open` + `handle.writeFile`: the two
    // are the same O_CREAT|O_EXCL write, and this shape is what the credential
    // tests inject failures through. (Writing through a partial-then-throw mock
    // is the only way to prove the destination survives a mid-write crash.)
    await fs.writeFile(tmp, data, { mode: opts.mode ?? 0o600, flag: "wx" })
    // Re-open for `fsync`: durability needs the flush to happen AFTER the write,
    // and a read handle can be `fsync`ed on POSIX and Windows alike.
    handle = await fs.open(tmp, "r")
    await fsyncFile(handle)
    const closedHandle = handle
    handle = undefined
    await closedHandle.close()

    const accepted =
      opts.acceptedContent
      ?? (typeof data === "string" ? data : undefined)
    const renamed = await renameWithRetry(tmp, filePath, {
      acceptedContent: accepted,
      delaysMs: opts.delaysMs,
    })
    if (!renamed) {
      throw new Error(
        `atomic write failed: could not rename ${tmp} over ${filePath} after ${(opts.delaysMs ?? RENAME_RETRY_DELAYS_MS).length + 1} attempts`,
      )
    }
    await fsyncDir(/** same directory as the destination */ dirnameOf(filePath))
    return
  } catch (err) {
    await handle?.close().catch(() => {})
    await fs.unlink(tmp).catch(() => {})
    throw err
  }
}

/**
 * `path.dirname` without importing `node:path` at module scope.
 *
 * The launcher this module's output is inlined into runs before any bundler
 * chunk is available, and a stray `node:path` import is one more thing the
 * inlining recipe has to keep external. A local split is exact for the paths
 * here (always absolute) and cannot drift from `dirname` for them.
 */
function dirnameOf(p: string): string {
  const idx = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"))
  if (idx <= 0) return "."
  return p.slice(0, idx)
}

/**
 * Read a file, retrying briefly through a racing rename.
 *
 * A reader that lands between the writer's `rename` and the OS finishing the
 * directory update can see `ENOENT`; a Windows reader can see `EBUSY` while the
 * writer's handle is still closing. Both clear within the retry window. A
 * persistent failure still propagates: callers must not treat "could not read"
 * as "absent" when their decision depends on it.
 *
 * `retryMissing` defaults to `true` because the readers that existed first (the
 * credential files) race a writer that replaces them constantly. Set it to
 * `false` for a file whose absence is a *normal state* — the managed pointer on
 * first run — where retrying would put 750 ms of latency in front of every
 * launch for no benefit. (Measured: the first version of `readPointer` cost
 * 760 ms per call on a machine with no managed install.)
 */
export async function readFileWithRetry(
  filePath: string,
  opts: { delaysMs?: readonly number[]; retryMissing?: boolean } = {},
): Promise<string> {
  const delays = opts.delaysMs ?? RENAME_RETRY_DELAYS_MS
  const retryMissing = opts.retryMissing ?? true
  let lastErr: unknown
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    try {
      return await fs.readFile(filePath, "utf8")
    } catch (err) {
      lastErr = err
      const code = errorCode(err)
      const retryable =
        code !== undefined
        && TRANSIENT_READ_CODES.has(code)
        && (retryMissing || code !== "ENOENT")
      if (!retryable) throw err
      if (attempt < delays.length) await sleep(delays[attempt]!)
    }
  }
  throw lastErr
}
