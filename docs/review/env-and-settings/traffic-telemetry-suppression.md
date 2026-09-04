# Non-essential traffic / telemetry suppression trio

Governing lens: raise the floor, never nerf. Three vars suppress external calls Claude
Code would otherwise make. The floor question: does suppressing them remove any capability
the model needs, or only quiet non-essential noise? Gateway-model discovery is
not one of the invariants anymore: Claude Code 2.1.258+ runs that refresh despite
`NONESSENTIAL_TRAFFIC`, and curated rows now come from `modelPicker` settings.

## 1. Identity

| Field | Value |
|---|---|
| Vars | `DISABLE_NON_ESSENTIAL_MODEL_CALLS`, `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`, `DISABLE_TELEMETRY` |
| Value injected | `"1"` each — UNCONDITIONALLY (no presence guard) |
| Where set | `src/lib/server-setup.ts:560-562` (the base `vars` object) |
| Opt-out | none — set unconditionally in the injected `vars`, so a parent value is overwritten |
| Design docs | `docs/ARCHITECTURE.md:164-165`, `docs/unsupported-features.md:17` |

Unlike almost every other var in `getClaudeCodeEnvVars`, these three are set in the base
`vars` literal with NO presence-based guard — they always win over a parent value.

## 2. What they do + behavior effect

From the inline comment (`src/lib/server-setup.ts:553-563`):

- **`DISABLE_NON_ESSENTIAL_MODEL_CALLS`** + **`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`** —
  Anthropic's own knobs (per cc-backup `managedEnv.ts`). Suppress non-essential model calls
  and traffic: Files API OAuth, account/settings sync, team-memory sync, user-settings sync,
  auto-updater checks, and most gateway/account background traffic (`docs/unsupported-features.md:17`). Claude Code 2.1.258+ explicitly exempts gateway model discovery from this suppression.
- **`DISABLE_TELEMETRY`** — suppresses Datadog/Statsig/etc. external analytics that would run
  regardless of the proxy.

None of these calls reach the proxy — they hit external Anthropic/analytics hosts, which the
proxy doesn't implement (Copilot has no equivalent). Suppressing them turns the spawned child
into a quiet local-only session, saving user resources and not leaking metadata.

The old second role as a gateway-discovery safety interlock no longer exists.
Claude Code 2.1.258 intentionally runs gateway discovery despite this flag, and
2.1.260's filtered refresh is why cache seeding was retired. Curated non-Claude
rows now use the supported `modelPicker` setting; see
[gateway-model-cache-seed.md](gateway-model-cache-seed.md).

## 3. Raise-the-floor assessment

**Does it restrict capability?** Only non-essential capability, by construction:

- The suppressed calls are the ones Copilot can't serve anyway (Files API, account sync,
  team-memory) — see `docs/unsupported-features.md`. Suppressing them prevents failed calls
  and error noise, not real capability. This is "quiet the calls that would fail regardless."
- `DISABLE_TELEMETRY` removes external analytics — a privacy/resource win, no model capability.

Gateway discovery is now independent of this flag in the installed client. The
router leaves its own discovery enable unset and uses `modelPicker`, so traffic
suppression neither enables nor disables model selection.

**Is unconditional (no presence guard) the right choice?** These three still
diverge from the presence-guard pattern used by optional feature gates. Their
current role is a product-level quiet-session default: prevent unsupported sync
calls and external analytics. A user who wants those calls has no per-launch
opt-out, so presence-guarding the trio remains a possible follow-up, but it is no
longer entangled with model-picker correctness.

## 4. Findings

- **[Suggestion]** The trio is unconditional while optional feature gates are
  presence-guarded. Since `NONESSENTIAL_TRAFFIC` is no longer a discovery
  interlock, all three could be considered together for a clean operator opt-out.
  That policy change is outside this compatibility fix.
- No Critical or Important finding. Nothing here removes model capability the
  model needs; the suppressed calls are Copilot-unsupported or pure analytics.

## 5. Verdict

Floor-neutral-to-raising: it suppresses unsupported background calls and external
telemetry. Model selection no longer relies on this behavior; the supported
`modelPicker` setting owns curated rows independently.
