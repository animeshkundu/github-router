# Review: `mcp__fleet__search`

> Per-tool audit of the model-facing surface github-router auto-injects. One doc per injected MCP tool.
> Reviewer: meta subagent. Fill every section. Cite `file:line`. Verify claims against code, do not assert.

## 1. Identity

| Field | Value |
|---|---|
| MCP path | `mcp__fleet__search` |
| Group / server | `fleet` (serverInfo `github-router-fleet`) — `src/lib/peer-mcp-personas.ts:118` |
| Wire tool name | `search` (`toolNameHttp`) — `src/lib/fleet/tools.ts:748` |
| Definition | `src/lib/fleet/tools.ts:747-764` (via `tool()` factory at `:283`) |
| Always-on? | gated |
| Capability gate | `fleet` → `fleetToolsEnabled()` (`src/lib/mcp-capabilities.ts:182`; list-time `handler.ts:341`, call-time `handler.ts:961-971`) |
| Backing model / endpoint | server-side fn — proxies to the remote instance's `GET /api/search` (`src/lib/fleet/client.ts:442-446`) |
| Write-capable | no (read-only file search on the remote instance) |

## 2. Injected surfaces (verbatim)

### 2a. Tool `description` (shown in `tools/list`)

Description string (`src/lib/fleet/tools.ts:749`):

> Search files on one fleet instance via its existing /api/search endpoint.

Input-schema fields (`src/lib/fleet/tools.ts:750-754`; `required: ["query"]`):

- `instance` — "Instance id or label. Defaults to the registry default, or the sole instance."
- `query` — "Search query." *(required)*
- `path` — "Optional path scope."

### 2b. System prompt (`--append-system-prompt`)

The fleet group is **NOT named** in `buildPeerAwarenessSnippet` (`src/lib/peer-mcp-personas.ts:555-646`). The function signature (`:555-567`) has no `fleetAvailable` field, and no `fleet`/`mcp__fleet__` clause appears anywhere in the snippet body — even in the gated conditionals (workers, orchestrate, stand_in, browser are the only gated mentions). The call site (`src/claude.ts:1019-1028`) passes no fleet flag. So neither the tool nor the fleet group is mentioned in the system prompt at all — not the tool, not the group.

### 2c. CLAUDE.md (mirrored `<CLAUDE_CONFIG_DIR>/CLAUDE.md`)

No injected marker block covers this tool. The mirrored CLAUDE.md's peer-awareness block is the SAME `peerSnippet` string used for `--append-system-prompt` (`src/claude.ts:1032`, `appendPeerAwarenessToMirroredClaudeMd(peerSnippet)` at `:1042`), so the fleet absence in 2b carries verbatim into the mirror. The operating-defaults, toolbelt, and artifact-panel blocks do not mention fleet either.

Checked-in repo root `CLAUDE.md`: **zero** fleet mentions (grep `fleet`/`mcp__fleet` → no matches). The fleet surface is documented only in `docs/aiordie-fleet.md` (`:6-75`), which is not injected into any agent context. That doc agrees with the code: it lists `search` among `read_file`/`list_dir`/`search`/`git_show` as instance-scoped reads over the remote's existing endpoints (`:62-65`), matching the client's `GET /api/search` (`client.ts:442-446`).

## 3. Assessment

### 3a. Description quality

- **Routing signal — weak.** "Search files on one fleet instance via its existing /api/search endpoint" tells the model WHAT (remote file search on a fleet instance) but gives no when-to-use / when-NOT signal and, critically, no disambiguation from the two other search tools the same agent sees: `mcp__search__code` (semantic/lexical code search of the LOCAL workspace) and `mcp__search__web`. All three are plausibly matched by a bare "search" intent. The only disambiguator in the string is "fleet instance," which presumes the model already knows "fleet" = remote ai-or-die instances — a term never defined in the system prompt or CLAUDE.md (see 2b/2c). A model that has registered fleet tools but never read `docs/aiordie-fleet.md` has no grounding for what "fleet instance" means.
- **`/api/search` is an implementation leak.** Naming the remote HTTP endpoint ("its existing /api/search endpoint") is diagnostic-only from the model's side: the model cannot act on the endpoint path, and it does not clarify behavior (query syntax, result shape, whether it is regex/substring/ranked). It costs context for no routing return. The same leak appears in the sibling read tools' descriptions (`read_file` `:723`, `list_dir` `:736`, `git_show` `:767`), so it is a consistent house style, not a one-off — but it is still surface the "ruthlessly minimal" principle (`docs/peer-mcp-design.md`) would cut.
- **Accuracy vs implementation — correct.** The handler (`tools.ts:755-763`) resolves the instance (default-allowed, matching the `instance` field text), requires `query` (`requiredString`, matching `required: ["query"]`), passes `path` through as optional scope, and returns the raw upstream response under `{ resolvedInstance, ...response }`. No stale model id / default / gate. `SearchResponse` is an open `[key: string]: unknown` (`client.ts:290-292`), so the result shape is entirely upstream-determined; the description promising nothing about the shape is at least not wrong.

### 3b. System-prompt coverage

- **Omitted.** Consistent with the whole fleet group and, per `docs/aiordie-fleet.md:13`, gated exactly like `--browse`. The design choice to leave an opt-in, operator-only remote-control surface out of the always-injected awareness snippet is defensible (the snippet stays lean; the operator who turned on `--fleet` is expected to drive it deliberately). The team-lead brief flags this as the item to judge: **acceptable.** Fleet is a niche, operator-gated, cross-machine control plane; naming 13 fleet tools in every spawned agent's system prompt would bloat the snippet for a capability most sessions never enable, and unlike workers/critics the model is not expected to reach for fleet autonomously. Leaving the `description` as the sole surface is the right call — the gap is that the description alone is too thin to self-orient a model that has no other fleet grounding (see 3a).
- No framing-constraint issue in the snippet (fleet is simply absent).

### 3c. CLAUDE.md coverage

- Accurate by omission (mirrors 2b; no drift because it is the same string).
- Root CLAUDE.md consistency: root CLAUDE.md documents the six intent-named MCP servers (`peers`/`search`/`workers`/`orchestrate`/`browser`/`decide`) but predates or omits `fleet` and `first-mate`; those live only in their own design docs. Not a contradiction, but the checked-in root CLAUDE.md's MCP-server inventory is now incomplete relative to `MCP_GROUPS` (`peer-mcp-personas.ts:118-119` adds `fleet` + `first-mate`). Minor doc-staleness, out of scope for this tool but worth a note.

### 3d. Cross-surface consistency

- No contradictions. Description ↔ code agree (`GET /api/search`, `query` required, `path`/`instance` optional). System prompt and mirrored CLAUDE.md are silent, consistently. `docs/aiordie-fleet.md` agrees with the code. The only cross-surface tension is the naming collision (below), which is a description-vs-sibling-tool problem, not a description-vs-code one.

## 4. Findings

- **[Important]** `src/lib/fleet/tools.ts:749` — the wire tool name `search` collides conceptually with `mcp__search__code` and `mcp__search__web`, and the description does not disambiguate. A model with fleet enabled sees three "search"-shaped tools; the fleet one is the only remote/file-content one but says nothing to steer a "search the codebase" or "search for X" intent away from it or toward it. Repro: with `--fleet` on, prompt an agent "search the repo for the retry logic" — `mcp__search__code` (local semantic) and `mcp__fleet__search` (remote file grep on a possibly-unrelated instance) are both plausible matches, and picking fleet silently queries a remote instance's workspace instead of the local one. Fix: prepend a one-clause disambiguator, e.g. "Search files on a REMOTE ai-or-die fleet instance's workspace (not the local workspace — for that use `mcp__search__code`)."
- **[Important]** `src/lib/fleet/tools.ts:749` — "fleet instance" is used as a routing term the model has no definition for anywhere in its injected context (absent from system prompt and CLAUDE.md per 2b/2c). Without grounding, the model cannot reliably decide when this tool applies. Fix: either add a one-line fleet-group framing to the mirrored CLAUDE.md / awareness snippet gated on `fleetToolsEnabled()`, or make the description self-contained ("a remote ai-or-die instance you registered with `--fleet`").
- **[Suggestion]** `src/lib/fleet/tools.ts:749` — drop the "via its existing /api/search endpoint" clause (and the equivalents in `read_file`/`list_dir`/`git_show`): the remote HTTP path is not model-actionable and spends context. Replace with a behavior hint the model CAN use (e.g. whether `query` is substring vs regex, and that results come from the remote instance's own search).
- **[Suggestion]** `src/lib/fleet/tools.ts:750-754` — schema is minimal and correct (all three fields are call-shaping and model-tunable; none are echoed inputs or diagnostics). No cut needed. Optional polish: the `path` description "Optional path scope" could say whether it is a dir prefix or a glob, since the model must guess otherwise.

## 5. Verdict

**N** — the tool works and its schema is minimal, but its injected surface is under-specified: a bare "search" name plus a description that neither disambiguates from the two sibling `mcp__search__*` tools nor defines "fleet instance" leaves the model without a reliable routing signal. Single most important fix: add a REMOTE-vs-local disambiguator to the description (Finding 1).
