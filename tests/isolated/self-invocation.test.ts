import { test, expect, mock, describe, afterEach } from "bun:test"
import fsp from "node:fs/promises"
import os from "node:os"
import path from "node:path"

/**
 * How this process names ITSELF in commands that get written to disk and run
 * later by someone else.
 *
 * The original bug: hook commands were built from `process.argv[1]`, which
 * under `bunx` lives in `$TMPDIR`. macOS's temp reaper empties that directory
 * (files deleted, directory skeleton kept) and every hook in the session then
 * failed with `ERR_MODULE_NOT_FOUND`. `npx` is NOT affected — it installs
 * under `$HOME` — which matters here because npx and global users are not
 * currently broken and must not be broken by the fix.
 */

const tempHome = await fsp.mkdtemp(
  path.join(os.tmpdir(), "github-router-self-invocation-"),
)

mock.module("node:os", () => ({
  default: { ...os, homedir: () => tempHome },
  ...os,
  homedir: () => tempHome,
}))

const { PATHS } = await import("../../src/lib/paths")
const {
  buildSelfCommand,
  currentInvocation,
  hookLauncherDegradedWarning,
  isUnderVolatileRoot,
  resolveSelfInvocation,
  __resetSelfInvocationForTests,
} = await import("../../src/lib/hook-launcher/self-invocation")

afterEach(() => {
  __resetSelfInvocationForTests()
})

describe("volatile-root classification", () => {
  test("a bunx install under the temp dir is volatile", () => {
    // The exact shape from the incident:
    // /var/folders/gh/…/T/bunx-501-github-router@latest/node_modules/.bin/…
    const bunxLike = path.join(
      os.tmpdir(),
      "bunx-501-github-router@latest",
      "node_modules",
      ".bin",
      "github-router",
    )
    expect(isUnderVolatileRoot(bunxLike)).toBe(true)
  })

  test("an npx install under $HOME is NOT volatile", () => {
    // npx uses ~/.npm/_npx (POSIX) / %LOCALAPPDATA%\npm-cache\_npx (Windows).
    // Measured on the machine that hit the bug: the npx copy of the SAME
    // package was fully intact (5655 files) while the bunx copy in $TMPDIR had
    // been emptied to 0 files. Misclassifying this would emit a scary warning
    // to users who were never affected.
    //
    // A LITERAL home path, not `os.homedir()`: this file mocks homedir to a
    // temp dir, so deriving the fixture from it would place a fake "npx"
    // install genuinely inside $TMPDIR and assert the opposite of reality.
    expect(
      isUnderVolatileRoot(
        "/Users/u/.npm/_npx/057940fd5f7c3eaf/node_modules/.bin/github-router",
      ),
    ).toBe(false)
  })

  test("a global install prefix is NOT volatile", () => {
    expect(isUnderVolatileRoot("/usr/local/lib/node_modules/github-router/dist/main.js")).toBe(
      false,
    )
    expect(
      isUnderVolatileRoot("/Users/u/.nvm/versions/node/v24.19.0/bin/github-router"),
    ).toBe(false)
  })

  test("a path merely NAMED like the temp dir is not volatile", () => {
    // Prefix matching without a separator would classify `/tmpfoo` as living
    // under `/tmp`.
    expect(isUnderVolatileRoot(`${os.tmpdir()}-not-really/x`)).toBe(false)
  })
})

describe("command composition", () => {
  const inv = {
    execPath: "/usr/bin/node",
    scriptPath: "/home/u/.local/share/github-router/hooks/hooks-abc.mjs",
    packageRoot: "/pkg/root",
  }

  test("bakes binary, script and package root in that order", () => {
    expect(buildSelfCommand(inv, "internal-stop-hook")).toBe(
      '"/usr/bin/node" "/home/u/.local/share/github-router/hooks/hooks-abc.mjs" '
        + '--package-root "/pkg/root" internal-stop-hook',
    )
  })

  test("omits the package root when there is none to bake", () => {
    // This is the unrelocated shape — byte-identical to what shipped before
    // the fix, which is what keeps npx / global / dev-from-source users on
    // exactly their current behaviour.
    expect(
      buildSelfCommand(
        { execPath: "/usr/bin/node", scriptPath: "/pkg/dist/main.js" },
        "internal-stop-hook",
      ),
    ).toBe('"/usr/bin/node" "/pkg/dist/main.js" internal-stop-hook')
  })

  test("omits the script for a packaged single-file build", () => {
    expect(
      buildSelfCommand(
        { execPath: "/usr/bin/github-router", scriptPath: "/usr/bin/github-router" },
        "internal-stop-hook",
      ),
    ).toBe('"/usr/bin/github-router" internal-stop-hook')
  })

  test("preserves each caller's own baked args verbatim", () => {
    // The worker guard bakes --workers-key / --modes into the ARGS rather than
    // the env so a changed resolution yields a DISTINCT command string; hook
    // dedup is by command string, so losing or reordering these would let a
    // stale matcher survive a relaunch.
    expect(
      buildSelfCommand(
        inv,
        'internal-worker-guard --workers-key "workers" --modes "explore,implement"',
      ),
    ).toBe(
      '"/usr/bin/node" "/home/u/.local/share/github-router/hooks/hooks-abc.mjs" '
        + '--package-root "/pkg/root" internal-worker-guard --workers-key "workers" '
        + '--modes "explore,implement"',
    )
  })
})

describe("degraded-state warning", () => {
  test("warns when a hook command would name a temp path", () => {
    const warning = hookLauncherDegradedWarning({
      execPath: "/usr/bin/node",
      scriptPath: path.join(os.tmpdir(), "bunx-501-github-router@latest/x.js"),
    })
    // Returned rather than logged on purpose: `claude` calls
    // enableFileLogging() before this point, so a consola.warn would land in
    // the error log where nobody looks — the caller writes it to stderr.
    expect(warning).toMatch(/temporary directory/)
  })

  test("warns when the launcher was published without a package root", () => {
    // Reachable when the install tree is partly missing: hooks.mjs and its
    // sidecar survive but package.json does not. Today this only degrades
    // `--version`, but it is the trap that turns into a cwd-relative resolve
    // against the user's repo the moment a hook subcommand pulls in code that
    // consumes the package root.
    const warning = hookLauncherDegradedWarning({
      execPath: "/usr/bin/node",
      scriptPath: path.join(PATHS.HOOK_LAUNCHER_DIR, "hooks-abc.mjs"),
    })
    expect(warning).toMatch(/without a package root/)
  })

  test("stays silent for a healthy relocated launcher", () => {
    expect(
      hookLauncherDegradedWarning({
        execPath: "/usr/bin/node",
        scriptPath: path.join(PATHS.HOOK_LAUNCHER_DIR, "hooks-abc.mjs"),
        packageRoot: "/pkg/root",
      }),
    ).toBeNull()
  })

  test("stays silent for npx, global and dev-from-source", () => {
    // These users are not broken today and must not start seeing a warning.
    for (const scriptPath of [
      "/Users/u/.npm/_npx/057940fd/node_modules/.bin/github-router",
      "/usr/local/lib/node_modules/github-router/dist/main.js",
      "/Users/dev/src/github-router/src/main.ts",
    ]) {
      expect(
        hookLauncherDegradedWarning({ execPath: "/usr/bin/node", scriptPath }),
      ).toBeNull()
    }
  })
})

describe("resolution", () => {
  test("falls back to the running entrypoint when nothing can be published", async () => {
    // These tests run from source, so there is no bundle to publish. The
    // fallback IS today's behaviour — a provisioning failure must degrade, not
    // fail the launch.
    const resolved = await resolveSelfInvocation()
    expect(resolved.execPath).toBe(process.execPath)
    expect(resolved.scriptPath).toBe(currentInvocation().scriptPath)
  })

  test("memoizes so every command in one launch names the same launcher", async () => {
    // A launch that resolved twice could persist two different launchers into
    // one settings.json, which is how a session ends up half-migrated.
    const a = await resolveSelfInvocation()
    const b = await resolveSelfInvocation()
    expect(b).toBe(a)
  })
})
