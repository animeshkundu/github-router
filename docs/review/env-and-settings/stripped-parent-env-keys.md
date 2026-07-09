# `STRIPPED_PARENT_ENV_KEYS` — parent-env sanitization

Governing lens: raise the floor, never nerf. This is the one surface that REMOVES things
from the spawned env. The floor question is inverted: does any strip remove a capability
the user legitimately wanted, or does it only remove leak/conflict vectors?

## 1. Identity

| Field | Value |
|---|---|
| Setting | strip a fixed list of keys from the parent env before merging proxy overrides |
| Where set | `STRIPPED_PARENT_ENV_KEYS` (`src/lib/launch.ts:33-97`); applied by `sanitizeParentEnv` (`:105-113`) in `buildLaunchCommand` (`:258-261`) |
| Opt-out | none — strips are unconditional (the whole point is that a stale/malicious parent value can't survive) |
| Design doc | `docs/auth-isolation.md:12-22` |

## 2. What it strips + why

Grouped by intent (`src/lib/launch.ts:33-97`):

- **Claude Code auth surface** — `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`,
  `ANTHROPIC_CUSTOM_HEADERS`, `ANTHROPIC_MODEL`, `CLAUDE_CODE_OAUTH_TOKEN`,
  `CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR`, `CLAUDE_CODE_USE_{BEDROCK,VERTEX,FOUNDRY}`,
  `CLAUDE_CONFIG_DIR`. The proxy supplies its own values; stripping prevents a shell-exported real
  credential from leaking AND silences the "Auth conflict" warning that fires when multiple auth
  sources are present (even dummy ones).
- **Bridge / IDE remote-session surface** — `CLAUDE_BRIDGE_*`, `SESSION_INGRESS_URL`,
  `CLAUDE_CODE_REMOTE`, `CLAUDE_CODE_CONTAINER_ID`, `CLAUDE_CODE_REMOTE_SESSION_ID`,
  `CLAUDE_CODE_SESSION_ID`, `CLAUDE_CODE_ADDITIONAL_PROTECTION`. These activate a remote-session
  code path (extra API calls the proxy doesn't implement) or add wire-fingerprint noise that breaks
  the stealth posture. Stripping forces a local-only session.
- **Codex CLI auth surface** — `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `CODEX_HOME`.
- **ai-or-die session-bind surface** — `AIORDIE_CLAUDE_BIND`, `AIORDIE_TOKEN`, `AIORDIE_INSECURE_TLS`.
  Tab-scoped; stripping prevents a nested `github-router claude` from hijacking the parent tab's
  sidecar / bearer token.

## 3. Raise-the-floor assessment

**Does any strip nerf a real capability?** No — every strip removes a leak, conflict, or noise
vector, and the proxy re-supplies the positive value where one is needed:

- The auth-surface strips are compensated: `ANTHROPIC_BASE_URL`, `ANTHROPIC_MODEL`, `CLAUDE_CONFIG_DIR`
  are all re-set by `getClaudeCodeEnvVars` to the proxy's own values. Stripping then re-setting is
  cleaner than override-with-empty (a missing var is unambiguously absent in every read path).
- The Bridge strips remove a code path Copilot can't serve anyway — keeping them would cause failed
  calls, not add capability.
- `CLAUDE_CODE_ADDITIONAL_PROTECTION` strip removes a header Copilot ignores but that breaks stealth
  — no capability, pure fingerprint noise.

**The one deliberate NON-strip is the tell that the list is thought through**:
`ANTHROPIC_SMALL_FAST_MODEL` is explicitly NOT stripped (`src/lib/launch.ts:77-81`), with a comment
that users with custom Copilot mappings legitimately rely on it to route the small/fast tier —
stripping it "would be an unforced error (gemini-critic finding)." This is precisely the
raise-the-floor discipline applied to a strip decision: strip leak/conflict vectors, but preserve a
key that carries legitimate user intent. The presence-guarded injection of `ANTHROPIC_SMALL_FAST_MODEL`
in `getClaudeCodeEnvVars` then only fills it when the user hasn't set it — the two decisions are
consistent.

**Could a strip surprise a user?** `ANTHROPIC_MODEL` and `ANTHROPIC_BASE_URL` being stripped means a
user who exported those in their shell to point at a DIFFERENT backend will find the proxy overrides
them — but that's the entire point of `github-router claude` (route through the proxy), so it's
expected, not a nerf. A user who wants a different backend runs plain `claude`.

**Drift risk.** The Bridge / remote-session key names are pinned to observed Claude Code surfaces
(cc-backup `src/bridge/*`, empirical checks 2026-05-11). A future remote-session env var not on the
list could leak through — but the failure mode is "an unimplemented code path activates and its calls
fail," which is loud, not silent capability loss.

## 4. Findings

- No Critical/Important/Suggestion. This is the cleanest surface reviewed: every strip removes a leak,
  conflict, or noise vector; the proxy re-supplies positive values where needed; and the deliberate
  `ANTHROPIC_SMALL_FAST_MODEL` non-strip demonstrates the list preserves legitimate user intent rather
  than blanket-stripping. No strip removes a capability the model or user actually needs.
- The only forward risk is completeness (a future remote-session var not yet on the list), which fails
  loudly rather than silently — acceptable.

## 5. Verdict

No nerf. Every strip targets a leak, an auth conflict, an unimplemented remote-session path, or wire
fingerprint noise — never a real capability, and the proxy re-supplies positive values where one is
needed. The explicit `ANTHROPIC_SMALL_FAST_MODEL` non-strip is a model example of preserving
legitimate user intent while sanitizing the rest. Cleanest surface in this set.
