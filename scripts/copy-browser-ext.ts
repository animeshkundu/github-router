// Copies src/browser-ext/ to dist/browser-ext/ as part of the npm
// build. The extension is plain JSON + JS (no bundling required), but
// it has to live under dist/ so the npm "files" allowlist ships it.
// Mirrors the placement of the bundled bridge at dist/browser-bridge/.

import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, "..")
const src = path.join(repoRoot, "src", "browser-ext")
const dst = path.join(repoRoot, "dist", "browser-ext")

if (!existsSync(src)) {
  console.error(`copy-browser-ext: source dir missing at ${src}`)
  process.exit(1)
}

if (existsSync(dst)) rmSync(dst, { recursive: true, force: true })
mkdirSync(path.dirname(dst), { recursive: true })
cpSync(src, dst, {
  recursive: true,
  filter: (s) => {
    // README is dev-only context, no value for users loading the
    // unpacked extension; everything else (manifest.json,
    // background.js, future icons / content scripts) ships.
    return !s.endsWith("README.md")
  },
})
console.log(`copied ${src} → ${dst}`)
