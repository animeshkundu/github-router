# Model defaults + `/model` picker seeds

Governing lens: raise the floor, never nerf. These env vars pick which model the
spawned session runs by default and which rows the `/model` picker offers. The floor
question: are the defaults the strongest available, and does 1M detection track the
live catalog?

## 1. Identity

| Setting | Value injected | Where set | Opt-out |
|---|---|---|---|
| `ANTHROPIC_MODEL` | `chosenSlug` — `claude-opus-5` or `claude-opus-5[1m]` (enterprise, cap-aware) | `src/claude.ts` + `getClaudeCodeEnvVars` | `-m <model>` explicit pin; stripped from parent by `STRIPPED_PARENT_ENV_KEYS` so a shell export can't leak |
| `ANTHROPIC_SMALL_FAST_MODEL` | `claude-sonnet-5` | `getClaudeCodeEnvVars` in `src/lib/server-setup.ts` | set in parent shell (presence-guarded); NOT stripped from parent |
| `ANTHROPIC_DEFAULT_SONNET_MODEL` | `claude-sonnet-5` | tier seeding in `getClaudeCodeEnvVars` | set in parent shell (presence-guarded) |
| `ANTHROPIC_DEFAULT_HAIKU_MODEL` | `claude-sonnet-5` (NOT a Haiku slug) | tier seeding in `getClaudeCodeEnvVars` | set in parent shell (presence-guarded) |
| `ANTHROPIC_DEFAULT_OPUS_MODEL` | `claude-opus-5` (catalog-gated `[1m]`) | tier seeding in `getClaudeCodeEnvVars` | set in parent shell (presence-guarded) |
| `CLAUDE_CODE_AUTO_COMPACT_WINDOW` | catalog-derived decimal integer, every profile | `applyAutoCompactWindow` in `src/lib/server-setup.ts` | parent value wins; omitted when catalog limits are unusable |
| `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` | never set | n/a | deliberately unset; see note below |
| Design doc | `docs/default-models.md` | | |

## 2. What they do + behavior effect

- **`ANTHROPIC_MODEL`** is the active default. It carries the Anthropic-published DASHED
  slug `claude-opus-5`, which is also an exact Copilot catalog-id match because Opus 5
  uses a single-segment slug. Claude Code's `/model` UI recognizes the Anthropic slug,
  while the proxy's `resolveModel` (`src/lib/utils.ts`) strips any `[1m]` bracket before
  the exact catalog lookup (`docs/default-models.md:12-16`).
- **`[1m]` decoration** (`src/lib/port.ts:pickClaudeDefault`) is a LOCAL context-accounting
  unlock — cc-backup `src/utils/context.ts:35-40` matches `/\[1m\]/i` to flip the local
  context window from 200K to 1M (compaction triggers, status-line %, token budgets). It
  is added by **dual-signal detection** against the live catalog: a sibling `opus-<family>-1m`
  slug (how 4.6/4.7 ship) OR the base slug advertising
  `max_context_window_tokens >= 1_000_000` (how Opus 5 ships, no sibling) — `src/lib/port.ts:96-111`.
  The bracket never reaches Copilot (`resolveModel` Step 0 strips it, `docs/default-models.md:57`).
- **`ANTHROPIC_SMALL_FAST_MODEL`** = the tier Claude Code uses for status text,
  auto-compact summaries, session titles, and background ops. Seeded to `claude-sonnet-5`
  (newest Sonnet, and cheaper than Sonnet 4.6 per the live catalog: 200/1000 vs 300/1500
  multipliers), deliberately Sonnet over Haiku for the quality lift on those ops on the
  canonical enterprise deployment (`docs/default-models.md:20`).
- **The three `ANTHROPIC_DEFAULT_{SONNET,HAIKU,OPUS}_MODEL`** knobs seed the `/model`
  picker's tier rows so a user switching model lands on ids the proxy can route. Values
  are catalog-gated and carry at most one `[1m]` suffix when the resolved backend
  advertises 1M; paired `*_MODEL_NAME` values remain bare for readable labels. Fast
  private aliases use the same one-suffix normalization, and the marker is removed
  before Copilot dispatch. The Haiku row is deliberately seeded to `claude-sonnet-5`
  in a standard Opus session to match the small/fast default.
- **Compaction window.** Every profile injects one derived integer window when unset.
  For each reachable `[1m]` candidate (lead, tier/custom rows, and settings-injected
  picker rows), compute `floor(prompt * 0.85) + min(output, 20_000) + 13_000`; export the
  minimum complete expression. Current Luna/Sol rows bind at `816700`; current live
  Opus/Sonnet/Gemini rows individually derive `828600`. `/model` cannot mutate the
  launch env, but Claude Code resolves `Math.min(locallyRecognizedModelWindow, value)`,
  so the minimum remains safe and only slightly conservative after a switch. Native
  subagents inherit it; true 200K models stay about 200K. Grok 4.6 advertises 500K but
  remains bare because the client has no 500K declaration, so it is conservatively
  treated as about 200K and compacts early. The env value MUST be a decimal integer:
  its `parseInt` path turns `"1m"` into `1`, floors to 100,000, and compacts a 1M
  session every ~52K tokens. `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` remains unset.

## 3. Raise-the-floor assessment

**Expands / picks the strongest.** `claude-opus-5` is the flagship; `[1m]` is added
only when the backend can actually serve 1M, so the local accounting matches the wire —
this is "the right amount," not over-claiming. `claude-sonnet-5` for the small/fast and
Sonnet/Haiku tier rows strictly dominates the prior Sonnet-4.6 / Haiku-4.5 defaults on
both recency and price. Every default is the floor-raising choice.

**Is the default the best choice?**

- Opus 5 active default: yes, flagship and natively 1M.
- 1M opt-in: yes, and cap-aware — on a non-enterprise tier with no 1M opus backend the
  detector returns the bare slug, so it never over-accounts. `CLAUDE_CODE_DISABLE_1M_CONTEXT=1`
  is the HIPAA opt-out (`docs/default-models.md:59`).
- Sonnet 5 small/fast: yes; the doc's price argument holds and the Haiku-row-to-Sonnet-5
  substitution is a deliberate, justified floor-raise (cheap tier lands on a better model).

**Drift risk.** This is the one surface where the defaults are HARDCODED string constants
(`DEFAULT_CLAUDE_MODEL = "claude-opus-5"` in `src/lib/port.ts:23`, the Sonnet-5 literals
in `server-setup.ts`). When Copilot ships Opus 4.9 or Sonnet 6, these do NOT auto-advance:

- `ANTHROPIC_MODEL` has a safety net — the implicit-default path walks
  `DEFAULT_CLAUDE_MODEL_FALLBACKS` (`claude-opus-4-8` → `4-7` → `4-6`) if Opus 5 is absent
  from the catalog (`src/claude.ts:410-425`), but there is NO forward walk to a NEWER
  Opus. If Opus 5 is absent and a later family is present, the session drops to 4.8 rather than advancing.
- The Sonnet-5 literals have no fallback chain at all — if `claude-sonnet-5` leaves the
  catalog, the small/fast + tier rows point at a dead id and `resolveModel`'s dated-slug
  retry / family fallback is the only recovery.
- The `[1m]` detection IS live-catalog-driven (dual-signal), so that piece self-heals;
  the base slug choice does not.

## 4. Findings

- **[Important]** `src/lib/port.ts:23` + `src/lib/server-setup.ts:633,660-668` — the
  default model slugs are hardcoded and only fall BACKWARD. When Copilot adds a newer
  Opus/Sonnet, the proxy keeps defaulting to the older pinned slug until someone bumps
  the constant. This is a slow floor-erosion (the default stops being the strongest).
  A "best available in family" forward-walk (mirroring `resolveCodexModel`'s
  "best available `/responses` model" net for codex, `docs/default-models.md:18`) would
  keep the Opus/Sonnet defaults honest against the live catalog. Deferred-acceptable
  (a stale-but-valid default still works), but it is a real drift vector.
- **[Suggestion]** The Sonnet-5 small/fast + tier literals have no fallback chain like
  the Opus default does. If `claude-sonnet-5` is ever pulled, there's no graceful
  named-fallback — worth a short chain for symmetry.

## 5. Verdict

Floor-raising defaults, correctly cap-aware on 1M, and the dashed-slug choice is the
right fix for the UI/routing split. The one real weakness is drift: the base model slugs
are hardcoded and only fall backward, so the "strongest available" property degrades
silently when Copilot ships a newer family. A forward best-available walk would close it.
No nerf.
