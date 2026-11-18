/**
 * Dev-only generator for src/lib/colbert/manifest.ts.
 *
 * Re-pins the SHA256 digests of the THREE ColBERT-sidecar artifacts (the
 * colgrep binary, the ONNX Runtime dylib, the 5 ColBERT INT8 model
 * files) for each supported (platform, arch). Re-run when bumping
 * `COLGREP_VERSION` / `ORT_VERSION` / `MODEL_REVISION`.
 *
 *   bun run scripts/gen-colbert-manifest.ts
 *
 * For the colgrep binary it reads the published `.sha256` sidecar so the
 * digest provenance is upstream's own checksum; for ORT and the model it
 * downloads the bytes and computes the digest. Output is a diff-able
 * report you paste into manifest.ts after eyeballing it.
 */

import { createHash } from "node:crypto"

const COLGREP_VERSION = process.env.COLGREP_VERSION ?? "1.5.2"
const ORT_VERSION = process.env.ORT_VERSION ?? "1.23.0"
const MODEL_REPO = "lightonai/LateOn-Code-edge"
const MODEL_REVISION =
  process.env.MODEL_REVISION ?? "07ef20f406c86badca122464808f4cac2f6e4b25"

const UA = { "User-Agent": "gh-router-colbert-gen" }

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, { headers: UA })
  if (!res.ok) throw new Error(`fetch ${url}: ${res.status}`)
  return res.text()
}

async function sha256(url: string): Promise<{ sha: string; size: number }> {
  const res = await fetch(url, { headers: UA })
  if (!res.ok) throw new Error(`download ${url}: ${res.status}`)
  const buf = Buffer.from(await res.arrayBuffer())
  return { sha: createHash("sha256").update(buf).digest("hex"), size: buf.length }
}

// --- colgrep binary (sidecar .sha256, no full download needed) ---------
const COLGREP_ASSETS: Record<string, string> = {
  "win32-x64": "colgrep-x86_64-pc-windows-msvc.zip",
  "darwin-arm64": "colgrep-aarch64-apple-darwin.tar.xz",
  "darwin-x64": "colgrep-x86_64-apple-darwin.tar.xz",
  "linux-x64": "colgrep-x86_64-unknown-linux-gnu.tar.xz",
}

console.error(`# colgrep ${COLGREP_VERSION}`)
const colgrepOut: Record<string, string> = {}
for (const [pa, asset] of Object.entries(COLGREP_ASSETS)) {
  const base = `https://github.com/lightonai/next-plaid/releases/download/v${COLGREP_VERSION}/${asset}`
  try {
    const sidecar = await fetchText(`${base}.sha256`)
    const sha = sidecar.trim().split(/\s+/)[0]
    colgrepOut[pa] = sha
    console.error(`  ${pa}: ${asset} ${sha.slice(0, 12)}… (from .sha256)`)
  } catch (e) {
    console.error(`  ${pa}: FAIL ${(e as Error).message}`)
  }
}

// --- ONNX Runtime CPU wheels (download + compute) ----------------------
// PyPI, not GitHub releases: the ORT GitHub repo and every release asset
// started 404ing on 2026-11-17 (see `ORT_LIB` in the manifest). The digest
// pinned here is the WHOLE WHEEL, which `extractZipMember` reads directly.
const ORT_WHEELS: Record<string, string> = {
  "win32-x64": `onnxruntime-${ORT_VERSION}-cp312-cp312-win_amd64.whl`,
  "darwin-arm64": `onnxruntime-${ORT_VERSION}-cp312-cp312-macosx_13_0_arm64.whl`,
  "darwin-x64": `onnxruntime-${ORT_VERSION}-cp312-cp312-macosx_13_0_x86_64.whl`,
  "linux-x64": `onnxruntime-${ORT_VERSION}-cp312-cp312-manylinux_2_27_x86_64.manylinux_2_28_x86_64.whl`,
}

console.error(`# onnxruntime ${ORT_VERSION} (pypi wheels)`)
const ortOut: Record<string, string> = {}
for (const [pa, filename] of Object.entries(ORT_WHEELS)) {
  try {
    // pypi.org/pypi/<pkg>/<ver>/json names the immutable files.pythonhosted
    // URL per file, which is what belongs in the manifest.
    const meta = (await (
      await fetch(`https://pypi.org/pypi/onnxruntime/${ORT_VERSION}/json`, {
        headers: UA,
      })
    ).json()) as { urls: Array<{ filename: string; url: string; digests: { sha256: string } }> }
    const entry = meta.urls.find((u) => u.filename === filename)
    if (!entry) throw new Error(`no wheel named ${filename}`)
    ortOut[pa] = entry.digests.sha256
    console.error(`  ${pa}: ${filename} ${entry.digests.sha256.slice(0, 12)}… -> ${entry.url}`)
  } catch (e) {
    console.error(`  ${pa}: FAIL ${(e as Error).message}`)
  }
}

// --- model files (per-file, at pinned revision) ------------------------
const MODEL_FILES = [
  "model_int8.onnx",
  "tokenizer.json",
  "config.json",
  "config_sentence_transformers.json",
  "onnx_config.json",
]

console.error(`# model ${MODEL_REPO}@${MODEL_REVISION}`)
const modelOut: Record<string, string> = {}
for (const f of MODEL_FILES) {
  const url = `https://huggingface.co/${MODEL_REPO}/resolve/${MODEL_REVISION}/${f}`
  try {
    const { sha, size } = await sha256(url)
    modelOut[f] = sha
    console.error(`  ${f}: ${sha.slice(0, 12)}… (${size} bytes)`)
  } catch (e) {
    console.error(`  ${f}: FAIL ${(e as Error).message}`)
  }
}

console.log(
  JSON.stringify(
    {
      COLGREP_VERSION,
      ORT_VERSION,
      MODEL_REPO,
      MODEL_REVISION,
      colgrep: colgrepOut,
      ort: ortOut,
      model: modelOut,
    },
    null,
    2,
  ),
)
