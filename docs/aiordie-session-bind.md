# ai-or-die session-bind handshake

When github-router's `claude` subcommand runs inside an [ai-or-die](https://github.com/)
Terminal tab, it emits the active Claude Code session id + transcript path to a per-tab
"sidecar" file so ai-or-die's sticky-note feature can bind each browser tab to exactly the
transcript its own claude wrote — surviving in-session `/resume`, `/clear`, `/compact`, and
exit→relaunch. Without this, ai-or-die can only guess via newest-mtime over the project dir,
which misattributes when multiple tabs share a working directory.

## Contract

- **`AIORDIE_CLAUDE_BIND`** (env, set by ai-or-die on the Terminal shell): absolute path to a
  per-tab sidecar file ai-or-die owns and watches. When present and non-empty, github-router
  registers the bind hook; otherwise it does nothing (standalone behavior unchanged). The var
  is stripped from the env passed to claude (`sanitizeParentEnv`), so a nested
  `github-router claude` can't inherit it and hijack the parent tab.
- **Sidecar JSON** (written atomically, temp + rename):
  `{ "schema": 1, "claudeSessionId": "<uuid>", "transcriptPath": "<realpath>",
     "cwd": "<cwd>", "event": "start"|"end", "source": "startup|resume|clear|compact",
     "reason": "<SessionEnd reason>", "at": <epoch ms> }`.
  `source` is present on `start`; `reason` on `end`. `transcriptPath` is realpath-resolved to
  the real `~/.claude/projects/...` (through the per-launch mirror's SHARED `projects`
  junction) so it stays valid after the mirror is swept on shutdown.

## Implementation

- `src/internal-session-bind.ts` — the `internal-session-bind` subcommand. Claude Code's
  `SessionStart`/`SessionEnd` hooks invoke it (`--out <sidecar>`); it reads the hook payload
  on stdin and writes the sidecar. Side-effect only (no stdout — a SessionStart hook's stdout
  is injected into the model's context), never throws. **Skips** subagent/teammate payloads
  (`agent_id`/`agent_type`) so only the top-level session drives the binding.
- `src/claude.ts` — registers the hook for `SessionStart` and `SessionEnd` via
  `injectStopHookIntoSettingsFile` into the per-launch `<CLAUDE_CONFIG_DIR>/settings.json`
  (idempotent merge; never clobbers user hooks), gated on `AIORDIE_CLAUDE_BIND`. The sidecar
  path is baked into the hook command (`buildSessionBindHookCommand`), not passed via env, so
  it survives the env-strip.
- `src/lib/launch.ts` — `AIORDIE_CLAUDE_BIND` is in `STRIPPED_PARENT_ENV_KEYS`.

The consumer side lives in ai-or-die (`docs/adrs/0026-…`, `docs/specs/sticky-notes.md`).
