# Review: env vars, settings, and config injected into the spawned session

The behavior-shaping config `github-router claude` injects into the spawned Claude Code
session. These are less "model-facing text" than the MCP/prompt surfaces, but they determine
what the model can DO and what it DEFAULTS to, so they belong in the injection inventory.

Governing lens for every item: **raise the floor, never nerf** + **the right thing, at the
right time, in the right amount**. For each: does it expand or restrict capability? Is the
default the floor-raising choice? Any opt-out? Any drift vs the live catalog?

All values are set in `getClaudeCodeEnvVars` (`src/lib/server-setup.ts:541-785`) unless noted.
The dominant mechanism is a **presence-based guard**: inject the default only when
`process.env[key] === undefined`, so any user-set value (including `0`/`false`/`off`) wins.

## Inventory

| Var / setting | Value injected | Presence-guarded opt-out? | Floor-raising? | Doc |
|---|---|---|---|---|
| `CLAUDE_CODE_ENABLE_EXPERIMENTAL_ADVISOR_TOOL` | `1` | yes (`=0`; also `CLAUDE_CODE_DISABLE_ADVISOR_TOOL=1`) | yes — adds advisor tool | [feature gates](claude-code-feature-gates.md) |
| `CLAUDE_CODE_FORK_SUBAGENT` | `1` | yes (`=0`) | yes — forks inherit context (no-ops in `--print`) | [feature gates](claude-code-feature-gates.md) |
| `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` | `1` | yes (`=0`) | yes — teams + SendMessage (needs config mirror) | [feature gates](claude-code-feature-gates.md) |
| `CLAUDE_CODE_ENABLE_FINE_GRAINED_TOOL_STREAMING` | `1` | yes (`=0`) | yes — vendor-recommended for proxies | [feature gates](claude-code-feature-gates.md) |
| `CLAUDE_CODE_ENABLE_TASKS` | `1` | yes (`=0`) | yes — task tracking in `-p` | [feature gates](claude-code-feature-gates.md) |
| `ANTHROPIC_MODEL` | `claude-opus-5[1m]` (enterprise, cap-aware) | `-m <model>` pin | yes — flagship + cap-aware 1M | [model defaults](model-defaults-and-picker-seeds.md) |
| `ANTHROPIC_SMALL_FAST_MODEL` | `claude-sonnet-5` | yes | yes — newer + cheaper than Sonnet 4.6 | [model defaults](model-defaults-and-picker-seeds.md) |
| `ANTHROPIC_DEFAULT_{SONNET,HAIKU,OPUS}_MODEL` | `claude-sonnet-5` / `claude-sonnet-5` / `claude-opus-5` | yes | yes — cheap tier lands on Sonnet 5 | [model defaults](model-defaults-and-picker-seeds.md) |
| `MCP_TIMEOUT` / `MCP_TOOL_TIMEOUT` | `22_500_000` ms (6h15m) | yes (`GH_ROUTER_MCP_TOOL_TIMEOUT_MS`) | yes — unblocks long MCP/worker calls past #50289 | [mcp timeout](mcp-tool-timeout.md) |
| `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY` | `1` (conditional, only when seed lands) | yes | yes — adds non-Claude picker rows, no tier nerf | [gateway seed](gateway-model-cache-seed.md) |
| `CLAUDE_CODE_PLAN_V2_AGENT_COUNT` | `7` | yes | yes — 7 planning agents vs tier-natural 3 | [plan agent count](plan-mode-agent-count.md) |
| `DISABLE_NON_ESSENTIAL_MODEL_CALLS` | `1` | **NO — unconditional** | neutral — suppresses Copilot-unsupported calls | [traffic suppression](traffic-telemetry-suppression.md) |
| `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` | `1` | **NO — unconditional** | neutral+ — also the gateway-fetch safety interlock | [traffic suppression](traffic-telemetry-suppression.md) |
| `DISABLE_TELEMETRY` | `1` | **NO — unconditional** | neutral — suppresses external analytics | [traffic suppression](traffic-telemetry-suppression.md) |
| `CLAUDE_CONFIG_DIR` + synthetic cred + onboarding skip | per-launch mirror dir | none by design | enabling — substrate for teams/subagent-MCP/fresh-launch | [config mirror](claude-config-dir-mirror.md) |
| Toolbelt PATH prepend | `PATHS.TOOLBELT_BIN_DIR` | `GH_ROUTER_DISABLE_TOOLBELT=1` | yes — native CLIs via gap-fill | [toolbelt path](toolbelt-path.md) |
| `STRIPPED_PARENT_ENV_KEYS` | strips ~25 keys | none by design | no-nerf — removes only leak/conflict/noise | [stripped keys](stripped-parent-env-keys.md) |

Also set unconditionally in the base `vars`: `ANTHROPIC_BASE_URL` (route to proxy). The
`[1m]` decoration on `ANTHROPIC_MODEL` is only added on enterprise tiers with a live-catalog
1M signal; non-enterprise gets the bare slug.

## Systemic findings

### 1. Presence-guard is the right pattern — and the three unconditional traffic vars are the one break

Every model-default, feature-gate, timeout, and picker-seed var uses the presence-based guard:
inject only when unset, so a user value (including an opt-out `0`) always wins. This is the
correct "right amount with an escape hatch" mechanism and it's applied consistently — **except**
the three traffic/telemetry vars (`DISABLE_NON_ESSENTIAL_MODEL_CALLS`,
`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`, `DISABLE_TELEMETRY`), which are set unconditionally
in the base `vars` object with no guard and no documented reason for the asymmetry. For
`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` the unconditional set is load-bearing (it's the
interlock that keeps the hazardous gateway network-fetch inert — a user `=0` would re-open the
tier-degradation hazard the gateway-cache-seed design closes), and that should be stated at the
injection site. For the other two the unconditional set is a mild over-reach — they have no
interlock role and could be presence-guarded for a clean opt-out. **Recommendation**: document
the interlock at `server-setup.ts:560-562`, and consider presence-guarding the two non-interlock
vars.

### 2. The base model slugs are hardcoded and only fall BACKWARD — slow floor-erosion vs the live catalog

`ANTHROPIC_MODEL`'s base slug (`DEFAULT_CLAUDE_MODEL = "claude-opus-5"`), the Sonnet-5
small/fast + tier literals, and the `NATIVE_NON_CLAUDE_MODELS` picker list are all hardcoded
constants. The `[1m]` DECORATION is live-catalog-driven (dual-signal detection, self-heals), but
the base slug CHOICE is not. The implicit-default path walks `DEFAULT_CLAUDE_MODEL_FALLBACKS`
(4.8 → 4.7 → 4.6) only BACKWARD if Opus 5 is absent — there is no forward walk to a NEWER Opus, and
the Sonnet-5 literals have no fallback chain at all. So when Copilot ships a later Opus / Sonnet 6,
the "strongest available" property degrades silently until someone bumps the constant.
**Recommendation**: a "best available in family" forward-walk (mirroring `resolveCodexModel`'s
"best available `/responses` model" net) would keep the Opus/Sonnet defaults honest against the
live catalog and preserve the floor without manual constant bumps.

### 3. Deep coupling to pinned Claude Code binary internals is the dominant drift vector

Multiple high-value injections depend on Claude Code binary internals verified against specific
builds: the feature-gate names (GrowthBook/`Z8()`/`JI()` semantics), the `MCP_TOOL_TIMEOUT`
`y13()` behavior (v2.1.141), the gateway cache path/schema (2.1.201), the synthetic credential
schema `guH` + onboarding gates `hasCompletedOnboarding`/`bypassPermissionsModeAccepted`
(2.1.140/2.1.158), and the plan-agent-count `bGK` (2.1.158). Most degrade GRACEFULLY on drift
(a renamed var becomes a harmless no-op; a changed cache schema just drops the picker rows). The
sharp exception is the credential/onboarding schema in the config mirror — a break there would
fail AUTH, not degrade a nicety. That half is guarded by the `assertOnboardingGateInjected`
postcondition (fails loudly) and the no-401 remap. **Recommendation**: keep the build-pinned
version numbers current in `docs/claude-env-injection.md` / `docs/auth-isolation.md`, and treat
the credential-mirror coupling as the one to re-verify first on any Claude Code upgrade.

### 4. Two floor-raisers found in code are under-documented

`CLAUDE_CODE_PLAN_V2_AGENT_COUNT=7` (7 planning agents vs tier-natural 3) and the fact that these
are the config that make the 6h worker + agent-teams surfaces viable are real capability
expansions, but the value 7 has no recorded rationale and no design-doc mention. Not a bug, but
"why 7" is asserted, not evidenced, and an operator reasoning about Copilot request volume won't
find it in the docs. **Recommendation**: add a one-line cost/coverage rationale at
`server-setup.ts:683` and a mention in `docs/claude-env-injection.md`.

## Overall verdict

The config-injection surface is strongly floor-raising and consistently well-mechanized. Every
feature gate, model default, timeout, and picker seed EXPANDS what the session can do, defaults to
the strongest/newest available, and (with the three traffic-var exceptions) honors a user opt-out
via the presence guard. The one surface that removes things (`STRIPPED_PARENT_ENV_KEYS`) removes
only leak/conflict/noise vectors and is the cleanest reviewed. No injection NERFS a capability the
model actually needs. The residual risks are all drift: hardcoded base slugs that only fall
backward (fixable with a forward best-available walk), and coupling to pinned binary internals
(mostly graceful, with the credential mirror as the one auth-critical exception). Fix the three
unconditional traffic vars' documented asymmetry and the backward-only model-default walk and this
surface is clean.
