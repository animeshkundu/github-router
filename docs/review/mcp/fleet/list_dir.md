# Review: `mcp__fleet__list_dir`

> Per-tool audit of the model-facing surface github-router auto-injects. One doc per injected MCP tool.
> Reviewer: meta subagent. Fill every section. Cite `file:line`. Verify claims against code, do not assert.

## 1. Identity

| Field | Value |
|---|---|
| MCP path | `mcp__fleet__list_dir` |
| Group / server | `fleet` (serverInfo `github-router-fleet`) |
| Wire tool name | `list_dir` |
| Definition | `src/lib/fleet/tools.ts:734` (via the `tool()` factory at `src/lib/fleet/tools.ts:283`) |
| Always-on? | gated by `fleet` capability |
| Capability gate | `fleet` → `fleetToolsEnabled()` (`src/lib/mcp-capabilities.ts:182`): `state.fleetEnabled \|\| GH_ROUTER_ENABLE_FLEET === "1"`; opt-in via `--fleet` / env. Enforced list-time AND call-time (`src/routes/mcp/handler.ts:341`, `:963`) |
| Backing model / endpoint | server-side fn — no model. Proxies to the remote ai-or-die `GET /api/files?path=<path>` (`src/lib/fleet/client.ts:438`) |
| Write-capable | no (read-only directory listing) |

## 2. Injected surfaces (verbatim)

### 2a. Tool `description` (shown in `tools/list`)

Description string (`src/lib/fleet/tools.ts:736`):

> `List a directory on one fleet instance via its existing /api/files endpoint.`

Input schema (`src/lib/fleet/tools.ts:737-740`), `required: ["path"]`, `additionalProperties: false`:

- `instance` (string): `Instance id or label. Defaults to the registry default, or the sole instance.`
- `path` (string, required): `Remote directory path to list.`

### 2b. System prompt (`--append-system-prompt`)

The `fleet` group and every fleet tool — `list_dir` included — are ABSENT from `buildPeerAwarenessSnippet` (`src/lib/peer-mcp-personas.ts:555-646`). The builder has no `fleetAvailable` option and emits no fleet clause; its opts shape (`:555-567`) covers only peers/search/workers/orchestrate/browser/decide. Neither the group nor the tool is named. The "fleet" occurrences elsewhere in that file (`:731-732`) are a doc comment on the `capability` field, not injected text.

So the ONLY model-facing surface for this tool is its `tools/list` `description` (2a).

### 2c. CLAUDE.md (mirrored `<CLAUDE_CONFIG_DIR>/CLAUDE.md`)

No marker block covers this tool. The mirrored peer-awareness block is produced by the same `buildPeerAwarenessSnippet` (`src/claude.ts:1019`), which omits fleet, so the injected CLAUDE.md peer-awareness text does not mention `list_dir` or the `fleet` group either. The other injected blocks (style directive, operating-defaults, toolbelt, artifact-panel directive) are unrelated.

Checked-in repo root `CLAUDE.md` does not document fleet at all (no `fleet`/`list_dir` match). The tool is documented only in `docs/aiordie-fleet.md:65` (`read_file`/`list_dir`/`search`/`git_show` listed as read-through file tools), which is a design doc, not injected. That doc agrees with the code: `list_dir` proxies the remote `/api/files` endpoint read-only.

## 3. Assessment

### 3a. Description quality

- **Clarity & routing signal**: The description states what it does (list a directory on one fleet instance) but gives no when-to-use / when-NOT signal. In isolation this is thin, but `list_dir` sits inside a coherent `fleet` family whose sibling names (`list_instances`, `read_file`, `search`, `git_show`) are self-describing, and the group server name (`github-router-fleet`) plus the `mcp__fleet__` path prefix carry the "remote instance" routing signal the description omits. Adequate.
- **Accuracy vs implementation**: Accurate. The handler (`:741-745`) resolves the instance, calls `clientFor(instance).listDir(path)`, which issues `GET /api/files?path=<path>` (`src/lib/fleet/client.ts:438`). "existing /api/files endpoint" matches the wire call exactly. No stale model id / default (there is no model). The `instance` default-resolution behavior described in the schema ("registry default, or the sole instance") matches `resolve(optionalString(args,"instance"))` → `getRegistry().resolveInstance(arg)`.
- **Schema minimality**: Two fields, both justified. `path` is required and directly consumed. `instance` is optional, model-tunable (selects the target when more than one is registered), and resolvable to a default — not an echoed input or diagnostic. Meets the ruthlessly-minimal bar; nothing to cut.

### 3b. System-prompt coverage

- **Omitted, by design.** Fleet is an opt-in operator surface (`--fleet`), off by default. `buildPeerAwarenessSnippet` gates every optional group behind an availability flag so the snippet never names a tool missing from the live `tools/list`; fleet simply has no such flag/clause, so it is never advertised in the system prompt. That is consistent with the always-on framing of the snippet (it describes the default-on toolkit), and acceptable: when `--fleet` is on, the model still discovers `list_dir` via `tools/list` and its `description`.
- **Accuracy / non-redundancy**: N/A (absent). No contradiction can arise from the snippet.
- **Framing-constraint compliance**: N/A — nothing injected to violate the no-imperatives / no-anchors rules.

Acceptability verdict on the group being unnamed in the snippet: acceptable. The absence is a deliberate default-off posture, not a coverage gap, and the tool remains fully discoverable through `tools/list` when enabled. The one cost is that the description alone must carry all routing weight (see 3a) — fine here given the self-describing family and path prefix.

### 3c. CLAUDE.md coverage

- Consistent: neither the injected CLAUDE.md nor the checked-in root CLAUDE.md documents fleet, matching the system-prompt omission. No drift, because there is nothing to drift.
- The only prose is `docs/aiordie-fleet.md`, which is not injected and agrees with the code.

### 3d. Cross-surface consistency

No contradictions. Description ↔ code agree (`/api/files`, required `path`, optional `instance`). System prompt and CLAUDE.md are uniformly silent on fleet, so there is no surface that could disagree with the description. Gate wording is consistent across `state.ts:45-52`, `mcp-capabilities.ts:182`, and the handler enforcement points.

## 4. Findings

- **[Suggestion]** `src/lib/fleet/tools.ts:736` — the description has no when-to-use / when-NOT clause and no note that the tool is read-only or that results/paths are remote to the resolved instance. Given fleet is unnamed in the system prompt, the description is the tool's only routing signal. Minor, tolerable fix: add a short clause, e.g. `List a directory on one remote ai-or-die fleet instance (read-only, via its /api/files endpoint). Use to browse a remote workspace before read_file/search.` Non-blocking; the family naming already carries most of the signal.

No Critical or Important findings. Gate is correctly enforced at both list-time and call-time; description matches implementation; schema is minimal.

## 5. Verdict

Y — the injected surface is correct, minimal, consistent, and adequately routed (via the self-describing `fleet` family + path prefix). Single most valuable improvement: add a one-line when-to-use/read-only clause to the description, since fleet is deliberately absent from the system prompt and CLAUDE.md so the `tools/list` description is the only routing signal.
