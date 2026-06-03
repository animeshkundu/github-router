import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

/**
 * Read this binary's published version from package.json at runtime.
 *
 * Done at runtime (not baked at build time) because release.yml builds
 * BEFORE `npm version patch` bumps the version — a build-time inline
 * would always ship the pre-bump value. The npm tarball ships package.json
 * alongside `dist/`, so a sibling-up lookup from import.meta.url resolves
 * cleanly in both dev (`src/lib/`) and bundled (`dist/`) layouts.
 *
 * Returns `"unknown"` if package.json can't be located or parsed —
 * never throws, so the CLI never fails to start over version reporting.
 */
export function getPackageVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url))
    // src/lib/version.ts → ../../package.json (dev)
    // dist/main.js       → ../package.json    (built npm tarball)
    // dist/<chunk>.js    → ../package.json    (split bundle)
    const candidates = [
      join(here, "..", "..", "package.json"),
      join(here, "..", "package.json"),
    ]
    for (const path of candidates) {
      try {
        const raw = readFileSync(path, "utf8")
        const parsed = JSON.parse(raw) as { version?: unknown; name?: unknown }
        if (
          typeof parsed.version === "string"
          && (parsed.name === "github-router"
            || parsed.name === "@animeshkundu/github-router")
        ) {
          return parsed.version
        }
      } catch {
        // Try next candidate.
      }
    }
  } catch {
    // Fall through to "unknown".
  }
  return "unknown"
}
