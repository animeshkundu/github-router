# Pi launch (`github-router pi`)

Launches the [Pi coding agent](https://pi.dev) against the proxy with a
fixed, cost-controlled profile. Only two `-m` aliases are supported:

| Profile | Lead | Roster | Consultants |
|---|---|---|---|
| `cheapest` | `gpt-6-luna` / max, 200K bare | Explore (Luna/high), General-Purpose (Luna/max), reviewer (Sol/high); no Plan | Sol/medium Advisor (plan review), Sol/high Oracle |
| `balanced` | `gpt-6-sol` / medium, 200K bare | Explore (Luna/high), General-Purpose (Luna/max), reviewer (Sol/high, may delegate Explore); no Plan | Grok/medium Oracle only — **advisor-free by design** |

Every role runs at the bare 200K default window (no `[1m]` accounting
anywhere) — that is the whole cost lever, same as the Claude
`cheap`/`cheapest`/`balanced` family.

Roster notes: our `reviewer`/`oracle` agent files intentionally shadow the
same-named pi-subagents builtins (pinned models); builtin
`scout`/`worker`/`researcher`/`evidence-auditor` are disabled via settings
(their habitual invocations resolve through our `scout`/`worker` aliases),
while builtin `delegate` stays enabled as the cheap append-mode path.
`General-Purpose` may nest `reviewer`/`oracle`, balanced `reviewer` may nest
`Explore` (2-level guard); `Explore` records `context.md` for the
`General-Purpose` handoff. `/parallel-review` intentionally shadows the
packaged prompt of the same name.

## Usage

```bash
github-router pi -m cheapest --search --browse
github-router pi -m balanced -- --print "review this diff"
```

Everything after `--` is forwarded verbatim to `pi`; other Pi flags
(`--print`, `--mode`, `--session`, …) flow through automatically.

## Flag policy (mirrors the Claude launcher's house rules)

A bare launch advertises no skills or prompts — only what Pi ships
plus the mode identity. Each surface rides a flag:

| Flag | Default | Surface |
|---|---|---|
| `--peers` / `--no-peers` | **on** | Native agent files, oracle tool (+cheapest advisor), `gh-oracle` skill, `pi-subagents` package (**extensions only** — its skills/prompts are filtered out so they never reach Ctrl+O). `--no-peers` drops all of it (plus the server-side allow-list) and validates the lead model only. |
| `--swe` | off | Pipeline surface: `gh-delegate` (+cheapest `gh-advisor`) skills, `review` / `parallel-review` (+cheapest `plan-review`) prompts |
| `--search` | off | ColBERT provision + `code_search` tool + `gh-search-first` skill (tool and prose appear together or not at all) |
| `--browse` | off | Browser tool surface when a supported browser is installed |
| `--bluebird` | off | No Pi-side surface; reaches Bluebird server-side through `/mcp/search/code` |
| `--memory-bridge` / `--no-memory-bridge` | **on** | Copilot (`.github/copilot-instructions.md`, `.github/instructions/*.instructions.md` `applyTo`) + Claude (`.claude/rules/`, `.claude/CLAUDE.md`, `~/.claude/CLAUDE.md`, `~/.copilot/copilot-instructions.md`) bridge. Static repo-wide slice synthesizes into the mirror `AGENTS.md` (Pi-native candidate, 24KB budget, secrets-redacted, fenced idempotent); path-scoped rules lazy-attach on matching `read/edit/write` (once/session). Auto-memory (`~/.claude/projects/<slug>/memory/MEMORY.md`, 200-line/25KB) is on-demand via `/memory` only, never auto-injected. Honors `GH_ROUTER_PI_BRIDGE=0` / `GH_ROUTER_DISABLE_PI_BRIDGE=1` and Pi's own `--no-context-files`/`-nc` passthrough. `--no-memory-bridge` = Pi-native `AGENTS.md`/`CLAUDE.md` discovery only. |

Always injected regardless of flags (like Claude's operating
defaults): `models.json` (routing is load-bearing), minimal
`settings.json`, `APPEND_SYSTEM.md` digest, statusline footer (built into
the `gh-router-pi` extension — no third-party package; opt out with
`GH_ROUTER_DISABLE_AIC_STATUSLINE=1`), toolbelt PATH (opt out with
`GH_ROUTER_DISABLE_TOOLBELT=1`), launch binding. The user's own
`~/.pi/agent` snapshot is their Pi default, never gated.

Deliberate divergence: pinned Claude profiles refuse `--no-codex-mcp`;
Pi allows `--no-peers`. Do not "fix" this back into parity.

## How it cooperates with Pi

- **Right wire endpoint, not a provider hack.** The launcher writes a
  `gh-router` provider into the mirror's `models.json` with
  `api: openai-responses` (per-model `api` override supported for a
  future chat-served model), `baseUrl: <proxy>/v1`, and `authHeader`
  for the dummy bearer — Pi POSTs `/v1/responses`, the Codex-proven
  path. Every roster model is Responses-only on Copilot; sending them
  to `/v1/chat/completions` is an upstream 400 (observed live). Each
  row also carries `maxTokens` (catalog output cap, ≥16 floor the
  proxy enforces), `cost` (USD/1M from live billing), and its
  cheap-tier `contextWindow`. No `registerProvider` override, no
  proxy-side translation. Two Pi quirks discovered live and pinned by
  tests: tool schemas must be TypeBox `parameters` (plain-JSON
  `inputSchema` fails the load), `execute` is
  `(toolCallId, params, signal)` returning `{content, details}` — and
  a **partial** `cost` object silently rejects the entire provider as
  `Unknown provider`, so `cost` is all-four-figures-or-absent
  (`piUsdCostFor`), never a guessed zero.
- **Isolated mirror.** The user's `~/.pi/agent` is snapshot-copied to a
  per-launch dir (`PI_CODING_AGENT_DIR` → mirror); `auth.json` and
  `sessions/` are never copied. The mirror is swept on shutdown (plus a
  boot sweep of dead-PID mirrors).
- **Subagents via `pi-subagents` + our agents.** The `gh-router-pi`
  extension registers executable seams only (`oracle`, cheapest-only
  `advisor`, `code_search`, `browser_*`), each POSTing JSON-RPC
  `tools/call` to the proxy's `/mcp` with the per-launch nonce. Rover
  guidance lives in skills (`gh-oracle`, `gh-search-first`,
  `gh-delegate`, cheapest-only `gh-advisor`) and `/review`,
  `/parallel-review` (+ cheapest-only `/plan-review`) prompts.
- **Native compaction stays authoritative.** `contextWindow: 200000`
  per model row; `compaction.reserveTokens` is derived per launch from
  live catalog `max_prompt_tokens` ceilings
  (`derivePiCompactionSettings` in `src/lib/pi-models-settings.ts`:
  reserve = 200K − min(floor(prompt × 0.85)), clamped to
  [16384, 100000]) so Pi's own trigger lands below Copilot's ceiling —
  the Pi-native analogue of `CLAUDE_CODE_AUTO_COMPACT_WINDOW`. The
  extension's `session_before_compact` handler observes only and always
  falls back to native.
- **Pi lifecycle respected.** Version floor Pi ≥ 0.80.10 / Node ≥ 22.19
  (`src/lib/pi-version-check.ts`, throttled hourly auto-install).
  Parent env is stripped of Pi routing keys (`PI_CODING_AGENT_DIR`,
  …) so a stale shell export can't re-route the session off the proxy.

## Tier-priced context windows

Copilot bills OpenAI/xAI models in two tiers keyed on per-request input
tokens. Each Pi model row carries its cheap-tier window, so Long-tier
(2x) pricing is structurally unreachable:

| Model | Default (cheap) tier | `contextWindow` |
|---|---|---|
| `gpt-6-luna` | ≤ 272K ($0.10/1M in) | 272000 |
| `gpt-6-sol` | ≤ 272K ($2.00/1M in) | 272000 |
| `grok-4.6` | ≤ 200K ($2.00/1M in) | 200000 |
| anything else | — | 200000 (fallback) |

Pinned in `src/lib/pi-tier-windows.ts` (sourced to the billing doc;
the live catalog carries no tier data). Compaction reserves derive per
model (`reserve = window − floor(min(prompt, window) × 0.85)`), so the
trigger sits below both the price cliff and Copilot's ceiling.
`warnOnTierPriceDriftForModels` warns loudly when live catalog prices
disagree with the table. Refresh the table when the billing doc changes.

## Statusline

Pi's footer shows `[AIC x.xx]` (this session's AI-credit total) plus
the discounted actual (`~$`), rendered by the **same
`internal-aic-status` runner** `github-router claude` drives — one
renderer, identical segments (`src/lib/default-statusline.ts`).

How it works: the mode's own `gh-router-pi` extension owns Pi's footer
(`ctx.ui.setFooter`, refreshed on `session_start`/`turn_end`/
`model_select`/`session_compact`/`session_tree`, 300 ms debounce) and
spawns the runner with a natively-built Claude-shaped payload
(`src/lib/pi-statusline.ts`): context % from Pi's authoritative
`getContextUsage()`, cumulative in/out tokens summed over the session
branch, wall-clock duration from session start (transcript-span
fallback), line counts from edit tool-result details, model + cwd
directly. The command travels via `GH_ROUTER_AIC_STATUS_COMMAND` env
(alongside `GH_ROUTER_AIC_LEDGER`); the last footer width is fed back as
`COLUMNS` so narrow terminals drop segments right-to-left with AIC
pinned, plus an ANSI-aware truncation backstop. Statuses published by
other extensions via `setStatus` render as extra footer rows so replacing
the footer never silently drops them.

Deliberate divergences from the Claude path:

- No third-party statusline package and no `statusLine` settings block.
  The community `pi-statusline` bridge only reads the user's real
  global/project settings and never sees the launch mirror behind
  `PI_CODING_AGENT_DIR`, so a mirror-injected block would be dead
  config — verified live against v0.0.2 (its payload also hardcodes
  line counts to null and derives context % from the latest turn only).
- Router-wins by architecture: the footer is extension-owned, so a
  user's own statusline command is never executed (pinned Claude
  profiles behave the same via `routerWins`).
- Ledger taps are proxy-side, so Pi traffic accumulates automatically.

Opt out with `GH_ROUTER_DISABLE_AIC_STATUSLINE=1`. Fail-open: a broken
runner degrades to Pi's native footer, never a broken launch.

## Files

- `src/pi.ts` — launcher (TTY or `--print`/`--mode` headless).
- `src/lib/pi-models-settings.ts` — pure builders (models/settings,
  agents, APPEND_SYSTEM digest, compaction derivation). Unit-tested in
  `tests/pi-models-settings.test.ts`.
- `src/lib/pi-tier-windows.ts` — pinned tier thresholds, window
  derivation, price-drift guard. Unit-tested in
  `tests/pi-tier-windows.test.ts`.
- `src/lib/pi-extension.ts` — extension source + skills + prompts + bridge lazy-attach (`tool_result`) + `/memory` + `/context`.
- `src/lib/pi-memory-bridge.ts` — pure bridge builders (frontmatter scope, glob match, `@` imports, caps, redaction, mirror synthesis). Unit-tested in `tests/pi-memory-bridge.test.ts`.
- `src/lib/pi-paths.ts` — mirror lifecycle.
- `src/lib/pi-version-check.ts` — install/update gate.

## Claude-Code look (recipe, not bundled)

Bare launches stay minimal per flag policy, and the `gh-router-pi` footer is router-owned (third-party footers lose). For a familiar look, install yourself — the `~/.pi/agent` snapshot carries it into the mirror automatically:

```bash
pi install npm:pi-code            # Claude behavior: todos, /rewind, /memory, subagents, /context, /init
pi install npm:pi-claude-code-ui  # Claude transcript: grouped rows, Shiki diffs, Ctrl+O previews
```

Alternatives: `@owlburtoe/pi-claudify` (closest `⏺`/`⎿` grammar), `cc-my-pi` (header + spinner + dark theme), `better-claude-code-ui` (6 themes + footer). Themes: `pi.dev/packages?type=theme`, `pi --theme <file>`, `/settings`.

## Verification

```bash
bun test tests/pi-memory-bridge.test.ts tests/pi-models-settings.test.ts
bun run typecheck && bun run lint:all && bun run build
```

Spike note: Pi 0.87.1 (latest at time of writing) vs the vendored
worker runtime pin v0.82.0 — the launcher uses the installed Pi and is
independent of the vendor tree.
