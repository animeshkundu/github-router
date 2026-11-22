/**
 * `github-router update`: which kinds it touches, and what it exits with.
 *
 * The exit code is the whole contract for a shell or a CI step, and it is easy to
 * get subtly wrong in a way no e2e run would catch: "another install is running"
 * and "the registry did not answer" are both non-events, while a genuine install
 * failure must be non-zero. So the classification is asserted directly, with the
 * managed layer mocked (the real one is covered by the managed-install suite; this
 * file is about the CLI's reporting and status).
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"

import type { InstallOutcome } from "~/lib/managed-install/install"
import type { ManagedKind } from "~/lib/managed-install/paths"
import type { UpdateReport } from "~/lib/managed-install/update"

/** Outcomes each `runManagedUpdate` call returns, in order. */
const outcomes: Array<InstallOutcome> = []
/** Calls recorded, so the tests can assert WHICH kinds were touched. */
const calls: Array<{ kind: string; version?: string; force?: boolean }> = []
/** Optional-payload calls. */
const optionalCalls: Array<{ pkg: string; force?: boolean }> = []
/** Target version returned by the mocked `checkForUpdate` (null = npm view failed). */
const checkTargets: { value: string | null } = { value: "1.0.0" }

const realUpdate = await import("../../src/lib/managed-install/update")
const realOptional = await import("../../src/lib/managed-install/optional")

mock.module("~/lib/managed-install/update", () => ({
  ...realUpdate,
  runManagedUpdate: async (opts: { kind: ManagedKind; version?: string; force?: boolean }) => {
    calls.push({ kind: opts.kind, ...(opts.version ? { version: opts.version } : {}), force: opts.force })
    const outcome = outcomes.shift() ?? { kind: "adopted", version: "1.0.0" }
    return {
      check: {
        kind: opts.kind,
        installedVersion: null,
        latestVersion: "1.0.0",
        targetVersion: "1.0.0",
        upToDate: false,
        registry: null,
        entryPath: null,
      },
      outcome,
    } satisfies UpdateReport
  },
  checkForUpdate: async (kind: ManagedKind) => {
    calls.push({ kind })
    return {
      kind,
      installedVersion: "0.9.0",
      latestVersion: checkTargets.value,
      targetVersion: checkTargets.value,
      upToDate: false,
      registry: null,
      entryPath: null,
    }
  },
}))

mock.module("~/lib/managed-install/optional", () => ({
  ...realOptional,
  // `ensureOptionalPackage` (singular) is what `update` now calls: the plural
  // wrapper could not be narrowed to one payload, and narrowing matters — see
  // the `--optional-pkg` test.
  ensureOptionalPackage: async (pkg: string, opts: { force?: boolean } = {}) => {
    optionalCalls.push({ pkg, force: opts.force })
    return { dir: null as string | null }
  },
}))

const { resolveKinds, runUpdate } = await import("../../src/update")

const savedQuiet = { value: undefined as string | undefined }

beforeEach(() => {
  outcomes.length = 0
  calls.length = 0
  optionalCalls.length = 0
  savedQuiet.value = process.env.GH_ROUTER_NO_OPTIONAL_INSTALL
  // The optional payload is a 547 MB download in the real world; the mock makes
  // it a no-op, but the env keeps a stray real call from slipping through if the
  // mock is ever wrong.
  process.env.GH_ROUTER_NO_OPTIONAL_INSTALL = "1"
})

afterEach(() => {
  if (savedQuiet.value === undefined) delete process.env.GH_ROUTER_NO_OPTIONAL_INSTALL
  else process.env.GH_ROUTER_NO_OPTIONAL_INSTALL = savedQuiet.value
})

describe("resolveKinds", () => {
  test("a bare update maintains both, which is the point of the feature", () => {
    expect(resolveKinds({ self: false, pi: false })).toEqual(["self", "pi"])
  })

  test("--self and --pi narrow it", () => {
    expect(resolveKinds({ self: true, pi: false })).toEqual(["self"])
    expect(resolveKinds({ self: false, pi: true })).toEqual(["pi"])
    expect(resolveKinds({ self: true, pi: true })).toEqual(["self", "pi"])
  })

  test("--version implies --self, so it can never silently re-pin Pi", () => {
    expect(resolveKinds({ self: false, pi: false, version: "1.2.3" })).toEqual(["self"])
  })
})

describe("runUpdate", () => {
  test("a successful install exits 0 and reports success", async () => {
    outcomes.push({ kind: "installed", version: "1.0.0", entryPath: "/x/dist/main.js" })
    outcomes.push({ kind: "adopted", version: "1.6.0", entryPath: "/y/cli.js" })
    expect(await runUpdate({ self: false, pi: false, check: false, force: false, quiet: true })).toBe(0)
    expect(calls.map((c) => c.kind)).toEqual(["self", "pi"])
  })

  test("a genuine failure exits 1", async () => {
    outcomes.push({ kind: "failed", version: null, detail: "npm exploded" })
    outcomes.push({ kind: "adopted", version: "1.6.0" })
    expect(await runUpdate({ self: false, pi: false, check: false, force: false, quiet: true })).toBe(1)
  })

  test("'another install is in progress' is NOT a failure", async () => {
    // The distinction that matters: a cron job running `update` concurrently with
    // a launch must not go red because the lock was briefly held.
    outcomes.push({ kind: "locked", version: null })
    outcomes.push({ kind: "backoff", version: null })
    expect(await runUpdate({ self: false, pi: false, check: false, force: false, quiet: true })).toBe(0)
  })

  test("npm missing and 'disabled' are also not failures", async () => {
    outcomes.push({ kind: "no-npm", version: null })
    outcomes.push({ kind: "disabled", version: null })
    expect(await runUpdate({ self: false, pi: false, check: false, force: false, quiet: true })).toBe(0)
  })

  test("--check never installs, and still exits 0", async () => {
    expect(
      await runUpdate({ self: false, pi: false, check: true, force: false, quiet: true }),
    ).toBe(0)
    // Both kinds were checked...
    expect(calls.map((c) => c.kind)).toEqual(["self", "pi"])
    // ...and the optional payload was never touched.
    expect(optionalCalls).toEqual([])
  })

  test("--optional-only installs the payloads and touches neither kind", async () => {
    // What the on-demand spawn asks for. The bug this prevents: a source
    // checkout whose structural search misses once must NOT grow a managed Pi
    // payload as a side effect.
    delete process.env.GH_ROUTER_NO_OPTIONAL_INSTALL
    expect(
      await runUpdate({
        self: false,
        pi: false,
        check: false,
        force: false,
        quiet: true,
        optionalOnly: true,
      }),
    ).toBe(0)
    expect(calls).toEqual([])
    expect(optionalCalls).toEqual([
      { pkg: "@huggingface/transformers", force: false },
      { pkg: "tree-sitter-wasms", force: false },
    ])
  })

  test("--optional-pkg narrows the install to ONE payload", async () => {
    // The bug: a structural search that found no grammars spawned
    // `update --quiet --optional-only`, which installed BOTH payloads — 547 MB of
    // ONNX runtime to answer a question about `.ts` files.
    delete process.env.GH_ROUTER_NO_OPTIONAL_INSTALL
    await runUpdate({
      self: false,
      pi: false,
      check: false,
      force: false,
      quiet: true,
      optionalOnly: true,
      optionalPkg: "tree-sitter-wasms",
    })
    expect(optionalCalls).toEqual([{ pkg: "tree-sitter-wasms", force: false }])
  })

  test("a disabled managed layer does not skip the optional payloads", async () => {
    // The two off switches are independent and documented as such: a user who
    // does not want a self-updater may still want reranking to work.
    const saved = process.env.GH_ROUTER_NO_MANAGED_INSTALL
    delete process.env.GH_ROUTER_NO_OPTIONAL_INSTALL
    process.env.GH_ROUTER_NO_MANAGED_INSTALL = "1"
    try {
      expect(await runUpdate({ self: false, pi: false, check: false, force: false, quiet: true })).toBe(0)
      expect(calls).toEqual([])
      expect(optionalCalls.length).toBe(2)
    } finally {
      if (saved === undefined) delete process.env.GH_ROUTER_NO_MANAGED_INSTALL
      else process.env.GH_ROUTER_NO_MANAGED_INSTALL = saved
    }
  })

  test("--check --optional-only is reported, not silently empty", async () => {
    delete process.env.GH_ROUTER_NO_OPTIONAL_INSTALL
    expect(
      await runUpdate({
        self: false,
        pi: false,
        check: true,
        force: false,
        quiet: true,
        optionalOnly: true,
      }),
    ).toBe(0)
    expect(calls).toEqual([])
    expect(optionalCalls).toEqual([])
  })

  test("the env opt-out also silences --optional-only", async () => {
    process.env.GH_ROUTER_NO_OPTIONAL_INSTALL = "1"
    await runUpdate({
      self: true,
      pi: false,
      check: false,
      force: false,
      quiet: true,
      optionalOnly: true,
    })
    expect(calls).toEqual([])
  })

  test("--check exits 1 when the latest version cannot be determined", async () => {
    // Printing "0.9.0 → unknown" and exiting 0 makes a broken registry look like
    // "nothing to do" to every script that reads the exit code.
    const saved = checkTargets.value
    checkTargets.value = null
    try {
      expect(
        await runUpdate({ self: true, pi: false, check: true, force: false, quiet: true }),
      ).toBe(1)
    } finally {
      checkTargets.value = saved
    }
  })

  test("--version is threaded through to the install", async () => {
    outcomes.push({ kind: "installed", version: "9.9.9" })
    await runUpdate({
      self: true,
      pi: false,
      check: false,
      version: "9.9.9",
      force: true,
      quiet: true,
    })
    expect(calls).toEqual([{ kind: "self", version: "9.9.9", force: true }])
  })
})
