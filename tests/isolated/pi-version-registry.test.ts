/**
 * The Pi launcher fail-closes when the installed Pi is below `PI_MIN_VERSION`,
 * and it upgrades with `npm install -g`. On a machine whose npm is pointed at a
 * corporate mirror that lags npmjs, that upgrade resolves through the SAME
 * mirror and cannot satisfy the floor — the launcher would print a command that
 * cannot work and exit 1 forever. These tests pin the fix: the Pi package probe
 * and the Pi install both carry an explicit `--registry`, defaulting to npmjs
 * and overridable with `GH_ROUTER_NPM_REGISTRY`.
 *
 * Isolated because it replaces `~/lib/exec` wholesale: bun applies `mock.module`
 * process-globally and `mock.restore()` cannot undo it, so sharing a process
 * would hand the fake `npm` to every other suite.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

// Captured BEFORE the node:os mock is installed; the mock's default-export-only
// shape would otherwise shadow tmpdir() for every later module in the process.
const REAL_TMPDIR = os.tmpdir()
const TEST_HOME = await fs.mkdtemp(path.join(REAL_TMPDIR, "gh-router-pi-registry-"))

mock.module("node:os", () => ({
  default: {
    homedir: () => TEST_HOME,
    tmpdir: () => REAL_TMPDIR,
  },
}))

interface RecordedCommand {
  kind: "capture" | "void"
  cmd: string[]
}

const commands: Array<RecordedCommand> = []

// Resolved BEFORE the mock is installed, and spread back in: `mock.module`
// replaces the whole module, so omitting an export that some other module in
// this process imports turns into a SyntaxError at its import site rather than
// a stubbed function.
const realExec = await import("../../src/lib/exec")
const realUpdateLock = await import("../../src/lib/update-lock")

mock.module("~/lib/exec", () => ({
  ...realExec,
  resolveExecutable: (name: string) => `/fake/bin/${name}`,
  runCommandCapture: async (cmd: string[]) => {
    commands.push({ kind: "capture", cmd })
    return {
      stdout: "1.3.0\n",
      stderr: "",
      code: 0,
      timedOut: false,
      truncated: false,
      stderrTruncated: false,
    }
  },
  runCommandVoid: async (cmd: string[]) => {
    commands.push({ kind: "void", cmd })
    return {
      stdout: "",
      stderr: "",
      code: 0,
      timedOut: false,
      truncated: false,
      stderrTruncated: false,
    }
  },
}))

// Real locking writes under the (mocked) home and serializes against any other
// process on the machine; the lock is not what these tests are about. Stubs the
// acquire so the install body always runs, which is what lets the argv be
// captured.
mock.module("~/lib/update-lock", () => ({
  ...realUpdateLock,
  withInstallLock: async (_name: string, fn: () => Promise<void>) => {
    await fn()
    return true
  },
}))

const ORIGINAL_REGISTRY_ENV = process.env.GH_ROUTER_NPM_REGISTRY

beforeEach(() => {
  commands.length = 0
  delete process.env.GH_ROUTER_NPM_REGISTRY
  // The throttle cache lives under the mocked homedir; clear it so every test
  // performs the real probe rather than replaying a previous test's result.
  return fs
    .rm(path.join(TEST_HOME, ".local"), { recursive: true, force: true })
    .catch(() => {})
})

afterEach(() => {
  if (ORIGINAL_REGISTRY_ENV === undefined) {
    delete process.env.GH_ROUTER_NPM_REGISTRY
  } else {
    process.env.GH_ROUTER_NPM_REGISTRY = ORIGINAL_REGISTRY_ENV
  }
})

async function loadModule() {
  return import("../../src/lib/pi-version-check")
}

function npmViewCommand(): string[] {
  const found = commands.find(
    (c) => c.kind === "capture" && c.cmd.includes("view"),
  )
  if (!found) throw new Error("no `npm view` invocation was recorded")
  return found.cmd
}

/**
 * Any recorded `npm install`, whichever capture mode produced it. The old
 * Pi install went through `runCommandVoid`; the managed installer goes through
 * `runCommandCapture` (it needs stderr for the failure message), so filtering on
 * the mode would report "no npm install was recorded" for a test that just
 * recorded one.
 */
function npmInstallCommand(): string[] {
  const found = commands.find((c) => c.cmd.includes("install"))
  if (!found) throw new Error("no `npm install` invocation was recorded")
  return found.cmd
}

describe("resolvePiRegistry", () => {
  test("defaults to npmjs so the floor is reachable through a lagging mirror", async () => {
    const { resolvePiRegistry, PI_DEFAULT_REGISTRY } = await loadModule()
    expect(resolvePiRegistry()).toBe(PI_DEFAULT_REGISTRY)
    expect(PI_DEFAULT_REGISTRY).toBe("https://registry.npmjs.org/")
  })

  test("honors GH_ROUTER_NPM_REGISTRY and normalizes a missing trailing slash", async () => {
    const { resolvePiRegistry } = await loadModule()
    process.env.GH_ROUTER_NPM_REGISTRY = "https://mirror.example.test/npm"
    expect(resolvePiRegistry()).toBe("https://mirror.example.test/npm/")
    process.env.GH_ROUTER_NPM_REGISTRY = "https://mirror.example.test/npm/"
    expect(resolvePiRegistry()).toBe("https://mirror.example.test/npm/")
  })

  test("a non-URL override degrades to the default instead of bricking the launcher", async () => {
    const { resolvePiRegistry, PI_DEFAULT_REGISTRY } = await loadModule()
    process.env.GH_ROUTER_NPM_REGISTRY = "mirror.example.test"
    expect(resolvePiRegistry()).toBe(PI_DEFAULT_REGISTRY)
    process.env.GH_ROUTER_NPM_REGISTRY = "   "
    expect(resolvePiRegistry()).toBe(PI_DEFAULT_REGISTRY)
  })

  test("piRegistryArgs carries the resolved registry as one argv entry", async () => {
    const { piRegistryArgs, PI_DEFAULT_REGISTRY } = await loadModule()
    expect(piRegistryArgs()).toEqual([`--registry=${PI_DEFAULT_REGISTRY}`])
  })
})

describe("the Pi version probe and install pin the registry", () => {
  test("checkPiVersion's npm view targets npmjs by default", async () => {
    const { checkPiVersion, PI_DEFAULT_REGISTRY } = await loadModule()
    await checkPiVersion({ force: true })
    expect(npmViewCommand()).toContain(`--registry=${PI_DEFAULT_REGISTRY}`)
  })

  test("checkPiVersion's npm view follows the env override", async () => {
    const { checkPiVersion } = await loadModule()
    process.env.GH_ROUTER_NPM_REGISTRY = "https://mirror.example.test/npm/"
    await checkPiVersion({ force: true })
    expect(npmViewCommand()).toContain(
      "--registry=https://mirror.example.test/npm/",
    )
  })

  // `updatePi` (npm install -g) was removed: the below-floor repair path is now
  // the MANAGED install, which must (a) never use `-g`, (b) still pin the
  // registry, and (c) still scrub the ambient npm env. These assert the argv the
  // managed installer actually spawns, through the same mocked exec the old
  // tests used.
  test("the managed Pi install pins the registry and never installs globally", async () => {
    const { ensureManagedInstall } = await import("../../src/lib/managed-install/install")
    const { resolvePiRegistry, PI_NPM_PACKAGE } = await loadModule()
    // The mocked npm installs nothing, so the entry verification fails by
    // design; the argv is what this test is about.
    await ensureManagedInstall({
      kind: "pi",
      version: "1.3.0",
      registry: resolvePiRegistry(),
    }).catch(() => {})
    const cmd = npmInstallCommand()
    expect(cmd).not.toContain("-g")
    expect(cmd).not.toContain("--global")
    expect(cmd).toContain("--no-global")
    expect(cmd).toContain("--ignore-scripts")
    expect(cmd).toContain(`--registry=${`https://registry.npmjs.org/`}`)
    // The package is installed via the generated staging package.json, so the
    // spec is not on argv — assert the generated dependency instead.
    expect(PI_NPM_PACKAGE).toBe("@earendil-works/pi-coding-agent")
  })

  test("the managed Pi install follows the registry override", async () => {
    const { ensureManagedInstall } = await import("../../src/lib/managed-install/install")
    const { resolvePiRegistry } = await loadModule()
    process.env.GH_ROUTER_NPM_REGISTRY = "https://mirror.example.test/npm/"
    await ensureManagedInstall({
      kind: "pi",
      version: "1.3.0",
      registry: resolvePiRegistry(),
      force: true,
    }).catch(() => {})
    expect(npmInstallCommand()).toContain("--registry=https://mirror.example.test/npm/")
  })

  test("a hostile allow_scripts in the ambient env is neutralized", async () => {
    const { ensureManagedInstall } = await import("../../src/lib/managed-install/install")
    process.env.npm_config_allow_scripts = "is-number"
    try {
      await ensureManagedInstall({ kind: "pi", version: "1.3.0", force: true }).catch(() => {})
    } finally {
      delete process.env.npm_config_allow_scripts
    }
    // The child env is not observable through this mock, so the invariant is
    // asserted where it is enforced: `buildNpmEnv` always sets it to "".
    const { buildNpmEnv } = await import("../../src/lib/managed-install/npm-env")
    expect(buildNpmEnv({ npm_config_allow_scripts: "is-number" }).env.npm_config_allow_scripts).toBe(
      "",
    )
  })
})

describe("PI_MIN_VERSION floor", () => {
  test("the floor is the release carrying the before_agent_start messageType discriminator", async () => {
    const { PI_MIN_VERSION, meetsPiMinVersion } = await loadModule()
    expect(PI_MIN_VERSION).toBe("1.3.0")
    expect(meetsPiMinVersion("1.3.0")).toBe(true)
    expect(meetsPiMinVersion("1.3.1")).toBe(true)
    expect(meetsPiMinVersion("1.4.0")).toBe(true)
    // 1.1.0 is what the corporate mirror serves as `latest`; its
    // before_agent_start event has no messageType field, so it cannot serve the
    // prompt hook and must fail closed rather than fire on subagent turns.
    expect(meetsPiMinVersion("1.1.0")).toBe(false)
    expect(meetsPiMinVersion("1.2.9")).toBe(false)
    expect(meetsPiMinVersion(null)).toBe(false)
  })
})
