import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { explicitPackageRoot } from "./package-root"

/**
 * Read this binary's published version from package.json at runtime.
 *
 * Done at runtime (not baked at build time) because release.yml builds
 * BEFORE `npm version patch` bumps the version — a build-time inline
 * would always ship the pre-bump value. The npm tarball ships package.json
 * alongside `dist/`, so a sibling-up lookup from import.meta.url resolves
 * cleanly in both dev (`src/lib/`) and bundled (`dist/`) layouts.
 *
 * The sibling-up walk fails for the relocated hook launcher, which runs from
 * `<APP_DIR>/hooks/` with no package.json above it — hence the explicit root
 * tried first. Baking the version into that bundle instead would reintroduce
 * exactly the pre-bump staleness the runtime read exists to avoid, so the
 * launcher is handed a path to read rather than a value to trust.
 *
 * Returns `"unknown"` if package.json can't be located or parsed —
 * never throws, so the CLI never fails to start over version reporting.
 */
export function getPackageVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url))
    const explicit = explicitPackageRoot()
    const candidates = [
      // Relocated hook launcher — the root was baked into its command line.
      ...(explicit ? [join(explicit, "package.json")] : []),
      // src/lib/version.ts → ../../package.json (dev)
      // dist/main.js       → ../package.json    (built npm tarball)
      // dist/<chunk>.js    → ../package.json    (split bundle)
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
