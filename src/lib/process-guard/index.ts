/**
 * Crash-safe process guard (POSIX only).
 *
 * If the proxy dies WITHOUT running its own shutdown handlers (hard crash,
 * SIGKILL, OOM), nothing in `cleanup()` runs to reap the launched CLI's
 * process tree. This guard is the last-resort net for that case.
 *
 * Platform split:
 *   - **Windows: no guard needed.** Node assigns each child to a Job
 *     Object with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, so when the proxy
 *     dies (any cause) the OS tears down the whole descendant tree —
 *     verified: force-killing a Node parent kills child AND grandchild.
 *     `startProcessGuard` is a no-op on win32.
 *   - **POSIX: a detached `node -e` reaper.** There is no job-object
 *     equivalent (a killed parent's children reparent to init), so we
 *     spawn a detached watchdog that learns of proxy death via an inherited
 *     stdin PIPE EOF (the proxy holds the write end; the OS closes it on
 *     proxy death) and reaps the CLI's process group.
 *
 * Never kill the WRONG process: if the child's PID/PGID was recycled after
 * the child exited, a blind `kill(-pid)` could hit an innocent group. The
 * reaper snapshots the child's process start-time at startup and, on proxy
 * death, kills ONLY if the live PID's start-time still matches. A mismatch
 * / unreadable probe → skip (fail-safe). We never trade an orphan-leak for
 * killing the user's work.
 *
 * The reaper is detached + unref'd so it survives the proxy's SIGKILL, and
 * self-exits once it has acted (or after a 24h cap) so it can never become
 * the orphan it exists to prevent. Opt out with
 * `GH_ROUTER_DISABLE_PROCESS_GUARD=1`.
 */

import { spawn, type ChildProcess } from "node:child_process"
import process from "node:process"

import { parseBoolEnv } from "../exec"

/**
 * Live reaper children, held so the GC can't collect the `ChildProcess`
 * (and with it the stdin write-end that is the proxy-death signal) while
 * the proxy runs. Entries self-remove on the reaper's exit. We do NOT
 * proactively kill these on graceful shutdown: when the proxy exits the OS
 * closes the stdin pipe, the reaper hits EOF, re-verifies the child's
 * identity, and reaps any survivor that ignored the graceful SIGTERM —
 * exactly the backstop we want.
 */
const _activeReapers = new Set<ChildProcess>()

/** Guard is on by default; `GH_ROUTER_DISABLE_PROCESS_GUARD=1` opts out. */
export function processGuardEnabled(): boolean {
  return parseBoolEnv(process.env.GH_ROUTER_DISABLE_PROCESS_GUARD) !== true
}

/**
 * Build the start-time-verified node reaper script (POSIX). PURE — `pid`
 * is our own integer. `detachedGroup` selects `kill(-pid)` (process group,
 * the detached CLI) vs `kill(pid)` on POSIX.
 *
 * Kept dependency-free (require'd builtins only) so it runs under `node -e`
 * with no module resolution against the dist bundle.
 */
export function buildNodeReaperScript(
  pid: number,
  detachedGroup: boolean,
): string {
  const target = detachedGroup ? "-PID" : "PID"
  return `
const cp = require("node:child_process");
const fs = require("node:fs");
const PID = ${pid >>> 0};
function startTime() {
  try {
    if (process.platform === "linux") {
      const stat = fs.readFileSync("/proc/" + PID + "/stat", "utf8");
      const post = stat.slice(stat.lastIndexOf(")") + 1).trim().split(/\\s+/);
      return post[19] || null; // field 22 (starttime) = index 19 after comm
    }
    const out = cp.execFileSync("ps", ["-o","lstart=","-p",String(PID)],
      { stdio: ["ignore","pipe","ignore"], timeout: 2000 }).toString().trim();
    return out || null;
  } catch { return null; }
}
function alive() { try { process.kill(PID, 0); return true; } catch { return false; } }
function treeKill() {
  try { process.kill(${target}, "SIGTERM"); } catch {}
  // NOT unref'd: this must keep the loop alive to deliver the escalated
  // SIGKILL (the onDeath exit timer below stays alive past 500ms too).
  setTimeout(() => { try { process.kill(${target}, "SIGKILL"); } catch {} }, 500);
}
const snap = (() => {
  // The child is definitely ours and alive at startup, so a null here is a
  // transient probe failure (e.g. a momentary 'ps' hiccup), NOT a real
  // identity loss. Retry a few times so a one-off failure can't silently
  // disable the guard for the rest of the run.
  for (let i = 0; i < 3; i++) { const s = startTime(); if (s !== null) return s; }
  return null;
})();
let done = false;
function onDeath() {
  if (done) return; done = true;
  // Re-verify identity: kill ONLY if the live PID is still our child.
  if (snap !== null && alive() && startTime() === snap) treeKill();
  // REF'd (NOT unref'd): stdin has closed, so an unref'd timer would let
  // the loop empty and the process exit immediately — dropping the 500ms
  // SIGKILL escalation. Keep the loop alive to deliver it, then exit.
  setTimeout(() => process.exit(0), 1500);
}
process.stdin.resume();
process.stdin.on("end", onDeath);
process.stdin.on("close", onDeath);
process.stdin.on("error", onDeath);
const cap = setTimeout(() => process.exit(0), 24*3600*1000); if (cap.unref) cap.unref();
`.trim()
}

/**
 * Spawn the detached node reaper holding the stdin death-pipe. Always
 * `detached` so it outlives a force-kill of the proxy, and `unref`'d so it
 * never holds the proxy's event loop open. Returns null on spawn failure.
 */
function spawnNodeReaper(pid: number, detachedGroup: boolean): ChildProcess | null {
  try {
    const child = spawn(
      process.execPath,
      ["-e", buildNodeReaperScript(pid, detachedGroup)],
      {
        stdio: ["pipe", "ignore", "ignore"],
        detached: true,
        windowsHide: true,
        shell: false,
      },
    )
    child.on("error", () => {})
    child.stdin?.on("error", () => {})
    // Hold a reference so the GC can't drop the ChildProcess (and its stdin
    // write-end, the proxy-death signal) mid-run; drop it on reaper exit.
    _activeReapers.add(child)
    child.once("exit", () => _activeReapers.delete(child))
    child.unref()
    return child
  } catch {
    return null
  }
}

/**
 * Start the crash-safe guard for a launched CLI child. No-op on Windows
 * (Node's Job Object already reaps the tree on proxy death) and when
 * disabled / unspawnable. Fire-and-forget; never throws.
 */
export function startProcessGuard(child: ChildProcess): void {
  if (!processGuardEnabled()) return
  const pid = child.pid
  if (!pid) return
  // Windows: the runtime's KILL_ON_JOB_CLOSE job object is the crash net.
  if (process.platform === "win32") return
  // POSIX: the CLI is spawned detached (own group), so reap the group.
  spawnNodeReaper(pid, true)
}
