# Curated model picker and gateway-cache migration

Governing lens: raise the floor, never nerf. This surface makes non-Claude
Copilot models selectable as `/model` rows while preserving the built-in Claude
lineup and a user's own curated picker.

The filename is retained for link stability. The gateway-cache seed described by
earlier revisions is retired.

## 1. Identity

| Field | Value |
|---|---|
| Setting | `modelPicker` in the per-launch mirror's `settings.json` |
| Shape | `{options: [{model, label}], replaceBuiltInOptions: false}` |
| Where written | `src/lib/model-picker-settings.ts`, called by `src/claude.ts` and `src/lib/serve/enhancements.ts` |
| Standard/Fast rows | Catalog-present subset of Sol, Luna, Gemini 3.8 Flash, Grok 4.6 |
| Max rows | Catalog-present subset of Sol, Luna, Gemini 3.8 Flash, Opus 5 |
| Context accounting | `[1m]` on `model`, never `label`, only when the exact live entry advertises at least 1M and the user has not set `CLAUDE_CODE_DISABLE_1M_CONTEXT`; Grok remains bare |
| User override | Any existing root `modelPicker` value in mirrored user settings wins wholesale |
| Discovery env | The router does not set `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY` |
| Design docs | `docs/claude-env-injection.md`, `docs/anthropic-translation-shim.md` Phase 3 |

## 2. Why the cache design was retired

Claude Code 2.1.258 changed gateway discovery to run even when
`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`. Version 2.1.260 requests
`GET /v1/models?limit=1000`, filters the response to ids matching
`/(claude|anthropic)/i`, and replaces `cache/gateway-models.json` when that
filtered list differs. A router-written seed containing Sol, Luna, Gemini, or
Grok is therefore overwritten after startup.

The defect class is a producer-controlled cache assumed authoritative after a
newer consumer gained an enabled refresh path that filters and replaces it. The
fix removes ownership of the cache rather than racing the client or inventing
fake `claude-*` aliases in `/v1/models`.

## 3. Current behavior

After `ensureClaudeConfigMirror()` snapshots the user's configuration and before
the child starts, the router adds an additive picker to the isolated mirror. The
write never reaches the user's real settings. It preserves unrelated settings,
uses a same-directory temporary file with mode `0o600`, renames atomically, and
retries transient Windows `EPERM`/`EBUSY`/`EACCES` contention. Invalid JSON or a
non-object settings file is never clobbered.

`replaceBuiltInOptions: false` retains Claude Code's built-in rows. Claude Code
2.1.260 does not offer an unknown model-catalog row until `behavesAs` maps it to
a model the client knows. Sol/Luna map to `claude-opus-5`; Gemini/Grok map to
`claude-sonnet-5`. These are client-side prompt/capability and effort profiles,
not wire aliases: the row label and selected model id stay unchanged, and the
proxy's request preprocessor enforces actual upstream effort. `[1m]` remains the
explicit context-accounting signal and is stripped before catalog resolution.

The user-preservation rule is intentionally whole-object, not a row merge.
Claude Code takes the highest-precedence settings source that defines
`modelPicker`; it does not merge picker objects across sources. Rewriting a
user's options or `replaceBuiltInOptions` choice would silently discard their
curation. The effective user row ids are still returned to env construction, so
catalog-known `[1m]` rows participate in the launch-global compaction minimum.

`github-router claude` injects the picker even under `--no-codex-mcp`.
`github-router serve` injects the Standard lineup before CloudCLI starts and
rejects the `fast`/`max` profile aliases rather than combining their lead model
with a mismatched Standard roster/ACL. An explicit model id remains valid while
retaining the Standard serve surface. `start --cc` remains env-only because it
does not own a per-launch mirror; use an explicit `-m <id>` with that generated
command.

## 4. Raw catalog boundary

`/models` and `/v1/models` remain raw, profile-independent Copilot catalog views.
They do not add router aliases or `[1m]` ids and do not inspect launch identity.
A regression test reproduces the 2.1.260 client filter to keep the retired-cache
failure mode visible.

## 5. Raise-the-floor assessment

The setting expands selection without replacing built-ins. Live catalog gating
prevents dead rows on lower tiers, profile-specific inventories prevent Max from
advertising a lead its ACL rejects, and explicit `-m` remains the fallback if a
settings write fails. Existing user curation always wins. The installed-client
canary checks that `modelPicker`, `replaceBuiltInOptions`, and `behavesAs` remain
present in the current client schema.

No Critical or Important findings remain in this surface.
