/**
 * The hook launcher must survive being separated from its package.
 *
 * Motivating incident: `github-router claude` persists Claude Code hook
 * commands into a settings.json that outlives the process that wrote it, built
 * from `process.argv[1]`. Under `bunx` that path lives in `$TMPDIR`, and
 * macOS's per-user temp reaper deletes files there while leaving the directory
 * skeleton — a real machine measured `dirs=599 files=0` in a bunx install. So
 * `node <tmp>/…/dist/main.js` died on its first bare import
 * (`ERR_MODULE_NOT_FOUND` for `consola`, the first bare specifier in the
 * bundle) and EVERY hook invocation in a 33-hour session failed, 54 of them,
 * strictly alternating UserPromptSubmit/Stop.
 *
 * The fix relocates the hook code to `<APP_DIR>/hooks/hooks-<sha256>.mjs`,
 * which only works if the bundle is genuinely self-contained. These tests pin
 * that property against the thing most likely to erode it: someone adding a
 * dependency, or a bundler default changing, so that the "single file" quietly
 * becomes a file plus a sibling chunk it can no longer find.
 *
 * WHY THIS LIVES IN tests/isolated/ AND USES NO `mock.module`
 *
 * Lane 2 exists for mock isolation, but the mechanism it provides — one
 * process per file, run one at a time — is also what this file needs for a
 * different reason. Proving relocation requires really spawning `node` against
 * the real bundle, eleven times. In lane 1 that added enough wall-clock load
 * to tip pre-existing timing-sensitive tests over their bars: a `< 100ms`
 * assertion in `worker-agent-stream-fn` and a 5s bash timeout in the toolbelt
 * suite both failed intermittently, and both passed as soon as this file was
 * excluded. Relaxing someone else's budget to make room for these spawns would
 * be weakening a gate to fit a new test; moving the load out of the shared
 * lane is the honest fix.
 *
 * Consequence to know: `bunfig.toml` hides `tests/isolated/**` from a bare
 * `bun test`, so these run under `bun run test` (what CI runs) and not in a
 * quick local sweep.
 */

import { test, expect, describe, beforeAll } from "bun:test"

import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { isBuiltin } from "node:module"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const DIST_DIR = path.resolve(import.meta.dirname, "../../dist")
const BUNDLE_PATH = path.join(DIST_DIR, "hooks.mjs")
const DIGEST_PATH = path.join(DIST_DIR, "hooks.sha256")

/**
 * Every subcommand the launcher is expected to dispatch, with the arguments
 * its own definition makes REQUIRED — `internal-worker-guard` exits 1 on a
 * missing `--workers-key`, which would otherwise look like a relocation
 * failure rather than a usage error.
 */
const SUBCOMMANDS: ReadonlyArray<{ cmd: string; args: ReadonlyArray<string> }> = [
  { cmd: "internal-stop-hook", args: [] },
  { cmd: "internal-prompt-submit", args: [] },
  { cmd: "internal-stop-review", args: [] },
  { cmd: "internal-plan-review", args: [] },
  { cmd: "internal-session-bind", args: [] },
  { cmd: "internal-workspace-header", args: [] },
  { cmd: "internal-artifact-open", args: [] },
  { cmd: "internal-first-mate-guard", args: [] },
  {
    cmd: "internal-worker-guard",
    args: ["--workers-key", "workers", "--modes", "explore"],
  },
]

/**
 * Same budget and reasoning as tests/internal-hooks-crash.test.ts: a cold
 * `node` load of a multi-megabyte bundle measures seconds on Windows, and a
 * tight budget would turn a correctness test into a flaky perf test.
 */
const SPAWN_TEST_TIMEOUT_MS = 60_000

/**
 * Inner `spawnSync` limit, deliberately well under the per-test budget above.
 *
 * When this fires, `spawnSync` returns `status: null` and a bare
 * `expect(status).toBe(0)` reports "expected 0, received null" — which reads
 * like the process exited badly when it was actually killed mid-run. This file
 * adds ten spawns to a lane that already contains spawn-based tests, so the
 * contention is real; `expectSpawnCompleted` below turns a kill into an
 * unambiguous message instead of a misleading one.
 */
const SPAWN_KILL_MS = 45_000

/** Fail loudly and accurately when the child was killed rather than finished. */
function expectSpawnCompleted(
  res: ReturnType<typeof spawnSync>,
  label: string,
): void {
  if (res.error && (res.error as NodeJS.ErrnoException).code === "ETIMEDOUT") {
    throw new Error(
      `${label}: child was killed after ${SPAWN_KILL_MS}ms without exiting. `
        + "This is a hang or extreme machine load, NOT a bad exit code.",
    )
  }
}

let bundleExists = false
let nodeOk = false
let bundleText = ""

beforeAll(() => {
  bundleExists = fs.existsSync(BUNDLE_PATH)
  if (bundleExists) {
    // latin1, not utf8: the bundle contains non-UTF8 bytes, and a lossy decode
    // would corrupt exactly the import statements being asserted on.
    bundleText = fs.readFileSync(BUNDLE_PATH, "latin1")
  }
  try {
    const v = spawnSync("node", ["--version"], { encoding: "utf8" })
    nodeOk = v.status === 0 && /^v\d/.test((v.stdout ?? "").trim())
  } catch {
    nodeOk = false
  }
})

describe("hook launcher bundle: self-containment", () => {
  test("dist/hooks.mjs exists (build must run before tests)", () => {
    expect(bundleExists).toBe(true)
  })

  test("imports nothing but node: builtins", () => {
    if (!bundleExists) return
    const specifiers = new Set<string>()
    for (const m of bundleText.matchAll(/(?:^|\n)\s*import\s[^;]*?from\s*"([^"]+)"/g)) {
      if (m[1]) specifiers.add(m[1])
    }
    for (const m of bundleText.matchAll(/(?:^|\n)\s*import\s*"([^"]+)"/g)) {
      if (m[1]) specifiers.add(m[1])
    }
    const external = [...specifiers].filter((s) => !s.startsWith("node:"))
    // A single bare specifier here reintroduces the original bug: it would be
    // resolved against a node_modules that the relocated launcher has no
    // relationship to.
    expect(external).toEqual([])
  })

  test("references no sibling chunk", () => {
    if (!bundleExists) return
    // Relative specifiers are the failure this guards: rolldown emits sibling
    // chunks when code splitting is on, and a relocated single file cannot
    // resolve them. (An ORPHAN chunk that nothing imports is harmless and is
    // deliberately not asserted against — rolldown emits one holding
    // tree-shaken-empty module shells.)
    const relative = bundleText.match(/from\s*"\.\.?\/[^"]*"/g) ?? []
    expect(relative).toEqual([])
    const dynamicRelative = bundleText.match(/import\(\s*"\.\.?\/[^"]*"\s*\)/g) ?? []
    expect(dynamicRelative).toEqual([])
  })

  test("every require() target is a node builtin", () => {
    if (!bundleExists) return
    // The import-only assertions above have a blind spot: rolldown emits
    // `__require = createRequire(import.meta.url)` for CJS interop and calls
    // it. A bare `__require("some-pkg")` satisfies every import check and then
    // fails at runtime from <APP_DIR>/hooks/, which is exactly the original
    // bug wearing a different hat. This is the assertion that would catch a
    // future dependency reaching the hook graph through CJS.
    const targets = new Set<string>()
    for (const m of bundleText.matchAll(/\b__?require\s*\(\s*"([^"]+)"\s*\)/g)) {
      if (m[1]) targets.add(m[1])
    }
    // A `node:` prefix is trusted outright rather than run past `isBuiltin`.
    // `isBuiltin` answers for the runtime executing THIS TEST, not the one
    // executing the hooks: bun 1.3.14 returns false for `node:sqlite` (which
    // the bundle does pull in) while Node and newer bun return true, so using
    // it as the sole oracle failed CI on the pinned bun while passing on
    // canary. The prefix is unambiguous everywhere; `isBuiltin` is kept only
    // for the legacy UNPREFIXED names rolldown emits (`buffer`, `process`).
    const nonBuiltin = [...targets].filter(
      (t) => !t.startsWith("node:") && !isBuiltin(t),
    )
    expect(nonBuiltin).toEqual([])
  })

  test("the bundle sits directly beside the chunk that publishes it", () => {
    if (!bundleExists) return
    // `bundledLauncherPath()` resolves `hooks.mjs` as a SIBLING of the chunk
    // holding provision.ts. Nothing else pins that: if the bundler ever nests
    // chunks, provisioning silently returns undefined, every hook falls back
    // to process.argv[1], and the original bug returns with no test failing.
    const provisioningChunks = fs
      .readdirSync(DIST_DIR)
      .filter(
        (f) =>
          f.endsWith(".js")
          && fs
            .readFileSync(path.join(DIST_DIR, f), "latin1")
            .includes("[hook-launcher]"),
      )
    expect(provisioningChunks.length).toBeGreaterThan(0)
    // Same directory as dist/hooks.mjs — a nested chunk would break the lookup.
    for (const chunk of provisioningChunks) {
      expect(path.dirname(path.join(DIST_DIR, chunk))).toBe(
        path.dirname(BUNDLE_PATH),
      )
    }
  })

  test("the digest sidecar matches the built bundle", () => {
    if (!bundleExists) return
    // The provisioner refuses to publish a bundle whose bytes disagree with
    // this value — that is what stops a torn mid-`bunx`-extraction read being
    // frozen under a stable content-addressed name forever.
    expect(fs.existsSync(DIGEST_PATH)).toBe(true)
    const expected = fs.readFileSync(DIGEST_PATH, "utf8").trim()
    const actual = createHash("sha256")
      .update(fs.readFileSync(BUNDLE_PATH))
      .digest("hex")
    expect(actual).toBe(expected)
  })
})

describe("hook launcher bundle: runs relocated", () => {
  let relocatedDir = ""
  let relocated = ""

  beforeAll(() => {
    if (!bundleExists) return
    // An empty directory with no node_modules anywhere beneath it, standing in
    // for <APP_DIR>/hooks/ after the package tree has been reaped.
    relocatedDir = fs.mkdtempSync(path.join(os.tmpdir(), "gh-router-relocated-"))
    relocated = path.join(relocatedDir, "hooks.mjs")
    fs.copyFileSync(BUNDLE_PATH, relocated)
  })

  for (const { cmd, args } of SUBCOMMANDS) {
    test(`${cmd} runs from a directory with no node_modules`, () => {
      if (!bundleExists || !nodeOk) return
      const res = spawnSync("node", [relocated, cmd, ...args], {
        input: "{}",
        encoding: "utf8",
        // cwd is deliberately NOT the repo: a resolution that accidentally
        // depends on the working directory must fail here rather than pass.
        cwd: relocatedDir,
        env: { ...process.env, GH_ROUTER_HOOK_MCP_URL: "", GH_ROUTER_HOOK_NONCE: "" },
        timeout: SPAWN_KILL_MS,
      })
      expectSpawnCompleted(res, cmd)
      const stderr = res.stderr ?? ""
      // The exact signature of the bug this whole change exists to fix.
      expect(stderr).not.toMatch(/ERR_MODULE_NOT_FOUND|Cannot find package/)
      // Guards the pre-22.7 runtimes this package still supports (it declares
      // no `engines` floor). Node has detected ESM syntax by default since
      // 22.7, so on a current runtime the bundle would survive even named
      // `.js`; on Node 20 it would be read as CommonJS and die here. The
      // `.mjs` extension makes the answer version-independent.
      expect(stderr).not.toMatch(/Cannot use import statement outside a module/)
      expect(stderr).not.toMatch(/Assertion failed|UV_HANDLE_CLOSING/)
      expect(res.status).toBe(0)
    }, SPAWN_TEST_TIMEOUT_MS)
  }

  test("--package-root is consumed and restores the runtime version read", () => {
    if (!bundleExists || !nodeOk) return
    const repoRoot = path.resolve(import.meta.dirname, "../..")
    const expected = (
      JSON.parse(
        fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"),
      ) as { version: string }
    ).version

    const withRoot = spawnSync(
      "node",
      [relocated, "--package-root", repoRoot, "--version"],
      { encoding: "utf8", cwd: relocatedDir, timeout: SPAWN_KILL_MS },
    )
    expectSpawnCompleted(withRoot, "--version with --package-root")
    // Proves both halves: citty did not reject the flag (it is stripped before
    // parsing), and the version is still READ at runtime rather than baked at
    // build time — release.yml builds before `npm version patch`, so an inlined
    // version would always ship the pre-bump value.
    expect((withRoot.stdout ?? "").trim()).toBe(expected)

    const withoutRoot = spawnSync("node", [relocated, "--version"], {
      encoding: "utf8",
      cwd: relocatedDir,
      timeout: SPAWN_KILL_MS,
    })
    expectSpawnCompleted(withoutRoot, "--version without --package-root")
    // Without the flag the relocated bundle genuinely cannot find its
    // package.json. That is why the flag exists, and why anything else
    // resolving paths relative to the entrypoint has to be told the answer.
    expect((withoutRoot.stdout ?? "").trim()).toBe("unknown")
  }, SPAWN_TEST_TIMEOUT_MS)
})
