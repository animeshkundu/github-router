# Default models & slug translation

What `github-router claude` and `github-router codex` set for `ANTHROPIC_MODEL` /
default model, why the Anthropic dashed slug is preferred over Copilot's dotted slug,
and how fallback chains behave on implicit-default vs explicit `--model`. See
[`../CLAUDE.md`](../CLAUDE.md) for project overview.

## Default models

The `claude` and `codex` subcommands default to the latest Copilot-supported models when no `--model` is given:

- `claude` → `ANTHROPIC_MODEL=claude-opus-4-7` (Anthropic-published dashed slug). The proxy's `resolveModel` (`src/lib/utils.ts`) translates this to Copilot's `claude-opus-4.7-1m-internal` on enterprise tokens or `claude-opus-4.7` on Pro+/Business/Max at request time, so the actual upstream call routes correctly. The `DEFAULT_CLAUDE_MODEL_FALLBACKS` chain (`claude-opus-4-6` → `claude-opus-4-5`) covers major.minor regressions only — the 1M↔200K downgrade is handled inside the resolver.

  Why the Anthropic slug instead of the Copilot slug: Claude Code 2.1.126's `/model` UI is backed by a hardcoded registry of Anthropic-published slugs. Setting `ANTHROPIC_MODEL=claude-opus-4.7-1m-internal` (Copilot's slug, with dots and `-internal` suffix) doesn't match any registry entry, so the menu falls back to "Opus 4" with a "Newer version available" hint instead of selecting "Opus 4.7 (1M context)". The Anthropic dashed slug fixes the UI without sacrificing routing — round-trip covered by `tests/lib-utils.test.ts:154`.

  Users can pass `--model claude-opus-4.7-1m-internal` (Copilot slug) for explicit pinning, but Claude Code's UI won't recognize it and will display "Opus 4" instead of "Opus 4.7 (1M context)". Use the Anthropic slug for correct UI labels.

- `codex` → `gpt-5.5` (dropped the `-codex` suffix; `/responses` is the discriminator). Falls back via `DEFAULT_CODEX_MODEL_FALLBACKS`: `gpt-5.4` → `gpt-5.3-codex` → `gpt-5.2-codex`. `resolveCodexModel`'s "best available `/responses` model" provides a final safety net beyond the named chain. Codex CLI's bundled catalog uses Copilot-style slugs directly, so no Anthropic-slug translation is needed.

`getClaudeCodeEnvVars` also defaults `ANTHROPIC_SMALL_FAST_MODEL=claude-haiku-4-5` (Anthropic-published dashed slug; Claude Code uses this tier for status text, auto-compact summaries, session titles, and other background ops). Presence-based guard preserves any user-set value — symmetric with `STRIPPED_PARENT_ENV_KEYS`'s intentional pass-through of `ANTHROPIC_SMALL_FAST_MODEL` for users with custom Copilot mappings.

Fallback chains only fire on the implicit-default path — explicit `-m`/`--model` is always respected as-is. Constants live in `src/lib/port.ts`.

## `/model` tier-default knobs

`getClaudeCodeEnvVars` seeds three additional presence-guarded defaults so the `/model` picker's Sonnet, Haiku, and Opus rows show ids the proxy knows how to route (cc-backup `src/utils/model/modelOptions.ts:78,109,167` reads these as the 3P-user picker customization knobs):

| Env var | Default | Why bare slug (no `[1m]`) |
|---|---|---|
| `ANTHROPIC_DEFAULT_SONNET_MODEL` | `claude-sonnet-4-6` | Copilot has no `*-sonnet-4*-1m*` backend; bracketing would either 400 upstream or silently over-account locally. |
| `ANTHROPIC_DEFAULT_HAIKU_MODEL` | `claude-haiku-4-5` | No 1M Haiku exists on EITHER side: cc-backup `context.ts:43-49` `modelSupports1M` lists only `claude-sonnet-4*` and `opus-4-6`. |
| `ANTHROPIC_DEFAULT_OPUS_MODEL` | `claude-opus-4-7` | The active default's `[1m]` decoration lives on `ANTHROPIC_MODEL` (see "1M context opt-in" below) and is cap-aware; the picker row stays bare so users who explicitly switch to "Opus" (non-1M) via `/model` get the 200K behavior. |

Presence-based guards mean each of these is preserved when set in the parent shell — symmetric with the `ANTHROPIC_SMALL_FAST_MODEL` and `CLAUDE_CODE_*` opt-out surfaces.

## 1M context opt-in (`[1m]` literal-bracket suffix)

Claude Code's 1M-context accounting (compaction triggers, status-line `%` indicator, token budgets) is gated by a literal `[1m]` bracket on the model string. cc-backup `src/utils/context.ts:35-40`:

```ts
export function has1mContext(model: string): boolean {
  if (is1mContextDisabled()) return false
  return /\[1m\]/i.test(model)
}
```

When `has1mContext` returns true, `getContextWindowForModel` returns `1_000_000` instead of the default `200_000`. The bracket is preserved through `parseUserSpecifiedModel` (`model.ts:445-506`), so Claude Code sends the bracketed slug verbatim on the wire (`model: "claude-opus-4-7[1m]"`). Copilot doesn't recognize the bracket → 400.

The proxy handles this with two cooperating pieces:

1. **`pickClaudeDefault()` in `src/lib/port.ts`** — Cap-aware. At launch (after `cacheModels()` populates `state.models`), it scans for an `opus-4[.-]7-1m` variant. If present (enterprise tier), it returns `claude-opus-4-7[1m]` so Claude Code unlocks 1M accounting locally. Otherwise it returns the bare `claude-opus-4-7`, preserving the pre-1M behavior. Emits an `info` breadcrumb so users see which mode was picked.

2. **`resolveModel` Step 0 in `src/lib/utils.ts`** — Strips the bracket before any catalog lookup, delegates to the regular cascade, and re-checks the resolution. If it lands on a `-1m` variant (enterprise opus path via family preference), perfect — the bracket and the 1M backend agreed. If it lands on a non-`-1m` variant (Pro+/Business/Max for opus, or any `[1m]` on sonnet/haiku where Copilot has no 1M backend), it logs a `warn` and returns the 200K resolution so the request still succeeds. The bracket **never** reaches Copilot.

Forcing 1M off entirely: `CLAUDE_CODE_DISABLE_1M_CONTEXT=1` is Claude Code's HIPAA-compliance opt-out (cc-backup `context.ts:31`). When set, `has1mContext` always returns false regardless of the bracket; the local context window collapses back to 200K.

Round-trip coverage: `tests/lib-utils.test.ts` (`resolveModel [1m]` and `pickClaudeDefault` describe blocks) pins enterprise/non-enterprise/sonnet/haiku behavior.

