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
