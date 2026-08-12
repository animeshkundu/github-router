/**
 * Stamp the hook launcher's content digest beside the built bundle.
 *
 * `src/lib/hook-launcher/provision.ts` copies `dist/hooks.mjs` to a stable,
 * content-addressed path so Claude Code's persisted hook commands survive the
 * `bunx` temp tree being reaped or re-extracted. Content-addressing alone
 * cannot tell a COMPLETE bundle from a TRUNCATED one — a torn read gets its
 * own hash and would be preserved under that name forever. This sidecar is
 * what the provisioner checks the bytes against before publishing them.
 *
 * It has to be a post-build step rather than a build-time `define`: the four
 * tsdown entries build in parallel, so the main bundle cannot know the hook
 * bundle's hash while it is being produced.
 */

import { createHash } from "node:crypto"
import { readFileSync, writeFileSync } from "node:fs"
import path from "node:path"

const distDir = path.resolve(import.meta.dirname, "..", "dist")
const bundlePath = path.join(distDir, "hooks.mjs")

const bytes = readFileSync(bundlePath)
const digest = createHash("sha256").update(bytes).digest("hex")

writeFileSync(path.join(distDir, "hooks.sha256"), `${digest}\n`, "utf8")

console.log(
  `stamped dist/hooks.sha256 = ${digest} (${bytes.byteLength} bytes)`,
)
