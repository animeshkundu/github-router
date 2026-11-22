import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { buildNpmEnv, managedInstallDisabled } from "~/lib/managed-install/npm-env"

/** The hostile shapes measured against npm 11.20.0 (see the module doc table). */
const HOSTILE = {
  npm_config_global: "true",
  npm_config_dry_run: "true",
  npm_config_workspaces: "true",
  npm_config_omit: "optional",
  npm_config_location: "global",
  npm_config_prefix: "/tmp/elsewhere",
  npm_config_allow_scripts: "is-number",
  npm_config_only: "prod",
  npm_config_link: "true",
  npm_config_before: "2020-01-01",
  npm_config_loglevel: "silent",
} as const

describe("buildNpmEnv", () => {
  test("drops every setting that redirects, skips, or refuses an install", () => {
    const { env, dropped } = buildNpmEnv({ ...HOSTILE, PATH: "/usr/bin" })
    for (const key of Object.keys(HOSTILE)) {
      if (key === "npm_config_allow_scripts") continue
      expect(env[key]).toBeUndefined()
      expect(dropped).toContain(key)
    }
    expect(env.PATH).toBe("/usr/bin")
  })

  test("nulls an inherited allow-scripts policy instead of deleting it", () => {
    // Deleting would let npm fall back to... nothing; but the documented fix in
    // server-setup.ts:1838 is the EMPTY STRING, which npm's loadEnv skips
    // (`envVal === ''` → continue) so the .npmrc cascade applies. Pin the exact
    // shape so the two call sites cannot drift.
    const { env } = buildNpmEnv({ npm_config_allow_scripts: "is-number" })
    expect(env.npm_config_allow_scripts).toBe("")
  })

  test("keeps connection and identity settings, including nerf-dart credentials", () => {
    const base = {
      npm_config_registry: "https://npm.corp.example/",
      "npm_config_//npm.corp.example/:_authToken": "placeholder-token",
      npm_config_https_proxy: "http://proxy.example:3128",
      npm_config_strict_ssl: "false",
      npm_config_userconfig: "/home/u/.npmrc",
      npm_config_cache: "/mnt/big/npm-cache",
      npm_config_fetch_retries: "5",
    }
    const { env, kept } = buildNpmEnv(base)
    for (const [key, value] of Object.entries(base)) {
      expect(env[key]).toBe(value as string)
      expect(kept).toContain(key)
    }
  })

  test("an override wins over the kept cascade", () => {
    const { env } = buildNpmEnv(
      { npm_config_registry: "https://mirror.example/" },
      { npm_config_registry: "https://registry.npmjs.org/" },
    )
    expect(env.npm_config_registry).toBe("https://registry.npmjs.org/")
  })

  test("undefined overrides delete, so a caller can unset a kept key", () => {
    const { env } = buildNpmEnv(
      { npm_config_registry: "https://mirror.example/" },
      { npm_config_registry: undefined },
    )
    expect(env.npm_config_registry).toBeUndefined()
  })

  test("non-npm env passes through untouched, empty npm values are kept as-is", () => {
    const { env } = buildNpmEnv({
      HOME: "/home/u",
      GH_ROUTER_NPM_REGISTRY: "https://registry.npmjs.org/",
      npm_config_registry: "",
    })
    expect(env.HOME).toBe("/home/u")
    expect(env.GH_ROUTER_NPM_REGISTRY).toBe("https://registry.npmjs.org/")
    expect(env.npm_config_registry).toBe("")
  })
})

describe("managedInstallDisabled", () => {
  test("recognises the documented off switches", () => {
    for (const value of ["1", "true", "TRUE", "yes", "on", " 1 "]) {
      expect(managedInstallDisabled({ GH_ROUTER_NO_MANAGED_INSTALL: value })).toBe(true)
    }
    for (const value of ["", "0", "false", "no", "off", undefined]) {
      expect(managedInstallDisabled({ GH_ROUTER_NO_MANAGED_INSTALL: value })).toBe(false)
    }
  })
})

describe("npm-env probe against a real npm (opt-in)", () => {
  // The scrub's whole purpose is to survive whatever the *installed* npm does.
  // The unit tests above pin our side of the contract; this one pins npm's.
  // Opt-in because it needs the network and a real npm on PATH.
  const enabled = process.env.GH_ROUTER_TEST_REAL_NPM === "1"
  const dirs: Array<string> = []

  afterEach(async () => {
    for (const dir of dirs.splice(0)) {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
    }
  })

  test.skipIf(!enabled)(
    "installs into the prefix even with a hostile npm_config_* environment",
    async () => {
      const { resolveExecutable, runCommandCapture } = await import("~/lib/exec")
      const npmPath = resolveExecutable("npm")
      expect(npmPath).not.toBeNull()

      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "npm-env-real-"))
      dirs.push(dir)
      await fs.writeFile(
        path.join(dir, "package.json"),
        JSON.stringify({ name: "probe", private: true, dependencies: { "is-number": "7.0.0" } }),
      )

      const { env } = buildNpmEnv({ ...process.env, ...HOSTILE })
      const { code, stderr } = await runCommandCapture(
        [npmPath!, "install", "--no-global", "--no-dry-run", "--ignore-scripts", "--loglevel=error"],
        { cwd: dir, env, timeoutMs: 120_000 },
      )
      expect(stderr).not.toContain("EALLOWSCRIPTS")
      expect(code).toBe(0)
      const installed = await fs
        .readFile(path.join(dir, "node_modules", "is-number", "package.json"), "utf8")
        .catch(() => null)
      expect(installed).not.toBeNull()
    },
    180_000,
  )
})
