# `CLAUDE_CODE_*` experimental feature gates

Governing lens: raise the floor, never nerf. These five env vars flip on Claude Code
feature surfaces that default OFF for non-Anthropic users (GrowthBook flags that only
fire inside Anthropic). Injecting them expands what the model can do.

## 1. Identity

| Field | Value |
|---|---|
| Vars | `CLAUDE_CODE_ENABLE_EXPERIMENTAL_ADVISOR_TOOL`, `CLAUDE_CODE_FORK_SUBAGENT`, `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS`, `CLAUDE_CODE_ENABLE_FINE_GRAINED_TOOL_STREAMING`, `CLAUDE_CODE_ENABLE_TASKS` |
| Value injected | `"1"` each |
| Where set | `src/lib/server-setup.ts:719-730` (`experimentalEnables` loop in `getClaudeCodeEnvVars`) |
| Guard | presence-based — injected only when `process.env[key] === undefined` |
| Opt-out | set the key to `0`/`false`/`no`/`off`/empty in the parent shell (Anthropic `SH()` falsy semantics). ADVISOR also honors the hard `CLAUDE_CODE_DISABLE_ADVISOR_TOOL=1` opt-out (wins via `JI()` ordering) |
| Design doc | `docs/claude-env-injection.md` |

None of these five keys are in `STRIPPED_PARENT_ENV_KEYS` (`src/lib/launch.ts:33-97`), so a
user-set value survives the parent-env sanitize and the presence guard preserves it.

## 2. What each does + behavior effect

| Var | Feature it unlocks | Capability effect |
|---|---|---|
| `CLAUDE_CODE_ENABLE_EXPERIMENTAL_ADVISOR_TOOL` | The built-in `advisor` tool (server-side wired to gpt-5.6-sol xhigh; the proxy injects `__anthropic_advisor` and streams `advisor_tool_result` back — `docs/unsupported-features.md` ADVISOR section). | Adds a stronger-model second-opinion tool to the model's toolset. Pure expansion. Gracefully degrades on a non-Claude main model (handler strips the tool + advisor beta, routes to the shim; does NOT 400). |
| `CLAUDE_CODE_FORK_SUBAGENT` | Forked subagents inherit the full parent conversation context instead of starting fresh. | Expands subagent quality (fork sees the whole thread). **No-ops in `claude --print` headless mode** — the binary's `Z8()` precondition gates it (`docs/claude-env-injection.md:18`). Not a bug, an upstream limitation. |
| `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` | `TeamCreate` + inter-teammate `SendMessage` primitives (multi-agent teams). | Expands to a whole collaboration surface. **Load-bearing dependency on the CONFIG_DIR mirror**: the teammate-spawn allowlist drops `ANTHROPIC_AUTH_TOKEN`, so teammates authenticate only by reading the synthetic credential from the inherited `CLAUDE_CONFIG_DIR` (see [claude-config-dir-mirror.md](claude-config-dir-mirror.md)). |
| `CLAUDE_CODE_ENABLE_FINE_GRAINED_TOOL_STREAMING` | Tool inputs stream as the model generates them. | Anthropic explicitly recommends this for proxy users at code.claude.com/docs/en/env-vars ("Set to `1` to force on when routing through a proxy via `ANTHROPIC_BASE_URL`"). Floor-raising and vendor-endorsed. |
| `CLAUDE_CODE_ENABLE_TASKS` | Task tracking in `claude -p` headless mode (already on interactively). | Extends task tracking to headless runs. Pure expansion, only manifests in `-p`. |

## 3. Raise-the-floor assessment

**Expands capability — every one.** These are opt-in features Anthropic ships dark to
non-Anthropic tenants; the proxy's stance is the same leverage rationale as extended
betas (users who ran `github-router claude` opted into the full feature surface). None
restricts anything.

**Is the default the floor-raising choice?** Yes. Default-ON with a clean per-feature
opt-out is exactly "the right thing, in the right amount, with an escape hatch." The
presence-based guard is the correct mechanism: it distinguishes "user wants it off"
(`=0`) from "user hasn't spoken" (unset), so injecting a default never overrides intent.

**Drift risk.** Low but real:

- These are Anthropic-internal names verified against specific builds (the FORK
  `Z8()` / AGENT_TEAMS allowlist / ADVISOR `JI()` observations are pinned to
  named binary versions in the doc). A future Claude Code build could rename a gate
  or change its semantics; the injection would then set a dead env var (harmless) or
  miss a renamed one (silent capability loss). There is no live-catalog signal for
  these — they are not catalog-gated, so nothing self-heals if a name drifts.
- FORK_SUBAGENT's `--print` no-op is documented but silent at runtime — a user in
  headless mode who expects forked context gets fresh context with no warning. This
  is an upstream `Z8()` precondition, not something the proxy can fix, but it is a
  gap between the injected value and the observed behavior.

## 4. Findings

- **[Suggestion]** `src/lib/server-setup.ts:719-730` — the five gate names are hardcoded
  strings verified against specific Claude Code builds. There is no runtime assertion
  that any still exists in the installed binary. A rename upstream degrades silently.
  Low priority (the failure mode is "feature quietly off," not a crash), but a periodic
  re-verification against the pinned build numbers in `docs/claude-env-injection.md` is
  the only guard.
- **[Suggestion]** FORK_SUBAGENT is injected unconditionally even though it no-ops under
  `--print`. Harmless, but a headless launch could log a one-line debug note that fork
  context is unavailable in `-p` so the behavior isn't a surprise.

## 5. Verdict

Correct, minimal, floor-raising. All five expand capability, default-ON is the right
call, and the presence-based opt-out is the right mechanism. Only residual risk is
build-pinned gate names drifting with no self-healing signal — acceptable, worth a
periodic re-verify. No nerf anywhere.
