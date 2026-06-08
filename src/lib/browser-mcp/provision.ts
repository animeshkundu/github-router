// provision.ts — materialize the browser extension + bridge bundle into
// a STABLE app-dir so a one-time Chrome "Load unpacked" survives package
// upgrades, and stamp the running proxy version into the materialized
// manifest in a single place on every launch.
//
// Why this exists: `extensionDir()` / `bridgeBundlePath()` used to resolve
// into the npm package root, which under `npx` / `bunx` is an ephemeral
// cache path that changes per version. A persisted "Load unpacked"
// extension only stays valid while its directory path is constant, so an
// upgrade broke it; the bridge launcher's `path` pointed at a soon-to-be-
// GC'd bundle; and the version-mismatch auto-reload re-read files from the
// dead path. Materializing into `<APP_DIR>/browser-ext` and
// `<APP_DIR>/browser-bridge/index.js` makes the "Load unpacked" target,
// the launcher, and the auto-reload all point at a path that never moves.
//
// Shape mirrors provisionToolbelt() / provisionAndIndexColbert(): single-
// flight, idempotent via a content-signature sidecar, and NEVER throws —
// a provisioning failure must not crash launch (the lazy install-check
// pre-flight still surfaces an actionable install_required).

import { createHash } from "node:crypto"
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import path from "node:path"

import consola from "consola"

import { getPackageVersion } from "../version"
import { detectSupportedBrowsers } from "./browser-detect"
import {
  bundledBridgeBundlePath,
  bundledExtensionDir,
  installNativeHostForAll,
  stableBridgeBundlePath,
  stableExtensionDir,
} from "./native-host-installer"

/** Sidecar holding the content signature of the last materialized copy. */
const SIGNATURE_FILE = ".provisioned"

/** Source files excluded from both the copy and the content signature. */
const EXCLUDED_FILES = new Set(["README.md", SIGNATURE_FILE])

let _provisioned = false
let _inFlight: Promise<void> | undefined

/**
 * Materialize the extension + bridge into the stable app-dir and stamp
 * the running version. Single-flight + once-guarded so the startup fire-
 * and-forget and the lazy install-check call collapse to one run per
 * process. Resolves (never rejects) regardless of outcome.
 */
export function provisionBrowserAssets(): Promise<void> {
  if (_provisioned) return Promise.resolve()
  if (_inFlight) return _inFlight
  _inFlight = _provisionImpl().finally(() => {
    _inFlight = undefined
  })
  return _inFlight
}

/** @internal — reset module state between test cases. */
export function __resetProvisionForTests(): void {
  _provisioned = false
  _inFlight = undefined
}

async function _provisionImpl(): Promise<void> {
  try {
    // Opt-out: skip materialization entirely. Useful when a user wants to
    // load the extension straight from a checkout (paired with
    // GH_ROUTER_BROWSER_EXT_DIR), and the lever tests use to stay hermetic.
    // Not once-guarded so toggling it back on re-enables provisioning.
    if (process.env.GH_ROUTER_DISABLE_BROWSER_PROVISION === "1") return

    const srcExtDir = bundledExtensionDir()
    const srcBridge = bundledBridgeBundlePath()

    // Fresh source checkout that hasn't run `bun run build`: the bundled
    // bridge bundle doesn't exist yet. Skip — the lazy pre-flight will
    // surface bridge_bundle_missing with the "run bun run build" hint,
    // and extensionDir() falls back to the bundled (src) dir meanwhile.
    if (!existsSync(srcBridge)) return

    const destExtDir = stableExtensionDir()
    const destBridge = stableBridgeBundlePath()
    const sigPath = path.join(destExtDir, SIGNATURE_FILE)
    const signature = computeSignature(srcExtDir, srcBridge)

    const upToDate =
      existsSync(path.join(destExtDir, "manifest.json"))
      && existsSync(destBridge)
      && readSignature(sigPath) === signature

    // Tracks whether the stable copy fully matches the source after this
    // run. A deferred bridge update (Windows file-in-use) or a failed
    // version stamp leaves it false so we DON'T latch _provisioned and a
    // later in-process call retries (the signature also stays unwritten).
    let fullySynced = true
    if (!upToDate) {
      materializeExtension(srcExtDir, destExtDir)
      const stampOk = stampVersion(destExtDir)
      const bridgeUpdated = tryMaterializeBridge(srcBridge, destBridge)
      if (stampOk && bridgeUpdated) {
        writeSignature(sigPath, signature)
      } else {
        fullySynced = false
      }
    }

    // (Re)write the launcher shim + NMH manifests so they point at the
    // stable bridge. Best-effort — a registry / file write hiccup here
    // must not abort provisioning (the lazy pre-flight retries it).
    let hostOk = true
    try {
      const browsers = detectSupportedBrowsers()
      if (browsers.length > 0) installNativeHostForAll(browsers)
    } catch (err) {
      hostOk = false
      consola.debug("[browser-mcp] native-host install during provision failed:", err)
    }

    // Latch the once-guard only when the stable copy is fully in sync AND
    // the native-host install succeeded, so a deferred update or a failed
    // host install is retried by the next browser_* tool call.
    if (fullySynced && hostOk) _provisioned = true
  } catch (err) {
    // Never throw — provisioning is best-effort. Leaves _provisioned
    // false so a later call retries.
    consola.debug("[browser-mcp] provisionBrowserAssets failed:", err)
  }
}

// ---------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------

function computeSignature(srcExtDir: string, srcBridge: string): string {
  const h = createHash("sha256")
  // Hash EVERY shipped top-level file (sorted for determinism) rather than
  // a hardcoded list, so a newly-added extension asset changes the
  // signature and triggers a re-copy. Subdirectories aren't descended into
  // (the extension is flat today); a future nested asset would still be
  // copied on any version bump, which also moves the signature.
  let names: string[]
  try {
    names = readdirSync(srcExtDir)
      .filter((n) => !EXCLUDED_FILES.has(n))
      .sort()
  } catch {
    names = []
  }
  for (const name of names) {
    h.update(name)
    try {
      h.update(readFileSync(path.join(srcExtDir, name)))
    } catch {
      // A directory entry or unreadable file — fold its name in so its
      // presence still affects the signature.
      h.update(`\x00unreadable:${name}\x00`)
    }
  }
  h.update("bridge")
  try {
    h.update(readFileSync(srcBridge))
  } catch {
    h.update("\x00missing:bridge\x00")
  }
  // Version participates so a same-content republish under a new version
  // re-stamps the manifest and lets the auto-reload mismatch fire.
  h.update(`\x00version:${getPackageVersion()}\x00`)
  return h.digest("hex")
}

function readSignature(sigPath: string): string | undefined {
  try {
    return readFileSync(sigPath, "utf8").trim()
  } catch {
    return undefined
  }
}

function writeSignature(sigPath: string, signature: string): void {
  writeFileSync(sigPath, signature, "utf8")
}

/**
 * Copy the bundled extension dir into the stable dir, overwriting in
 * place. README and our sidecar are filtered out. We do NOT prune extra
 * files in the destination (a stale file left from an older version is
 * harmless — Chrome loads only what the manifest references).
 */
function materializeExtension(srcDir: string, destDir: string): void {
  mkdirSync(destDir, { recursive: true })
  cpSync(srcDir, destDir, {
    recursive: true,
    force: true,
    filter: (s) => !EXCLUDED_FILES.has(path.basename(s)),
  })
}

/**
 * Copy the bridge bundle into the stable path via temp-write + atomic
 * rename. Returns true on update; false when the destination couldn't be
 * replaced but a usable stable bridge already exists (e.g. Windows
 * EBUSY because a bridge process holds the old file — acceptable, the
 * old bridge is the version about to be reloaded). Throws only when there
 * is no usable bridge at all.
 */
function tryMaterializeBridge(srcBridge: string, destBridge: string): boolean {
  mkdirSync(path.dirname(destBridge), { recursive: true })
  const tmp = `${destBridge}.tmp-${process.pid}`
  try {
    writeFileSync(tmp, readFileSync(srcBridge))
    renameSync(tmp, destBridge)
    return true
  } catch (err) {
    try {
      rmSync(tmp, { force: true })
    } catch {
      // best-effort temp cleanup
    }
    if (existsSync(destBridge)) {
      consola.debug("[browser-mcp] bridge update deferred (file in use?):", err)
      return false
    }
    throw err
  }
}

/**
 * Stamp the running proxy version into the materialized manifest — the
 * single place the version is set on launch. Returns true when the
 * manifest is in its intended end state (stamped, already-correct, or
 * deliberately left at the bundled stamp for a non-Chrome-compliant
 * version), false only when a read/write threw. Chrome requires
 * `manifest.version` to be 1-4 dot-separated integers, so a non-numeric
 * value (`"unknown"`, a prerelease/build semver) is left as the bundled
 * build-time stamp rather than written (which would make the unpacked
 * extension fail to load).
 */
function stampVersion(destExtDir: string): boolean {
  const version = getPackageVersion()
  if (!/^\d{1,9}(\.\d{1,9}){0,3}$/.test(version)) return true
  const manifestPath = path.join(destExtDir, "manifest.json")
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<
      string,
      unknown
    >
    if (manifest.version === version) return true
    manifest.version = version
    // Atomic temp-write + rename so a concurrent launch can't observe a
    // half-written manifest, and two interleaved read-modify-writes can't
    // corrupt it (last writer wins a whole, valid file).
    const tmp = `${manifestPath}.tmp-${process.pid}`
    writeFileSync(tmp, `${JSON.stringify(manifest, null, 2)}\n`)
    renameSync(tmp, manifestPath)
    return true
  } catch (err) {
    consola.debug("[browser-mcp] manifest version stamp failed:", err)
    return false
  }
}
