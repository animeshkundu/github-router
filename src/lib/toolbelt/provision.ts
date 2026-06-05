/**
 * Toolbelt provisioner: materialize curated CLI tools into the durable
 * router `bin/` dir so the spawned agent can call them on PATH.
 *
 * Properties (all load-bearing):
 *   - **Best-effort.** Every tool is isolated in try/catch; a failure
 *     skips that one tool and never throws to the launcher.
 *   - **Gap-fill.** A tool already on the user's PATH is NOT
 *     materialized (and a stale copy is removed) so we never shadow the
 *     user's own `jq`/`yq`/etc.
 *   - **Verified.** The downloaded archive's SHA256 must match the
 *     hardcoded manifest digest BEFORE extraction.
 *   - **Safe extraction.** Only the expected regular-file binary is
 *     pulled out; symlink/hardlink/device entries are rejected.
 *   - **Concurrency-safe.** A cross-process lock serializes writers;
 *     unique temp names + atomic rename avoid half-written binaries.
 *   - **Integrity-pruned.** Unexpected files in `bin/` are removed each
 *     launch so a prompt-injected agent can't plant a `git.cmd` that
 *     shadows real tools in future sessions.
 */

import { randomBytes, createHash } from "node:crypto"
import { existsSync } from "node:fs"
import {
  chmod,
  copyFile,
  link,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises"
import path from "node:path"
import process from "node:process"

import consola from "consola"

import { resolveExecutable } from "../exec"
import { PATHS } from "../paths"
import { withInstallLock } from "../update-lock"

import { extractTarGzMember, extractZipMember } from "./extract"
import { toolbeltEnabled, toolbeltSkipSet, vscodeRipgrepPath } from "./index"
import { assetFor, TOOLBELT_TOOLS, type ToolAsset, type ToolSpec } from "./manifest"

/** Per-download cap (bytes) — these binaries are a few MB at most. */
const MAX_DOWNLOAD_BYTES = 64 * 1024 * 1024
const DOWNLOAD_TIMEOUT_MS = 30_000

const EXE_EXT = process.platform === "win32" ? ".exe" : ""

/**
 * Materialize the toolbelt. Returns the list of command names exposed
 * in `bin/` after provisioning. Best-effort; never throws.
 */
export async function provisionToolbelt(): Promise<string[]> {
  if (!toolbeltEnabled()) return []
  const binDir = PATHS.TOOLBELT_BIN_DIR
  try {
    await mkdir(binDir, { recursive: true })
  } catch (err) {
    consola.debug("toolbelt: could not create bin dir:", err)
    return []
  }

  const skip = toolbeltSkipSet()

  // Serialize across concurrent proxies. If another process holds the
  // lock it is provisioning; we skip and just report current state.
  await withInstallLock("toolbelt.lock", async () => {
    await pruneUnexpected(binDir)
    await provisionRg(binDir, skip).catch((err) =>
      consola.debug("toolbelt: rg skipped:", err),
    )
    await Promise.all(
      TOOLBELT_TOOLS.map((spec) =>
        provisionTool(spec, binDir, skip).catch((err) =>
          consola.debug(`toolbelt: ${spec.command} skipped:`, err),
        ),
      ),
    )
  })

  return exposedCommands(binDir)
}

/** Names allowed to live in `bin/` (managed binaries + their sidecars). */
function expectedFileNames(): Set<string> {
  const names = new Set<string>()
  const add = (base: string) => {
    names.add(base + EXE_EXT)
    names.add(`${base}${EXE_EXT}.sha256`)
  }
  add("rg")
  for (const spec of TOOLBELT_TOOLS) {
    add(spec.binBasename)
    for (const a of spec.aliases ?? []) add(a)
  }
  return names
}

/** Remove any file in `bin/` that isn't a managed binary or sidecar. */
async function pruneUnexpected(binDir: string): Promise<void> {
  const expected = expectedFileNames()
  let entries: string[]
  try {
    entries = await readdir(binDir)
  } catch {
    return
  }
  for (const name of entries) {
    if (name.endsWith(".tmp")) continue // in-flight temp from a peer
    if (!expected.has(name)) {
      await rm(path.join(binDir, name), { force: true }).catch(() => {})
    }
  }
}

async function provisionRg(binDir: string, skip: Set<string>): Promise<void> {
  const dest = path.join(binDir, "rg" + EXE_EXT)
  if (skip.has("rg") || resolveExecutable("rg")) {
    // User has rg (or skipped) — don't shadow it. code_search uses its
    // own resolver regardless.
    await removeBin(dest)
    return
  }
  if (existsSync(dest)) return // already materialized
  const src = vscodeRipgrepPath()
  if (!src) return

  const tmp = tempName(dest)
  try {
    await link(src, tmp) // hardlink (same-volume fast path)
  } catch {
    await copyFile(src, tmp) // cross-volume (EXDEV) or other → copy
  }
  if (process.platform !== "win32") await chmod(tmp, 0o755).catch(() => {})
  await commit(tmp, dest)
}

async function provisionTool(
  spec: ToolSpec,
  binDir: string,
  skip: Set<string>,
): Promise<void> {
  const dest = path.join(binDir, spec.binBasename + EXE_EXT)
  const sidecar = `${dest}.sha256`
  const asset = assetFor(spec)

  if (skip.has(spec.command) || !asset) {
    await removeTool(spec, binDir)
    return
  }
  // Gap-fill: user already has it on PATH → remove ours, don't shadow.
  if (resolveExecutable(spec.command)) {
    await removeTool(spec, binDir)
    return
  }
  // Idempotent: present + sidecar matches → just ensure aliases exist.
  if (existsSync(dest) && (await sidecarMatches(sidecar, asset.sha256))) {
    await ensureAliases(spec, binDir, dest)
    return
  }

  const bytes = await downloadAndExtract(spec, asset)
  await atomicInstall(dest, bytes)
  await writeFile(sidecar, asset.sha256).catch(() => {})
  await ensureAliases(spec, binDir, dest)
}

async function downloadAndExtract(
  spec: ToolSpec,
  asset: ToolAsset,
): Promise<Buffer> {
  const data = await download(asset.url)
  const digest = createHash("sha256").update(data).digest("hex")
  if (digest !== asset.sha256) {
    throw new Error(
      `checksum mismatch for ${spec.command} (${asset.url}): expected ${asset.sha256}, got ${digest}`,
    )
  }
  if (asset.archive === "raw") return data
  const member =
    asset.archive === "zip"
      ? extractZipMember(data, spec.binBasename)
      : extractTarGzMember(data, spec.binBasename)
  if (!member) {
    throw new Error(`binary "${spec.binBasename}" not found in ${asset.url}`)
  }
  return member
}

async function download(url: string): Promise<Buffer> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: { "User-Agent": "github-router-toolbelt" },
    })
    if (!res.ok) throw new Error(`download ${url}: HTTP ${res.status}`)
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.length > MAX_DOWNLOAD_BYTES) {
      throw new Error(`download ${url}: exceeds ${MAX_DOWNLOAD_BYTES} bytes`)
    }
    return buf
  } finally {
    clearTimeout(timer)
  }
}

/** Write to a unique temp then atomically rename into place. */
async function atomicInstall(dest: string, bytes: Buffer): Promise<void> {
  const tmp = tempName(dest)
  await writeFile(tmp, bytes)
  if (process.platform !== "win32") await chmod(tmp, 0o755).catch(() => {})
  await commit(tmp, dest)
}

/** Rename tmp→dest, handling Windows replace-existing / in-use locks. */
async function commit(tmp: string, dest: string): Promise<void> {
  try {
    await rename(tmp, dest)
  } catch {
    // Windows: rename won't replace an existing/locked dest. Remove and
    // retry once; if that fails (in-use .exe), leave the existing copy.
    try {
      await rm(dest, { force: true })
      await rename(tmp, dest)
    } catch (err) {
      await rm(tmp, { force: true }).catch(() => {})
      throw err
    }
  }
}

async function ensureAliases(
  spec: ToolSpec,
  binDir: string,
  dest: string,
): Promise<void> {
  for (const alias of spec.aliases ?? []) {
    const ap = path.join(binDir, alias + EXE_EXT)
    if (existsSync(ap)) continue
    const tmp = tempName(ap)
    try {
      await copyFile(dest, tmp)
      if (process.platform !== "win32") await chmod(tmp, 0o755).catch(() => {})
      await commit(tmp, ap)
    } catch (err) {
      consola.debug(`toolbelt: alias ${alias} skipped:`, err)
    }
  }
}

async function removeTool(spec: ToolSpec, binDir: string): Promise<void> {
  const dest = path.join(binDir, spec.binBasename + EXE_EXT)
  await removeBin(dest)
  for (const alias of spec.aliases ?? []) {
    await removeBin(path.join(binDir, alias + EXE_EXT))
  }
}

async function removeBin(dest: string): Promise<void> {
  await rm(dest, { force: true }).catch(() => {})
  await rm(`${dest}.sha256`, { force: true }).catch(() => {})
}

async function sidecarMatches(sidecar: string, sha256: string): Promise<boolean> {
  try {
    return (await readFile(sidecar, "utf8")).trim() === sha256
  } catch {
    return false
  }
}

function tempName(dest: string): string {
  return `${dest}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`
}

/** The command names currently exposed in `bin/`. */
async function exposedCommands(binDir: string): Promise<string[]> {
  let files: Set<string>
  try {
    files = new Set(await readdir(binDir))
  } catch {
    return []
  }
  const present = (base: string) => files.has(base + EXE_EXT)
  const out: string[] = []
  if (present("rg")) out.push("rg")
  for (const spec of TOOLBELT_TOOLS) {
    if (present(spec.binBasename)) out.push(spec.command)
  }
  return out
}
