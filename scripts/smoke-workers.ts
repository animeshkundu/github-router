// Live smoke test for the Pi-backed worker surface. Drives the REAL
// `runWorkerAgent` against the REAL Copilot upstream, so it proves the
// vendored Pi runtime + the internal tool surface actually work end to
// end — the thing the mocked matrix (`tests/worker-tool-matrix.test.ts`)
// deliberately cannot prove.
//
// Gated behind GH_ROUTER_RUN_WORKER_SMOKE=1 (mirrors the browser E2E's
// GH_ROUTER_RUN_BROWSER_E2E=1) because it costs real tokens and needs a
// live Copilot session. It is NOT part of `bun test`.
//
//   GH_ROUTER_RUN_WORKER_SMOKE=1 bun run scripts/smoke-workers.ts
//
// Every leg is BOUNDED. That is load-bearing, not a nicety: a heavy
// multi-step brief was observed hanging for 82+ minutes with no return on
// BOTH gemini-3.6-flash and gpt-5.6-terra, and the worker default
// wall-clock is 6h — so an unbounded leg can wedge this script for hours.
// `maxWallClockMs` makes a non-converging worker abort gracefully and
// return its partial work plus a `[halted: wallclock]` marker instead.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import { ensurePaths } from "../src/lib/paths"
import { setupCopilotToken, setupGitHubToken } from "../src/lib/token"
import { cacheModels } from "../src/lib/utils"
import { runWorkerAgent } from "../src/lib/worker-agent"

const ANSI_BOLD = "\x1b[1m"
const ANSI_GREEN = "\x1b[32m"
const ANSI_RED = "\x1b[31m"
const ANSI_DIM = "\x1b[2m"
const ANSI_RESET = "\x1b[0m"

/** Cheap, fast, 1M-context tool-caller — the point is to exercise the tool
 *  surface, not to get a clever answer. Override with SMOKE_MODEL. */
const SMOKE_MODEL = process.env.SMOKE_MODEL ?? "gemini-3.6-flash"
/** Per-leg ceiling. See the header note on why this must never be omitted. */
const LEG_WALL_CLOCK_MS = Number(process.env.SMOKE_WALLCLOCK_MS ?? 10 * 60 * 1000)

interface LegResult {
  name: string
  ok: boolean
  detail: string
  ms: number
}

/** A worker returned "no output" or halted — distinguishable from a real
 *  answer, and worth surfacing rather than counting as a pass. */
function isDegenerate(text: string): boolean {
  return (
    text.includes("[worker exited with no output")
    || text.includes("[halted: wallclock]")
    || text.trim().length === 0
  )
}

async function leg(
  name: string,
  run: () => Promise<{ text: string; isError?: boolean }>,
  expect: (text: string) => boolean,
): Promise<LegResult> {
  const started = Date.now()
  try {
    const r = await run()
    const ms = Date.now() - started
    if (r.isError) {
      return { name, ok: false, detail: `isError: ${r.text.slice(0, 200)}`, ms }
    }
    if (isDegenerate(r.text)) {
      return { name, ok: false, detail: `degenerate: ${r.text.slice(0, 200)}`, ms }
    }
    if (!expect(r.text)) {
      return { name, ok: false, detail: `unexpected: ${r.text.slice(0, 200)}`, ms }
    }
    return { name, ok: true, detail: r.text.replace(/\s+/g, " ").slice(0, 120), ms }
  } catch (err) {
    const ms = Date.now() - started
    const msg = err instanceof Error ? err.message : String(err)
    return { name, ok: false, detail: `threw: ${msg}`, ms }
  }
}

async function main(): Promise<void> {
  if (process.env.GH_ROUTER_RUN_WORKER_SMOKE !== "1") {
    console.log(
      "worker smoke is gated — set GH_ROUTER_RUN_WORKER_SMOKE=1 to run it (costs real tokens).",
    )
    return
  }

  console.log(`${ANSI_BOLD}worker surface live smoke${ANSI_RESET}`)
  console.log(
    `${ANSI_DIM}model=${SMOKE_MODEL}  per-leg cap=${Math.round(LEG_WALL_CLOCK_MS / 1000)}s${ANSI_RESET}\n`,
  )

  await ensurePaths()
  await setupGitHubToken()
  await setupCopilotToken()
  await cacheModels()

  // Scratch workspace: a git repo, because implement/test ALWAYS provision a
  // worktree and hard-error on a non-git workspace.
  const ws = mkdtempSync(path.join(tmpdir(), "worker-smoke-"))
  writeFileSync(
    path.join(ws, "marker.ts"),
    "export const SMOKE_MARKER_VALUE = 4242\n",
  )
  // Initialize git: implement/test ALWAYS provision a worktree and hard-error
  // on a non-git workspace.
  const { execFileSync } = await import("node:child_process")
  for (const args of [
    ["init", "-q"],
    ["add", "-A"],
    ["-c", "user.email=smoke@local", "-c", "user.name=smoke", "commit", "-qm", "seed"],
  ]) {
    try {
      execFileSync("git", args, { cwd: ws, stdio: "ignore" })
    } catch {
      /* best-effort: implement/test legs will report the real error */
    }
  }

  const common = {
    model: SMOKE_MODEL,
    thinking: "high" as const,
    workspace: ws,
    maxWallClockMs: LEG_WALL_CLOCK_MS,
  }

  // All legs run in PARALLEL — the whole point is a fast fan-out.
  const results = await Promise.all([
    leg(
      "explore · code_search finds the marker",
      () =>
        runWorkerAgent({
          ...common,
          mode: "explore",
          prompt:
            "Use your code_search tool once to find SMOKE_MARKER_VALUE in this workspace, then reply with exactly the number it is assigned. Nothing else.",
        }),
      (t) => t.includes("4242"),
    ),
    leg(
      "explore · web_search reachable",
      () =>
        runWorkerAgent({
          ...common,
          mode: "explore",
          prompt:
            "Use your web_search tool once for 'GitHub Copilot supported models', then reply with one short sentence summarizing what you found.",
        }),
      (t) => t.length > 10,
    ),
    leg(
      "review · reads code and reports",
      () =>
        runWorkerAgent({
          ...common,
          mode: "review",
          prompt:
            "Use your read tool on marker.ts and reply with exactly the number SMOKE_MARKER_VALUE is assigned. Nothing else.",
        }),
      (t) => t.includes("4242"),
    ),
    leg(
      "plan · produces a plan",
      () =>
        runWorkerAgent({
          ...common,
          mode: "plan",
          prompt:
            "In at most 3 lines, plan how to add a second exported constant to marker.ts. Use your read tool once first.",
        }),
      (t) => t.length > 20,
    ),
    leg(
      "implement · edits in a worktree",
      () =>
        runWorkerAgent({
          ...common,
          mode: "implement",
          prompt:
            "Add a line `export const SMOKE_ADDED = 7\\n` to marker.ts using your edit or write tool. Then reply 'done'. Do not run tests.",
        }),
      (t) => t.length > 0,
    ),
    leg(
      "test · authors a test in a worktree",
      () =>
        runWorkerAgent({
          ...common,
          mode: "test",
          prompt:
            "Create a file smoke.test.ts containing a single trivial bun:test case asserting 1===1, using your write tool. Then reply 'done'. Do not run it.",
        }),
      (t) => t.length > 0,
    ),
  ])

  rmSync(ws, { recursive: true, force: true })

  console.log(`${ANSI_BOLD}== results ==${ANSI_RESET}`)
  let pass = 0
  let fail = 0
  for (const r of results) {
    const tag = r.ok ? `${ANSI_GREEN}PASS${ANSI_RESET}` : `${ANSI_RED}FAIL${ANSI_RESET}`
    if (r.ok) pass += 1
    else fail += 1
    console.log(
      `  [${tag}] ${r.name} ${ANSI_DIM}(${Math.round(r.ms / 1000)}s)${ANSI_RESET}\n         ${ANSI_DIM}${r.detail}${ANSI_RESET}`,
    )
  }
  console.log(`\n${pass} passed, ${fail} failed`)
  if (fail > 0) process.exit(1)
}

await main()
