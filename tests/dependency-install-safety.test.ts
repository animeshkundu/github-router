/**
 * Install-time safety pins.
 *
 * `bun install` runs a dependency's `postinstall` ONLY when the package is
 * listed in `trustedDependencies`. That gate is the one lever we have over
 * arbitrary install-time network + disk work, so a package listed there is
 * making a claim we have to be able to defend.
 *
 * The case this file exists for: `onnxruntime-node@1.21.0` (pinned exactly by
 * `@huggingface/transformers@3.8.1`, reached through `flashrank-js`) has a
 * `postinstall` that, on linux/x64 only, downloads the CUDA execution-provider
 * binaries from
 *
 *   https://github.com/microsoft/onnxruntime/releases/download/v1.21.0/…
 *
 * On 2026-11-17 that whole upstream release path started returning 404 and CI
 * went red in the *install* step on ubuntu only — every later step skipped, so
 * it looked like the branch broke the build. Nothing in this repository ever
 * selects a CUDA execution provider: reranking is CPU, and the ColBERT sidecar
 * carries its own SHA-pinned ONNX Runtime. The CPU library is bundled in the
 * npm tarball, so blocking the postinstall removes a network dependency from
 * every install (CI and user machines alike) and costs us nothing.
 *
 * If a future dependency genuinely needs its postinstall, trust it AND make
 * sure a failure there cannot fail the install — an install step that depends
 * on an upstream GitHub release URL is not something we can promise.
 */

import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const ROOT = join(import.meta.dir, "..")

const readJson = (rel: string) => JSON.parse(readFileSync(join(ROOT, rel), "utf8"))

describe("install-time dependency safety", () => {
  test("onnxruntime-node is not trusted, so its CUDA postinstall never runs", () => {
    const pkg = readJson("package.json") as { trustedDependencies?: string[] }
    const trusted = pkg.trustedDependencies ?? []
    // Its postinstall fetches CUDA binaries from a GitHub release URL that can
    // (and did) 404. The CPU library it would otherwise still need ships in the
    // tarball, and no code path here asks for CUDA.
    expect(trusted).not.toContain("onnxruntime-node")
  })

  test("the lockfile's trusted list matches package.json", () => {
    // `bun install` trusts what the LOCKFILE says (`bun.lock` carries its own
    // copy of the list). If the two drift, a package can be trusted in CI or on
    // a developer machine without a visible diff in package.json — exactly the
    // kind of silent install-time work this suite is pinning against.
    const pkg = readJson("package.json") as { trustedDependencies?: string[] }
    const lock = readFileSync(join(ROOT, "bun.lock"), "utf8")
    const block = /"trustedDependencies":\s*\[([^\]]*)\]/.exec(lock)
    expect(block).not.toBeNull()
    const fromLock = (block?.[1] ?? "")
      .split(",")
      .map((entry) => /"([^"]+)"/.exec(entry)?.[1])
      .filter((entry): entry is string => typeof entry === "string")
      .sort()
    expect(fromLock).toEqual([...(pkg.trustedDependencies ?? [])].sort())
  })
})
