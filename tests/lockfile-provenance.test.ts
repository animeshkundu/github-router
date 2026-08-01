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
// This test is deliberately offline and content-free: it reads bytes and
// asserts shape, so it cannot flake on a network hiccup. The deep check that
// every hash still matches the public registry lives in the script above and
// is run by hand, because it needs 333 network round-trips.

const lockPath = path.join(import.meta.dir, "..", "bun.lock")
const lockText = await fs.readFile(lockPath, "utf8")

test("every bun.lock tarball resolves to the public npm registry", () => {
  const hosts = [...lockText.matchAll(/"https:\/\/([a-z0-9.-]+)\//g)].map(
    (m) => m[1],
  )

  // Guard the guard: if the lockfile format ever stops embedding absolute
  // tarball URLs, an empty match set would make this test vacuously pass.
  expect(hosts.length).toBeGreaterThan(100)

  const offenders = [...new Set(hosts)].filter((h) => h !== "registry.npmjs.org")
  expect(offenders).toEqual([])
})

test("every bun.lock integrity hash uses sha512", () => {
  const algos = [...lockText.matchAll(/"(sha[0-9]+)-[A-Za-z0-9+/=]+"/g)].map(
    (m) => m[1],
  )

  expect(algos.length).toBeGreaterThan(100)

  const weak = [...new Set(algos)].filter((a) => a !== "sha512")
  expect(weak).toEqual([])
})
