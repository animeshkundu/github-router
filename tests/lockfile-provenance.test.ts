import { test, expect } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"

// The lockfile's provenance is a supply-chain property, and it regresses
// silently: running `bun install` on a machine whose default registry points
// at a corporate pass-through mirror rewrites every tarball URL to that
// internal host, and nothing in the build fails. It stays wrong until someone
// reads the lockfile.
//
// It happened. 332 of 333 entries pointed at packagefeedproxy.microsoft.io and
// one at ms-feed-2.pkgs.visualstudio.com, in a public repository. The bytes
// were genuine (every integrity hash matched what npmjs publishes, verified
// entry by entry via scripts/verify-lockfile-provenance.mjs), so this was a
// provenance and reproducibility defect rather than a compromise — a fork or
// a CI runner cannot resolve those hosts at all.
//
// That mirror also advertised a WEAKER hash for one package: diff@8.0.4 was
// recorded as sha1, which is not collision-resistant, while every other entry
// carried sha512. So the algorithm is asserted too, not just the host.
//
// Note the two legitimate shapes for the URL field. bun writes an EMPTY string
// when a package resolves from the default registry, and an absolute URL only
// when it does not. So the canonical lockfile from a clean `bun install`
// contains no URLs at all, and "no URLs" is the healthy state rather than a
// suspicious one. An earlier version of this guard asserted a minimum URL
// count to avoid passing vacuously, which inverted the check: it failed on a
// correctly regenerated lockfile and would have passed on one full of internal
// hosts. The anti-vacuous floor therefore counts parsed package ENTRIES, which
// exist in both shapes.
//
// This test is deliberately offline and content-free: it reads bytes and
// asserts shape, so it cannot flake on a network hiccup. The deep check that
// every hash still matches the public registry lives in
// `bun run verify:lockfile` and is run by hand, because it needs 333 network
// round-trips.

const lockPath = path.join(import.meta.dirname, "..", "bun.lock")
const lockText = await fs.readFile(lockPath, "utf8")

/** `  "key": ["name@version", "<url or empty>", {...}, "<integrity>"],` */
const ENTRY_RE =
  /^\s+"[^"]+": \["([^"]+)", "([^"]*)", .*, "(sha[0-9]+)-[^"]*"\],?$/gm

function parseEntries() {
  ENTRY_RE.lastIndex = 0
  return [...lockText.matchAll(ENTRY_RE)].map((m) => ({
    spec: m[1],
    url: m[2],
    algo: m[3],
  }))
}

test("no bun.lock entry resolves through a non-public registry", () => {
  const entries = parseEntries()

  // Guard the guard: a lockfile format change that stops matching must fail
  // here rather than silently reduce the test to an assertion about nothing.
  expect(entries.length).toBeGreaterThan(100)

  const offenders = entries
    .filter((e) => e.url !== "" && !e.url.startsWith("https://registry.npmjs.org/"))
    .map((e) => `${e.spec} -> ${e.url}`)

  expect(offenders).toEqual([])
})

test("every bun.lock integrity hash uses sha512", () => {
  const entries = parseEntries()

  expect(entries.length).toBeGreaterThan(100)

  const weak = entries.filter((e) => e.algo !== "sha512").map((e) => `${e.spec} -> ${e.algo}`)

  expect(weak).toEqual([])
})
