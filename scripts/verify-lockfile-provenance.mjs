// Verify every bun.lock entry against the public npm registry.
//
// The lockfile was generated on a machine whose default registry pointed at an
// internal pass-through mirror, so every tarball URL names an internal host
// rather than registry.npmjs.org. A pass-through mirror serves npmjs's own
// bytes, so the recorded integrity hashes SHOULD already be npmjs's — but
// "should" is not "verified", and rewriting 333 URLs on that assumption is
// exactly the kind of unchecked step that ships a broken lockfile.
//
// So: ask npmjs directly for each name@version, compare its published
// integrity against what the lockfile recorded, and emit the canonical
// dist.tarball URL. A rewrite driven by this output is provably equivalent to
// what a clean-network `bun install` would have produced.
//
// Usage: node scripts/verify-lockfile-provenance.mjs [--json <out>]

import { readFileSync, writeFileSync } from "node:fs"

const REGISTRY = "https://registry.npmjs.org"
const CONCURRENCY = 12

/**
 * bun.lock is JSONC: it carries trailing commas that `JSON.parse` rejects.
 * Strip them string-aware — a blind regex would corrupt any package whose
 * metadata legitimately contains `,]` or `,}` inside a quoted value.
 */
function parseJsonc(text) {
  let out = ""
  let inString = false
  let escaped = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      out += ch
      if (escaped) escaped = false
      else if (ch === "\\") escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') {
      inString = true
      out += ch
      continue
    }
    if (ch === ",") {
      // Look ahead past whitespace for a closing bracket.
      let j = i + 1
      while (j < text.length && /\s/.test(text[j])) j++
      if (text[j] === "}" || text[j] === "]") continue // drop the trailing comma
    }
    out += ch
  }
  return JSON.parse(out)
}

const lock = parseJsonc(readFileSync("bun.lock", "utf8"))
const entries = Object.entries(lock.packages ?? {})

/** Split "@scope/name@1.2.3" or "name@1.2.3" on the LAST "@". */
function splitNameVersion(spec) {
  const at = spec.lastIndexOf("@")
  if (at <= 0) return null
  return { name: spec.slice(0, at), version: spec.slice(at + 1) }
}

async function fetchJson(url, tries = 3) {
  let lastErr
  for (let i = 0; i < tries; i++) {
    try {
      const res = await globalThis.fetch(url, {
        headers: { accept: "application/vnd.npm.install-v1+json, application/json" },
      })
      if (res.status === 404) return { notFound: true }
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return await res.json()
    } catch (err) {
      lastErr = err
      await new Promise((r) => setTimeout(r, 300 * (i + 1)))
    }
  }
  throw lastErr
}

const results = []
let cursor = 0

async function worker() {
  for (;;) {
    const idx = cursor++
    if (idx >= entries.length) return
    const [key, value] = entries[idx]
    if (!Array.isArray(value)) continue

    const spec = value[0]
    const lockUrl = typeof value[1] === "string" ? value[1] : ""
    const lockIntegrity = typeof value.at(-1) === "string" ? value.at(-1) : ""
    const nv = splitNameVersion(spec)
    if (!nv) {
      results.push({ key, spec, status: "unparseable" })
      continue
    }

    const url = `${REGISTRY}/${nv.name.replace("/", "%2f")}/${nv.version}`
    try {
      const doc = await fetchJson(url)
      if (doc?.notFound) {
        results.push({ key, spec, status: "not-on-npmjs", lockUrl })
        continue
      }
      const dist = doc?.dist ?? {}
      const published = dist.integrity ?? (dist.shasum ? `sha1-${Buffer.from(dist.shasum, "hex").toString("base64")}` : "")

      let status
      if (!published) status = "no-published-integrity"
      else if (published === lockIntegrity) status = "match"
      else if (lockIntegrity.startsWith("sha1-") && dist.shasum) {
        // Lockfile recorded the weaker hash the mirror advertised. Confirm the
        // sha1 genuinely corresponds to the same tarball, then upgrade it.
        const asSha1 = `sha1-${Buffer.from(dist.shasum, "hex").toString("base64")}`
        status = asSha1 === lockIntegrity ? "sha1-upgradable" : "MISMATCH"
      } else status = "MISMATCH"

      results.push({
        key,
        spec,
        status,
        lockUrl,
        lockIntegrity,
        npmUrl: dist.tarball ?? "",
        npmIntegrity: dist.integrity ?? "",
        npmShasum: dist.shasum ?? "",
      })
    } catch (err) {
      results.push({ key, spec, status: "fetch-failed", error: String(err?.message ?? err), lockUrl })
    }
  }
}

await Promise.all(Array.from({ length: CONCURRENCY }, worker))

const by = (s) => results.filter((r) => r.status === s)
const counts = {}
for (const r of results) counts[r.status] = (counts[r.status] ?? 0) + 1

console.log(`checked ${results.length} entries against ${REGISTRY}`)
for (const [k, v] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${k}: ${v}`)
}

for (const r of [...by("MISMATCH"), ...by("not-on-npmjs"), ...by("fetch-failed"), ...by("no-published-integrity")]) {
  console.log(`\n!! ${r.status}  ${r.spec}`)
  console.log(`   lock: ${r.lockIntegrity ?? ""}`)
  console.log(`   npm : ${r.npmIntegrity ?? r.error ?? ""}`)
}
for (const r of by("sha1-upgradable")) {
  console.log(`\n~~ sha1-upgradable  ${r.spec}`)
  console.log(`   lock sha1 : ${r.lockIntegrity}`)
  console.log(`   npm sha512: ${r.npmIntegrity}`)
  console.log(`   npm url   : ${r.npmUrl}`)
}

// Non-npmjs hosts still present after the mapping is applied.
const hosts = new Set(results.map((r) => (r.npmUrl ? new URL(r.npmUrl).host : "")).filter(Boolean))
console.log(`\ncanonical hosts in npm-supplied URLs: ${[...hosts].join(", ")}`)

const jsonIdx = process.argv.indexOf("--json")
if (jsonIdx !== -1 && process.argv[jsonIdx + 1]) {
  writeFileSync(process.argv[jsonIdx + 1], JSON.stringify(results, null, 2))
  console.log(`wrote ${process.argv[jsonIdx + 1]}`)
}

const bad = counts.MISMATCH ?? 0
const unresolved = (counts["not-on-npmjs"] ?? 0) + (counts["fetch-failed"] ?? 0) + (counts["no-published-integrity"] ?? 0)
process.exit(bad + unresolved > 0 ? 1 : 0)
