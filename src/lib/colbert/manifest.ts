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
 * is the VERSIONED dylib basename inside the archive's `lib/` dir. The
 * Windows `.zip` ALSO ships a 377 MB `.pdb` (debug symbols) and `.lib`
 * import libs — we extract ONLY the `.dll`. On POSIX the archive ships
 * the versioned dylib plus an unversioned soname symlink; the
 * provisioner re-creates the soname symlink colgrep's `ORT_LIB_NAME`
 * expects (`libonnxruntime.so` → `…so.1.23.0`,
 * `libonnxruntime.dylib` → `…1.23.0.dylib`).
 */
export const ORT_LIB: Record<
  string,
  ColbertAsset & { soname?: string }
> = {
  "win32-x64": {
    url: "https://github.com/microsoft/onnxruntime/releases/download/v1.23.0/onnxruntime-win-x64-1.23.0.zip",
    sha256: "72c23470310ec79a7d42d27fe9d257e6c98540c73fa5a1db1f67f538c6c16f2f",
    archive: "zip",
    member: "onnxruntime.dll",
  },
  "darwin-arm64": {
    url: "https://github.com/microsoft/onnxruntime/releases/download/v1.23.0/onnxruntime-osx-arm64-1.23.0.tgz",
    sha256: "8182db0ebb5caa21036a3c78178f17fabb98a7916bdab454467c8f4cf34bcfdf",
    archive: "tar.gz",
    member: "libonnxruntime.1.23.0.dylib",
    soname: "libonnxruntime.dylib",
  },
  "darwin-x64": {
    url: "https://github.com/microsoft/onnxruntime/releases/download/v1.23.0/onnxruntime-osx-x86_64-1.23.0.tgz",
    sha256: "a8e43edcaa349cbfc51578a7fc61ea2b88793ccf077b4bc65aca58999d20cf0f",
    archive: "tar.gz",
    member: "libonnxruntime.1.23.0.dylib",
    soname: "libonnxruntime.dylib",
  },
  "linux-x64": {
    url: "https://github.com/microsoft/onnxruntime/releases/download/v1.23.0/onnxruntime-linux-x64-1.23.0.tgz",
    sha256: "b6deea7f2e22c10c043019f294a0ea4d2a6c0ae52a009c34847640db75ec5580",
    archive: "tar.gz",
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
