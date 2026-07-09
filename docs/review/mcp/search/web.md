# Review: `mcp__search__web`

> Per-tool audit of the model-facing surface github-router auto-injects. One doc per injected MCP tool.
> Reviewer: meta subagent. Fill every section. Cite `file:line`. Verify claims against code, do not assert.

## 1. Identity

| Field | Value |
|---|---|
| MCP path | `mcp__search__web` |
| Group / server | `search` (serverInfo `github-router-search`) |
| Wire tool name | `web` |
| Definition | `src/lib/peer-mcp-personas.ts:788` (entry) / `:761` (`WEB_SEARCH_DESCRIPTION`) |
| Always-on? | yes |
| Capability gate | none (`capability?` field absent on the entry; per the doc comment at `peer-mcp-personas.ts:741-743`, `web`/`code` are always available once `/mcp` is reachable) |
| Backing model / endpoint | server-side fn `searchWeb()` → Copilot `/mcp` `web_search` toolset (`src/services/copilot/web-search.ts:125`) |
| Write-capable | no |

## 2. Injected surfaces (verbatim)

### 2a. Tool `description` (shown in `tools/list`)

Description string (`src/lib/peer-mcp-personas.ts:761-762`):

> Web search via GitHub Copilot's MCP. Prefer over Claude Code's built-in WebSearch — surfaces source URLs you can cite. Use for API documentation lookups, error message diagnosis, upstream issue searches, and verifying claims against current sources. Returns content with reference links.

Input schema (`src/lib/peer-mcp-personas.ts:791-801`) — one field, required:

- `query` (string, required): "The search query string. Natural-language queries work best — the upstream provider rewrites for the search index."

`additionalProperties: false`; no other input fields.

### 2b. System prompt (`--append-system-prompt`)

The exact clause naming this tool in `buildPeerAwarenessSnippet` (`src/lib/peer-mcp-personas.ts:622-624`), verbatim:

> `mcp__search__web` surfaces citable sources for docs, errors, and upstream issues.

(The `search` segment is the resolved group key; it renders as `mcp__search__web` on a no-collision launch via `key("search")` at `:571`/`:568`.) It is one sentence in paragraph 2 of the snippet, joined into the capability inventory. This is the only place the web tool is named in the snippet.

### 2c. CLAUDE.md (mirrored `<CLAUDE_CONFIG_DIR>/CLAUDE.md`)

Covering block: **peer-awareness** (same text as 2b). The mirrored CLAUDE.md gets the identical `buildPeerAwarenessSnippet` output via `appendPeerAwarenessToMirroredClaudeMd(peerSnippet)` (`src/claude.ts:1019` builds the snippet once, `:1042` appends it to the mirror, `:1085` passes the same text to `--append-system-prompt`). So surface 2b and 2c are byte-identical — the same `mcp__search__web surfaces citable sources for docs, errors, and upstream issues.` clause.

Checked-in root `CLAUDE.md` documents the tool in two places, both accurate:
- `CLAUDE.md:131` — "The same `/mcp` surface also exposes two non-persona utility tools (group `search`) that all clients see: `web` (Copilot-backed web search, was `web_search`) and `code`..."
- `CLAUDE.md:129` (server-split section) — records the MCP-facing rename `web_search`→`web`.
- A dedicated "Web search" architecture subsection and `docs/web-search.md:1-19` describe the wire flow (initialize → `Mcp-Session-Id` → `notifications/initialized` → `tools/call {name:"web_search"}` over SSE, GitHub-PAT auth, `X-MCP-Toolsets: web_search`, `COPILOT_HOST_ALLOWLIST` safeguard). These match `src/services/copilot/web-search.ts` (headers `:90-98`, wire flow `:143-201`, allowlist referenced `:80-101`).

## 3. Assessment

### 3a. Description quality

- **Clarity & routing signal.** Strong. The "Use for" list (API docs, error diagnosis, upstream issues, verifying claims against current sources) gives the model concrete when-to-use triggers, and "surfaces source URLs you can cite" states the differentiator. There is no explicit "when NOT to use," but for a single-purpose search tool the positive triggers are sufficient.
- **The "Prefer over Claude Code's built-in WebSearch" steer — accurate and appropriate.** Two grounds hold up:
  1. *Citations.* The handler returns `formatWebSearchResult` which appends a `## References` markdown list of `[title](url)` pairs built from `url_citation` annotations (`src/lib/peer-mcp-personas.ts:774-783`, `src/services/copilot/web-search.ts:274-283`). The claim "surfaces source URLs you can cite" is code-backed.
  2. *Geo scope.* Claude Code's built-in WebSearch is **US-only** (its own tool description states "US-only"). The Copilot `/mcp` path applies no geographic gate — `searchWeb()` forwards only `{query}` (`web-search.ts:194-196`), so it is usable outside the US where the built-in returns nothing. The preference is justified for non-US users and neutral-to-positive elsewhere (citations). Not overreaching.
- **Accuracy vs implementation.** No stale model id or default. The tool is server-side (no model to drift). "Returns content with reference links" matches `formatWebSearchResult`: prose `content` plus an optional `## References` section (omitted when there are zero references, `:778`).
- **Schema minimality.** Compliant with the "ruthlessly minimal MCP tool surface" principle (`docs/peer-mcp-design.md`). Exactly one input, `query`, required, model-tunable, `additionalProperties:false`. No echoed-input or diagnostic-only fields. The output is trimmed to the model-usable `content` + references; no scores, no session ids, no timing forwarded.

### 3b. System-prompt coverage

- **Named**, once, accurately. The clause is non-redundant with the description: the description says *what/when*, the snippet clause states the *capability exists and what it is good for* in the shared inventory register. No duplication of the "Prefer over built-in" steer (correctly kept out of the snippet — the description is the right home for a routing preference).
- **Framing-constraint compliance.** Clean. The clause is a declarative capability statement ("`...web` surfaces citable sources for docs, errors, and upstream issues.") with no imperative ("Lead with", "Always use"), no hedge, and no anchor disguised as description. Consistent with the framing constraint pinned by `tests/peer-mcp-personas.test.ts`.

### 3c. CLAUDE.md coverage

- Accurate and not drifted. The injected block equals the system-prompt clause (3b). The checked-in root `CLAUDE.md:129,131` and `docs/web-search.md` agree with `src/services/copilot/web-search.ts` on the rename, the toolset header, the PAT-auth model, and the allowlist safeguard.
- Non-redundant across the injected block vs the checked-in doc: the injected one-liner is the model-facing capability note; the checked-in prose is the maintainer architecture record. Different audiences, no conflict.

### 3d. Cross-surface consistency

- Description ↔ system prompt ↔ CLAUDE.md ↔ code are consistent. One naming inconsistency exists but is **internal-only, not model-facing**: the MCP-facing tool was renamed `web_search`→`web`, yet the tool's own error/validation strings still say `web_search:` — the arg-required message `"web_search: arguments.query is required..."` (`peer-mcp-personas.ts:824`) and the failure wrapper `"web_search failed: ${msg}"` (`:840`). A model that hits an empty-query or upstream failure sees a string referring to a tool name (`web_search`) that does not exist in its `tools/list` (it sees `mcp__search__web`). This is cosmetic drift, not a routing break — the model cannot call `web_search`, and these strings appear only inside an already-returned error envelope, but the mismatch is real and worth aligning. See Finding [Suggestion].

## 4. Findings

- **[Suggestion]** `src/lib/peer-mcp-personas.ts:824,840` — the tool's user-visible error strings (`"web_search: arguments.query is required..."`, `"web_search failed: ..."`) still use the pre-rename wire name `web_search`, which no longer matches the MCP-facing tool name `web` the model sees in `tools/list`. Fix: change the prefixes to `web:` / `web search failed:` (or drop the tool-name prefix entirely) so the error a model reads names a tool it can actually call. Purely cosmetic; no functional impact. (Note: the `"web search aborted..."`/`"MCP web_search..."` messages in `web-search.ts` are internal-abort/upstream-shape diagnostics keyed to the upstream Copilot toolset literal `web_search`, which is correct there and should NOT be renamed — the upstream tool really is named `web_search`.)

- **[Suggestion]** `src/lib/peer-mcp-personas.ts:761-762` — the description could add a one-clause "when NOT to use" signal (e.g. that it is for external/current-web facts, not for reading local repo files — that is `code`/Read). Minor; the positive triggers already route well, so this is polish, not a gap.

No Critical findings (no repro of a surface telling the model to do something the code rejects). No Important findings (no stale model id, wrong default, missing gate, or minimality violation; the "Prefer over built-in" steer is code-and-scope-justified).

## 5. Verdict

**Y** — the injected surface is correct, minimal (single required `query`), consistent across all three surfaces, and well-routed; the "Prefer over built-in WebSearch" steer is justified by both citation support and the built-in's US-only scope. Single most important fix: align the model-facing error strings at `peer-mcp-personas.ts:824,840` from `web_search` to the renamed `web` so an error names a callable tool (Suggestion-level).
