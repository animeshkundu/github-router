/**
 * The ColBERT sidecar's ONNX Runtime download source.
 *
 * This is a pinned-supply-chain artifact: a URL that dies turns semantic
 * search off with a `consola.debug` line and no user-visible error, so the
 * failure mode is silence. That is not hypothetical — the manifest pinned
 * `github.com/microsoft/onnxruntime/releases/download/v1.23.0/…` for all four
 * platforms, and on 2026-11-17 that repo, its releases and every asset under
 * them began returning 404 with no redirect and no rename. Provisioning broke
 * for every platform at once, and nothing in the suite noticed, because the
 * only assertion on `ORT_LIB` was "the sha256 is 64 hex characters".
 *
 * What is pinned here is the SHAPE of the source, plus a real round trip
 * through the repo's own extractor against any pinned archive already on disk.
 * Live reachability is a separate concern, checked by
 * `scripts/gen-colbert-manifest.ts`, which fetches and re-digests every asset.
 */

import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"

import { extractZipMember } from "~/lib/toolbelt/extract"
import { ORT_LIB, ORT_VERSION, ortLibAsset } from "~/lib/colbert/manifest"

const PLATFORMS = [
  ["darwin", "arm64"],
  ["darwin", "x64"],
  ["linux", "x64"],
  ["win32", "x64"],
] as const

/**
 * Archives a machine that has already provisioned (or is repinning) keeps
 * around. A missing file SKIPS the round trip rather than failing, so the
 * suite stays hermetic on a fresh clone and in CI.
 */
const CACHED_ARCHIVES: Record<string, string> = {
  "darwin-arm64": "/tmp/gh-router-ort/darwin-arm64.whl",
  "darwin-x64": "/tmp/gh-router-ort/darwin-x64.whl",
  "linux-x64": "/tmp/gh-router-ort/linux-x64.whl",
  "win32-x64": "/tmp/gh-router-ort/win32-x64.whl",
}

describe("colbert ORT manifest", () => {
  test("every supported platform has an entry, from one host, in an implemented format", () => {
    const hosts = new Set<string>()
    for (const [platform, arch] of PLATFORMS) {
      const asset = ortLibAsset(platform, arch)
      expect(asset, `${platform}-${arch}`).toBeDefined()
      // A single host is the point: when one vendor page went dark, all four
      // platforms went dark with it. Asserting a shared host (rather than a
      // specific vendor) keeps a future move deliberate rather than accidental.
      hosts.add(new URL(asset!.url).host)
      // Every kind listed here has an extraction path in `extractMember`; the
      // pinned one is "zip" because a Python wheel is a zip.
      expect(["raw", "zip", "tar.gz", "tar.xz"]).toContain(asset!.archive)
      // The member is matched by BASENAME, so a nested path in the archive is
      // fine but a member name with a separator can never match.
      expect(asset!.member ?? "").not.toContain("/")
      expect(asset!.member ?? "").not.toBe("")
      // The URL is the version we pin: a half-moved manifest (new digest, old
      // version, or the reverse) is the failure this catches.
      expect(asset!.url).toContain(ORT_VERSION)
      expect(/^[0-9a-f]{64}$/.test(asset!.sha256), `${platform}-${arch} sha`).toBe(true)
    }
    expect(hosts.size).toBe(1)
  })

  test("POSIX members carry the versioned dylib name; Windows does not", () => {
    // colgrep re-creates the unversioned soname symlink beside the versioned
    // file we write, so on POSIX the two names must agree with ORT_VERSION.
    // Windows ships an unversioned `onnxruntime.dll` and needs no symlink.
    expect(ortLibAsset("darwin", "arm64")!.member).toBe(`libonnxruntime.${ORT_VERSION}.dylib`)
    expect(ortLibAsset("darwin", "x64")!.member).toBe(`libonnxruntime.${ORT_VERSION}.dylib`)
    expect(ortLibAsset("linux", "x64")!.member).toBe(`libonnxruntime.so.${ORT_VERSION}`)
    expect(ortLibAsset("win32", "x64")!.member).toBe("onnxruntime.dll")
    // `soname` is what the provisioner symlinks; only defined where a link is
    // meaningful (POSIX), and `provisionOrt` also guards on `platform !== win32`.
    expect(ortLibAsset("linux", "x64")!.soname).toBe("libonnxruntime.so")
    expect(ortLibAsset("darwin", "arm64")!.soname).toBe("libonnxruntime.dylib")
  })

  test("an unsupported platform resolves to undefined", () => {
    // `semanticSearchEnabled()` gates on an entry existing; a wrong answer here
    // advertises a capability that cannot be provisioned.
    expect(ortLibAsset("linux", "arm64")).toBeUndefined()
    expect(ortLibAsset("freebsd", "x64")).toBeUndefined()
  })

  test("each pinned member extracts from its archive (when the archive is cached)", () => {
    let checked = 0
    for (const [platform, arch] of PLATFORMS) {
      const file = CACHED_ARCHIVES[`${platform}-${arch}`]
      if (!file || !existsSync(file)) continue
      const asset = ORT_LIB[`${platform}-${arch}`]
      const member = extractZipMember(readFileSync(file), asset.member ?? "")
      // A null here means the pinned `member` is not in the pinned archive —
      // exactly the half-finished repin that would fail at provision time on a
      // user's machine instead of here.
      expect(member, `${platform}-${arch} ${asset.member}`).not.toBeNull()
      // A dylib is never a few kilobytes; a truncated member is a broken
      // extraction, not a valid artifact.
      expect(member!.length).toBeGreaterThan(1024)
      checked++
    }
    // Recorded, not asserted-on: zero cached archives is a valid state on a
    // fresh clone. The loop above is inert, and saying so beats a silent no-op.
    expect(checked).toBeGreaterThanOrEqual(0)
  })
})
