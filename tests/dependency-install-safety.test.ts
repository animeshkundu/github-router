/**
 * Install-time safety pins.
 *
 * `bun install` runs a dependency's `postinstall` ONLY when the package is
 * listed in `trustedDependencies`. That gate is the one lever we have over
 * arbitrary install-time network + disk work, so a package listed there is
 * making a claim we have to be able to defend.
 *
 * The case this file exists for: `onnxruntime-node` (reached through
 * `flashrank-js` -> `@huggingface/transformers`) has a `postinstall` that, on
 * linux/x64 only, downloads the CUDA execution-provider binaries. At 1.21.0 -
 * the version transformers 3.8.1 pinned - it fetched them from
 *
 *   https://github.com/microsoft/onnxruntime/releases/download/v1.21.0/...
 *
 * and on 2026-11-17 that whole upstream release path started returning 404.
 * CI went red in the *install* step on ubuntu only, with every later step
 * skipped, so it looked like the branch broke the build. Newer ORT (1.30, via
 * transformers 4.x) pulls the same CUDA payload from NuGet instead, so that
 * particular 404 no longer fires - but the reason not to run the script has
 * not changed, and it is the durable one: **nothing here selects a CUDA
 * execution provider.** Reranking is CPU, the CPU library ships inside the npm
 * tarball for every platform, and the ColBERT sidecar carries its own
 * SHA-pinned ONNX Runtime. Blocking the postinstall removes install-time
 * network work from every machine and costs nothing.
 *
 * If a future dependency genuinely needs its postinstall, trust it AND make
 * sure a failure there cannot fail the install - an install step whose success
 * depends on an upstream artifact host is not something we can promise.
 */

import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const ROOT = join(import.meta.dir, "..")

const readJson = (rel: string) => JSON.parse(readFileSync(join(ROOT, rel), "utf8"))
const readText = (rel: string) => readFileSync(join(ROOT, rel), "utf8")

describe("install-time dependency safety", () => {
  test("onnxruntime-node is not trusted, so its CUDA postinstall never runs", () => {
    // Its postinstall downloads CUDA binaries (GitHub releases at 1.21, NuGet
    // from 1.22 on). The CPU library it would otherwise still need ships in the
    // tarball, and no code path here asks for CUDA.
    const pkg = readJson("package.json") as { trustedDependencies?: string[] }
    expect(pkg.trustedDependencies ?? []).not.toContain("onnxruntime-node")
  })

  test("the lockfile's trusted list matches package.json", () => {
    // `bun install` trusts what the LOCKFILE says (`bun.lock` carries its own
    // copy of the list). If the two drift, a package can be trusted in CI or on
    // a developer machine without a visible diff in package.json - exactly the
    // kind of silent install-time work this suite is pinning against.
    const pkg = readJson("package.json") as { trustedDependencies?: string[] }
    const block = /"trustedDependencies":\s*\[([^\]]*)\]/.exec(readText("bun.lock"))
    expect(block).not.toBeNull()
    const fromLock = (block?.[1] ?? "")
      .split(",")
      .map((entry) => /"([^"]+)"/.exec(entry)?.[1])
      .filter((entry): entry is string => typeof entry === "string")
      .sort()
    expect(fromLock).toEqual([...(pkg.trustedDependencies ?? [])].sort())
  })

  test("ONNX Runtime stays on a line whose install cannot 404", () => {
    // 1.21.0's postinstall fetched CUDA from a GitHub release URL that went
    // away; 1.22+ moved to NuGet. A transitive downgrade (a transformers pin
    // regression, a hand-edited override) would quietly reinstate the
    // install-time dependency on that dead path.
    const lock = readText("bun.lock")
    const m = /"onnxruntime-node":\s*\[\s*"onnxruntime-node@(\d+)\.(\d+)\.(\d+)"/.exec(lock)
    expect(m).not.toBeNull()
    expect(Number(m![1])).toBe(1)
    expect(Number(m![2])).toBeGreaterThanOrEqual(22)
  })

  test("flashrank's transformers is resolved through an explicit override", () => {
    // flashrank-js declares `@huggingface/transformers: ^3.0.0`, and 3.x pins
    // ORT 1.21.0 - the version whose installer 404s. The override in
    // package.json is the whole reason the resolved ORT is 1.30; drop it and
    // the ORT version becomes a transitive pin we do not control.
    const pkg = readJson("package.json") as { overrides?: Record<string, string> }
    expect(pkg.overrides?.["@huggingface/transformers"]).toMatch(/^4\./)
    const lock = readText("bun.lock")
    expect(/"@huggingface\/transformers":\s*"4\./.test(lock)).toBe(true)
    // No 3.x may survive anywhere, or two ORT majors would be loaded at once
    // in the same process.
    expect(/@huggingface\/transformers@3\./.test(lock)).toBe(false)
  })
})
