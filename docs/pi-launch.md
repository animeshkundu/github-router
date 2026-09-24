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

## Usage

```bash
github-router pi -m cheapest --search --browse
github-router pi -m balanced -- --print "review this diff"
```

Everything after `--` is forwarded verbatim to `pi`; other Pi flags
(`--print`, `--mode`, `--session`, …) flow through automatically.
`--search` provisions the ColBERT semantic index (the `code_search`
tool is absent without it); `--browse` enables the browser tool
surface when a supported browser is installed.

## How it cooperates with Pi

- **Compatible endpoint, not a provider hack.** The launcher writes a
  `gh-router` provider into the mirror's `models.json`
  (`api: openai-completions`, `baseUrl: <proxy>/v1`) — the documented
  Ollama/vLLM pattern. No `registerProvider` override.
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

## Files

- `src/pi.ts` — launcher (TTY or `--print`/`--mode` headless).
- `src/lib/pi-models-settings.ts` — pure builders (models/settings,
  agents, APPEND_SYSTEM digest, compaction derivation). Unit-tested in
  `tests/pi-models-settings.test.ts`.
- `src/lib/pi-extension.ts` — extension source + skills + prompts.
- `src/lib/pi-paths.ts` — mirror lifecycle.
- `src/lib/pi-version-check.ts` — install/update gate.

## Verification

```bash
bun test tests/pi-models-settings.test.ts
bun run typecheck && bun run lint:all && bun run build
```

Spike note: Pi 0.87.1 (latest at time of writing) vs the vendored
worker runtime pin v0.82.0 — the launcher uses the installed Pi and is
independent of the vendor tree.
