/**
 * Server-side image loading for peer-critic attachments (`imagePaths`).
 *
 * WHY PATHS AND NOT BASE64
 *
 * The obvious schema would take base64 directly. It would also mean megabytes
 * of payload crossing the MCP boundary and sitting in the CALLER's context — the
 * exact cost the browser-screenshot fix exists to remove — and it would trip the
 * `predictedTooLong` pre-flight, which sizes the brief before a slot is
 * acquired. Reading the bytes here instead keeps the caller's context clean and
 * the wire small: the caller sends a path, the proxy sends the pixels.
 *
 * The proxy and the caller are the same machine in this product (the MCP server
 * is loopback-only and the CLI is spawned by it), so a local path is meaningful
 * on both sides.
 *
 * THREAT MODEL
 *
 * This is a second file-reading path, so it must not become a way around the
 * first one's rules. Every path goes through `confineToWorkspaceResult` — the
 * SAME chokepoint the worker's `read`/`glob`/`grep` tools use — which enforces
 * workspace confinement, `realpathSync.native()` (so a symlink or junction is
 * resolved to its true target before the prefix check), and syntactic rejection
 * of UNC, device, and drive-relative Windows paths. `isSensitivePath` then
 * applies the credential-shaped denylist (`.env*`, `*.pem`, `id_rsa*`, `.ssh/`,
 * `.git/` interior, `.netrc`, …).
 *
 * On top of that, content identification adds a second barrier: a file is only
 * ever sent if its leading BYTES are a supported image, so a `.env` renamed to
 * `shot.png` is refused even if it somehow passed confinement.
 *
 * That barrier is header-only, and worth stating honestly: a file beginning
 * with a valid PNG signature and carrying arbitrary data afterwards would pass.
 * Constructing one requires write access, and a caller with write access
 * already has `bash` and could exfiltrate directly — so this stops the
 * realistic case (a model pointing at a credential file by mistake or via
 * prompt injection), not a determined adversary. Confinement and the denylist
 * are the primary controls; this is defence in depth.
 */

import { constants as fsConstants, realpathSync } from "node:fs"
import { open } from "node:fs/promises"
import type { FileHandle } from "node:fs/promises"

import { SUPPORTED_IMAGE_MIME_TYPES, detectImageMimeType } from "./attachments"
import { confineToWorkspaceResult, isSensitivePath } from "./worker-agent/paths"

/**
 * Pre-encode size ceiling. Every vision-capable model in the live catalog
 * publishes `max_prompt_image_size: 3145728`, so anything larger cannot be sent
 * to any of them. Checking BEFORE `readFile` means an oversized file is never
 * loaded into memory, let alone base64-expanded by a third.
 *
 * The per-model check still runs later at the transport boundary
 * (`assertOutboundImagesOk`); this is the cheap guard, not the authority.
 */
export const MAX_ATTACHMENT_BYTES = 3 * 1024 * 1024

/**
 * Caps on the request as a whole. `imagePaths` is caller-supplied and otherwise
 * unbounded, so without these a single call could ask for hundreds of files —
 * each up to 3 MiB, each inflating by a third on base64 — and hold them all in
 * memory at once. 10 is the most permissive per-model image ceiling in the live
 * catalog, so nothing beyond it could be sent anyway.
 */
export const MAX_ATTACHMENT_COUNT = 10
export const MAX_TOTAL_ATTACHMENT_BYTES = 12 * 1024 * 1024

/**
 * Open flags. `O_NOFOLLOW` is POSIX-only and simply absent on Windows, where
 * `fsConstants.O_NOFOLLOW` is `undefined` — OR-ing that in would produce `NaN`
 * and break every open, so it is added only when the platform defines it.
 */
const READ_FLAGS =
  typeof fsConstants.O_NOFOLLOW === "number"
    ? fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW
    : fsConstants.O_RDONLY

export interface LoadedImage {
  data: string
  mimeType: string
}

export type LoadImagesResult =
  | { ok: true; images: Array<LoadedImage> }
  | { ok: false; error: string }

/**
 * Resolve, validate, and base64-encode each path.
 *
 * Fails on the FIRST bad path rather than silently skipping it: a caller that
 * attached four screenshots and got three has been quietly misled about what the
 * reviewer actually saw.
 *
 * Error strings reach a model, so they say what was wrong and what to do, and
 * never echo the resolved absolute path (the confinement helper deliberately
 * keeps its own messages path-free for the same reason).
 */
export async function loadPeerImages(
  paths: ReadonlyArray<string>,
  workspace: string,
): Promise<LoadImagesResult> {
  if (paths.length > MAX_ATTACHMENT_COUNT) {
    return {
      ok: false,
      error:
        `imagePaths: ${paths.length} paths exceeds the ${MAX_ATTACHMENT_COUNT}-image `
        + "ceiling (the most any Copilot model accepts). Send fewer.",
    }
  }
  // `confineToWorkspaceResult` canonicalizes the FILE with
  // `realpathSync.native()` and then prefix-checks it against the workspace, so
  // the workspace must be canonical too or the comparison is between two
  // different spellings of the same directory. Its doc says the caller
  // pre-resolves (the worker engine does, at start); this entry point is reached
  // straight from an MCP call with `process.cwd()`, so it resolves here.
  //
  // This is not theoretical: on a Windows CI runner `os.tmpdir()` yields a
  // short-name path (`C:/Users/RUNNER~1/...`) while the realpath of a file
  // inside it is the long form (`C:/Users/runneradmin/...`). Without this, every
  // attachment was rejected on that machine and only on that machine.
  let workspaceAbs: string
  try {
    workspaceAbs = realpathSync.native(workspace)
  } catch {
    workspaceAbs = workspace
  }

  const images: Array<LoadedImage> = []
  let totalBytes = 0
  for (const [index, raw] of paths.entries()) {
    const position = `imagePaths[${index}]`
    if (typeof raw !== "string" || raw.length === 0) {
      return { ok: false, error: `${position}: must be a non-empty string.` }
    }

    const confined = confineToWorkspaceResult(raw, workspaceAbs)
    if (!confined.ok) {
      return { ok: false, error: `${position}: ${confined.error}` }
    }
    if (isSensitivePath(confined.abs, workspaceAbs)) {
      return { ok: false, error: `${position}: rejected: sensitive path` }
    }

    // Open ONCE and do every check against that handle. Doing `stat(path)`
    // and then `readFile(path)` is a check/use race: between the two calls the
    // path can be repointed at a different file, so the size and file-type
    // checks would describe one file while the bytes come from another — and
    // `readFile` buffers whatever it finds, so a swapped-in huge file is an
    // out-of-memory crash as well as a bypassed limit. A handle is bound to the
    // opened file; re-pointing the path afterwards cannot change what it reads.
    //
    // `O_NOFOLLOW` additionally refuses to open the final component if it is a
    // symlink, closing the window between `confineToWorkspaceResult`'s
    // canonicalization and this `open()` for the common case. Be precise about
    // what remains: an INTERMEDIATE directory swapped for a symlink in that
    // same window is still not covered, because nothing portable resolves a
    // path atomically. That residual race is a property of the shared
    // confinement helper and is equally present in the worker's own `read` /
    // `glob` / `grep`; it is not introduced here. Closing it properly needs
    // openat(2)-style directory-relative resolution, which Node does not
    // expose. `O_NOFOLLOW` is POSIX-only; on Windows the flag is absent and the
    // constant is undefined, so it is added conditionally.
    let handle: FileHandle | undefined
    let buf: Buffer
    try {
      handle = await open(confined.abs, READ_FLAGS)
      const info = await handle.stat()
      if (!info.isFile()) {
        return { ok: false, error: `${position}: rejected: not a regular file` }
      }
      if (info.size > MAX_ATTACHMENT_BYTES) {
        return {
          ok: false,
          error:
            `${position}: ${info.size} bytes exceeds the ${MAX_ATTACHMENT_BYTES}-byte limit `
            + "every vision model publishes. Re-capture at a smaller scale or lower quality.",
        }
      }
      totalBytes += info.size
      if (totalBytes > MAX_TOTAL_ATTACHMENT_BYTES) {
        return {
          ok: false,
          error:
            `${position}: the attachments total more than ${MAX_TOTAL_ATTACHMENT_BYTES} bytes. `
            + "Send fewer or smaller images.",
        }
      }
      // Allocation is bounded by the ceiling, never by the reported size, so a
      // hostile size cannot drive the allocation either. Read one byte PAST the
      // stat size so a file that grew after the stat is detected rather than
      // silently truncated.
      const capacity = Math.min(info.size, MAX_ATTACHMENT_BYTES)
      const scratch = Buffer.alloc(Math.min(capacity + 1, MAX_ATTACHMENT_BYTES + 1))
      // A single `read()` may return FEWER bytes than requested — Node makes no
      // completeness guarantee even for regular files. Taking one call's
      // `bytesRead` as the whole file would hand a TRUNCATED image to the
      // header detector, which would happily accept it, and the failure would
      // surface as an opaque upstream error much later. Loop to EOF.
      let filled = 0
      for (;;) {
        const { bytesRead } = await handle.read(scratch, filled, scratch.length - filled, filled)
        if (bytesRead === 0) break
        filled += bytesRead
        if (filled >= scratch.length) break
      }
      if (filled > capacity) {
        return {
          ok: false,
          error:
            `${position}: the file grew while it was being read. Retry once it has `
            + "stopped changing.",
        }
      }
      buf = scratch.subarray(0, filled)
    } catch {
      // Covers open, stat and read alike: the file vanished, is locked, or is
      // unreadable. A structured error keeps the result contract intact — this
      // used to be able to throw straight out of the function.
      return { ok: false, error: `${position}: file not found or unreadable` }
    } finally {
      await handle?.close().catch(() => {})
    }

    const mimeType = detectImageMimeType(buf)
    if (!mimeType) {
      return {
        ok: false,
        error:
          `${position}: not a supported image. Content is identified by its bytes, `
          + `not its extension. Supported: ${[...SUPPORTED_IMAGE_MIME_TYPES].join(", ")}.`,
      }
    }
    images.push({ data: buf.toString("base64"), mimeType })
  }
  return { ok: true, images }
}
