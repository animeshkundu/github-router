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

// --- ONNX Runtime archive (download + compute) -------------------------
const ORT_ASSETS: Record<string, string> = {
  "win32-x64": `onnxruntime-win-x64-${ORT_VERSION}.zip`,
  "darwin-arm64": `onnxruntime-osx-arm64-${ORT_VERSION}.tgz`,
  "darwin-x64": `onnxruntime-osx-x86_64-${ORT_VERSION}.tgz`,
  "linux-x64": `onnxruntime-linux-x64-${ORT_VERSION}.tgz`,
}

console.error(`# onnxruntime ${ORT_VERSION}`)
const ortOut: Record<string, string> = {}
for (const [pa, asset] of Object.entries(ORT_ASSETS)) {
  const url = `https://github.com/microsoft/onnxruntime/releases/download/v${ORT_VERSION}/${asset}`
  try {
    const { sha, size } = await sha256(url)
    ortOut[pa] = sha
    console.error(`  ${pa}: ${asset} ${sha.slice(0, 12)}… (${size} bytes)`)
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
