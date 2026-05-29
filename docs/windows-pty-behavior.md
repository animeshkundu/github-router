# Windows PTY / node-pty Signal Behavior

Worker-agent worktree cleanup relies on a three-layer signal-handler
architecture (see `src/lib/worker-agent/lifecycle.ts`). On Windows, signal
delivery varies by terminal type — this matrix documents which cleanup
layers fire in each scenario.

## Signal Delivery Matrix

| Terminal | SIGINT | SIGTERM | `exit` handler | Boot sweep | Effective layers |
|----------|--------|---------|----------------|-----------|-----------------|
| cmd.exe (native console) | ✅ | ✅ via `process.kill()` | ✅ | ✅ | 4/4 |
| PowerShell 7 | ✅ | ✅ via `process.kill()` | ✅ | ✅ | 4/4 |
| ConPTY / node-pty | ✅ (Ctrl+C / CTRL_CLOSE_EVENT → SIGINT) | ❌ | ✅ | ✅ | 3/4 |
| Windows Terminal | ✅ (Ctrl+C / CTRL_CLOSE_EVENT → SIGINT) | ❌ | ✅ | ✅ | 3/4 |
| SSH session | ✅ | ✅ | ✅ | ✅ | 4/4 |
| SIGKILL / OOM / container kill | ❌ | ❌ | ❌ | ✅ | 1/4 |

## Why SIGTERM doesn't fire in ConPTY

When a ConPTY host closes the pseudo-console (e.g., user closes VS Code terminal
tab, or node-pty's `pty.kill()` is called), the Windows Console subsystem sends
`CTRL_CLOSE_EVENT` to all processes in the console session. Node.js maps this to
`SIGINT`, not `SIGTERM`. The `SIGTERM` listener registered by
`registerExitHandlers()` is therefore never invoked.

This is a Windows platform constraint, not a bug. The boot-time PID+instance
sweep (`sweepStaleWorktreesAtBoot`) provides the crash-recovery safety net for
the SIGKILL / OOM / unclean-shutdown scenarios where none of the in-process
handlers fire.

## Testing

ConPTY signal behavior is not exercised by the automated test suite (it would
require a node-pty dependency and ConPTY host setup). Manual verification:

1. Start `github-router claude` in Windows Terminal
2. Run a worker_implement task that creates a worktree
3. Close the terminal tab (not Ctrl+C — close the tab)
4. Re-launch `github-router claude` — boot sweep should clean the orphaned worktree
