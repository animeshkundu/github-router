import { test, expect, mock, describe } from "bun:test"
import fsp from "node:fs/promises"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { createHash } from "node:crypto"

/**
 * Publication semantics for the relocated hook launcher.
 *
 * The launcher is the file every persisted Claude Code hook command points at,
 * so the ways this can go wrong are all silent-and-durable: publishing a torn
 * bundle freezes it under a content-addressed name forever, latching a
 * transient failure disables the stable path for the whole process lifetime,
 * and a non-atomic write leaves a partial file under the exact name a hook is
 * about to execute.
 */

const tempHome = await fsp.mkdtemp(
  path.join(os.tmpdir(), "github-router-hook-launcher-"),
)

// Same homedir-override pattern as tests/isolated/claude-md-injection.test.ts —
// preserve every other os export so os.tmpdir() keeps working here and in any
// later file sharing this process.
mock.module("node:os", () => ({
  default: { ...os, homedir: () => tempHome },
  ...os,
  homedir: () => tempHome,
}))

const { PATHS } = await import("../../src/lib/paths")
const {
  provisionHookLauncher,
  publishLauncherFrom,
  __resetHookLauncherForTests,
} = await import("../../src/lib/hook-launcher/provision")

const REPO_DIST = path.resolve(import.meta.dirname, "../../dist")
const BUNDLE = path.join(REPO_DIST, "hooks.mjs")
const built = fs.existsSync(BUNDLE) && fs.existsSync(path.join(REPO_DIST, "hooks.sha256"))

function sha256(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex")
}

/** A throwaway dist-shaped directory: a bundle plus its digest sidecar. */
async function fakeDist(
  contents: string,
  sidecar?: string,
): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "gh-fake-dist-"))
  fs.writeFileSync(path.join(dir, "hooks.mjs"), contents)
  if (sidecar !== undefined) {
    fs.writeFileSync(path.join(dir, "hooks.sha256"), `${sidecar}\n`)
  }
  return dir
}

describe("hook launcher: publication", () => {
  test("publishes under the digest of its own bytes", async () => {
    __resetHookLauncherForTests()
    const dir = await fakeDist("export const x = 1\n", sha256("export const x = 1\n"))
    const published = publishLauncherFrom(path.join(dir, "hooks.mjs"))

    expect(published).toBeTruthy()
    const target = published as string
    // Content-addressed: the name IS the digest, which is what lets two
    // proxies on different versions coexist with nothing to garbage-collect,
    // and therefore no cross-process delete race on a live session's launcher.
    expect(path.basename(target)).toBe(`hooks-${sha256("export const x = 1\n")}.mjs`)
    expect(path.dirname(target)).toBe(PATHS.HOOK_LAUNCHER_DIR)
    expect(fs.readFileSync(target, "utf8")).toBe("export const x = 1\n")

    await fsp.rm(dir, { recursive: true, force: true })
  })

  test("refuses a bundle whose digest disagrees with the build's sidecar", async () => {
    __resetHookLauncherForTests()
    // The shape of a read that raced a `bunx` in-place re-extraction. Content
    // addressing alone cannot catch this: a truncated file hashes to something
    // perfectly valid and would be preserved under that hash forever.
    const dir = await fakeDist("truncated", "0".repeat(64))
    expect(publishLauncherFrom(path.join(dir, "hooks.mjs"))).toBeUndefined()

    const published = fs.existsSync(PATHS.HOOK_LAUNCHER_DIR)
      ? fs.readdirSync(PATHS.HOOK_LAUNCHER_DIR)
      : []
    expect(published.some((f) => f.includes("truncated"))).toBe(false)

    await fsp.rm(dir, { recursive: true, force: true })
  })

  test("refuses when the sidecar is missing entirely", async () => {
    __resetHookLauncherForTests()
    // Deliberate asymmetry: "cannot verify" and "verified bad" both mean
    // do-not-publish. Treating an absent sidecar as permission would delete the
    // integrity check in exactly the degraded conditions it exists for.
    const dir = await fakeDist("export const y = 2\n")
    expect(publishLauncherFrom(path.join(dir, "hooks.mjs"))).toBeUndefined()
    await fsp.rm(dir, { recursive: true, force: true })
  })

  test("refuses a malformed sidecar rather than trusting it", async () => {
    __resetHookLauncherForTests()
    const dir = await fakeDist("export const z = 3\n", "not-a-digest")
    expect(publishLauncherFrom(path.join(dir, "hooks.mjs"))).toBeUndefined()
    await fsp.rm(dir, { recursive: true, force: true })
  })

  test("is idempotent and leaves no temp files behind", async () => {
    __resetHookLauncherForTests()
    const body = "export const idem = 1\n"
    const dir = await fakeDist(body, sha256(body))
    const first = publishLauncherFrom(path.join(dir, "hooks.mjs"))
    const second = publishLauncherFrom(path.join(dir, "hooks.mjs"))
    expect(second).toBe(first as string)

    // A leftover .tmp means a rename failed silently. The publish path cleans
    // up after every failed attempt precisely so a retry cannot litter the
    // directory that hook commands execute out of.
    const stray = fs
      .readdirSync(PATHS.HOOK_LAUNCHER_DIR)
      .filter((f) => f.endsWith(".tmp"))
    expect(stray).toEqual([])

    await fsp.rm(dir, { recursive: true, force: true })
  })

  test("republishes after the target is deleted out from under it", async () => {
    __resetHookLauncherForTests()
    const body = "export const heal = 1\n"
    const dir = await fakeDist(body, sha256(body))
    const target = publishLauncherFrom(path.join(dir, "hooks.mjs")) as string
    fs.rmSync(target)

    // APP_DIR is not a temp dir, so this should not happen — but a resolver
    // that silently accepted a missing target would hand a hook command a path
    // to nothing, which is the failure mode this whole change exists to end.
    expect(publishLauncherFrom(path.join(dir, "hooks.mjs"))).toBe(target)
    expect(fs.existsSync(target)).toBe(true)

    await fsp.rm(dir, { recursive: true, force: true })
  })
})

describe("hook launcher: resolution", () => {
  test("running from source publishes nothing", async () => {
    __resetHookLauncherForTests()
    // These tests import the module from `src/`, so the sibling lookup lands on
    // `src/lib/hook-launcher/hooks.mjs`, which does not exist. That is the
    // intended dev-from-source behaviour: `bun run dev` must keep using
    // `process.argv[1]` rather than silently adopting a stale bundle left over
    // from some earlier build.
    expect(await provisionHookLauncher()).toBeUndefined()
  })

  test("a failed resolution is not latched", async () => {
    __resetHookLauncherForTests()
    expect(await provisionHookLauncher()).toBeUndefined()
    // Caching the failure would disable the stable launcher for the rest of
    // the process lifetime after one transient EBUSY (Windows antivirus, a
    // concurrent reader), which is worse than the condition it reacts to.
    expect(await provisionHookLauncher()).toBeUndefined()

    const body = "export const unlatched = 1\n"
    const dir = await fakeDist(body, sha256(body))
    expect(publishLauncherFrom(path.join(dir, "hooks.mjs"))).toBeTruthy()
    await fsp.rm(dir, { recursive: true, force: true })
  })

  test("single-flight: concurrent calls collapse to one answer", async () => {
    __resetHookLauncherForTests()
    const results = await Promise.all([
      provisionHookLauncher(),
      provisionHookLauncher(),
      provisionHookLauncher(),
    ])
    expect(new Set(results).size).toBe(1)
  })
})

describe("hook launcher: the real built bundle", () => {
  test("publishes and round-trips byte-for-byte", () => {
    if (!built) return // lane-1 tests/hook-launcher-bundle.test.ts asserts the build ran
    __resetHookLauncherForTests()
    const published = publishLauncherFrom(BUNDLE) as string
    expect(published).toBeTruthy()
    expect(sha256(fs.readFileSync(published))).toBe(sha256(fs.readFileSync(BUNDLE)))
    expect(path.basename(published)).toBe(
      `hooks-${sha256(fs.readFileSync(BUNDLE))}.mjs`,
    )
  })
})
