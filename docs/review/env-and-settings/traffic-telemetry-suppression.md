# Non-essential traffic / telemetry suppression trio

Governing lens: raise the floor, never nerf. Three vars suppress external calls Claude
Code would otherwise make. The floor question: does suppressing them remove any capability
the model needs, or only quiet non-essential noise? (One of them, `NONESSENTIAL_TRAFFIC`,
is also load-bearing for the gateway-cache-seed non-regression argument.)

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
  auto-updater checks, and the gateway-model network fetch (`docs/unsupported-features.md:17`).
- **`DISABLE_TELEMETRY`** — suppresses Datadog/Statsig/etc. external analytics that would run
  regardless of the proxy.

None of these calls reach the proxy — they hit external Anthropic/analytics hosts, which the
proxy doesn't implement (Copilot has no equivalent). Suppressing them turns the spawned child
into a quiet local-only session, saving user resources and not leaking metadata.

**Load-bearing second role**: `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` is what keeps the
gateway-model DISCOVERY network fetch permanently inert (the fetch bails when nonessential
traffic is disabled). That inertness is the structural basis for the gateway-cache-seed
non-regression argument (see [gateway-model-cache-seed.md](gateway-model-cache-seed.md)) — the
one path that could degrade the Claude tier capability mapping cannot run. So this var is not
just noise-suppression; it's a safety interlock.

## 3. Raise-the-floor assessment

**Does it restrict capability?** Only non-essential capability, by construction:

- The suppressed calls are the ones Copilot can't serve anyway (Files API, account sync,
  team-memory) — see `docs/unsupported-features.md`. Suppressing them prevents failed calls
  and error noise, not real capability. This is "quiet the calls that would fail regardless."
- `DISABLE_TELEMETRY` removes external analytics — a privacy/resource win, no model capability.

There is a subtle interaction: `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` blocks the gateway
network FETCH, which WOULD be a capability path (auto-discovering models). But that path is the
HAZARDOUS one (it discovers dotted `claude-*` slugs and degrades tier tool-use mapping), and the
proxy replaces it with the safe cache-SEED path. So the net is: block a harmful auto-discovery,
substitute a safe curated one. Floor-raising overall.

**Is unconditional (no presence guard) the right choice?** This is the one place the pattern
diverges from every other var, and it's defensible but worth flagging:

- FOR unconditional: `NONESSENTIAL_TRAFFIC=1` is a load-bearing safety interlock for the
  gateway-cache-seed non-regression argument. If a user could set it to `0`, the network fetch
  could run, discover Copilot's dotted slugs, and overwrite the curated seed — re-opening the
  exact tier-degradation hazard the design closes. Forcing it on protects the invariant.
- AGAINST: a user who genuinely wants telemetry or non-essential calls (e.g. to debug an
  Anthropic-side feature) has no per-launch opt-out — they'd have to edit the source. The other
  two (`DISABLE_NON_ESSENTIAL_MODEL_CALLS`, `DISABLE_TELEMETRY`) don't have the interlock role,
  yet they're also unconditional.

The asymmetry (these three ignore the user; everything else respects them) is unstated. For
`NONESSENTIAL_TRAFFIC` it's justified by the interlock; for the other two the justification is
weaker (they'd be safe to presence-guard).

## 4. Findings

- **[Important]** `src/lib/server-setup.ts:560-562` — all three are set UNCONDITIONALLY, breaking
  the presence-guard pattern used by every other injected var, and this asymmetry is not
  documented. For `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` it's load-bearing (the gateway-fetch
  interlock — a user `=0` would re-open the tier-degradation hazard), and that justification should
  be stated at the injection site. For `DISABLE_NON_ESSENTIAL_MODEL_CALLS` and `DISABLE_TELEMETRY`
  the unconditional set is a mild over-reach — they have no interlock role, so presence-guarding
  them (like every other var) would give users an opt-out without weakening any invariant. Either
  presence-guard those two, or document why the trio is deliberately non-overridable.
- No Critical. Nothing here removes model capability the model actually needs; the suppressed
  calls are Copilot-unsupported or pure analytics.

## 5. Verdict

Floor-neutral-to-raising: suppresses only calls Copilot can't serve (no real capability lost) plus
external telemetry, and `NONESSENTIAL_TRAFFIC=1` doubles as the safety interlock that keeps the
hazardous gateway auto-discovery inert. The one blemish is the undocumented break from the
presence-guard pattern: the interlock justifies forcing `NONESSENTIAL_TRAFFIC`, but the other two
could be presence-guarded for a clean opt-out. No meaningful nerf.
