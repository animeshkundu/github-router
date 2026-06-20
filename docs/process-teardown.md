# Deterministic child-process teardown

The proxy launches a long-lived child CLI (Claude Code / Codex) that fans
out into `node`/MCP-server and agent grandchildren. This subsystem
guarantees that subtree does not survive the proxy on the exit paths the
proxy can observe, and biases to **never kill a wrong process** when it
cannot positively identify its own child.

## The three layers

1. **Graceful tree-kill (signal handlers run).** `cleanup()` in
   `src/lib/launch.ts` calls `killChildProcessTree(child, …)`
   (`src/lib/exec.ts`): `taskkill /T /F /PID` on Windows (walks the live
   parent chain), `kill(-pgid)` SIGTERM→SIGKILL on POSIX (the CLI is
   spawned `detached:true` so it leads its own group). This replaced a
   plain `child.kill()` that on Windows reaped only the `cmd.exe` wrapper
   and orphaned the grandchildren.
2. **Direct child on Windows.** A real `.exe` (the native-installer
   `claude.exe`) is spawned with `shell:false` — no `cmd.exe`
   intermediary, so the kill/guard target the real process. Only genuine
   `.cmd`/`.bat` shims keep `shell:true` (`windowsLaunchNeedsShell`), and
   even then `cmd.exe` stays alive as the CLI's parent so `taskkill /T`
   reaps the whole tree.
3. **Crash-safe net (no handler runs: SIGKILL/taskkill of the proxy, OOM,
   hard crash).** Split by platform, because the OS guarantees differ:
   - **Windows: the runtime's Job Object.** Node assigns each child to a
     Job Object with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, so when the
     proxy dies (any cause) the OS tears down the whole descendant tree —
     verified: force-killing a Node parent kills child *and* grandchild
     (`tests/process-guard.test.ts` asserts this as a regression canary).
     No reaper is needed; `startProcessGuard` is a no-op on win32.
   - **POSIX: a detached `node -e` reaper** (`src/lib/process-guard/`).
     There is no job-object equivalent (a killed parent's children reparent
     to init), so the reaper learns of proxy death via an inherited **stdin
     pipe → EOF** (never PID polling) and reaps the CLI's process group.

## Never kill the wrong process

The POSIX reaper is **start-time verified**: it snapshots the child's
process start-time at startup and, on proxy death, kills only if the live
PID's start-time still matches the snapshot. A mismatch / unreadable probe
→ **skip** (fail-safe). A sub-millisecond check-to-kill TOCTOU remains,
accepted on POSIX. **Universal invariant:** when the guard cannot
positively confirm the live target is its original child, it kills nothing.
A missed orphan is preferred over an innocent kill.

## Guarantee honesty

- **Deterministic:** Windows graceful (`taskkill /T`) and crash (Node Job
  Object); POSIX graceful (`kill -pgid`).
- **Best-effort (not overclaimed):** POSIX descendants that `setsid`/break
  away from the group; the POSIX crash path's sub-ms TOCTOU; the case where
  the CLI (group leader) exits before the proxy but leaves group members
  behind (the reaper gates on the leader PID being alive, to avoid killing
  a reused PGID); macOS in general; an OOM that also kills the reaper; a
  Windows grandchild that deliberately breaks away from the job object.

Opt out of the POSIX crash reaper with `GH_ROUTER_DISABLE_PROCESS_GUARD=1`
(the graceful tree-kill always runs; Windows crash teardown is the OS's).

## Other spawn sites

Already correct and unchanged: managed-exe / colbert / worker-bash use
`taskkill /T /F` + POSIX process-group kill; keep-awake is crash-safe via
stdin-EOF; self-update and the stop-hook reviewer are intentionally
detached (they outlive the proxy by design).
