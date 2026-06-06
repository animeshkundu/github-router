/**
 * Dev-only generator for src/lib/toolbelt/manifest.ts.
 *
 * Discovers the latest GitHub release of each toolbelt tool, downloads
 * the asset for each supported (platform, arch), computes its SHA256,
 * and prints a ready-to-paste `TOOLBELT_TOOLS` literal. Re-run to re-pin
 * (the SHA256 provenance is this script + the upstream release assets).
 *
 *   bun run scripts/gen-toolbelt-manifest.ts
 */

import { createHash } from "node:crypto"

type ArchiveKind = "raw" | "zip" | "tar.gz"
type PA = "win32-x64" | "win32-arm64" | "darwin-x64" | "darwin-arm64" | "linux-x64" | "linux-arm64"

const PAS: PA[] = ["win32-x64", "win32-arm64", "darwin-x64", "darwin-arm64", "linux-x64", "linux-arm64"]

interface ToolGen {
  command: string
  repo: string
  // returns a regex to match the asset filename for a platform-arch, or null if unsupported
  match: (pa: PA) => RegExp | null
  archive: (pa: PA) => ArchiveKind
}

const rustTriple: Record<PA, string | null> = {
  "win32-x64": "x86_64-pc-windows-msvc",
  "win32-arm64": "aarch64-pc-windows-msvc",
  "darwin-x64": "x86_64-apple-darwin",
  "darwin-arm64": "aarch64-apple-darwin",
  "linux-x64": "x86_64-unknown-linux-musl",
  "linux-arm64": "aarch64-unknown-linux-musl",
}
const rustTripleGnu: Record<PA, string | null> = {
  "win32-x64": "x86_64-pc-windows-msvc",
  "win32-arm64": "aarch64-pc-windows-msvc",
  "darwin-x64": "x86_64-apple-darwin",
  "darwin-arm64": "aarch64-apple-darwin",
  "linux-x64": "x86_64-unknown-linux-gnu",
  "linux-arm64": "aarch64-unknown-linux-gnu",
}

const TOOLS: ToolGen[] = [
  {
    command: "fd",
    repo: "sharkdp/fd",
    match: (pa) => {
      const t = rustTriple[pa]
      if (!t) return null
      const ext = pa.startsWith("win32") ? "zip" : "tar\\.gz"
      return new RegExp(`^fd-v[\\d.]+-${t}\\.${ext}$`)
    },
    archive: (pa) => (pa.startsWith("win32") ? "zip" : "tar.gz"),
  },
  {
    command: "sd",
    repo: "chmln/sd",
    match: (pa) => {
      const t = rustTriple[pa]
      if (!t) return null
      return new RegExp(`^sd-v[\\d.]+-${t}\\.(zip|tar\\.gz)$`)
    },
    archive: (pa) => (pa.startsWith("win32") ? "zip" : "tar.gz"),
  },
  {
    command: "jq",
    repo: "jqlang/jq",
    match: (pa) => {
      const m: Record<PA, string | null> = {
        "win32-x64": "jq-windows-amd64.exe",
        "win32-arm64": "jq-windows-arm64.exe",
        "darwin-x64": "jq-macos-amd64",
        "darwin-arm64": "jq-macos-arm64",
        "linux-x64": "jq-linux-amd64",
        "linux-arm64": "jq-linux-arm64",
      }
      const f = m[pa]
      return f ? new RegExp(`^${f.replace(/\./g, "\\.")}$`) : null
    },
    archive: () => "raw",
  },
  {
    command: "yq",
    repo: "mikefarah/yq",
    match: (pa) => {
      const m: Record<PA, string | null> = {
        "win32-x64": "yq_windows_amd64.exe",
        "win32-arm64": "yq_windows_arm64.exe",
        "darwin-x64": "yq_darwin_amd64",
        "darwin-arm64": "yq_darwin_arm64",
        "linux-x64": "yq_linux_amd64",
        "linux-arm64": "yq_linux_arm64",
      }
      const f = m[pa]
      return f ? new RegExp(`^${f.replace(/\./g, "\\.")}$`) : null
    },
    archive: () => "raw",
  },
  {
    command: "ast-grep",
    repo: "ast-grep/ast-grep",
    match: (pa) => {
      const t = rustTripleGnu[pa]
      if (!t) return null
      return new RegExp(`^app-${t}\\.zip$`)
    },
    archive: () => "zip",
  },
  {
    command: "tokei",
    repo: "XAMPPRocky/tokei",
    match: (pa) => {
      const t = rustTripleGnu[pa]
      if (!t) return null
      const ext = pa.startsWith("win32") ? "exe" : "tar\\.gz"
      return new RegExp(`^tokei-${t}\\.${ext}$`)
    },
    archive: (pa) => (pa.startsWith("win32") ? "raw" : "tar.gz"),
  },
]

interface Asset {
  name: string
  browser_download_url: string
}

async function ghLatest(repo: string): Promise<{ tag: string; assets: Asset[] }> {
  const res = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
    headers: { "User-Agent": "gh-router-toolbelt-gen", Accept: "application/vnd.github+json" },
  })
  if (!res.ok) throw new Error(`${repo}: ${res.status}`)
  const j = (await res.json()) as { tag_name: string; assets: Asset[] }
  return { tag: j.tag_name, assets: j.assets }
}

async function sha256(url: string): Promise<string> {
  const res = await fetch(url, { headers: { "User-Agent": "gh-router-toolbelt-gen" } })
  if (!res.ok) throw new Error(`download ${url}: ${res.status}`)
  const buf = Buffer.from(await res.arrayBuffer())
  return createHash("sha256").update(buf).digest("hex")
}

const out: Record<string, { command: string; archive: Record<string, ArchiveKind>; assets: Record<string, { url: string; sha256: string; archive: ArchiveKind }> }> = {}

for (const tool of TOOLS) {
  const { tag, assets } = await ghLatest(tool.repo)
  console.error(`# ${tool.command} ${tag} (${assets.length} assets)`)
  out[tool.command] = { command: tool.command, archive: {}, assets: {} }
  for (const pa of PAS) {
    const re = tool.match(pa)
    if (!re) continue
    const asset = assets.find((a) => re.test(a.name))
    if (!asset) {
      console.error(`  ${pa}: NO MATCH for ${re}`)
      continue
    }
    try {
      const hash = await sha256(asset.browser_download_url)
      out[tool.command].assets[pa] = {
        url: asset.browser_download_url,
        sha256: hash,
        archive: tool.archive(pa),
      }
      console.error(`  ${pa}: ${asset.name} ${hash.slice(0, 12)}…`)
    } catch (e) {
      console.error(`  ${pa}: FAIL ${(e as Error).message}`)
    }
  }
}

console.log(JSON.stringify(out, null, 2))
