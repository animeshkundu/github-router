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

### `-m fast`

`-m fast` is a named alias for the budget lead, resolved by `resolveLeadSlugArg` in `src/lib/port.ts` alongside the `-m 4.7` / `-m 4.8` Opus-family shorthand, and like that shorthand it leaves `usingDefault` false so the fallback walk cannot override it. It resolves to an ordinary slug and sets no mode flag: every budget-mode surface keys off the RESOLVED lead through the single `isBudgetClaudeLead` predicate, so `-m fast` and `-m claude-sonnet-5` produce identical sessions. Besides the tier above, budget mode changes the advisor's model (see [`unsupported-features.md`](unsupported-features.md)) and the ordering of the injected delegation prose.

Like every other lead branch, `-m fast` is `[1m]`-decorated against the live catalog — see [1M context opt-in](#1m-context-opt-in-1m-literal-bracket-suffix) below. That identity between `-m fast` and `-m claude-sonnet-5` includes the context budget: decorating one branch and not the other would reintroduce through the context window exactly the divergence the alias exists to avoid.

Fallback chains only fire on the implicit-default path — explicit `-m`/`--model` is always respected as-is. Constants live in `src/lib/port.ts`.

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
