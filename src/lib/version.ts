import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

/**
 * Memoized result. `package.json` cannot change under a running process in any
 * way that process should follow — the npm tarball is immutable once installed,
 * and an upgrade means a NEW process.
 *
 * The cache is load-bearing, not an optimization. This function does a
 * synchronous `readFileSync` + `JSON.parse`, and its callers put it on hot and
 * externally-reachable paths: every persisted log line (`logIdentity`), the
 * browser-MCP provisioning signature, and `GET /version` — which sits behind an
 * unrestricted `cors()`, so an unmemoized read there lets any web page block
 * the event loop for all concurrent Copilot traffic by spamming one endpoint.
 *
 * A failed read is cached too. Failure means `package.json` is missing or
 * corrupt, which is not a transient condition, and re-reading per call would
 * reintroduce exactly the blocking-I/O problem in the case where it is most
 * expensive (two failing `readFileSync`s each time).
 */
let cachedVersion: string | undefined

/**
 * Read this binary's published version from package.json at runtime.
 *
 * Done at runtime (not baked at build time) because release.yml builds
 * BEFORE `npm version patch` bumps the version — a build-time inline
 * would always ship the pre-bump value. The npm tarball ships package.json
 * alongside `dist/`, so a sibling-up lookup from import.meta.url resolves
 * cleanly in both dev (`src/lib/`) and bundled (`dist/`) layouts.
 *
 * Reading once per PROCESS still satisfies that: the process starts after the
 * bump, so it observes the published value.
 *
 * Returns `"unknown"` if package.json can't be located or parsed —
 * never throws, so the CLI never fails to start over version reporting.
 */
export function getPackageVersion(): string {
  if (cachedVersion !== undefined) return cachedVersion
  cachedVersion = readPackageVersion()
  return cachedVersion
}

function readPackageVersion(): string {
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
