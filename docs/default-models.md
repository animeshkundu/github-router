# Default models & slug translation

What `github-router claude` and `github-router codex` set for `ANTHROPIC_MODEL` /
default model, why the Anthropic dashed slug is preferred over Copilot's dotted slug,
and how fallback chains behave on implicit-default vs explicit `--model`. See
[`../CLAUDE.md`](../CLAUDE.md) for project overview.

## Default models

The `claude` and `codex` subcommands default to the latest Copilot-supported models when no `--model` is given:

- `claude` → `ANTHROPIC_MODEL=claude-opus-4-8` (Anthropic-published dashed slug). The proxy's `resolveModel` (`src/lib/utils.ts`) translates this to Copilot's `claude-opus-4.8` at request time, so the actual upstream call routes correctly. Unlike 4.6 / 4.7 which ship as `<base>` + `<base>-1m*` slug pairs, **4.8 ships as a single slug** whose catalog entry already advertises `max_context_window_tokens: 1_000_000` — there is no separate `-1m` sibling. The `DEFAULT_CLAUDE_MODEL_FALLBACKS` chain (`claude-opus-4-7` → `claude-opus-4-6` → `claude-opus-4-5`) covers major.minor regressions only — the 1M↔200K downgrade is handled inside the resolver.

  Why the Anthropic slug instead of the Copilot slug: Claude Code's `/model` UI is backed by a hardcoded registry of Anthropic-published slugs. Setting `ANTHROPIC_MODEL=claude-opus-4.8` (Copilot's dotted slug) doesn't match the registry shape, so the menu falls back to "Opus 4" with a "Newer version available" hint instead of selecting "Opus 4.8 (1M context)". The Anthropic dashed slug fixes the UI without sacrificing routing — round-trip covered by `tests/lib-utils.test.ts`.

  Users can pass `--model claude-opus-4.8` (Copilot slug) for explicit pinning, but Claude Code's UI won't recognize it the same way. Use the Anthropic dashed slug for correct UI labels.

- `codex` → `gpt-5.5` (dropped the `-codex` suffix; `/responses` is the discriminator). Falls back via `DEFAULT_CODEX_MODEL_FALLBACKS`: `gpt-5.4` → `gpt-5.3-codex` → `gpt-5.2-codex`. `resolveCodexModel`'s "best available `/responses` model" provides a final safety net beyond the named chain. Codex CLI's bundled catalog uses Copilot-style slugs directly, so no Anthropic-slug translation is needed.

`getClaudeCodeEnvVars` also defaults `ANTHROPIC_SMALL_FAST_MODEL=claude-sonnet-4-6` (Anthropic-published dashed slug; Claude Code uses this tier for status text, auto-compact summaries, session titles, and other background ops). We deliberately pass Sonnet rather than Haiku here: on the canonical Copilot-Enterprise deployment the quality lift on those background ops outweighs Haiku's marginal latency/cost edge, and Copilot bills per-request by multiplier rather than per-token. The `/model` picker's Haiku tier row (`ANTHROPIC_DEFAULT_HAIKU_MODEL`, below) stays `claude-haiku-4-5` so users who explicitly want the cheap tier still get it. Presence-based guard preserves any user-set value — symmetric with `STRIPPED_PARENT_ENV_KEYS`'s intentional pass-through of `ANTHROPIC_SMALL_FAST_MODEL` for users with custom Copilot mappings.

Fallback chains only fire on the implicit-default path — explicit `-m`/`--model` is always respected as-is. Constants live in `src/lib/port.ts`.

## `/model` tier-default knobs

`getClaudeCodeEnvVars` seeds three additional presence-guarded defaults so the `/model` picker's Sonnet, Haiku, and Opus rows show ids the proxy knows how to route (cc-backup `src/utils/model/modelOptions.ts:78,109,167` reads these as the 3P-user picker customization knobs):

| Env var | Default | Why bare slug (no `[1m]`) |
|---|---|---|
| `ANTHROPIC_DEFAULT_SONNET_MODEL` | `claude-sonnet-4-6` | Copilot has no `*-sonnet-4*-1m*` backend; bracketing would either 400 upstream or silently over-account locally. |
| `ANTHROPIC_DEFAULT_HAIKU_MODEL` | `claude-haiku-4-5` | No 1M Haiku exists on EITHER side: cc-backup `context.ts:43-49` `modelSupports1M` lists only `claude-sonnet-4*` and `opus-4-6`. |
| `ANTHROPIC_DEFAULT_OPUS_MODEL` | `claude-opus-4-8` | The active default's `[1m]` decoration lives on `ANTHROPIC_MODEL` (see "1M context opt-in" below) and is cap-aware; the picker row stays bare so users who explicitly switch to "Opus" (non-1M) via `/model` get the 200K behavior. |

Presence-based guards mean each of these is preserved when set in the parent shell — symmetric with the `ANTHROPIC_SMALL_FAST_MODEL` and `CLAUDE_CODE_*` opt-out surfaces.

## 1M context opt-in (`[1m]` literal-bracket suffix)

Claude Code's 1M-context accounting (compaction triggers, status-line `%` indicator, token budgets) is gated by a literal `[1m]` bracket on the model string. cc-backup `src/utils/context.ts:35-40`:

```ts
export function has1mContext(model: string): boolean {
  if (is1mContextDisabled()) return false
  return /\[1m\]/i.test(model)
}
```

When `has1mContext` returns true, `getContextWindowForModel` returns `1_000_000` instead of the default `200_000`. The bracket is preserved through `parseUserSpecifiedModel` (`model.ts:445-506`), so Claude Code sends the bracketed slug verbatim on the wire (`model: "claude-opus-4-8[1m]"`). Copilot doesn't recognize the bracket → 400.

The proxy handles this with two cooperating pieces:

1. **`pickClaudeDefault()` in `src/lib/port.ts`** — Cap-aware via **dual-signal 1M detection**. At launch (after `cacheModels()` populates `state.models`), it flips the `[1m]` decoration on when EITHER signal fires:
   - **Sibling-slug signal**: a catalog entry matches `opus-${family}-1m(?:$|-)` — how 4.6 ships (`claude-opus-4.6-1m`) and how 4.7 ships (`claude-opus-4.7-1m-internal`).
   - **Base-slug capability signal**: the catalog entry whose id IS the base `opus-${family}` slug advertises `capabilities.limits.max_context_window_tokens >= 1_000_000` — how 4.8 ships (`claude-opus-4.8` with `max_context_window_tokens: 1_000_000`, no `-1m` sibling).

   Either signal alone is enough; both together also work (no double-counting). Otherwise it returns the bare `claude-opus-${family}` slug, preserving the pre-1M behavior. Emits an `info` breadcrumb naming which signal fired so users see which mode was picked.

2. **`resolveModel` Step 0 in `src/lib/utils.ts`** — Strips the bracket before any catalog lookup, delegates to the regular cascade, and re-checks the resolution. If it lands on a 1M backend (4.8 base slug, 4.7-1m-internal, 4.6-1m), perfect. If it lands on a non-1M variant (Pro tier for opus, or any `[1m]` on sonnet/haiku where Copilot has no 1M backend), it logs a `warn` and returns the 200K resolution so the request still succeeds. The bracket **never** reaches Copilot.

Forcing 1M off entirely: `CLAUDE_CODE_DISABLE_1M_CONTEXT=1` is Claude Code's HIPAA-compliance opt-out (cc-backup `context.ts:31`). When set, `has1mContext` always returns false regardless of the bracket; the local context window collapses back to 200K.

Round-trip coverage: `tests/lib-utils.test.ts` (`resolveModel [1m]` and `pickClaudeDefault` describe blocks) pins both detection signals across enterprise/non-enterprise/sonnet/haiku behavior, including the 4.8-no-sibling and the version-anchored false-positive guards.
