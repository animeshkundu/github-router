// Rewrite bun.lock's tarball URLs to the canonical public-registry ones.
//
// Driven by the verified map that verify-lockfile-provenance.mjs produces, so
// every replacement is one whose integrity was already confirmed identical to
// what npmjs publishes. Each swap is an exact string replacement of the URL
// recorded in the lockfile for the URL npmjs itself reports as dist.tarball —
// not a prefix guess — and the surrounding bytes are untouched, so the diff is
// URLs only (plus the single sha1 -> sha512 upgrade).
//
// Usage: node scripts/rewrite-lockfile-registry.mjs <map.json> [--dry-run]

import { readFileSync, writeFileSync } from "node:fs"

const mapPath = process.argv[2]
const dryRun = process.argv.includes("--dry-run")
if (!mapPath) {
  console.error("usage: node scripts/rewrite-lockfile-registry.mjs <map.json> [--dry-run]")
  process.exit(2)
}

const results = JSON.parse(readFileSync(mapPath, "utf8"))
let text = readFileSync("bun.lock", "utf8")
const before = text

let urlSwaps = 0
let integritySwaps = 0
const problems = []

// A package resolved at two keys (top-level plus nested, e.g. `ignore` and
// `eslint/ignore`) shares one tarball URL, so a URL can legitimately appear
// more than once. Collapse to unique mappings and assert no URL is claimed by
// two different targets before touching the file.
const urlMap = new Map()
const integrityMap = new Map()

for (const r of results) {
  if (r.status !== "match" && r.status !== "sha1-upgradable") {
    problems.push(`${r.spec}: status=${r.status} — refusing to rewrite`)
    continue
  }
  if (!r.lockUrl || !r.npmUrl) {
    problems.push(`${r.spec}: missing url (lock=${r.lockUrl} npm=${r.npmUrl})`)
    continue
  }

  const priorUrl = urlMap.get(r.lockUrl)
  if (priorUrl !== undefined && priorUrl !== r.npmUrl) {
    problems.push(`${r.lockUrl}: conflicting targets ${priorUrl} vs ${r.npmUrl}`)
    continue
  }
  urlMap.set(r.lockUrl, r.npmUrl)

  if (r.status === "sha1-upgradable" && r.npmIntegrity) {
    const priorInt = integrityMap.get(r.lockIntegrity)
    if (priorInt !== undefined && priorInt !== r.npmIntegrity) {
      problems.push(`${r.spec}: conflicting integrity targets`)
      continue
    }
    integrityMap.set(r.lockIntegrity, r.npmIntegrity)
  }
}

for (const [lockUrl, npmUrl] of urlMap) {
  if (lockUrl === npmUrl) continue
  const needle = `"${lockUrl}"`
  const occurrences = text.split(needle).length - 1
  if (occurrences === 0) {
    problems.push(`${lockUrl}: not found in lockfile`)
    continue
  }
  text = text.replaceAll(needle, `"${npmUrl}"`)
  urlSwaps += occurrences
}

for (const [lockIntegrity, npmIntegrity] of integrityMap) {
  const needle = `"${lockIntegrity}"`
  const occurrences = text.split(needle).length - 1
  if (occurrences === 0) {
    problems.push(`${lockIntegrity}: not found in lockfile`)
    continue
  }
  text = text.replaceAll(needle, `"${npmIntegrity}"`)
  integritySwaps += occurrences
}

if (problems.length > 0) {
  console.error("refusing to write — unresolved entries:")
  for (const p of problems) console.error(`  ${p}`)
  process.exit(1)
}

const remaining = [...text.matchAll(/"https:\/\/([a-z0-9.-]+)\//g)].map((m) => m[1])
const nonPublic = [...new Set(remaining)].filter((h) => h !== "registry.npmjs.org")

console.log(`url rewrites      : ${urlSwaps}`)
console.log(`integrity upgrades: ${integritySwaps}`)
console.log(`hosts remaining   : ${[...new Set(remaining)].join(", ") || "(none)"}`)

if (nonPublic.length > 0) {
  console.error(`refusing to write — non-public hosts remain: ${nonPublic.join(", ")}`)
  process.exit(1)
}

if (dryRun) {
  console.log(`dry run: ${before.length} -> ${text.length} bytes, not written`)
  process.exit(0)
}

writeFileSync("bun.lock", text)
console.log(`wrote bun.lock (${before.length} -> ${text.length} bytes)`)
