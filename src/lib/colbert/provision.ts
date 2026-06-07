/**
 * ColBERT sidecar provisioner: download + SHA-verify + extract the three
 * artifacts (`colgrep` binary, ONNX Runtime dylib, ColBERT INT8 model)
 * into the router-owned data dir, then run a smoke test that confirms
 * the ORT dylib actually loads before the capability advertises `ready`.
 *
 * Mirrors `toolbelt/provision.ts`:
 *   - **Best-effort.** Every step is timeout-bounded and the public
 *     `provisionColbert()` swallows to a structured result; it never
 *     throws to the launcher.
 *   - **Verified.** Each download's SHA256 must match the hardcoded
 *     manifest digest BEFORE it is written into place. This closes the
 *     two supply-chain holes colgrep leaves open (it does NO checksum on
 *     its own ORT / HF-model downloads).
 *   - **Concurrency-safe.** A cross-process `withInstallLock` serializes
 *     downloads; partial files land in a temp dir and are atomically
 *     renamed into VERSIONED artifact dirs so a failed upgrade never
 *     poisons the current install.
 */

import { createHash, randomBytes } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import {
  chmod,
  mkdir,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises"
import path from "node:path"
import process from "node:process"

import consola from "consola"

import { PATHS } from "../paths"
import { runManagedExeCapture } from "../exec"
import { withInstallLock } from "../update-lock"
import { extractTarGzMember, extractTarXzMember, extractZipMember } from "../toolbelt/extract"

import {
  colgrepBinAsset,
  ortLibAsset,
  MODEL_FILES,
  MODEL_REPO,
  MODEL_REVISION,
  modelDirName,
  ORT_VERSION,
  type ColbertAsset,
} from "./manifest"

/**
 * Per-download cap. The Windows ORT `.zip` is ~78 MB (it bundles a
 * 377 MB `.pdb` we discard but still transfer), so this is larger than
 * the toolbelt's 64 MB. 256 MB comfortably covers every artifact.
 */
const MAX_DOWNLOAD_BYTES = 256 * 1024 * 1024
const DOWNLOAD_TIMEOUT_MS = 120_000
const SMOKE_TIMEOUT_MS = 30_000

const EXE_EXT = process.platform === "win32" ? ".exe" : ""

export type ColbertProvisionStatus =
  | "ready" // binary + model + ORT present AND smoke test passed
  | "unsupported" // no manifest asset for this platform-arch
  | "incomplete" // a download/verify/extract step failed
  | "smoke_failed" // artifacts present but ORT dlopen / colgrep run failed

export interface ColbertProvisionResult {
  status: ColbertProvisionStatus
  /** Absolute path to the provisioned colgrep binary (when present). */
  binaryPath?: string
  /** Absolute path to the ORT dylib (ORT_DYLIB_PATH) (when present). */
  ortDylibPath?: string
  /** Absolute path to the local model dir (--model) (when present). */
  modelDir?: string
  /** SHA of the colgrep binary archive (for the rebuild-on-engine-change trigger). */
  binarySha?: string
  /** SHA of the ORT archive. */
  ortSha?: string
  /** Short, non-source-bearing reason when not ready (safe to surface). */
  reason?: string
}

/** Absolute path the provisioned colgrep binary lives at. */
export function colgrepBinaryPath(): string {
  return path.join(PATHS.COLBERT_BIN_DIR, "colgrep" + EXE_EXT)
}

/** Absolute path the provisioned model dir lives at (pinned revision). */
export function colbertModelDir(): string {
  return path.join(PATHS.COLBERT_MODELS_DIR, "LateOn-Code-edge", modelDirName())
}

/** Absolute path the provisioned ORT dylib lives at. */
export function colbertOrtDylibPath(): string {
  const asset = ortLibAsset()
  const lib = asset?.member ?? "libonnxruntime.so"
  return path.join(PATHS.COLBERT_ORT_DIR, ORT_VERSION, "cpu", lib)
}

/**
 * Cheap on-disk presence check (no download, no smoke). Used by the
 * MCP preflight to decide `provisioning` vs `ready`-eligible. Returns
 * true iff the binary, model dir (with the INT8 onnx), and ORT dylib
 * all exist on disk.
 */
export function colbertArtifactsPresent(): boolean {
  return (
    existsSync(colgrepBinaryPath()) &&
    existsSync(path.join(colbertModelDir(), "model_int8.onnx")) &&
    existsSync(colbertOrtDylibPath())
  )
}

/**
 * Router credentials that must NOT reach a colgrep child. colgrep is a
 * SHA-verified local binary, but it makes network calls (model fetch), so
 * no router secret belongs in its environment. Mirrors the credential-drop
 * posture of the worker-bash env (src/lib/worker-agent/bash.ts).
 */
const COLGREP_SECRET_ENV_KEYS = [
  "GITHUB_TOKEN",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "COPILOT_TOKEN",
]

/**
 * Strip router credentials (the keys above + any `GH_ROUTER_*`) from a
 * child-process env object, in place. Operates on a caller-owned copy of
 * `process.env`, never the live process env.
 */
export function dropColgrepSecrets(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  for (const k of Object.keys(env)) {
    if (k.startsWith("GH_ROUTER_") || COLGREP_SECRET_ENV_KEYS.includes(k)) {
      delete env[k]
    }
  }
  return env
}

/** Marker file written next to the model dir once the smoke test passed. */
function smokeMarkerPath(): string {
  return path.join(PATHS.COLBERT_DIR, ".smoke-ok")
}

/**
 * The content written into `.smoke-ok` on a successful smoke test:
 * the SHAs of the binary + ORT archive + model revision the smoke was
 * run against. `colbertSmokeOk()` validates the on-disk marker against
 * the CURRENT manifest values, so a re-pin (new binary/ORT/model)
 * invalidates a stale marker — the capability gate then reads false
 * until the new artifact set is re-provisioned and re-smoked. Without
 * this, a partial provision after a re-pin could leave an old `.smoke-ok`
 * that advertises `ready` for an un-smoke-tested artifact set.
 */
function expectedSmokeMarker(): string {
  const bin = colgrepBinAsset()?.sha256 ?? "?"
  const ort = ortLibAsset()?.sha256 ?? "?"
  return `colbert-smoke-ok\nbinary=${bin}\nort=${ort}\nmodel=${MODEL_REVISION}\n`
}

/**
 * Has the post-provision smoke test passed for the CURRENT artifact set?
 * Validates the marker content against the live manifest SHAs so a
 * re-pin invalidates a stale marker (see `expectedSmokeMarker`).
 */
export function colbertSmokeOk(): boolean {
  try {
    return readFileSync(smokeMarkerPath(), "utf8") === expectedSmokeMarker()
  } catch {
    return false
  }
}

/**
 * Provision all three artifacts under a cross-process lock, then smoke
 * test. Idempotent: present + sha-matching artifacts are skipped. Never
 * throws — returns a structured status the caller can act on.
 */
export async function provisionColbert(): Promise<ColbertProvisionResult> {
  const binAsset = colgrepBinAsset()
  const ortAsset = ortLibAsset()
  if (!binAsset || !ortAsset) {
    return { status: "unsupported", reason: "no prebuilt asset for this platform" }
  }

  const result: ColbertProvisionResult = {
    status: "incomplete",
    binarySha: binAsset.sha256,
    ortSha: ortAsset.sha256,
  }

  try {
    await mkdir(PATHS.COLBERT_DIR, { recursive: true })
  } catch (err) {
    consola.debug("colbert: cannot create data dir:", err)
    return { ...result, reason: "data dir unwritable" }
  }

  await withInstallLock("colbert-provision.lock", async () => {
    // 1. Binary
    const binaryPath = colgrepBinaryPath()
    try {
      await provisionBinary(binAsset, binaryPath)
      result.binaryPath = binaryPath
    } catch (err) {
      consola.debug("colbert: binary provision failed:", err)
      result.reason = "binary download/verify failed"
      return
    }

    // 2. ORT dylib (+ soname symlink on POSIX)
    const ortDylibPath = colbertOrtDylibPath()
    try {
      await provisionOrt(ortAsset, ortDylibPath)
      result.ortDylibPath = ortDylibPath
    } catch (err) {
      consola.debug("colbert: ORT provision failed:", err)
      result.reason = "ORT download/verify failed"
      return
    }

    // 3. Model (5 files, per-file SHA)
    const modelDir = colbertModelDir()
    try {
      await provisionModel(modelDir)
      result.modelDir = modelDir
    } catch (err) {
      consola.debug("colbert: model provision failed:", err)
      result.reason = "model download/verify failed"
      return
    }

    result.status = "incomplete" // becomes ready only after smoke
  })

  // All three present? Run the smoke test (outside the download lock —
  // it spawns colgrep, which we don't want to hold the download lock for).
  if (result.binaryPath && result.ortDylibPath && result.modelDir) {
    const smoke = await runSmokeTest(
      result.binaryPath,
      result.ortDylibPath,
      result.modelDir,
    )
    if (smoke.ok) {
      await writeFile(smokeMarkerPath(), expectedSmokeMarker()).catch(() => {})
      result.status = "ready"
    } else {
      await rm(smokeMarkerPath(), { force: true }).catch(() => {})
      result.status = "smoke_failed"
      result.reason = smoke.reason
    }
  }

  return result
}

async function provisionBinary(
  asset: ColbertAsset,
  dest: string,
): Promise<void> {
  const sidecar = `${dest}.sha256`
  if (existsSync(dest) && (await sidecarMatches(sidecar, asset.sha256))) {
    return // idempotent
  }
  await mkdir(path.dirname(dest), { recursive: true })
  const archive = await download(asset.url)
  verifySha(archive, asset.sha256, "colgrep binary")
  const member = await extractMember(asset, archive, "colgrep")
  if (!member) throw new Error("colgrep binary not found in archive")
  await atomicWrite(dest, member, /*executable*/ true)
  await writeFile(sidecar, asset.sha256).catch(() => {})
}

async function provisionOrt(
  asset: ColbertAsset & { soname?: string },
  dest: string,
): Promise<void> {
  const sidecar = `${dest}.sha256`
  if (existsSync(dest) && (await sidecarMatches(sidecar, asset.sha256))) {
    return // idempotent
  }
  await mkdir(path.dirname(dest), { recursive: true })
  const archive = await download(asset.url)
  verifySha(archive, asset.sha256, "ONNX Runtime")
  const member = await extractMember(asset, archive, asset.member ?? "")
  if (!member) throw new Error("ORT dylib not found in archive")
  await atomicWrite(dest, member, /*executable*/ true)
  await writeFile(sidecar, asset.sha256).catch(() => {})
  // POSIX: create the unversioned soname symlink colgrep's ORT_LIB_NAME
  // expects (e.g. libonnxruntime.so → libonnxruntime.so.1.23.0). Some
  // loaders dlopen the versioned name directly (we point ORT_DYLIB_PATH
  // at the versioned file), but the symlink is cheap insurance.
  if (process.platform !== "win32" && asset.soname) {
    const link = path.join(path.dirname(dest), asset.soname)
    await rm(link, { force: true }).catch(() => {})
    await symlink(path.basename(dest), link).catch((err) =>
      consola.debug("colbert: ORT soname symlink skipped:", err),
    )
  }
}

async function provisionModel(modelDir: string): Promise<void> {
  await mkdir(modelDir, { recursive: true })
  for (const file of MODEL_FILES) {
    const dest = path.join(modelDir, file.name)
    if (existsSync(dest)) {
      // Verify existing matches the pinned digest; re-download if not.
      try {
        const have = await readFile(dest)
        if (createHash("sha256").update(have).digest("hex") === file.sha256) {
          continue
        }
      } catch {
        // fall through to re-download
      }
    }
    const url = `https://huggingface.co/${MODEL_REPO}/resolve/${MODEL_REVISION}/${file.name}`
    const bytes = await download(url)
    verifySha(bytes, file.sha256, `model file ${file.name}`)
    await atomicWrite(dest, bytes, /*executable*/ false)
  }
}

async function extractMember(
  asset: ColbertAsset,
  archive: Buffer,
  wantBasename: string,
): Promise<Buffer | null> {
  if (asset.archive === "raw") return archive
  if (asset.archive === "zip") return extractZipMember(archive, wantBasename)
  if (asset.archive === "tar.gz") return extractTarGzMember(archive, wantBasename)
  if (asset.archive === "tar.xz") {
    // POSIX-only path (Windows assets are never tar.xz). Needs a temp dir.
    const tmp = path.join(
      PATHS.COLBERT_DIR,
      `xz-tmp-${process.pid}-${randomBytes(4).toString("hex")}`,
    )
    try {
      return await extractTarXzMember(archive, wantBasename, tmp)
    } finally {
      await rm(tmp, { recursive: true, force: true }).catch(() => {})
    }
  }
  return null
}

function verifySha(data: Buffer, expected: string, label: string): void {
  const got = createHash("sha256").update(data).digest("hex")
  if (got !== expected) {
    throw new Error(
      `checksum mismatch for ${label}: expected ${expected}, got ${got}`,
    )
  }
}

async function download(url: string): Promise<Buffer> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: { "User-Agent": "github-router-colbert" },
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

/** Write bytes to a unique temp then atomically rename into place. */
async function atomicWrite(
  dest: string,
  bytes: Buffer,
  executable: boolean,
): Promise<void> {
  const tmp = `${dest}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`
  await writeFile(tmp, bytes)
  if (executable && process.platform !== "win32") {
    await chmod(tmp, 0o755).catch(() => {})
  }
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

async function sidecarMatches(sidecar: string, sha256: string): Promise<boolean> {
  try {
    return (await readFile(sidecar, "utf8")).trim() === sha256
  } catch {
    return false
  }
}

/**
 * Post-provision smoke test. Runs ONE cheap colgrep invocation with the
 * EXACT isolating env the runner uses (`COLGREP_DATA_DIR`,
 * `ORT_DYLIB_PATH`, `--model <dir>`, `--force-cpu`) against a tiny
 * one-file fixture, and confirms it exits 0 AND the ORT dylib actually
 * loaded.
 *
 * This is LOAD-BEARING (design Risk #5): the spike proved that an
 * invalid `ORT_DYLIB_PATH` makes colgrep print "is not a loadable ONNX
 * Runtime dylib; ignoring" and silently FALL THROUGH to its own
 * unverified GitHub download. So we must verify the handoff actually
 * took before advertising `ready`. We detect the fall-through by
 * scanning stderr for colgrep's exact "ignoring" warning — if present,
 * the dylib didn't load and we fail the smoke test even on exit 0.
 */
async function runSmokeTest(
  binaryPath: string,
  ortDylibPath: string,
  modelDir: string,
): Promise<{ ok: boolean; reason?: string }> {
  const tmp = path.join(
    PATHS.COLBERT_DIR,
    `smoke-${process.pid}-${randomBytes(4).toString("hex")}`,
  )
  const fixtureDir = path.join(tmp, "fixture")
  const dataDir = path.join(tmp, "data")
  try {
    await mkdir(fixtureDir, { recursive: true })
    await mkdir(dataDir, { recursive: true })
    await writeFile(
      path.join(fixtureDir, "smoke.py"),
      "def smoke_test_function():\n    return 1\n",
    )
  } catch {
    return { ok: false, reason: "smoke fixture setup failed" }
  }

  try {
    const env = dropColgrepSecrets({
      ...process.env,
      COLGREP_DATA_DIR: dataDir,
      ORT_DYLIB_PATH: ortDylibPath,
      COLGREP_FORCE_CPU: "1",
      // Co-locate ORT dir on PATH so dependent DLLs resolve on Windows.
      PATH: `${path.dirname(ortDylibPath)}${path.delimiter}${process.env.PATH ?? ""}`,
    })
    const res = await runManagedExeCapture(
      binaryPath,
      [
        "search",
        "--json",
        "--color",
        "never",
        "--force-cpu",
        "--model",
        modelDir,
        "-y",
        "-k",
        "1",
        "smoke",
        fixtureDir,
      ],
      { env, timeoutMs: SMOKE_TIMEOUT_MS, maxStdoutBytes: 4 * 1024 * 1024 },
    )
    if (res.timedOut) return { ok: false, reason: "smoke test timed out" }
    if (res.code !== 0) {
      return { ok: false, reason: `colgrep exited ${res.code}` }
    }
    // The ORT handoff guard: colgrep prints this EXACT phrase and falls
    // through to its own unverified download when ORT_DYLIB_PATH is bad.
    if (/not a loadable onnx runtime dylib/i.test(res.stderr)) {
      return { ok: false, reason: "ORT dylib failed to load (ORT_DYLIB_PATH ignored)" }
    }
    return { ok: true }
  } catch (err) {
    consola.debug("colbert: smoke test spawn failed:", err)
    return { ok: false, reason: "colgrep failed to launch (AV quarantine / missing runtime?)" }
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => {})
  }
}
