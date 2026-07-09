# `CLAUDE_CONFIG_DIR` mirror + synthetic credential + onboarding-skip injection

Governing lens: raise the floor, never nerf. This surface doesn't shape model TEXT — it
shapes whether the session STARTS at all, and whether spawned teammates can authenticate.
It enables the feature surface (agent teams, subagent MCP visibility) rather than steering
the model. The floor question: does it enable capability, and does any part of it silently
remove capability?

## 1. Identity

| Field | Value |
|---|---|
| Var | `CLAUDE_CONFIG_DIR` → `PATHS.CLAUDE_CONFIG_DIR` (per-launch `~/.local/share/github-router/claude-config/<pid>-<rand>/`) |
| Where set | `src/lib/server-setup.ts:552` (env) + `ensureClaudeConfigMirror` / `injectSyntheticClaudeJsonFields` in `src/lib/paths.ts` |
| Synthetic credential | `claudeAiOauth` blob in `<mirror>/.credentials.json` (schema verbatim from binary `guH`) |
| Onboarding-skip fields | `hasCompletedOnboarding: true`, `bypassPermissionsModeAccepted: true`, synthetic `oauthAccount` merged into `.claude.json` |
| Opt-out | none by design (the session cannot authenticate without it); `CLAUDE_CONFIG_DIR` is stripped from the parent env (`src/lib/launch.ts:55`) so a parent value can't leak in |
| Design doc | `docs/auth-isolation.md` |

## 2. What it does + behavior effect

The proxy sets `CLAUDE_CONFIG_DIR` to a per-launch router-owned mirror of `~/.claude/`, then:

1. **Classifies each `~/.claude/` entry** as ISOLATED (skipped), SHARED (directory symlink),
   or MIRRORED (snapshot copy) per `CLAUDE_HOME_POLICY` (`docs/auth-isolation.md:28-33`).
   `settings.json`, `agents/`, `.claude.json` are MIRRORED; chat-history dirs (`projects/`,
   `sessions/`, `plans/`, ...) are SHARED symlinks so history flows both ways;
   `.credentials.json`, lock files, `cache/`, `statsig/` are ISOLATED.
2. **Writes a synthetic `claudeAiOauth` credential** — `accessToken`/`refreshToken` synthetic
   strings, `expiresAt: 4070908800000` (2099, sidesteps proactive refresh), `scopes:
   ["user:inference","user:profile"]`, `subscriptionType: "max"`. This is the auth source:
   Claude Code reads `accessToken` and sends `Authorization: Bearer`. The teammate-spawn
   allowlist includes `CLAUDE_CONFIG_DIR`, so spawned teammates inherit the path, find the
   credential on disk, and authenticate.
3. **Injects onboarding-skip fields** into `.claude.json` via `injectSyntheticClaudeJsonFields`.
   On a fresh machine the synthetic credential covers the OAuth token but Claude Code's
   first-launch wizard still runs, including a browser-OAuth "Sign in" step that DEFEATS the
   synthetic credential. `hasCompletedOnboarding: true` (single load-bearing gate) +
   `bypassPermissionsModeAccepted: true` (skips the `--dangerously-skip-permissions`
   disclaimer) + a placeholder `oauthAccount` (`github-router@local`, zero UUIDs) skip it.
   The two booleans are FORCE-overridden even if the mirrored content sets them false; a real
   `oauthAccount` (non-empty account + org UUID) is preserved. An `assertOnboardingGateInjected`
   postcondition re-reads and throws if the fields didn't land — converting every "warn and
   return" branch into a launch-failing error so the wizard can't silently re-emerge.
4. **Injects the scoped MCP servers** into the mirrored `.claude.json`'s `mcpServers` so
   Agent-tool subagents / forks / agent-teams teammates inherit MCP visibility (they read
   from persistent `CLAUDE_CONFIG_DIR/.claude.json`, not the parent's ephemeral `--mcp-config`).

## 3. Raise-the-floor assessment

**Enables capability — this is the substrate the whole feature surface stands on.**
Agent teams (`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS`) literally cannot authenticate without
the on-disk credential in an inherited config dir — the teammate-spawn allowlist drops
`ANTHROPIC_AUTH_TOKEN`, so env-source auth is impossible for teammates (`docs/auth-isolation.md:40`).
Subagent MCP visibility depends on the `.claude.json` injection. The onboarding-skip is what
makes a fresh-machine launch work at all (otherwise the OAuth wizard blocks the session).
Every piece here EXPANDS what the session can do.

**Is it the best design?** Yes:

- Per-launch mirror (`<pid>-<rand>`) gives safe concurrency (two `github-router claude`
  launches never race on `.claude.json` writes or stomp each other's MCP nonce) and a boot-time
  orphan sweep reclaims dirs whose PID is dead. The cost is a full snapshot per launch (bounded,
  millisecond range for typical home dirs).
- The `subscriptionType: "max"` label also raises the floor indirectly: it drives Claude Code's
  tier-gated `getPlanModeV2AgentCount()` toward the higher branch (see
  [plan-mode-agent-count.md](plan-mode-agent-count.md)), and passes `tB()`/`Hq()` for the full
  feature surface.

**Does any part NERF?** Two potential concerns, both correctly handled:

- **MIRRORED entries are one-way snapshots** — a proxy-session `/config` edit to `settings.json`
  lands in the mirror, not the user's real `~/.claude/` (`docs/auth-isolation.md:49`). This is a
  deliberate isolation trade, not a capability loss: within-session settings still apply; they
  just don't flow back. Correct for credential-domain isolation.
- **Keychain isolation** — `CLAUDE_CONFIG_DIR` set means the keychain service name becomes
  `Claude Code-<sha256(path)[0..8]>`, missing the user's real no-suffix entry
  (`docs/auth-isolation.md:42`). This is intentional isolation (the proxy session must not see
  the user's real login), and the file fallback hits our synthetic blob, so auth still succeeds.
  Not a nerf.

**Drift risk.** High coupling to Claude Code binary internals — the `guH` credential schema,
the `hasCompletedOnboarding` / `bypassPermissionsModeAccepted` gate names, the `qG` source-priority
resolver, the teammate-spawn allowlist — all pinned to specific versions (v2.1.140/2.1.158).
A schema change could break auth. Mitigated by the `assertOnboardingGateInjected` postcondition
(fails loudly rather than silently re-emerging the wizard) and the no-401 invariant
(`forwardError` remaps upstream 401 → 503 so the reactive refresh of the synthetic token never
fires, `docs/auth-isolation.md:44`).

## 4. Findings

- **[Suggestion]** `src/lib/paths.ts` (`ensureClaudeConfigMirror` / `injectSyntheticClaudeJsonFields`)
  — the credential schema + onboarding gate names are pinned to Claude Code v2.1.140/2.1.158
  internals. This is the highest-coupling injection surface; an upstream schema change could
  break auth entirely (not graceful — the session wouldn't authenticate). The
  `assertOnboardingGateInjected` postcondition is the right guard for the onboarding half; the
  credential half relies on the no-401 remap. Worth periodic re-verification against the live
  binary.
- **[Suggestion]** The one-way MIRRORED snapshot means a proxy-session `/config` or `/model`
  change to `settings.json` silently doesn't persist to the user's real config. Documented in
  `docs/auth-isolation.md:49` as deliberate, but a user who edits settings inside a proxy session
  expecting persistence gets a surprise. Non-blocking (isolation is the correct default).
- No Critical/Important findings on the capability axis — nothing here removes model capability;
  the isolation trade-offs are the correct choice for credential-domain separation.

## 5. Verdict

This is enabling infrastructure, not a steering knob — and it's correct. It's the substrate that
makes agent teams, subagent MCP visibility, and fresh-machine launches work; every piece expands
capability. The isolation trade-offs (one-way mirror, keychain miss) are deliberate and correct,
not nerfs. The only real risk is deep coupling to Claude Code binary internals, guarded by the
onboarding postcondition and the no-401 invariant. No capability nerf.
