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

const DIST_PATH = path.resolve(import.meta.dir, "../dist/main.js")

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
        timeout: 20_000,
      })
      const stderr = res.stderr ?? ""
      // The crash signature (exit 127 + this assertion) must be gone.
      expect(stderr).not.toMatch(/Assertion failed|UV_HANDLE_CLOSING/)
      // A fast-return hook path must exit 0 (UserPromptSubmit/Stop never block
      // on these inputs; a non-zero here is the regression).
      expect(res.status).toBe(0)
    })
  }
})
