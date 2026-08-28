/**
 * Regression guard for the Windows libuv teardown crash in the internal hook
 * subcommands (`internal-stop-hook` / `internal-prompt-submit` /
 * `internal-stop-review`).
 *
 * The bug: a hard `process.exit()` on a fast-return path raced libuv's stdio /
 * async-handle teardown on Windows, aborting the process with
 * `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)` (exit 127) instead of
 * exiting cleanly. SubagentStop fires the Stop command for every subagent, so the
 * fast-return paths run constantly in practice. The fix: read stdin synchronously
 * (no in-flight FS request) and exit naturally via `process.exitCode` (no forced
 * loop teardown).
 *
 * This MUST be a spawned-subprocess test: the crash only manifests in a real
 * Node process tearing down its event loop — the pure decision functions
 * (`decideStopHook` / `decidePromptSubmitV2`) can't reproduce it. We spawn the
 * BUILT `dist/main.js` under Node (the same `node dist/main.js <cmd>` the launcher
 * registers as the hook command) with each previously-crashing payload and assert
 * a clean exit (0, never 127) with no assertion text on stderr.
 *
 * On POSIX the pre-fix code happened to exit 0 too (the assertion is
 * Windows-only), so this test's teeth are on the `windows-latest` CI job — the
 * primary deployment target and a merge blocker. The exit-code assertion still
 * has value cross-platform (a fast-return path must never exit non-zero).
 */

import { test, expect, describe, beforeAll } from "bun:test"

import { spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"

const DIST_PATH = path.resolve(import.meta.dirname, "../dist/main.js")

/**
 * Per-test budget for every spawn-based case in this file.
 *
 * bun's DEFAULT per-test timeout is 5000ms, and one `node dist/main.js` spawn
 * measures ~3.2-5s on Windows because node has to load the 6.3 MB bundle. That
 * leaves essentially no margin, so these failed intermittently: 2 of 3
 * consecutive local runs, and the windows + bun-1.3.14 CI lane while the other
 * three lanes passed.
 *
 * The symptom actively misleads. bun kills the child when the budget expires,
 * so `spawnSync` returns `status: null` and the assertion reports "expected 0,
 * received null" as if the process had exited badly, when it was never allowed
 * to finish. The real message is one line further down: "this test timed out
 * after 5000ms".
 *
 * These assert TEARDOWN CORRECTNESS (no libuv assertion, exit 0), not startup
 * latency. A budget tight enough to fire under load turns a correctness test
 * into a performance test that fails for reasons unrelated to the bug it
 * guards, so this is deliberately ~12x the measured baseline: a failure now
 * means the process genuinely did not exit.
 */
const SPAWN_TEST_TIMEOUT_MS = 60_000

let bundleExists = false
let nodeOk = false

beforeAll(() => {
  bundleExists = fs.existsSync(DIST_PATH)
  // The hooks run under Node (settings.json registers `node.exe dist/main.js`),
  // and the crash is a Node/libuv assertion — so the regression must be checked
  // under Node, not the bun runner. Confirm a `node` is invocable; skip if not.
  try {
    const v = spawnSync("node", ["--version"], { encoding: "utf8" })
    nodeOk = v.status === 0 && /^v\d/.test((v.stdout ?? "").trim())
  } catch {
    nodeOk = false
  }
})

/** Payloads that hit the FAST-RETURN paths (the ones that crashed pre-fix). None
 *  reach the network — they stand down before any proxy call — so this stays a
 *  pure process-teardown test. */
const CASES: ReadonlyArray<{ cmd: string; label: string; stdin: string }> = [
  // internal-stop-hook: SubagentStop is the real-world trigger.
  { cmd: "internal-stop-hook", label: "subagent", stdin: JSON.stringify({ cwd: "/x", agent_type: "Explore" }) },
  { cmd: "internal-stop-hook", label: "empty-stdin", stdin: "" },
  { cmd: "internal-stop-hook", label: "malformed", stdin: "not json {{" },
  { cmd: "internal-stop-hook", label: "no-session", stdin: JSON.stringify({ cwd: "/x" }) },
  // internal-prompt-submit
  { cmd: "internal-prompt-submit", label: "subagent", stdin: JSON.stringify({ session_id: "s", prompt: "x", agent_id: "w1" }) },
  { cmd: "internal-prompt-submit", label: "empty-stdin", stdin: "" },
  { cmd: "internal-prompt-submit", label: "malformed", stdin: "garbage{" },
  // internal-stop-review (no hook env -> stands down before any payload read)
  { cmd: "internal-stop-review", label: "no-runtime", stdin: JSON.stringify({ session_id: "s", cwd: "/x", diff: "+a" }) },
  { cmd: "internal-stop-review", label: "empty-stdin", stdin: "" },
  { cmd: "internal-stop-review", label: "malformed", stdin: "x{" },
  // internal-plan-review (no hook env -> stands down before any payload read)
  { cmd: "internal-plan-review", label: "no-runtime", stdin: JSON.stringify({ session_id: "s", cwd: "/x", tool_input: { plan: "long enough to matter" } }) },
  { cmd: "internal-plan-review", label: "empty-stdin", stdin: "" },
  { cmd: "internal-plan-review", label: "malformed", stdin: "x{" },
  // internal-fast-dispatch-guard: a denied native call must emit its JSON
  // decision and still drain/exit cleanly through the fallback launcher.
  { cmd: "internal-fast-dispatch-guard", label: "denied-subagent", stdin: JSON.stringify({ tool_name: "Task", tool_input: { subagent_type: "Plan" }, agent_type: "reviewer" }) },
]

describe("internal hook subcommands: Windows libuv teardown regression", () => {
  test("dist/main.js exists (build must run before tests)", () => {
    expect(bundleExists).toBe(true)
  })

  for (const c of CASES) {
    test(`${c.cmd} [${c.label}] exits cleanly with no libuv assertion`, () => {
      if (!bundleExists || !nodeOk) return // skip when not built / no node
      const res = spawnSync("node", [DIST_PATH, c.cmd], {
        input: c.stdin,
        encoding: "utf8",
        // Strip the hook reach-back env so these fast-return paths never attempt
        // a proxy call — this isolates the process-teardown behavior under test.
        env: { ...process.env, GH_ROUTER_HOOK_MCP_URL: "", GH_ROUTER_HOOK_NONCE: "" },
        // Kills the child before SPAWN_TEST_TIMEOUT_MS so a genuine hang is
        // reported as a spawn timeout rather than as bun killing the test.
        timeout: 30_000,
      })
      const stderr = res.stderr ?? ""
      // The crash signature (exit 127 + this assertion) must be gone.
      expect(stderr).not.toMatch(/Assertion failed|UV_HANDLE_CLOSING/)
      // A fast-return hook path must exit 0 (UserPromptSubmit/Stop never block
      // on these inputs; a non-zero here is the regression).
      expect(res.status).toBe(0)
    }, SPAWN_TEST_TIMEOUT_MS)
  }
})

// The SAME libuv teardown defect, reached through a completely different door:
// citty's own `runMain` calls `process.exit(0)` immediately after `showUsage`
// resolves (citty dist/index.mjs:389 — 0.1.6 does it too, so not an upgrade
// regression). On Windows a pipe-backed stdout is async, so the usage text is
// still queued when the hard exit tears the loop down and node aborts with
// exit 127 AFTER printing the help the user asked for.
//
// It hid for a long time because `--version` is clean: citty's version branch
// has no `process.exit()` and drains naturally. So the cheapest smoke test
// passes while every `--help` path aborts. Node 22 on Windows tolerated it and
// node 24 does not — and release.yml publishes with node 24, so this reached
// users on the published runtime. It was found by adding a node-24 Windows
// lane to CI, not by anyone reading the code.
//
// Asserting the EXIT CODE is the whole point. The help text still prints on a
// crashing build, so any assertion on output would have passed throughout.
describe("citty usage paths: Windows libuv teardown regression", () => {
  const USAGE_ARGS: ReadonlyArray<{ args: Array<string>; label: string }> = [
    { args: ["--help"], label: "root --help" },
    { args: ["claude", "--help"], label: "subcommand --help" },
    { args: ["start", "--help"], label: "start --help" },
  ]

  for (const { args, label } of USAGE_ARGS) {
    test(`${label} exits 0 with no libuv assertion`, () => {
      if (!bundleExists || !nodeOk) return
      const r = spawnSync("node", [DIST_PATH, ...args], {
        encoding: "utf8",
        // A pipe (not a TTY) is what makes stdout async on Windows, which is
        // precisely the condition that triggers the abort. Inheriting a TTY
        // here would make the test silently unable to fail.
        stdio: ["ignore", "pipe", "pipe"],
      })
      const combined = `${r.stdout ?? ""}${r.stderr ?? ""}`
      expect(combined).not.toContain("UV_HANDLE_CLOSING")
      expect(r.status).toBe(0)
    }, SPAWN_TEST_TIMEOUT_MS)
  }
})
