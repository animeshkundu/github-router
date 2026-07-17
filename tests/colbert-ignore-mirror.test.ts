/**
 * Non-git `.gitignore` → `.ignore` mirror.
 *
 * Two layers:
 *  1. UNIT tests of `ensureIgnoreMirror` — the router-side logic we own.
 *     Deterministic, filesystem-only, CI-safe (no colgrep binary needed).
 *  2. A GATED colgrep integration canary that pins the upstream behavior
 *     the fix relies on: colgrep skips `.gitignore`'d paths in a git repo,
 *     ignores `.gitignore` in a NON-git dir, but honors the mirrored
 *     `.ignore`. It runs ONLY under `GH_ROUTER_RUN_COLBERT_E2E=1` with the
 *     artifacts provisioned (same opt-in pattern as the browser E2E), and
 *     is hermetic (its own temp COLGREP_DATA_DIR — never the shared index).
 *     A colgrep upgrade that regresses ignore handling fails this canary.
 */

import { afterEach, describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { readdirSync, readFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"

import {
  MIRROR_MARKER,
  ensureIgnoreMirror,
  ignoreMirrorOptedOut,
} from "../src/lib/colbert/ignore-mirror"

const dirs: string[] = []
async function tmpWorkspace(): Promise<string> {
  const d = await mkdtemp(path.join(os.tmpdir(), "gh-router-ignore-mirror-"))
  dirs.push(d)
  return d
}
afterEach(async () => {
  delete process.env.GH_ROUTER_COLBERT_NO_IGNORE_MIRROR
  for (const d of dirs.splice(0)) {
    await rm(d, { recursive: true, force: true }).catch(() => {})
  }
})

// ---------------------------------------------------------------------
// Unit: ensureIgnoreMirror
// ---------------------------------------------------------------------

describe("colbert ignore-mirror (unit)", () => {
  test("mirrors .gitignore -> .ignore when no .ignore exists", async () => {
    const ws = await tmpWorkspace()
    await writeFile(path.join(ws, ".gitignore"), "dist/\nnode_modules/\n*.min.js\n")
    await ensureIgnoreMirror(ws)
    const ignore = await readFile(path.join(ws, ".ignore"), "utf8")
    expect(ignore.startsWith(MIRROR_MARKER)).toBe(true)
    expect(ignore).toContain("dist/")
    expect(ignore).toContain("node_modules/")
    expect(ignore).toContain("*.min.js")
  })

  test("no-op when there is no .gitignore", async () => {
    const ws = await tmpWorkspace()
    await ensureIgnoreMirror(ws)
    await expect(readFile(path.join(ws, ".ignore"), "utf8")).rejects.toThrow()
  })

  test("never overwrites a USER-authored .ignore", async () => {
    const ws = await tmpWorkspace()
    await writeFile(path.join(ws, ".gitignore"), "dist/\n")
    await writeFile(path.join(ws, ".ignore"), "my-own-rules/\n")
    await ensureIgnoreMirror(ws)
    expect(await readFile(path.join(ws, ".ignore"), "utf8")).toBe("my-own-rules/\n")
  })

  test("refreshes its OWN mirror when .gitignore changed", async () => {
    const ws = await tmpWorkspace()
    await writeFile(path.join(ws, ".gitignore"), "dist/\n")
    await ensureIgnoreMirror(ws)
    await writeFile(path.join(ws, ".gitignore"), "dist/\ncoverage/\n")
    await ensureIgnoreMirror(ws)
    const ignore = await readFile(path.join(ws, ".ignore"), "utf8")
    expect(ignore.startsWith(MIRROR_MARKER)).toBe(true)
    expect(ignore).toContain("coverage/")
  })

  test("is idempotent — second run leaves an identical file", async () => {
    const ws = await tmpWorkspace()
    await writeFile(path.join(ws, ".gitignore"), "dist/\n")
    await ensureIgnoreMirror(ws)
    const first = await readFile(path.join(ws, ".ignore"), "utf8")
    await ensureIgnoreMirror(ws)
    expect(await readFile(path.join(ws, ".ignore"), "utf8")).toBe(first)
  })

  test("opt-out env disables the mirror", async () => {
    const ws = await tmpWorkspace()
    await writeFile(path.join(ws, ".gitignore"), "dist/\n")
    process.env.GH_ROUTER_COLBERT_NO_IGNORE_MIRROR = "1"
    expect(ignoreMirrorOptedOut()).toBe(true)
    await ensureIgnoreMirror(ws)
    await expect(readFile(path.join(ws, ".ignore"), "utf8")).rejects.toThrow()
  })

  test("preserves gitignore negation patterns verbatim", async () => {
    const ws = await tmpWorkspace()
    await writeFile(path.join(ws, ".gitignore"), "build/\n!build/keep.txt\n")
    await ensureIgnoreMirror(ws)
    const ignore = await readFile(path.join(ws, ".ignore"), "utf8")
    expect(ignore).toContain("!build/keep.txt")
  })

  test("does not misclassify a user file that only starts with the tag line", async () => {
    const ws = await tmpWorkspace()
    await writeFile(path.join(ws, ".gitignore"), "dist/\n")
    // Same first line as our mirror, but NOT the full header → user-owned.
    const userFile = `${MIRROR_MARKER}\nmy-own-rule/\n`
    await writeFile(path.join(ws, ".ignore"), userFile)
    await ensureIgnoreMirror(ws)
    expect(await readFile(path.join(ws, ".ignore"), "utf8")).toBe(userFile)
  })

  test("leaves a non-regular .ignore (a directory) untouched", async () => {
    const ws = await tmpWorkspace()
    await writeFile(path.join(ws, ".gitignore"), "dist/\n")
    await mkdir(path.join(ws, ".ignore"), { recursive: true })
    await ensureIgnoreMirror(ws)
    // Still a directory — we never wrote through it.
    const { stat } = await import("node:fs/promises")
    expect((await stat(path.join(ws, ".ignore"))).isDirectory()).toBe(true)
  })
})

// ---------------------------------------------------------------------
// Gated integration canary — pins colgrep's ignore behavior end-to-end.
// Opt-in: GH_ROUTER_RUN_COLBERT_E2E=1 AND provisioned artifacts present.
// ---------------------------------------------------------------------

const E2E =
  process.env.GH_ROUTER_RUN_COLBERT_E2E === "1" &&
  (await (async () => {
    try {
      const prov = await import("../src/lib/colbert/provision")
      return prov.colbertArtifactsPresent()
    } catch {
      return false
    }
  })())

describe("colbert ignore behavior (colgrep canary)", () => {
  test.skipIf(!E2E)(
    "git repo skips .gitignore'd paths; non-git honors the .ignore mirror",
    async () => {
      const { runManagedExeCapture } = await import("../src/lib/exec")
      const prov = await import("../src/lib/colbert/provision")
      const binary = prov.colgrepBinaryPath()
      const model = prov.colbertModelDir()
      const ortDir = path.dirname(prov.colbertOrtDylibPath())

      const dataDir = await mkdtemp(path.join(os.tmpdir(), "gh-router-colgrep-e2e-data-"))
      dirs.push(dataDir)
      const env = {
        ...process.env,
        COLGREP_DATA_DIR: dataDir,
        ORT_DYLIB_PATH: prov.colbertOrtDylibPath(),
        COLGREP_FORCE_CPU: "1",
        PATH: `${ortDir}${path.delimiter}${process.env.PATH ?? ""}`,
      }

      const indexAndList = async (ws: string): Promise<string[]> => {
        await runManagedExeCapture(
          binary,
          ["init", "-y", "--color", "never", "--force-cpu", "--model", model, ws],
          { env, timeoutMs: 180_000, maxStdoutBytes: 1 << 20 },
        )
        // Exactly one project dir per hermetic data dir; read its manifest.
        const proj = readdirSync(dataDir).find((d) => {
          try {
            readFileSync(path.join(dataDir, d, "state.json"))
            return true
          } catch {
            return false
          }
        })
        if (!proj) return []
        const state = JSON.parse(
          readFileSync(path.join(dataDir, proj, "state.json"), "utf8"),
        )
        return Object.keys(state.files ?? {})
      }
      const has = (keys: string[], name: string) =>
        keys.some((k) => k.split(/[\\/]/).includes(name))

      // (a) git repo: build-out/ (non-default name, only in .gitignore) skipped.
      const gitWs = await tmpWorkspace()
      await mkdir(path.join(gitWs, "src"), { recursive: true })
      await mkdir(path.join(gitWs, "build-out"), { recursive: true })
      await writeFile(path.join(gitWs, "src", "app.ts"), "export const a = 'MARK app'\n")
      await writeFile(path.join(gitWs, "build-out", "gen.ts"), "export const g = 'MARK gen'\n")
      await writeFile(path.join(gitWs, ".gitignore"), "build-out/\n")
      execFileSync("git", ["init", "-q"], { cwd: gitWs })
      const gitKeys = await indexAndList(gitWs)
      expect(has(gitKeys, "app.ts")).toBe(true)
      expect(has(gitKeys, "gen.ts")).toBe(false) // .gitignore honored in a git repo

      // (b) NON-git dir: without the mirror, colgrep would index gen.ts.
      //     After ensureIgnoreMirror, the mirrored .ignore is honored.
      const bareWs = await tmpWorkspace()
      await mkdir(path.join(bareWs, "src"), { recursive: true })
      await mkdir(path.join(bareWs, "build-out"), { recursive: true })
      await writeFile(path.join(bareWs, "src", "app.ts"), "export const a = 'MARK app'\n")
      await writeFile(path.join(bareWs, "build-out", "gen.ts"), "export const g = 'MARK gen'\n")
      await writeFile(path.join(bareWs, ".gitignore"), "build-out/\n")
      await ensureIgnoreMirror(bareWs) // the fix under test
      const bareKeys = await indexAndList(bareWs)
      expect(has(bareKeys, "app.ts")).toBe(true)
      expect(has(bareKeys, "gen.ts")).toBe(false) // mirror made colgrep skip it
    },
    240_000,
  )
})
