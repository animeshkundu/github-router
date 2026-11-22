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
 *
 * That promise has to hold for CONSUMERS, not just for this checkout. The
 * `trustedDependencies` gate above is Bun-only and the `overrides` field is
 * honoured only from a ROOT package.json, so neither exists once the package
 * is installed by `npx`, `npm i -g`, or as somebody's dependency. On
 * 2026-11-20 `npx github-router@latest` died on linux/x64 exactly that way:
 * `flashrank-js` pulled transformers 3.8.1 -> ORT 1.21.0, whose postinstall
 * 404s, and the root-only pins never applied. The invariant that matters is
 * therefore structural - no REGULAR dependency may reach an ORT whose
 * installer can fail - and it is pinned below.
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

  test("the heavy payloads are optional peers, and this repo dev-depends on them", () => {
    // Why the shape, not just "they are somewhere": the install-size goal is
    // 586 MB → 66 MB for every CONSUMER, and the only lever is moving them out
    // of `dependencies`. Two facts were measured, and both are load-bearing:
    //
    //   1. an OPTIONAL PEER is installed for nobody — npm and bun, root and
    //      non-root — so `peerDependenciesMeta.optional` alone would mean "no
    //      consumer ever has reranking or structural search";
    //   2. a devDependency on an optional peer DOES resolve under both npm and
    //      bun, which is what keeps this checkout (and CI) fully featured.
    //
    // Consumers get the payload on demand from `<APP_DIR>/optional` instead —
    // `src/lib/managed-install/optional.ts`.
    const pkg = readJson("package.json") as {
      dependencies?: Record<string, string>
      devDependencies?: Record<string, string>
      peerDependencies?: Record<string, string>
      peerDependenciesMeta?: Record<string, { optional?: boolean }>
    }
    for (const name of ["@huggingface/transformers", "tree-sitter-wasms"]) {
      expect(pkg.dependencies?.[name]).toBeUndefined()
      expect(pkg.peerDependencies?.[name]).toBeDefined()
      expect(pkg.peerDependenciesMeta?.[name]?.optional).toBe(true)
      // Same range in both places: a devDependency that drifted from the peer
      // range would let CI pass on a version consumers are told they need.
      expect(pkg.devDependencies?.[name]).toBe(pkg.peerDependencies?.[name])
    }
    expect(pkg.peerDependencies?.["@huggingface/transformers"]).toMatch(/^\^4\./)
  })

  test("no CONSUMER dependency tree can reach onnxruntime-node@1.21", () => {
    // The 2026-11-20 lesson. The first fix for the ORT-1.21 404 used two
    // ROOT-ONLY mechanisms: an `overrides` entry and Bun's
    // `trustedDependencies` gate. Both held for this repo and for nothing
    // else. npm honours `overrides` only from the ROOT package.json (a
    // dependency's own overrides are ignored), and `npx` / `npm i -g` have no
    // project file to carry an `allowScripts` policy. Consumers therefore kept
    // resolving `flashrank-js -> @huggingface/transformers@3.8.1 ->
    // onnxruntime-node@1.21.0` and died in the INSTALL step on linux/x64 —
    // before any of this package's code could run. The durable fix is a
    // DIRECT transformers-4 dependency, which pins ORT 1.30.
    const pkg = readJson("package.json") as {
      dependencies?: Record<string, string>
      optionalDependencies?: Record<string, string>
      overrides?: Record<string, string>
    }
    expect(pkg.dependencies?.["flashrank-js"]).toBeUndefined()
    expect(pkg.optionalDependencies?.["flashrank-js"]).toBeUndefined()
    // `@huggingface/transformers` moved to optional peer + devDependency (the
    // payload diet); the invariant that matters here is that it is NOT a
    // regular dependency, because a regular dependency is what a consumer
    // installs unconditionally. Asserted in the diet test above.
    expect(pkg.dependencies?.["@huggingface/transformers"]).toBeUndefined()
    // The override is deliberately GONE: with flashrank-js removed nothing
    // else pulls transformers, so a root-only pin would be dead config that
    // reads like a consumer guarantee.
    expect(pkg.overrides?.["@huggingface/transformers"]).toBeUndefined()
    const lock = readText("bun.lock")
    // No 3.x may survive anywhere, or two ORT majors would be loaded at once
    // in the same process.
    expect(/@huggingface\/transformers@3\./.test(lock)).toBe(false)
    expect(/flashrank-js/.test(lock)).toBe(false)
  })
})
