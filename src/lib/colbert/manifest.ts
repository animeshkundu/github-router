/**
 * ColBERT sidecar manifest: pinned versions, download URLs and SHA256
 * digests for the THREE artifacts the `colgrep` semantic-search sidecar
 * needs — the colgrep binary, the ONNX Runtime dylib, and the ColBERT
 * INT8 model files.
 *
 * The SHA256 values are hardcoded HERE (NOT fetched from the same
 * release at runtime). For colgrep they're read from the published
 * `.sha256` sidecar at manifest-generation time; for ORT and the model
 * they're computed over the bytes we pin. **colgrep itself does ZERO
 * checksum verification** on its own HF-model and ORT downloads
 * (`model.rs` trusts `hf-hub`; `onnx_runtime.rs` `ureq::get(...)` with
 * no digest check), so pre-supplying both SHA-pinned is not just
 * convenience — it closes a supply-chain hole colgrep leaves open.
 *
 * Regenerate with `bun run scripts/gen-colbert-manifest.ts` when
 * re-pinning; the script downloads each asset and recomputes the digest.
 *
 * See docs/research/colbert-sidecar-design.md §3 for the full
 * supply-chain rationale.
 */

/** Archive container of a downloaded artifact. */
export type ColbertArchiveKind = "raw" | "zip" | "tar.gz" | "tar.xz"

export interface ColbertAsset {
  url: string
  /** SHA256 of the downloaded archive/file (hex). Verified before extraction. */
  sha256: string
  archive: ColbertArchiveKind
  /**
   * Basename of the member to extract from the archive (no path).
   * Ignored for `raw`. For colgrep this is `colgrep`/`colgrep.exe`; for
   * ORT it's the platform dylib basename.
   */
  member?: string
}

/** colgrep release version pinned by this manifest. */
export const COLGREP_VERSION = "1.5.2"
/** ONNX Runtime version colgrep pins (`onnx_runtime.rs:33`). */
export const ORT_VERSION = "1.23.0"
/** ColBERT model HF repo id (`model.rs:5`). */
export const MODEL_REPO = "lightonai/LateOn-Code-edge"
/**
 * Pinned model revision (commit SHA). Pins BOTH integrity (per-file SHA)
 * and version (revision) so a model re-publish upstream can't silently
 * change ranking. `--model <local-dir>` short-circuits HF entirely
 * (`model.rs:27-30`), so this revision is only used at provision time.
 */
export const MODEL_REVISION = "07ef20f406c86badca122464808f4cac2f6e4b25"

/**
 * The 5 required model files (`model.rs:8-14`). We deliberately ship
 * ONLY `model_int8.onnx` (NOT the 68 MB FP32 `model.onnx`): smaller
 * footprint, faster CPU inference, the published-recommended edge
 * config. Since we own the local model dir, omitting `model.onnx`
 * makes INT8 the only option present.
 */
export interface ModelFileSpec {
  name: string
  sha256: string
}

/** colgrep binary, keyed `<platform>-<arch>`. */
export const COLGREP_BIN: Record<string, ColbertAsset> = {
  "win32-x64": {
    url: "https://github.com/lightonai/next-plaid/releases/download/v1.5.2/colgrep-x86_64-pc-windows-msvc.zip",
    sha256: "5986665a13e50c0c714be45d9f083ac65c243d549f7de52f72d2ecb8ead70c18",
    archive: "zip",
    member: "colgrep.exe",
  },
  "darwin-arm64": {
    url: "https://github.com/lightonai/next-plaid/releases/download/v1.5.2/colgrep-aarch64-apple-darwin.tar.xz",
    sha256: "28beb4524124681a6b82967d00eea92272ef7ac4cb9b4132bb193d429288ead7",
    archive: "tar.xz",
    member: "colgrep",
  },
  "darwin-x64": {
    url: "https://github.com/lightonai/next-plaid/releases/download/v1.5.2/colgrep-x86_64-apple-darwin.tar.xz",
    sha256: "763939edb80e93c0c9405b62929d804c0f72ae85a4a73f879ef122839264f557",
    archive: "tar.xz",
    member: "colgrep",
  },
  "linux-x64": {
    url: "https://github.com/lightonai/next-plaid/releases/download/v1.5.2/colgrep-x86_64-unknown-linux-gnu.tar.xz",
    sha256: "2e736e7abb32a084cfd33f78979fad577e5650e4112b28bef78a438a643f44b5",
    archive: "tar.xz",
    member: "colgrep",
  },
}

/**
 * ONNX Runtime CPU dylib archive, keyed `<platform>-<arch>`. `member`
 * is the VERSIONED dylib basename inside the archive. The provisioner
 * re-creates the unversioned soname symlink colgrep's `ORT_LIB_NAME`
 * expects (`libonnxruntime.so` → `…so.1.23.0`,
 * `libonnxruntime.dylib` → `…1.23.0.dylib`).
 *
 * These used to be the official GitHub release tarballs. On 2026-11-17
 * `github.com/microsoft/onnxruntime` — repo, releases and every tag —
 * started returning 404, with no redirect, no rename and no GitHub-side
 * notice, while every OTHER GitHub release we pin stayed up. The CUDA
 * postinstall of `onnxruntime-node` broke on it in CI the same day
 * (`tests/dependency-install-safety.test.ts`). A sidecar that cannot be
 * provisioned is a silent semantic-search outage, so the source moved to
 * the CPU wheels on PyPI, which are versioned, immutable, and served from
 * `files.pythonhosted.org` rather than a single vendor page.
 *
 * A wheel is a zip, so `extractZipMember` reads it as-is: it matches on
 * BASENAME, and each wheel ships exactly one `libonnxruntime*`/
 * `onnxruntime.dll`, so the nested `onnxruntime/capi/` path is harmless.
 * The `cp312` builds are pinned because the dylib and `.so` differ
 * byte-wise per Python ABI; which build we take is arbitrary as long as
 * it is pinned, since the dylib is loaded via `ORT_DYLIB_PATH` by
 * `colgrep`, not by Python. The NuGet CPU package carries the SAME
 * `libonnxruntime` bytes (verified byte-for-byte for osx-arm64), so this
 * is a mirror move, not an upgrade: `ORT_VERSION`, the soname suffix and
 * colgrep's own pinned runtime are unchanged.
 */
export const ORT_LIB: Record<
  string,
  ColbertAsset & { soname?: string }
> = {
  "win32-x64": {
    url: "https://files.pythonhosted.org/packages/19/90/d5b4ea0bd6805f3f21aac2fe549a5b58ee10d1c99c499d867539620a002b/onnxruntime-1.23.0-cp312-cp312-win_amd64.whl",
    sha256: "e100f3869da4c12b17a9b942934a96a542406f860eb8beb74a68342ea43aaa55",
    archive: "zip",
    member: "onnxruntime.dll",
  },
  "darwin-arm64": {
    url: "https://files.pythonhosted.org/packages/fb/33/ec5395c9539423246e4976d6ec7c4e7a4624ad8bcbe783fea5c629d7980a/onnxruntime-1.23.0-cp312-cp312-macosx_13_0_arm64.whl",
    sha256: "5921f2e106f5faf2b32095b2ecdfae047e445c3bce063e439dadc75c212e7be7",
    archive: "zip",
    member: "libonnxruntime.1.23.0.dylib",
    soname: "libonnxruntime.dylib",
  },
  "darwin-x64": {
    url: "https://files.pythonhosted.org/packages/f0/3c/d1976a9933e075291a3d67f4e949c667ff36a3e3a4a0cbd883af3c4eae5a/onnxruntime-1.23.0-cp312-cp312-macosx_13_0_x86_64.whl",
    sha256: "053df2f9c6522b258055bce4b776aa9ea3adb4b28d2530ab07b204a3d4b04bf9",
    archive: "zip",
    member: "libonnxruntime.1.23.0.dylib",
    soname: "libonnxruntime.dylib",
  },
  "linux-x64": {
    url: "https://files.pythonhosted.org/packages/0b/62/84f23952d01e07ce8aa02e657e3a0c8fa40aba0d5e11a0e9904a9063af76/onnxruntime-1.23.0-cp312-cp312-manylinux_2_27_x86_64.manylinux_2_28_x86_64.whl",
    sha256: "05f67edb93678cab5cd77eda89b65bb1b58f3d4c0742058742cfad8b172cfa83",
    archive: "zip",
    member: "libonnxruntime.so.1.23.0",
    soname: "libonnxruntime.so",
  },
}

/**
 * The 5 model files, per-file SHA-pinned at `MODEL_REVISION`. Downloaded
 * from `https://huggingface.co/<repo>/resolve/<rev>/<file>`. These are
 * platform-agnostic (the model is the same on every OS).
 */
export const MODEL_FILES: ReadonlyArray<ModelFileSpec> = [
  {
    name: "model_int8.onnx",
    sha256: "eac35bdaa862e2762e6455337f7a3e704b05dbc4259f00929fcc8e10207f11c7",
  },
  {
    name: "tokenizer.json",
    sha256: "a388b94942e98e5c661c6c23f919842285738bfd123a0d148dea0c56287505d0",
  },
  {
    name: "config.json",
    sha256: "c1413b20ad05927b8226aa2223b3ae104cd04c8541fe1300bdcf455fc8667601",
  },
  {
    name: "config_sentence_transformers.json",
    sha256: "34942289dec20e285b07132aa1d09980ed776a0bc34e531dd7b49c4701876871",
  },
  {
    name: "onnx_config.json",
    sha256: "fa4fef89820dcdc33c5504c62c1d5efc19603cfbfebf02368a70d51a4dbe6651",
  },
]

export function platformArchKey(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string {
  return `${platform}-${arch}`
}

/** colgrep binary asset for this platform, or undefined if unsupported. */
export function colgrepBinAsset(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): ColbertAsset | undefined {
  return COLGREP_BIN[platformArchKey(platform, arch)]
}

/** ORT dylib asset for this platform, or undefined if unsupported. */
export function ortLibAsset(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): (ColbertAsset & { soname?: string }) | undefined {
  return ORT_LIB[platformArchKey(platform, arch)]
}

/**
 * True iff a prebuilt colgrep + ORT asset exist for this platform-arch.
 * Used by `semanticSearchEnabled()`: the capability is platform-gated on
 * a manifest entry existing, NOT on "already downloaded" (gating on
 * download would hide the very tool whose first call triggers
 * provisioning).
 */
export function colbertPlatformSupported(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): boolean {
  return (
    colgrepBinAsset(platform, arch) !== undefined &&
    ortLibAsset(platform, arch) !== undefined
  )
}

/** Model dir basename (the `<rev>` leaf under `models/LateOn-Code-edge/`). */
export function modelDirName(): string {
  return MODEL_REVISION
}

/** Short model id used in the sidecar metadata `model` field. */
export const MODEL_ID = "LateOn-Code-edge"

/** next-plaid-api release tag these server binaries are promoted from. */
export const NEXTPLAID_SERVER_TAG = "next-plaid-server-v1.7.0"

/** Compute flavour of a next-plaid-api server binary. */
export type NextPlaidServerVariant = "cpu" | "cuda"

export interface NextPlaidServerAsset {
  url: string
  /**
   * SHA256 of the downloaded binary (hex). Verified before use.
   * EMPTY means "not yet promoted" — the promotion workflow
   * (.github/workflows/promote-next-plaid.yml) fills it from a real
   * build; provisioning treats an empty digest as unavailable
   * (fail closed, never downloads an unverified binary).
   */
  sha256: string
  archive: "raw"
  variant: NextPlaidServerVariant
  /** Minimum NVIDIA driver major required (cuda variant only). */
  cudaVersion?: string
}

function nextPlaidServerUrl(asset: string): string {
  return `https://github.com/animeshkundu/github-router/releases/download/${NEXTPLAID_SERVER_TAG}/${asset}`
}

/**
 * next-plaid-api server binaries, keyed `<platform>-<arch>-<variant>`.
 * Built by .github/workflows/next-plaid-server.yml from the pinned
 * upstream tag: cpu = OpenBLAS-static (Linux/Windows) / Accelerate
 * (macOS); cuda = + CUDA execution provider (Linux/Windows x64 only).
 * macOS has no cuda variant (no NVIDIA target); linux-arm64 and
 * win-arm64 have no entries (unsupported → lexical fallback).
 */
export const NEXTPLAID_SERVER: Record<string, NextPlaidServerAsset> = {
  "linux-x64-cpu": {
    url: nextPlaidServerUrl("next-plaid-api-x86_64-unknown-linux-gnu"),
    sha256: "799b69de51c8f9978ea6537315da4ad63f9c2fd6f0b50f3ea8021d7ffdbc0aa3",
    archive: "raw",
    variant: "cpu",
  },
  "linux-x64-cuda": {
    url: nextPlaidServerUrl("next-plaid-api-x86_64-unknown-linux-gnu-cuda"),
    sha256: "94adc97569abc4ea58d411cb23e6692c70b23e18eef0071d08fe97bc159a12d6",
    archive: "raw",
    variant: "cuda",
    cudaVersion: "12.8",
  },
  "win32-x64-cpu": {
    url: nextPlaidServerUrl("next-plaid-api-x86_64-pc-windows-msvc.exe"),
    sha256: "86c243c15f84ff32186f6fe04e98c2d71d922e13a2fdaa9b95da3ac2df8ff7a1",
    archive: "raw",
    variant: "cpu",
  },
  "win32-x64-cuda": {
    url: nextPlaidServerUrl("next-plaid-api-x86_64-pc-windows-msvc-cuda.exe"),
    sha256: "f235faf71fbcec0a28024cb416e3060c62f035f446a4eb3a1024220be0666edc",
    archive: "raw",
    variant: "cuda",
    cudaVersion: "12.8",
  },
  "darwin-arm64-cpu": {
    url: nextPlaidServerUrl("next-plaid-api-aarch64-apple-darwin"),
    sha256: "04d8d8ab6a49617076e1c0f4ff7756a555efd159890d5c3ea1adf54bae0238bb",
    archive: "raw",
    variant: "cpu",
  },
  "darwin-x64-cpu": {
    url: nextPlaidServerUrl("next-plaid-api-x86_64-apple-darwin"),
    sha256: "f3bca729db0043c7b609731ea095685fc2a72f0c2f58571b33c4fa52691fbe98",
    archive: "raw",
    variant: "cpu",
  },
}

/** Server asset for this platform-arch-variant, or undefined if unsupported. */
export function nextPlaidServerAsset(
  variant: NextPlaidServerVariant,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): NextPlaidServerAsset | undefined {
  return NEXTPLAID_SERVER[`${platformArchKey(platform, arch)}-${variant}`]
}

/** True iff a promoted (SHA-pinned) server binary exists for this variant. */
export function nextPlaidServerPromoted(
  variant: NextPlaidServerVariant,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): boolean {
  const asset = nextPlaidServerAsset(variant, platform, arch)
  return asset !== undefined && asset.sha256.length > 0
}
