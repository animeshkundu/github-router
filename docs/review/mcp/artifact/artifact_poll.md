# Review: `mcp__peers__artifact_poll`

> Per-tool audit of the model-facing surface github-router auto-injects. One doc per injected MCP tool.
> Reviewer: meta subagent. Fill every section. Cite `file:line`. Verify claims against code, do not assert.

## 1. Identity

| Field | Value |
|---|---|
| MCP path | `mcp__peers__artifact_poll` |
| Group / server | `peers` (serverInfo `github-router-peers`) |
| Wire tool name | `artifact_poll` |
| Definition | `src/lib/artifact/tools.ts:185` (factory `tool()` at `:31`, registered in `ARTIFACT_TOOLS` frozen array `:53`) |
| Always-on? | gated by `artifactToolsEnabled()` (ai-or-die tab env trio) |
| Capability gate | `"artifact"` → `artifactToolsEnabled()` (`src/lib/mcp-capabilities.ts:212`); list-time filter `src/routes/mcp/handler.ts:343`, call-time reject `:985` |
| Backing model / endpoint | server-side fn (ai-or-die HTTP relay via `ArtifactClient.poll`; no LLM) |
| Write-capable | no (read/drain only) |

Group note (the flag the brief asked to confirm): `ARTIFACT_GROUP: McpGroup = "peers"` at `src/lib/artifact/tools.ts:13`, and `GROUP_META.peers` is `{ preferredKey: "peers", serverInfoName: "github-router-peers" }` at `src/lib/peer-mcp-personas.ts:112`. The `ARTIFACT_PANEL_DIRECTIVE` hardcodes `mcp__peers__artifact_*` (`src/lib/claude-md-injection.ts:50-53`). **These agree — there is NO prefix mismatch.** The artifact tools genuinely live under the `peers` server, so the hardcoded `mcp__peers__` prefix in the directive is correct, not a bug. (Worth a design note: co-locating human-review tools with the peer *critic* tools under one `peers` server is a category blur, but it is internally consistent, so not a finding here.)

## 2. Injected surfaces (verbatim)

### 2a. Tool `description` (shown in `tools/list`)

Description string (`src/lib/artifact/tools.ts:187`):

> FROZEN legacy alias for artifact_await (old payload, human comments only, no structured actions). New agents should call artifact_await instead. Only works inside an ai-or-die tab-backed Claude session.

Input schema (`:188-190`, `objectSchema({...}, [])` — no required fields):

- `timeoutMs` (number) — "Optional per-call budget hint in ms (advisory)."

Output (server-side, not in `tools/list` but part of the model-facing contract; `formatPollResponse` at `:288`): `status`, `prompts`, `layout_warnings`, `dom_snapshot`, `next_step`. The `next_step` on a waiting poll is `"No human feedback is ready yet. Call artifact_poll again."` (`:266`, `:337`), and on ready feedback `"Apply the human Artifact review feedback, then call artifact_reply with a concise summary."` (`:337`).

### 2b. System prompt (`--append-system-prompt`)

**Not named in `buildPeerAwarenessSnippet`.** That builder (`src/lib/peer-mcp-personas.ts:555-646`) enumerates the `peers` critics (`codex_critic`, `codex_reviewer`, `gemini_*`, `opus_critic`) and the `search` / `workers` / `orchestrate` / `decide` / `browser` tools, but names **no** artifact tool at all — neither `artifact_poll` nor `artifact_await`, and not even the group in an artifact sense. This is correct by design: the awareness snippet is capability inventory for the always-available/critic surface, whereas the artifact tools are tab-scoped and are steered by a separate injection.

The artifact surface reaches the system prompt only via the **`ARTIFACT_PANEL_DIRECTIVE`**, prepended to the mirrored CLAUDE.md (`src/claude.ts:811`, gated on the ai-or-die tab). Its one clause on this tool (`src/lib/claude-md-injection.ts:53`), verbatim:

> `mcp__peers__artifact_poll` is a frozen legacy alias (comments only).

That directive is NOT pushed through `--append-system-prompt` (only `OPERATING_DEFAULTS_DIRECTIVE` + the peer-awareness snippet ride that arg — `src/claude.ts:1084-1088`); it is a CLAUDE.md-only injection. So the sole model-facing mention of `artifact_poll` outside its own `description` is this one CLAUDE.md sentence plus the `gh-artifact-review` skill.

### 2c. CLAUDE.md (mirrored `<CLAUDE_CONFIG_DIR>/CLAUDE.md`)

Covering block: **artifact-panel directive** (`ARTIFACT_MARKER_OPEN`/`_CLOSE` fence, `src/lib/claude-md-injection.ts:36-38`, prepended at `:731`). Relevant sentence (`:53`):

> `artifact_await` returns typed events: `comment` … and `action` …. Use `mcp__peers__artifact_update`/`artifact_refresh` … and `mcp__peers__artifact_dismiss` …. `mcp__peers__artifact_poll` is a frozen legacy alias (comments only).

The injected `gh-artifact-review` skill also carries a dedicated "frozen legacy" note (`src/lib/injected-skills/artifact-review-skill.ts:51-53`):

> ### `artifact_poll` (frozen legacy)
> `mcp__peers__artifact_poll` still resolves for back-compat but returns the OLD payload (human comments only, no structured actions). Prefer `artifact_await`.

**Checked-in repo root `CLAUDE.md`**: no artifact directive — a grep for `artifact_poll` / `mcp__peers__artifact` returns no matches. The directive is injected-only, so there is nothing in the repo root to drift against. (The global user-scope CLAUDE.md supplied as session context contains the same directive text; that is the injected copy surfaced back, not a second source of truth.)

All three code sources — description, CLAUDE.md directive, skill — agree: frozen alias, comments-only, prefer `artifact_await`.

## 3. Assessment

### 3a. Description quality

- **Clarity & routing signal**: Excellent for a deprecated tool. The first word `FROZEN` and the explicit `New agents should call artifact_await instead` give a clean when-NOT-to-use signal; the `(old payload, human comments only, no structured actions)` states exactly the capability delta versus the successor. A fresh agent reading only `tools/list` is correctly steered away.
- **Accuracy vs implementation**: Accurate. It truly returns the old poll payload (`ArtifactPollResponse` via `client.poll`, `:194`, shaped by `formatPollResponse` `:288`) with no `events`/`cursor` typed-drain fields (those exist only in `artifact_await`, `:122-135`). "comments only, no structured actions" matches — the poll path has no `action`/`comment` `kind` discrimination that `artifact_await` has (`awaitNextStep` `:316-332`). The "Only works inside an ai-or-die tab-backed Claude session" clause matches the `artifactToolsEnabled()` gate and the `missingEnvResult()` fallback (`:411`).
- **Schema minimality**: Compliant. One optional field, `timeoutMs`, described as "advisory". It IS honored — `pollUntilReady` clamps it internally (`:254-257`) — so it is model-tunable, not a diagnostic echo. No `additionalProperties`, `required: []`. Nothing to cut in the schema itself.

### 3b. System-prompt coverage

- **Named or omitted?** Omitted from `buildPeerAwarenessSnippet` — by design (that snippet is the critic/always-on inventory, not the tab-scoped artifact surface). Not a gap.
- **Accurate & non-redundant**: The one artifact-panel-directive sentence that names it is accurate and terse. It does not restate the description; it just flags the alias as legacy inside the workflow paragraph, which is the right altitude.
- **Framing-constraint compliance**: The directive is prose steer, not a persona `baseInstructions`, so the "no imperatives / no anchors" persona rules (pinned by `tests/peer-mcp-personas.test.ts`) do not apply to it. The clause is a plain factual statement ("is a frozen legacy alias"), no imperative disguised as description.

### 3c. CLAUDE.md coverage

- **Accurate, non-drifted**: Yes — the CLAUDE.md directive, the skill's "frozen legacy" section, and the tool's own `description` all say the same three things (frozen, comments-only, prefer `artifact_await`). Triple-consistent.
- **Injected vs checked-in root**: The root repo `CLAUDE.md` intentionally omits the artifact directive (tab-scoped), so there is no injected-vs-checked-in contradiction to reconcile.

### 3d. Cross-surface consistency

Fully consistent across `description` ↔ CLAUDE.md directive ↔ `gh-artifact-review` skill ↔ code behavior. Group prefix `mcp__peers__` is correct on every surface. No stale model id (there is no model), no wrong default, no gate mismatch.

## 4. Findings

- **[Suggestion]** `src/lib/artifact/tools.ts:266,337` — the poll `next_step` tells the model to "Call `artifact_poll` again." For a tool the same session's description flags as FROZEN and superseded, the self-referential retry instruction gently re-anchors the model on the deprecated tool instead of nudging it toward `artifact_await`. Fix: change the waiting `next_step` to steer forward, e.g. "No human feedback is ready yet. Prefer `artifact_await` (typed drain); if continuing on the legacy path, call `artifact_poll` again." Non-blocking — a caller already on `artifact_poll` is a legacy/BYO client, and the description already carries the primary steer.

- **[Suggestion]** Surface-minimality of keeping the deprecated alias listed at all. `artifact_poll` still occupies a `tools/list` slot next to `artifact_await` whenever the artifact gate is on (`ARTIFACT_TOOLS` unconditionally includes it, `:185`). This is defensible: it exists for **back-compat with BYO/older clients** that only speak the poll payload (the skill says it "still resolves for back-compat", `artifact-review-skill.ts:53`), and its `description` does the one thing a well-behaved deprecated alias must do — actively route new agents to the successor. The cost is ~35 tokens of always-present list surface inside an already tab-scoped, rarely-broad context. Verdict: **justified to keep, and the description steers correctly.** Only revisit (drop the alias, or hide it behind an opt-in env) once telemetry shows no client depends on the poll payload. No change required now.

- **[Suggestion]** `docs/copilot-compat-matrix.md` / probe coverage — the artifact tools relay to ai-or-die (not Copilot), so the compat-probe rule does not apply; noted only to preempt a false "missing probe" flag on a later sweep. No action.

No Critical (prefix matches — the brief's escalation condition does not trigger) and no Important findings.

## 5. Verdict

**Y.** The injected surface for `artifact_poll` is correct, group-consistent (`mcp__peers__` matches the real `peers` server everywhere), minimal, and well-routed: the `description`, CLAUDE.md directive, and skill all mark it FROZEN and point new agents to `artifact_await`. Single most useful (non-blocking) fix: make the poll `next_step` steer forward to `artifact_await` instead of re-suggesting `artifact_poll`, so the tool's own runtime output stops re-anchoring the model on the deprecated path.
