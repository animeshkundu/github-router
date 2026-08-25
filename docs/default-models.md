# Default models & slug translation

What `github-router claude` and `github-router codex` set for `ANTHROPIC_MODEL` /
default model, why the Anthropic dashed slug is preferred over Copilot's dotted slug,
and how fallback chains behave on implicit-default vs explicit `--model`. See
[`../CLAUDE.md`](../CLAUDE.md) for project overview.

## Default models

The `claude` and `codex` subcommands default to the latest Copilot-supported models when no `--model` is given:

- `claude` → `ANTHROPIC_MODEL=claude-opus-5` (Anthropic-published dashed slug). Opus 5 uses a single-segment slug that is also an exact Copilot catalog-id match, so the proxy's `resolveModel` (`src/lib/utils.ts`) routes it without dotted/dashed translation. Unlike 4.6 / 4.7 which ship as `<base>` + `<base>-1m*` slug pairs, **Opus 5 ships as a single slug** whose catalog entry already advertises `max_context_window_tokens: 1_000_000` — there is no separate `-1m` sibling. The `DEFAULT_CLAUDE_MODEL_FALLBACKS` chain (`claude-opus-4-8` → `claude-opus-4-7` → `claude-opus-4-6`) covers regressions only — the 1M↔200K downgrade is handled inside the resolver.

  Why the Anthropic slug: Claude Code's `/model` UI is backed by a hardcoded registry of Anthropic-published slugs. `claude-opus-5` has the registry-compatible shape while also exactly matching Copilot's catalog id, so the UI and upstream routing agree without a separate normalized slug.

- `codex` → `gpt-5.6-sol` (dropped the `-codex` suffix; `/responses` is the discriminator). Falls back via `DEFAULT_CODEX_MODEL_FALLBACKS`: `gpt-5.5` → `gpt-5.4` → `gpt-5.3-codex` → `gpt-5.2-codex`. `resolveCodexModel`'s "best available `/responses` model" provides a final safety net beyond the named chain. Codex CLI's bundled catalog uses Copilot-style slugs directly, so no Anthropic-slug translation is needed.

`getClaudeCodeEnvVars` also defaults `ANTHROPIC_SMALL_FAST_MODEL=claude-sonnet-5` (Anthropic-published dashed slug that is also the Copilot catalog id verbatim, so `resolveModel` resolves it via an exact catalog match; Claude Code uses this tier for status text, auto-compact summaries, session titles, and other background ops). We deliberately pass Sonnet rather than Haiku here: on the canonical Copilot-Enterprise deployment the quality lift on those background ops outweighs Haiku's marginal latency/cost edge, and Copilot bills per-request by multiplier rather than per-token. Sonnet 5 is both the newest Sonnet and cheaper than Sonnet 4.6 per the live catalog (input/output multipliers 200/1000 vs 300/1500), so it strictly dominates the prior default for this tier. The `/model` picker's Haiku tier row (`ANTHROPIC_DEFAULT_HAIKU_MODEL`, below) is likewise seeded to `claude-sonnet-5`, so the cheap-tier pick also lands on Sonnet 5. Presence-based guard preserves any user-set value — symmetric with `STRIPPED_PARENT_ENV_KEYS`'s intentional pass-through of `ANTHROPIC_SMALL_FAST_MODEL` for users with custom Copilot mappings.

**On a budget lead this inverts.** When the lead is a lighter Claude tier (`isBudgetClaudeLead`), Sonnet IS the lead, so seeding the small/fast tier to Sonnet leaves no cheap tier at all — background ops would cost the same as real work. Both `ANTHROPIC_SMALL_FAST_MODEL` and the `ANTHROPIC_DEFAULT_HAIKU_MODEL` picker row therefore drop to Haiku, together: leaving the row on Sonnet while background ops ran on Haiku would make the cheap-tier pick disagree with the tier actually in use. The env vars get the Anthropic DASHED `claude-haiku-4-5` (`BUDGET_SMALL_FAST_SLUG`) because Claude Code's `/model` registry is keyed on Anthropic slugs, while the presence probe tests Copilot's DOTTED `claude-haiku-4.5` (`BUDGET_SMALL_FAST_CATALOG_ID`) because that is the id the catalog carries — the same dashed-vs-dotted trap documented for `claude-opus-5` above. A catalog without that entry falls back to `claude-sonnet-5` rather than naming a model the account cannot reach.

### `-m fast` is now a distinct Luna launch profile, not a Sonnet alias

`-m fast` used to be a named alias that resolved to `claude-sonnet-5` and therefore
produced a session byte-identical to `-m claude-sonnet-5` (both keyed off the same
`isBudgetClaudeLead` predicate). It now points to a dedicated **Luna** lead (`gpt-5.6-luna`) with its own
narrowed agent/MCP surface — see [Fast launch
profile](#fast-launch-profile--m-fast). Three model identities that must not be
confused:

- **`-m fast`** — the new fast launch profile: Luna lead, exactly `scout` /
  `implementer-fast` / `reviewer-fast` natives, only the `gemini-critic` persona,
  and only the `peers`/`search` MCP groups.
- **`-m gpt-5.6-luna`** (direct Luna selection) — an ordinary standard-surface
  launch on the Luna model. It does NOT imply the fast profile: the profile is
  selected from the raw parsed alias (`fast`, trimmed/case-insensitive), never
  inferred from the resolved model id, so this keeps the full native roster,
  worker/orchestrate MCP groups, and all peer personas.
- **`-m claude-sonnet-5`** (or any other lighter Claude-family pick) — still
  reaches **budget mode** via the unchanged, Claude-family-only
  `isBudgetClaudeLead` predicate (advisor escalation, Haiku small/fast tier,
  delegation-prose ordering — see the paragraph above). Budget mode and the fast
  profile are now two independent axes: one is keyed on the resolved lead being a
  lighter Claude model, the other on the literal `-m fast` alias.

Explicit `-m`/`--model` is always respected as-is; fallback chains fire only on
the implicit-default path. Constants live in `src/lib/port.ts`.

## Fast launch profile (`-m fast`)

`github-router claude -m fast` selects a deliberately lean, Luna-led launch
profile distinct from an ordinary Opus or Sonnet launch. The profile is an
explicit abstraction (`src/lib/launch-profile.ts`) with frozen `standard` and
`fast` descriptors, selected purely from the raw `-m` argument being `fast`
(trimmed, case-insensitive) — never inferred from the resolved model id, so a
direct `-m gpt-5.6-luna` launch stays on the standard surface.

### Lead and startup validation

The fast lead is `gpt-5.6-luna`, requiring live catalog presence, `tool_calls`,
and at least 1M advertised context (via `withOneMSuffixForLead`, same detector the
standard lead branches use). On `-m fast` startup the proxy additionally validates
that the live catalog carries `grok-4.6` (tool calls, `medium` effort, usable
prompt-window metadata) and `gemini-3.7-flash` (tool calls, 1M context, `high`
effort, chat-capable) — these are prerequisites for constructing the *exact* fast
roster (the fast `reviewer-fast` and `gemini-critic` targets), not an allowlist the
user is later restricted to. If any prerequisite is missing or invalid, launch
**fails** rather than substituting a different model or silently shipping a
partial roster: the failure message lists every missing/invalid model and gives
the rollback command, plain `github-router claude`. Once a fast launch is up,
switching the global picker to Sol or Opus changes only the active lead — it does
not rerun startup validation or widen the profile's tool/agent surface.

### Exact fast roster

The fast profile emits exactly three native subagents, each pinned to a specific
model AND effort via `effort:` frontmatter (an extension to `PeerAgentDefinition`
in `src/lib/codex-mcp-config.ts`), with single-entry no-fallback resolution:

| Agent | Model | Effort |
|---|---|---|
| `scout` | `gpt-5.6-luna[1m]` | `high` |
| `implementer-fast` | `gpt-5.6-luna[1m]` | `max` |
| `reviewer-fast` | `grok-4.6` | `medium` |

Unlike the standard surface, where a subagent's reasoning effort follows the
Claude Code picker (see [Native subagents](../CLAUDE.md) in `CLAUDE.md`), the
fast roster's per-agent effort is pinned in frontmatter and does not follow a
mid-session picker change. Each of these three starts with its own fresh context
window rather than inheriting the lead's or another subagent's transcript, so the
Grok reviewer is never handed a 1M-token shared history it can't safely hold (see
[Grok context accounting](#grok-context-accounting) below).

The fast profile registers only the `peers` and `search` MCP groups — `workers`
and `orchestrate` are omitted entirely, along with the peer-review coordinator,
worker dispatcher subagents, worker/orchestration skills, the UserPromptSubmit
worker-steer prose, and the worker PreToolUse guard. These exclusions are hard
denies: no environment flag or catalog gate can re-enable `workers`/`orchestrate`
inside a fast session. Only one peer persona is emitted, `gemini-critic`, backed
by Gemini 3.7 Flash at `defaultEffort: high` — no coordinator, no other critics.
The deterministic structural Stop gate stays on regardless of profile (it is
MCP-independent and is the executable correctness floor).

Every fast-profile description, the `OPERATING_DEFAULTS_DIRECTIVE`, the peer
awareness snippet, and the startup persona banner are roster-aware: fast prose
must not name `implementer`, `reviewer`, `brainstorm`, `scribe`,
`general-purpose-fast`, the coordinator, any worker tool, or a worker/orchestration
skill — only `scout`, `implementer-fast`, `reviewer-fast`, `gemini-critic`
(Gemini 3.7 Flash), and the Gemini 3.7 Flash Advisor (see below). Standard-profile
prose is unaffected (byte-identical except for the globally-replaced gateway
picker rows and advisor-default changes described below).

### Three Luna effort aliases

Because the fast driver, the `/model` picker's Sonnet-tier row, and its
Haiku-tier row would otherwise all resolve to the same bare `gpt-5.6-luna`
catalog id — indistinguishable after canonicalization — the fast profile
introduces a small router-owned alias registry (in or alongside
`src/lib/launch-profile.ts`) so each tier gets its own absent-effort default:

| Router-owned alias | Backing model | Absent-effort default | Role |
|---|---|---|---|
| `gh-router-luna-driver-max` | Luna | `max` | fast driver |
| `gh-router-luna-sonnet-xhigh` | Luna | `xhigh` | `/model` picker Sonnet-tier row in fast mode |
| `gh-router-luna-haiku-high` | Luna | `high` | `/model` picker Haiku-tier row in fast mode |

The header-only `/v1/messages` identity preflight first authenticates the launch.
Later, `resolveModelInBody` retains any `[1m]` metadata, resolves the alias
descriptor, reads an explicit `output_config.effort` or `thinking` budget, applies
the alias default ONLY when neither is present, then canonicalizes `body.model` to
the real Luna id before route classification and outbound assembly. The loop guard
runs before this step but is model-agnostic. Precedence is explicit
`output_config.effort` > a client thinking budget > the alias/model default. A
router-owned alias id never reaches Copilot.

**Client UI limitation.** Claude Code's picker may initially label the canonical
Luna gateway row "high" (or whatever effort the UI infers) while the proxy applies
the driver alias's `max` default underneath. This is a documented UI cosmetic
limitation, not a bug to paper over: the proxy does **not** forge GrowthBook
experiment state and does **not** set `CLAUDE_CODE_EFFORT_LEVEL`, either of which
would defeat the effort picker for every other model in the session, not just
Luna.

### Replaced gateway picker rows

`src/lib/server-setup.ts`'s globally-seeded, live-catalog-gated `/model` picker
rows are being replaced with exactly four (dropping the previous `gpt-5.5` /
`gpt-5.3-codex` / `gemini-3.5-flash` list and the dynamic Gemini-review row
append — see the current [Phase 3](anthropic-translation-shim.md#phase-3-native-model-selection-gateway-cache-seed)
section for what ships today):

1. `gpt-5.6-sol` (display "GPT-5.6 Sol"), `[1m]` when the live catalog permits
2. `gpt-5.6-luna` (display "GPT-5.6 Luna"), `[1m]` when permitted
3. `gemini-3.7-flash` (display "Gemini 3.7 Flash"), `[1m]` when permitted
4. `grok-4.6` (display "Grok 4.6"), always bare at its current 500K window

A row missing from the live catalog is omitted, never substituted with a
different model. This picker change applies to BOTH standard and fast Claude
launches — it does not change either surface's active default lead.

### Grok context accounting

Grok 4.6 advertises a 500K total context window but only a 372K maximum prompt
and a 128K maximum output, with a `low..xhigh` effort ladder. The proxy does
**not** append `[1m]` to Grok and does **not** pass `--autocompact`: a
launch-global autocompact setting would incorrectly cap every other 1M model
(Sol, Luna, Gemini) in the same session after a `/model` switch, and a
process-global `CLAUDE_CODE_MAX_CONTEXT_TOKENS` override cannot safely be made
Grok-specific while Claude Code still permits arbitrary bare non-Claude ids or a
runtime model switch. Grok therefore stays bare: Claude Code assumes the 200K
default window for its own UI and proactive-compaction heuristics — a
conservative client-side accounting choice, not a claim that 200K is Grok's real
runtime ceiling.

The shipped contract deliberately accepts that conservatism: the Grok
`reviewer-fast` reviewer is locally budgeted as a 200K model even though Copilot
can accept 372K of prompt, and the fast profile does not depend on exploiting the
unused ~172K. A request-boundary/loop-budget guard sized from Claude Code's
*effective local* prompt budget (200K minus actual system/tool/framing reserve —
necessarily below Grok's live 372K upstream ceiling) must fail VISIBLY rather
than silently truncate a review; the review artifact itself must stay
byte-for-byte intact, with only prior tool/history material eligible for
compaction. A recorded >200K (target 250K) probe documents whether the current
Claude Code build compacts or refuses at that size — early compaction is not
treated as an incompatibility, only as a data point.

A pure helper derives (never hardcodes) a future per-model declaration:

```text
target trigger = floor(max_prompt_tokens * 0.85)
assumed client window = target trigger + min(max_output_tokens, 20_000)
```

For Grok 4.6's current catalog entry this yields an **85%-of-prompt trigger of
316,200** tokens, with Claude Code needing an **assumed window of 336,200**
(it subtracts a 20K reserve). Neither number is activated yet — only computed and
tested — pending either a supported per-model client declaration from Claude Code,
or a fast profile that can block every incompatible bare-model switch and prove
the override is request/profile scoped. This is a deliberate rejection of unsafe
global state, not a claim that today's picker set is an exhaustive allowlist of
what a user may select.

### Gemini 3.7 Flash Advisor on the Luna translation path

The authenticated fast profile makes `__anthropic_advisor` usable again by
selecting `gemini-3.7-flash` as the Advisor model when the lead is Luna-via-shim
(normal Opus-lead → Sol and budget-Claude-lead → Opus escalation are unchanged —
see [`unsupported-features.md`](unsupported-features.md)). This is a
from-scratch cross-protocol streaming workstream, landed as its own later commit
so defects have an isolated bisect range: it is not a conditional strip of the
existing Claude-only Advisor loop or a drop-in reuse of `dispatchModelCall`
(non-streaming, caller-endpoint-driven; it can only donate request-shaping
logic). Load-bearing pieces:

- Advisor's default effort becomes `high` (no forced floor), clamped to whichever
  advisor model is actually selected; an operator pin (`GH_ROUTER_ADVISOR_MODEL`)
  still wins first.
- Advisor stripping for non-Claude routes stays unconditional for every profile
  except the fast Luna profile carrying the advisor beta.
- `toClientServerToolUseId` becomes total for `/responses` `call_*` ids: it
  preserves the original replay id, derives a distinct spec-valid client
  `srvtoolu_*` id with collision-safe indexing, and leaves the existing Claude
  `toolu_*` path byte-identical.
- Advisor dispatch is generalized to pick `/responses`, `/chat/completions`, or
  `/v1/messages` from the Advisor's own live catalog entry, reusing the
  `dispatchModelCall` request-shaping logic so Gemini receives a real chat
  payload with `reasoning_effort: high` — it never falls through to the Claude
  Messages branch.
- A context-free streaming lead shim entry (extracted from
  `src/lib/anthropic-translate/index.ts`) returns Anthropic SSE and accepts the
  caller's own shared `AbortController`, and `buildAdvisorStream` gains an
  injectable `continueTurn(body, signal)` — defaulting to today's native
  `createMessages` path, using the extracted shim only for Luna continuations.
- Deferred advisor history (`server_tool_use{advisor}` / `advisor_tool_result`)
  is translated into visible neutral text for a shim-routed lead instead of being
  silently dropped, though a shim-routed lead still drops replayed assistant
  *thinking* — the Gemini Advisor sees the lead's actions and transcript, not its
  hidden reasoning.
- A provider-neutral Advisor event algebra (message start; ordered content-block
  start/delta/stop; buffered tool calls keyed separately by provider item id and
  call id; terminal usage/stop; terminal error) governs cancellation, malformed or
  fragmented JSON, parallel/interleaved tools, and duplicate terminal events, with
  exactly one `message_start`, monotonic block indices, one-to-one provider-id ↔
  client-id ↔ replay-id mappings, and exactly-once continuation across the initial
  lead fetch, the Advisor call, and the continuation fetch.

Gemini 3.7 Flash is a hard fast-profile prerequisite under the exact-roster
contract described above: its absence fails the fast launch rather than silently
omitting the Advisor or the `gemini-critic` persona.

## `/model` tier-default knobs

`getClaudeCodeEnvVars` seeds three additional presence-guarded defaults so the `/model` picker's Sonnet, Haiku, and Opus rows show ids the proxy knows how to route (cc-backup `src/utils/model/modelOptions.ts:78,109,167` reads these as the 3P-user picker customization knobs), each paired with a `*_MODEL_NAME` label seed:

| Env var | Default | Notes |
|---|---|---|
| `ANTHROPIC_DEFAULT_SONNET_MODEL` | `claude-sonnet-5`, `[1m]`-decorated when the catalog backs it | Sonnet 5 is newer + cheaper than `claude-sonnet-4-6` (200/1000 vs 300/1500 multipliers, broadly available pro..enterprise). |
| `ANTHROPIC_DEFAULT_HAIKU_MODEL` | `claude-sonnet-5` (Opus lead) / `claude-haiku-4-5` (budget lead) | On an Opus lead, seeded to Sonnet 5 (not a Haiku slug) to match the `ANTHROPIC_SMALL_FAST_MODEL` default — the cheap-tier pick lands on Sonnet 5, which is newer and cheaper than `claude-haiku-4-5`. On a budget lead this row holds a genuinely 200K model, so it stays bare. |
| `ANTHROPIC_DEFAULT_OPUS_MODEL` | `claude-opus-5`, `[1m]`-decorated when the catalog backs it | |
| `ANTHROPIC_DEFAULT_{SONNET,HAIKU,OPUS}_MODEL_NAME` | the BARE slug of the row above | The picker label. Seeded only when we also seeded the row's model, so a user who pins their own tier model is never handed our label for it; a user-set label still wins when we did seed the model. |

**Why the rows carry `[1m]` (they used to be pinned bare).** Selecting a tier row makes its env value the ACTIVE model id — cc-backup `model.ts:456-465` returns `getDefaultSonnetModel()` verbatim — so a bare row reproduces the same 200K under-accounting the active default already guards against, one interaction later. The earlier objection was that seeding a bracketed slug "would bypass cap-awareness"; the rows now go through `withOneMSuffixForLead`, the same catalog-gated detector the lead slug uses, which is exactly the cap-awareness that was missing. Verified rather than assumed in Claude Code's own source: `has1mContext()` is applied DIRECTLY to the env value to produce the row's "(1M context)" description (`modelOptions.ts:76-121`), and nothing validates or rejects the bracket — `parseUserSpecifiedModel` deliberately round-trips it.

The label is seeded with the BARE slug because Claude Code falls back to the raw env value for a custom row's label (`label: process.env.ANTHROPIC_DEFAULT_SONNET_MODEL_NAME ?? customSonnetModel`), so an undecorated row would otherwise render literally as `claude-sonnet-5[1m]`. Seeding the name keeps the picker reading exactly as it does today while the value carries the bracket, and Claude Code appends its own "(1M context)" to the description.

Presence-based guards mean each of these is preserved when set in the parent shell — symmetric with the `ANTHROPIC_SMALL_FAST_MODEL` and `CLAUDE_CODE_*` opt-out surfaces.

## 1M context opt-in (`[1m]` literal-bracket suffix)

Claude Code's 1M-context accounting (compaction triggers, status-line `%` indicator, token budgets) is gated by a literal `[1m]` bracket on the model string. cc-backup `src/utils/context.ts:35-40`:

```ts
export function has1mContext(model: string): boolean {
  if (is1mContextDisabled()) return false
  return /\[1m\]/i.test(model)
}
```

When `has1mContext` returns true, `getContextWindowForModel` returns `1_000_000` instead of the default `200_000`. The bracket is preserved through `parseUserSpecifiedModel` (`model.ts:445-506`), so Claude Code sends the bracketed slug verbatim on the wire (`model: "claude-opus-5[1m]"`). Copilot doesn't recognize the bracket → 400.

The proxy handles this with two cooperating pieces:

1. **The active lead slug** — every branch of `resolveLeadSlugArg` (`src/lib/port.ts`) is catalog-gated, by one of two detectors that answer the same question about different kinds of input.

   **`pickClaudeDefault()`** handles the two branches that name an Opus FAMILY rather than a slug (the implicit default, and the `-m 4.7` / `-m 4.8` shorthand). It is cap-aware via **dual-signal 1M detection**, flipping the decoration on when EITHER signal fires:
   - **Sibling-slug signal**: a catalog entry matches `opus-${family}-1m(?:$|-)` — how 4.6 ships (`claude-opus-4.6-1m`) and how 4.7 ships (`claude-opus-4.7-1m-internal`).
   - **Base-slug capability signal**: the catalog entry whose id IS the base `opus-${family}` slug advertises `capabilities.limits.max_context_window_tokens >= 1_000_000` — how Opus 5 ships (`claude-opus-5` with `max_context_window_tokens: 1_000_000`, no `-1m` sibling).

   Either signal alone is enough; both together also work (no double-counting). Otherwise it returns the bare `claude-opus-${family}` slug. Emits an `info` breadcrumb naming which signal fired so users see which mode was picked.

   **`withOneMSuffixForLead()`** (`src/lib/one-m-context.ts`) handles the other two branches — `-m fast` and a full slug a power user pins. It resolves the slug through `resolveModel` first, then reads the resolved entry's advertised window. Resolving first is what makes it correct for input the user typed: it maps the Anthropic dashed form onto Copilot's dotted catalog id (`claude-sonnet-4-6` → `claude-sonnet-4.6`) and picks up the `-1m` sibling shape for free through `resolveModel`'s Opus family preference, so it reaches the same conclusion `pickClaudeDefault` does wherever both can be asked. It is idempotent, so a hand-pinned `-m claude-opus-5[1m]` is not double-decorated.

   **Nothing here is family-gated.** An earlier revision decorated Opus only, on the stated grounds that Copilot had no 1M backend for Sonnet or Haiku. That was true when written and is now false for Sonnet: the live catalog advertises `max_context_window_tokens: 1_000_000` on `claude-sonnet-5` and `claude-sonnet-4.6`. Under the old rule a `-m fast` session was budgeted locally at 200K and auto-compacted at roughly a fifth of the window Copilot was serving. The catalog now decides per model — `claude-haiku-4.5` really is 200K and comes back bare by the same check rather than by a hardcoded family rule, and the next family that ships 1M is picked up without an edit.

2. **`resolveModel` Step 0 in `src/lib/utils.ts`** — Strips the bracket before any catalog lookup, delegates to the regular cascade, and re-checks the resolution. If it lands on a 1M backend (an Opus 5 / 4.8 / Sonnet 5 base slug, `4.7-1m-internal`, `4.6-1m`), perfect. If it lands on a non-1M variant (a Pro tier carrying only the 200K Opus, or a genuinely 200K model such as `claude-haiku-4.5`), it logs a `warn` and returns the 200K resolution so the request still succeeds. The bracket **never** reaches Copilot. Because every decorator upstream is catalog-gated, reaching that warn means the catalog changed under a running process or the slug was pinned by hand.

The exact-id detector `withOneMSuffix()` in `src/lib/one-m-context.ts` gives a concrete catalog id `[1m]` exactly when its own live catalog entry advertises at least 1M context. `nativeSelectableModelsInCatalog()` uses it for gateway-cache picker rows, and `buildPeerAgentDefinitions()` uses it only for native-subagent `model:` frontmatter. Both callers already hold a concrete id from a catalog walk, which is why exact matching is the right rule there and why the lead path uses the resolving variant instead. That keeps a 1M gpt/gemini picker row or subagent from being locally budgeted at 200K, while 400k gpt-5.3-codex and gpt-5.4-mini remain bare. The upstream-facing resolver and model resolvers keep bare ids: brackets are local accounting metadata, not Copilot model ids.

Forcing 1M off entirely: `CLAUDE_CODE_DISABLE_1M_CONTEXT=1` is Claude Code's HIPAA-compliance opt-out (cc-backup `context.ts:31`). The proxy matches Claude Code's raw truthiness gate, so any non-empty value, including `0`, prevents this decoration; the local context window collapses back to 200K.

Round-trip coverage: `tests/lib-utils.test.ts` (`resolveModel [1m]` and `pickClaudeDefault` describe blocks) pins both detection signals across enterprise/non-enterprise/sonnet/haiku behavior, including the Opus-5-no-sibling and the version-anchored false-positive guards. The lead-slug decorator is pinned in `tests/lib-server-setup.test.ts` (`budget-mode lead and small/fast tier`) against a fixture shaped like the measured live catalog, and end to end in `tests/isolated/cli-claude.test.ts`, which asserts the bracket reaches the spawned child's `ANTHROPIC_MODEL` rather than only the resolver's return value.
