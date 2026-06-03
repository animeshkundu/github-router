// Copies src/browser-ext/ to dist/browser-ext/ as part of the npm
// build. The extension is plain JSON + JS (no bundling required), but
// it has to live under dist/ so the npm "files" allowlist ships it.
// Mirrors the placement of the bundled bridge at dist/browser-bridge/.
//
// Also stamps the package.json version into dist/browser-ext/manifest.json
// so the extension's chrome.runtime.getManifest().version matches the
// proxy's expected version — pre-flight uses this to detect when a
// loaded extension is stale relative to a freshly-updated package and
// trigger an auto-reload (see src/lib/browser-mcp/install-check.ts).

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
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

const pkgPath = path.join(repoRoot, "package.json")
const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: unknown }
if (typeof pkg.version !== "string" || pkg.version.length === 0) {
  console.error(`copy-browser-ext: package.json has no string version field`)
  process.exit(1)
}
const manifestPath = path.join(dst, "manifest.json")
const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>
manifest.version = pkg.version
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)

console.log(`copied ${src} → ${dst} (manifest.version = ${pkg.version})`)
