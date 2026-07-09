# Plan-mode v2 agent count — `CLAUDE_CODE_PLAN_V2_AGENT_COUNT`

Governing lens: raise the floor, never nerf. Not in the original brief, found in code
during the audit — it materially expands the model's planning parallelism, so it belongs
in the inventory.

## 1. Identity

| Field | Value |
|---|---|
| Var | `CLAUDE_CODE_PLAN_V2_AGENT_COUNT` |
| Value injected | `"7"` |
| Where set | `src/lib/server-setup.ts:683-685` |
| Guard | presence-based — injected only when `process.env.CLAUDE_CODE_PLAN_V2_AGENT_COUNT === undefined` |
| Opt-out / override | set the var in the parent shell (range 1..10; any user value wins) |
| Design doc | none dedicated — documented inline in `server-setup.ts:670-685` |

## 2. What it does + behavior effect

Claude Code's plan-mode (v2) Phase-2 "Plan" agent spins up N parallel planning agents.
`getPlanModeV2AgentCount()` (verified verbatim in the v2.1.158 binary, minified `bGK`)
resolves the count as:

- env override `CLAUDE_CODE_PLAN_V2_AGENT_COUNT` (1..10) wins, else
- `subscriptionType:"max"` + `rateLimitTier:"default_claude_max_20x"` → 3,
  enterprise/team → 3, else → 1.

The proxy's synthetic credential is `subscriptionType:"max"` with
`rateLimitTier:"default_claude_max_20x"`, so the NATURAL tier path already yields 3. The
injection PINS it to 7 via the env override — the clean, tier-independent lever that wins
unconditionally (`server-setup.ts:670-682`), so the count holds even if the credential tier
ever changes.

## 3. Raise-the-floor assessment

**Expands capability.** 7 parallel planning agents vs the tier-natural 3 (or 1 for a base
tier) means broader plan-mode fan-out — more parallel exploration of the plan space. Pure
expansion of the planning surface.

**Is the default the best choice?** The choice of 7 (over the tier-natural 3, and out of a
1..10 range) is a judgment call. Rationale from the "right amount" lens:

- More planning agents = broader coverage, but also more Copilot requests per plan-mode
  invocation (Copilot bills per-request by multiplier). 7 is a middle-high point, not the
  max (10), leaving headroom and not maximally taxing quota.
- Using the ENV OVERRIDE rather than relying on the tier path is the correct mechanism: it's
  tier-independent, so a future credential-tier change (e.g. if `subscriptionType` were ever
  downgraded) doesn't silently collapse the count to 1.
- Presence-guarded, so a user who wants fewer (cost) or more (coverage) sets their own value.

The specific value 7 has no dedicated design doc or empirical justification recorded — it's a
reasonable floor-raise but the "why 7 and not 5 or 10" is asserted inline, not evidenced.

**Drift risk.** Pinned to the v2.1.158 binary's `bGK`/`getPlanModeV2AgentCount()` behavior
and the 1..10 range. If a future build changes the range or removes the env lever, the
injection becomes a harmless no-op (an out-of-range or unread value falls back to the tier
path, which still yields 3 on our credential) — graceful degradation.

## 4. Findings

- **[Suggestion]** `src/lib/server-setup.ts:683-685` — the value 7 is chosen without a recorded
  empirical basis (no doc, no test asserting the trade-off). It's a plausible floor-raise, but
  "why 7" is asserted, not evidenced. A one-line rationale (cost-vs-coverage sweet spot, headroom
  under the 10 max) in the comment or a design-doc note would make it defensible on review.
- **[Suggestion]** No dedicated design doc mentions this var; it's inline-only. Given it materially
  changes plan-mode parallelism and Copilot request volume, a line in `docs/claude-env-injection.md`
  or `docs/default-models.md` would surface it for operators reasoning about quota.
- No Critical/Important. The mechanism (env override, presence guard) is correct.

## 5. Verdict

Floor-raising (7 > tier-natural 3), correct mechanism (tier-independent env override, presence
guard). The only gap is that the specific value 7 lacks a recorded rationale and the var isn't in
any design doc, so its cost/coverage trade-off is unstated. No nerf.
