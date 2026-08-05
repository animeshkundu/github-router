# Gateway-model cache seed + `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY`

Governing lens: raise the floor, never nerf. This surface makes five non-Claude
Copilot models selectable as `/model` picker rows WITHOUT the hazardous network fetch. The
floor question: does it add capability (native non-Claude models) without degrading the
Claude tiers?

## 1. Identity

| Field | Value |
|---|---|
| Var | `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY` |
| Value injected | `"1"` — CONDITIONALLY (only when a seed landed) |
| Cache file | `<CLAUDE_CONFIG_DIR>/cache/gateway-models.json` (atomic temp+rename) |
| Where set | `src/lib/server-setup.ts:1045-1056` (select, seed, enable, or clear) + `seedGatewayModelCache` `:731-761` |
| Seeded models | `nativeSelectableModelsInCatalog()` — the catalog-present subset of `gpt-5.6-sol`, `gpt-5.5`, `gpt-5.3-codex`, `gemini-3.5-flash`, `gemini-3.1-pro-preview` (`:650-690`) |
| Context accounting | `withOneMSuffix()` decorates the cache `id`, not `display_name`, only when the exact live catalog entry advertises at least 1M context and `CLAUDE_CODE_DISABLE_1M_CONTEXT` is unset. Thus gpt-5.6-sol, gpt-5.5, and both Gemini rows receive `[1m]`; 400k gpt-5.3-codex stays bare. |
| Guard | presence-based, checks BOTH parent env AND in-function `vars` (`:1047-1053`) |
| Opt-out | set `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY` in the parent shell (a user value always wins) |
| Design docs | `docs/claude-env-injection.md:31-70`, `docs/anthropic-translation-shim.md` (Phase 3) |

## 2. What it does + behavior effect

Gateway model discovery has two code paths with asymmetric hazard
(`docs/claude-env-injection.md:37-51`):

- The **network-FETCH path** would discover Copilot's DOTTED `claude-*` slugs
  (`claude-opus-4.6-1m`) which don't match Anthropic's DASHED registry (`claude-opus-4-6`),
  silently degrading advanced tool use to lowest-common-denominator fallback. This path is
  **permanently inert**: it bails when nonessential traffic is disabled, and the proxy
  ALWAYS sets `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` (and it never reads the synthetic
  OAuth credential). It cannot run, discover, or overwrite anything.
- The **cache-READ path** applies NO id filter (the `/^(claude|anthropic)/i` filter lives
  only on the fetch path). So a pre-seeded cache can carry the real non-Claude Copilot ids,
  and the picker builder APPENDS them as rows, leaving the opus/sonnet/haiku tier rows
  untouched (`src/lib/server-setup.ts:693-729`).

Phase 3 of the translation shim exploits exactly that asymmetry: pre-seed the cache with the
catalog-present non-Claude ids, then flip discovery on — but ONLY when the seed actually
landed AND the key is unset in both parent env and `vars`. When no target model is in the
catalog, any prior seed is cleared so a user-pinned flag can't surface stale rows
(`:1055-1056`). Selecting a seeded row sends the real Copilot id, which `resolveModel`
exact-matches and the `/v1/messages` shim routes to `/responses` (gpt) or `/chat/completions`
(gemini). Explicit `-m <id>` also routes through the shim regardless of the picker.

## 3. Raise-the-floor assessment

**Expands capability.** It adds gpt-5.5 / gpt-5.3-codex / gemini rows to the `/model` picker
so the user can run the main agent loop on a non-Claude model by selection instead of only
by CLI flag. Pure addition — the Claude tiers are structurally untouched (the cache-read
path appends, and the seed contains ONLY the five non-Claude ids).

**Is the default the best choice?** Yes, and the conditional enable is the subtle-but-correct
part. Discovery is turned on ONLY when there is something to show (a seed landed). This avoids
enabling a feature with an empty result, and it means lesser tiers (where none of the four are
in the catalog) see the unchanged picker with discovery off. The both-sides presence guard
(parent env AND `vars`) is defensive against a future refactor setting the key earlier.

**Non-regression is structural, not probabilistic** (`src/lib/server-setup.ts:1020-1035`): the
one path that could degrade tier capability mapping (the network fetch of dotted `claude-*`
slugs) is permanently blocked by `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`, and the seed
contains only non-Claude models. This is a genuine "raise the floor without nerfing" —
the capability that would nerf the Claude tiers is the fetch, and it can't run.

**Drift risk.** Meaningfully higher than the other surfaces because it couples to Claude Code's
INTERNAL cache path AND schema (`cache/gateway-models.json`, `{baseUrl, fetchedAt, models:[{id,
display_name?}]}`), verified against build 2.1.201 (`src/lib/server-setup.ts:693-729`). If a future build changes the
path or schema, the read silently ignores the seed and the rows just don't appear — graceful
degradation, and the models still run via explicit `-m` selection through the shim. The
`baseUrl` must equal the `ANTHROPIC_BASE_URL` Claude Code sees or the cache is discarded, which
is guaranteed by construction (same `serverUrl`, same `configDir`).

## 4. Findings

- **[Suggestion]** `src/lib/server-setup.ts:693-729` — the seed is coupled to Claude Code's
  internal cache path + schema (build 2.1.201). Higher drift surface than the pure-env
  injections. Mitigated by graceful degradation (rows vanish, explicit `-m` still works) and
  the design is honest about it, but this is the injection most likely to silently stop
  working on a Claude Code upgrade. A launch-time debug note when the seed lands but no rows
  are expected to appear would aid diagnosis; not blocking.
- **[Suggestion]** The `NATIVE_NON_CLAUDE_MODELS` list (`src/lib/server-setup.ts:650-659`) is hardcoded. A newer
  non-Claude Copilot model (e.g. a future gpt-5.6) won't appear as a picker row until the list
  is extended — same forward-drift class as the model-default constants, but lower stakes
  (these are convenience picker rows, not the active default).
- No Critical/Important findings. The non-regression argument is structural and sound; the
  clear-on-empty branch closes the pinned-port + catalog-change seam.

## 5. Verdict

Floor-raising and carefully non-nerfing: it adds native non-Claude model rows while the only
path that could degrade the Claude tiers (the network fetch) is permanently blocked, and the
seed carries only the five non-Claude ids. Conditional enable + clear-on-empty + both-sides
presence guard are all correct. The one real risk is coupling to Claude Code's internal cache
schema, which degrades gracefully. No nerf.
