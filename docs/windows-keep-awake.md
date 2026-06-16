# Windows keep-awake (`SetThreadExecutionState`, default-on)

`github-router start` / `claude` / `codex` run long, often unattended agent
sessions. On Windows the machine can idle-sleep mid-run and kill the work.
This feature keeps the machine awake while the proxy runs, by asserting the
Win32 execution state — the same thing GitHub Copilot CLI's `/keep-alive`
(alias `/caffeinate`) does on Windows.

- Code: `src/lib/keep-awake/` (`flags.ts`, `helper.ts`, `index.ts`)
- Wiring: `src/start.ts`, `src/codex.ts`, `src/claude.ts` (after `setupAndServe`)
- Tests: `tests/keep-awake.test.ts`

## What it does

After the server is listening, `startKeepAwake()` (fire-and-forget, alongside
`provisionAndIndexColbert()`) spawns a **persistent `powershell.exe` helper**
that P/Invokes:

```
SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED)   // 0x80000001
```

so the system stays awake (the display may still sleep). With
`GH_ROUTER_KEEP_DISPLAY_ON=1` it adds `ES_DISPLAY_REQUIRED` (`0x80000003`,
screen stays on too). Release = `SetThreadExecutionState(ES_CONTINUOUS)`
(`0x80000000`).

| Flag | Default | Effect |
|---|---|---|
| `GH_ROUTER_DISABLE_KEEP_AWAKE` | unset (ON, win32 only) | `1/true/yes/on` → disable |
| `GH_ROUTER_KEEP_DISPLAY_ON` | unset (OFF) | `1` → also keep the display on |

Non-Windows is a total no-op (`keepAwakeEnabled()` gates on
`process.platform === "win32"` before anything is spawned).

## Why a persistent helper (thread-scope)

`SetThreadExecutionState` is **thread-scoped**: a one-shot process that sets
the state and exits releases the assertion immediately. So the assertion must
be held by a live thread for the proxy's lifetime. The helper sets the state
on its main thread, then **blocks reading stdin**. The proxy keeps the child's
stdin pipe open for as long as it runs.

## Crash safety (no orphan possible)

| Termination | How the assertion is released |
|---|---|
| Clean exit / `claude` shutdown chain | `stopKeepAwake()` closes stdin → helper EOF-exits + clears; OS releases on death |
| Ctrl-C (SIGINT) / SIGTERM | self-registered handler closes stdin + `taskkill /T /F`, then re-raises |
| SIGKILL / taskkill / OOM (proxy hard-killed) | stdin pipe auto-closes on proxy death → helper hits EOF → exits → OS releases |

Because the helper's only job is to block on a pipe that closes when the proxy
dies, it **cannot outlive the proxy**. Unlike the colbert sidecar or worktrees
(which leave on-disk artifacts), the execution-state assertion is pure
process-lifetime kernel state with no residue — so **no boot-time orphan sweep
is needed**. The signal handlers follow the colbert/worker re-raise pattern
(`release → process.off(self) → process.kill(self, sig)`) so attaching a
listener doesn't cancel Node's default terminate-on-signal. This is
load-bearing for `start`, which has no `launchChild`/`onShutdown` of its own.

## Mechanism decision (why PowerShell, not a binary or FFI)

`SetThreadExecutionState` lives in `kernel32.dll`. Three ways to call it from a
Node-runtime proxy were considered:

1. **Persistent PowerShell helper (chosen).** `Add-Type` P/Invoke, zero new
   artifacts/dependencies, runtime-agnostic (a child process, so no
   Bun-vs-Node FFI split). Reuses the project's managed-child + `taskkill`
   discipline.
2. **Bundled native `.exe`.** CLM-proof, but introduces the project's first
   first-party binary AND is **refused under enforced WDAC code-integrity**
   (`CodeIntegrityPolicyEnforcementStatus = 2`, observed on the canonical
   enterprise target) because it would be unsigned.
3. **koffi in-process FFI.** Cleanest runtime, but a **native npm addon** the
   project deliberately avoids, with a Bun-vs-Node load-path risk.

No mechanism works in every lockdown configuration, and keep-awake is a
best-effort nicety, so the lowest-friction option that works on the common
case wins. The probe that settled it: the canonical machine is PowerShell
`LanguageMode = FullLanguage` (Add-Type permitted) but WDAC-enforced — which
favors PowerShell and disfavors the unsigned binary, the opposite of a
CLM-hardened box.

### The hex→decimal bug (verified fix)

Templating the flag as a hex literal **fails**: Windows PowerShell parses
`0x80000001` as a *negative* Int32 (`-2147483647`) that throws converting to
the `uint` parameter ("Value was either too large or too small for a UInt32").
The script must use a **decimal `[uint32]` literal** — a decimal over
Int32.MaxValue auto-promotes to a positive Int64 and the explicit `[uint32]`
cast then fits:

```powershell
Add-Type -Name P -Namespace W -MemberDefinition '[System.Runtime.InteropServices.DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint e);'
if ([W.P]::SetThreadExecutionState([uint32]2147483649) -ne 0) { [Console]::Out.WriteLine('OK'); [Console]::Out.Flush() }
while ($null -ne [Console]::In.ReadLine()) {}   # block until stdin EOF
[void][W.P]::SetThreadExecutionState([uint32]2147483648)   # ES_CONTINUOUS clear
```

Verified on a real win32 host: `OK` is printed (assertion succeeded) and the
helper exits cleanly when stdin closes. Invoked via `powershell.exe -NoProfile
-NonInteractive -Command <script>` (NOT `-File` — a `.ps1` is subject to
ExecutionPolicy, often RemoteSigned/AllSigned on corporate machines;
`-Command` is not). The C# member-definition is a PowerShell single-quoted
string so its embedded `"kernel32.dll"` needs no escaping, and the whole
script survives Node `spawn(..., {shell:false})` arg-quoting (verified).

## Best-effort degradation (when the assertion can't be set)

When keep-awake can't run, behavior is a **clean no-op — never install, never
auto-enable, never nag**:

- **Constrained Language Mode (FullLanguage unavailable).** CLM is an
  org-enforced security control (WDAC/AppLocker/`__PSLockdownPolicy`), not a
  user-mode-changeable setting. `Add-Type` throws → the helper exits before
  printing `OK`. We do not attempt to install/enable/bypass it (impossible
  from user mode and an EDR red flag) and do not prompt the user to weaken
  policy.
- **Detection.** The helper prints a single `OK` line on stdout *after*
  `SetThreadExecutionState` succeeds; `spawnHelper` waits briefly for it. No
  `OK` (helper died, Add-Type blocked) or no resolvable `powershell.exe` →
  `consola.debug("keep-awake: inactive (...)")`. Default is silent (matches
  the fire-and-forget convention); surfaced under verbose logging.
- **Honest scope caveat.** In a genuinely locked-down environment CLM is
  almost always imposed *via* WDAC, and that same enforcement also blocks the
  unsigned `.exe` and gates an unsigned koffi `.node` under UMCI. So "no-op" is
  the terminal state for **any** mechanism short of a helper the org has
  signed/allowlisted — not a PowerShell-specific gap.

## Verifying manually

`powercfg /requests` (run from an **elevated** prompt — it requires admin)
lists active power requests:

```
> github-router start
# in an elevated shell:
> powercfg /requests
SYSTEM:
[PROCESS] \Device\...\powershell.exe
```

Ctrl-C the proxy and re-run `powercfg /requests` → the entry is gone.
`GH_ROUTER_KEEP_DISPLAY_ON=1` adds a `DISPLAY:` entry;
`GH_ROUTER_DISABLE_KEEP_AWAKE=1` shows neither (no helper spawned).
