/**
 * The managed-install pointer: `m/<kind>/current.json`.
 *
 * This is the ONE mutable thing in the layout, and every design constraint here
 * comes from a measured failure:
 *
 * - **It is a file, not a directory or a junction.** On Windows,
 *   `MoveFileExW(MOVEFILE_REPLACE_EXISTING)` cannot replace a directory or a
 *   reparse point, so swapping a live `current/` directory works on first
 *   install and fails `EPERM` on every update — and the `rmdir` + `rename`
 *   fallback is non-atomic across exactly the window the ~13 per-turn
 *   `internal-*` hooks fire. A file-over-file rename is supported everywhere.
 * - **A bad pointer must never be fatal.** A launch that cannot resolve its
 *   payload must fall back to "no managed install" and run from whatever tree it
 *   already has. So every parse failure, unknown schema version, missing field,
 *   and missing entry resolves to `null`, and the caller treats that as absent.
 * - **Readers retry through a racing rename**, so the pointer is read via
 *   `readFileWithRetry` rather than raw `readFile`: a reader can legitimately see
 *   `ENOENT`/`EBUSY` for a microsecond after a writer's rename.
 *
 * ### What the pointer must NOT say
 *
 * The published bin is the bootstrap (`dist/bin.js`), so anything that resolves
 * "the bin target from package.json" would write a pointer to the bootstrap and
 * exec itself in a loop. `entry` is therefore the **app entry**, checked against
 * the installed tree, and `resolvePointer` refuses a pointer whose entry is the
 * bootstrap.
 *
 * ### `runtimeHint` is a hint
 *
 * Recording an absolute `node` path as authoritative is the "`claude` vanished
 * after a node upgrade" bug: nvm/fnm/volta/brew all delete the previous
 * interpreter, and a shim written once would then fail forever. The pointer
 * records what ran the install for diagnostics and fallback, and the launcher
 * resolves the runtime at run time.
 */

import fs from "node:fs/promises"
import path from "node:path"

import { readFileWithRetry, writeFileAtomic } from "../atomic-file"
import { reportManagedDiagnostic } from "./diagnostics"
import {
  type ManagedKind,
  entryRelativeFor,
  installedMarkerPath,
  pointerPath,
  versionDir,
} from "./paths"

export const POINTER_SCHEMA_VERSION = 1

/** The bootstrap entry, never a valid payload entry. */
export const BOOTSTRAP_ENTRY = "dist/bin.js"

export interface ManagedPointer {
  schemaVersion: number
  kind: ManagedKind
  version: string
  /** Path INSIDE the version dir, e.g. `node_modules/github-router/dist/main.js`. */
  entry: string
  /** Absolute path of the payload entry, derived; never trusted from disk alone. */
  entryPath: string
  /** The runtime that performed the install. Diagnostics + last-resort fallback. */
  runtimeHint?: string
  registry?: string
  installedAt?: string
}

/** On-disk shape. Kept separate so validation is explicit about optionality. */
interface PointerFile {
  schemaVersion?: unknown
  kind?: unknown
  version?: unknown
  entry?: unknown
  runtimeHint?: unknown
  registry?: unknown
  installedAt?: unknown
}

export interface WritePointerParams {
  kind: ManagedKind
  version: string
  /** Relative entry. Defaults to the kind's known entry. */
  entry?: string
  runtimeHint?: string
  registry?: string
  installedAt?: string
}

/**
 * Reject an entry that would point at the bootstrap or escape the version dir.
 *
 * This is not paranoia about our own writer: the pointer is a plain file in a
 * user-writable directory, and the launcher `import()`s whatever it names. A
 * relative entry that climbs out (`../../..`) or is absolute would turn a
 * corrupt pointer into arbitrary code execution on the next launch.
 */
export function isSafeEntry(entry: string): boolean {
  if (entry.length === 0) return false
  if (path.isAbsolute(entry) || entry.startsWith("/") || /^[A-Za-z]:/.test(entry)) return false
  // Reject both separators regardless of platform: a pointer written on POSIX
  // can be read by a Windows install (roaming profile) and vice versa.
  const normalized = entry.replace(/\\/g, "/")
  if (normalized.split("/").some((segment) => segment === "..")) return false
  if (normalized === BOOTSTRAP_ENTRY || normalized.endsWith(`/${BOOTSTRAP_ENTRY}`)) return false
  return true
}

function kindOf(value: unknown): ManagedKind | null {
  return value === "self" || value === "pi" ? value : null
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

/**
 * Parse + validate a pointer body. Returns `null` for anything unusable, which
 * every caller must treat identically to "no managed install".
 */
export function parsePointer(raw: string, kind: ManagedKind): ManagedPointer | null {
  let parsed: PointerFile
  try {
    parsed = JSON.parse(raw) as PointerFile
  } catch {
    return null
  }
  if (typeof parsed !== "object" || parsed === null) return null
  if (parsed.schemaVersion !== POINTER_SCHEMA_VERSION) return null
  if (kindOf(parsed.kind) !== kind) return null
  const version = nonEmptyString(parsed.version)
  if (!version) return null
  // A version string reaches a path join; refuse separators outright rather
  // than reasoning about whether a crafted name can escape the root.
  if (version.includes("/") || version.includes("\\") || version === "." || version === "..") {
    return null
  }
  const entry = nonEmptyString(parsed.entry) ?? entryRelativeFor(kind)
  if (!isSafeEntry(entry)) return null

  return {
    schemaVersion: POINTER_SCHEMA_VERSION,
    kind,
    version,
    entry,
    entryPath: path.join(versionDir(kind, version), entry),
    runtimeHint: nonEmptyString(parsed.runtimeHint),
    registry: nonEmptyString(parsed.registry),
    installedAt: nonEmptyString(parsed.installedAt),
  }
}

/**
 * Why a pointer read produced no pointer.
 *
 * `absent` and `unreadable` MUST be distinguishable, and the distinction is not
 * academic: GC treats "no pointer" as "nothing is live, so an old version dir may
 * be deleted". A transient `EPERM`/`EBUSY` (a virus scanner holding the file, a
 * torn read on a network home) reported as `absent` would let GC delete the very
 * tree the pointer names — unrecoverable without reinstalling, and it happens
 * precisely on the machines that are already unhappy.
 *
 * - `ok` — a complete pointer.
 * - `absent` — no pointer file, or one whose body is unusable.
 * - `unreadable` — the read failed for a reason other than ENOENT.
 */
export type PointerReadStatus = "ok" | "absent" | "unreadable"

export interface PointerReadResult {
  status: PointerReadStatus
  pointer: ManagedPointer | null
}

/**
 * Read the pointer with the reason it was not usable.
 *
 * This is the primitive; `readPointer` is the ergonomic form for callers whose
 * only decision is "run the payload or not". GC must use this one.
 */
export async function readPointerDetailed(
  kind: ManagedKind,
  opts: { verifyEntry?: boolean } = {},
): Promise<PointerReadResult> {
  const file = pointerPath(kind)
  let raw: string
  try {
    // `retryMissing: false`: a missing pointer is the normal first-run state, so
    // waiting out the retry window would tax every launch that has no managed
    // install yet (measured 760 ms before this flag existed).
    raw = await readFileWithRetry(file, { retryMissing: false })
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { status: "absent", pointer: null }
    }
    onReadError(kind, err)
    return { status: "unreadable", pointer: null }
  }
  const pointer = parsePointer(raw, kind)
  if (!pointer) {
    onInvalid(kind, file)
    return { status: "absent", pointer: null }
  }
  if (opts.verifyEntry === false) return { status: "ok", pointer }

  try {
    const stat = await fs.stat(pointer.entryPath)
    if (!stat.isFile()) {
      onMissingEntry(kind, pointer)
      return { status: "absent", pointer: null }
    }
  } catch {
    onMissingEntry(kind, pointer)
    return { status: "absent", pointer: null }
  }
  return { status: "ok", pointer }
}

/**
 * Read the pointer, or `null`.
 *
 * A missing file is the normal first-run answer. Any other read error is a
 * debug-level event, never a throw: a launch must not die because the pointer
 * is unreadable, and the caller's fallback (run from the current tree) is always
 * correct. The entry is stat'd by default, so a pointer to a GC'd or
 * half-published payload is also reported as absent.
 *
 * Callers that DESTROY something based on this answer must use
 * `readPointerDetailed` instead — see `PointerReadStatus`.
 */
export async function readPointer(
  kind: ManagedKind,
  opts: { verifyEntry?: boolean } = {},
): Promise<ManagedPointer | null> {
  return (await readPointerDetailed(kind, opts)).pointer
}

/**
 * Write the pointer atomically.
 *
 * Temp + fsync + rename, with a bounded retry through a transient Windows lock
 * (`atomic-file`).
 *
 * `atomic-file`'s exhausted-rename fallback re-reads the destination and accepts
 * a byte-for-byte match as success. For a pointer that is not the "did I win?"
 * question being swept under the rug: the body carries `version` + `installedAt`,
 * so identical bytes mean the other writer published the SAME version at the
 * same instant, and reporting success is correct. Two writers naming DIFFERENT
 * versions can never byte-match, so the caller still learns who won.
 */
export async function writePointer(params: WritePointerParams): Promise<ManagedPointer> {
  const entry = params.entry ?? entryRelativeFor(params.kind)
  if (!isSafeEntry(entry)) {
    throw new Error(`refusing to write an unsafe managed entry: ${entry}`)
  }
  const body = {
    schemaVersion: POINTER_SCHEMA_VERSION,
    kind: params.kind,
    version: params.version,
    entry,
    ...(params.runtimeHint ? { runtimeHint: params.runtimeHint } : {}),
    ...(params.registry ? { registry: params.registry } : {}),
    installedAt: params.installedAt ?? new Date().toISOString(),
  }
  const file = pointerPath(params.kind)
  await fs.mkdir(path.dirname(file), { recursive: true })
  await writeFileAtomic(file, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o644 })
  return {
    schemaVersion: POINTER_SCHEMA_VERSION,
    kind: params.kind,
    version: params.version,
    entry,
    entryPath: path.join(versionDir(params.kind, params.version), entry),
    runtimeHint: params.runtimeHint,
    registry: params.registry,
    installedAt: body.installedAt,
  }
}

/** Remove the pointer (used by `update --force` and by tests). */
export async function removePointer(kind: ManagedKind): Promise<void> {
  await fs.rm(pointerPath(kind), { force: true })
}

// ---------------------------------------------------------------------------
// Reporting
//
// The pointer is read by the bootstrap (`dist/bin.js`) and by the launcher path,
// both of which must stay importable without `consola` — two bundles would mean
// two instances and two configurations. Messages go through the sink instead;
// see `diagnostics.ts`.
// ---------------------------------------------------------------------------

function onReadError(kind: ManagedKind, err: unknown): void {
  reportManagedDiagnostic(
    "debug",
    `managed[${kind}]: could not read current.json (${
      err instanceof Error ? err.message : String(err)
    }); treating as no managed install`,
  )
}

function onInvalid(kind: ManagedKind, file: string): void {
  reportManagedDiagnostic(
    "warn",
    `managed[${kind}]: ${file} is not a valid pointer (schema/kind/entry); ignoring it. \`github-router update\` will rewrite it.`,
  )
}

function onMissingEntry(kind: ManagedKind, pointer: ManagedPointer): void {
  reportManagedDiagnostic(
    "debug",
    `managed[${kind}]: pointer names ${pointer.version} but ${pointer.entryPath} is missing; treating as no managed install`,
  )
}

// ---------------------------------------------------------------------------
// Installed-marker bookkeeping
// ---------------------------------------------------------------------------

export interface InstalledMarker {
  version: string
  /** `{ "pkg@version": { resolved, integrity } }` for provenance. */
  packages?: Record<string, { resolved?: string; integrity?: string }>
  installedAt?: string
  runtime?: string
  registry?: string
}

/**
 * Write `<version>/.installed.json`.
 *
 * Publishing is rename-then-pointer, so this marker is the only thing that says
 * "this directory is a COMPLETE payload". `install.ts` writes it after the
 * rename, inside the version dir; `update` reads it to decide adopt-vs-install.
 */
export async function writeInstalledMarker(
  kind: ManagedKind,
  marker: InstalledMarker,
): Promise<void> {
  const file = installedMarkerPath(kind, marker.version)
  await writeFileAtomic(file, `${JSON.stringify(marker, null, 2)}\n`, { mode: 0o644 })
}

export async function readInstalledMarker(
  kind: ManagedKind,
  version: string,
): Promise<InstalledMarker | null> {
  try {
    // A missing marker is a normal state (not installed yet), so do not wait
    // out the retry window for it.
    const raw = await readFileWithRetry(installedMarkerPath(kind, version), {
      retryMissing: false,
    })
    const parsed = JSON.parse(raw) as InstalledMarker
    if (typeof parsed !== "object" || parsed === null) return null
    if (parsed.version !== version) return null
    return parsed
  } catch {
    return null
  }
}
