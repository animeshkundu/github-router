# Review: `mcp__fleet__git_show`

> Per-tool audit of the model-facing surface github-router auto-injects. One doc per injected MCP tool.
> Reviewer: meta subagent. Fill every section. Cite `file:line`. Verify claims against code, do not assert.

## 1. Identity

| Field | Value |
|---|---|
| MCP path | `mcp__fleet__git_show` |
| Group / server | `fleet` (serverInfo `github-router-fleet`, `src/lib/peer-mcp-personas.ts:118`) |
| Wire tool name | `git_show` (`src/lib/fleet/tools.ts:766`) — spread into `NON_PERSONA_MCP_TOOLS` with NO rename (`src/lib/peer-mcp-personas.ts:2059`), unlike the `browser_*` prefix strip; MCP name == wire name |
| Definition | `src/lib/fleet/tools.ts:765-780` (factory `tool()` at `:283-303`) |
| Always-on? | gated by capability `fleet` |
| Capability gate | `fleet` → `fleetToolsEnabled()` (`src/lib/mcp-capabilities.ts:182-184`): `state.fleetEnabled` (set by `--fleet`) OR `GH_ROUTER_ENABLE_FLEET=1`. No catalog/model/local-dep check. Enforced at `tools/list` AND `tools/call` (`src/routes/mcp/handler.ts:961-971`, rejects with `RPC_METHOD_NOT_FOUND` when off). |
| Backing model / endpoint | server-side fn — HTTP `GET /api/files/git-show` on the resolved ai-or-die instance (`src/lib/fleet/client.ts:448-456`). No LLM. |
| Write-capable | no (read-only git-object fetch) |

## 2. Injected surfaces (verbatim)

### 2a. Tool `description` (shown in `tools/list`)

Description string (`src/lib/fleet/tools.ts:767`):

> Read a file/revision through one fleet instance's existing /api/files/git-show endpoint.

Input-schema fields (`src/lib/fleet/tools.ts:768-774`; `required: ["path"]`):

- `instance` (string, optional): "Instance id or label. Defaults to the registry default, or the sole instance."
- `path` (string, required): "Remote repository path or file path for git-show."
- `ref` (string, optional): "Optional git ref/revision."
- `rev` (string, optional): "Optional git revision alias."
- `commit` (string, optional): "Optional commit id."

Schema is declared closed (`additionalProperties: false`, `objectSchema` at `:1192-1199`) but **not enforced**: the MCP handler dispatches raw `args` to `handler(args, ...)` with no JSON-schema validation step (`src/routes/mcp/handler.ts:1173`), and the handler forwards `{ ...args, instance: undefined }` to the client (`:777`), which stringifies EVERY remaining key into a query param (`src/lib/fleet/client.ts:450-453`). See finding [Important].

Output (handler, `src/lib/fleet/tools.ts:775-779`): `ok({ resolvedInstance: publicInstance(instance), ...response })`. `response` is `GitShowResponse` = an open `{ [key: string]: unknown }` (`src/lib/fleet/client.ts:294-296`), i.e. the upstream body verbatim; `resolvedInstance` = `{ id, label }` (`publicInstance`, `:1086-1088`). So the model receives `{ resolvedInstance, ...<whatever /api/files/git-show returns> }`.

### 2b. System prompt (`--append-system-prompt`)

`git_show` is NOT named in `buildPeerAwarenessSnippet` (`src/lib/peer-mcp-personas.ts:555-646`). The snippet's capability inventory (`para2Parts`, `:595-637`) names only the `peers`, `search`, `workers`, `orchestrate`, `decide`, and `browser` groups. **The `fleet` group is named nowhere in the snippet** — not the group, not any of its tools; `fleet` appears in the file only as the `McpGroup` type / `GROUP_META` wiring (`:81,:91,:118`), which is not model-facing. The only model-facing surface for this tool is its `tools/list` `description` (2a). This omission is acceptable for an off-by-default operator surface (the description carries the tool), but it is group-wide: even with `--fleet` on, the model gets zero system-prompt framing for the whole fleet surface, unlike the other gated groups (workers/stand_in/browser) which each emit a conditional clause when enabled.

### 2c. CLAUDE.md (mirrored `<CLAUDE_CONFIG_DIR>/CLAUDE.md`)

No injected marker block covers this tool. The mirrored peer-awareness block is the same text as 2b (`buildPeerAwarenessSnippet` output), which omits fleet entirely; the artifact-panel directive, operating-defaults, and toolbelt blocks are unrelated. So the mirrored CLAUDE.md says nothing about `git_show`.

Checked-in root `CLAUDE.md` (project root): no `fleet` / `aiordie` / `ai-or-die` / `git_show` mention (grep returned no matches). The tool is documented only in `docs/aiordie-fleet.md:65`, which lists `git_show` in the `read_file`/`list_dir`/`search`/`git_show` filesystem-tool group. That doc agrees with the code (opt-in gate `--fleet` / `GH_ROUTER_ENABLE_FLEET=1` at `:13`; origin-pinning safety at `:68-70`; implementation pointers at `:72-74` match `fleetToolsEnabled()` and `src/lib/fleet/`). The doc does not describe `git_show`'s arg shape, so there is nothing there to drift from the `ref`/`rev`/`commit` triple.

## 3. Assessment

### 3a. Description quality

- **Clarity & routing signal:** weak. "Read a file/revision through one fleet instance's existing /api/files/git-show endpoint" tells the model *which HTTP endpoint fires* but not *when to reach for it* vs the sibling `read_file` (working-tree content) — the natural confusion for this tool. "file/revision" is ambiguous: git-show reveals a file **at a specific revision** (or a commit object), which is precisely the distinction from `read_file`, yet the description elides it. Leaking the raw endpoint path (`/api/files/git-show`) into a model-facing string is noise: the model cannot act on the URL, and it is an implementation detail (same anti-pattern as naming the transport instead of the capability). No when-NOT signal, no relation to `read_file`.
- **Accuracy vs implementation:** accurate as far as it goes — it does `GET /api/files/git-show` (`src/lib/fleet/client.ts:448-456`) on the resolved instance, read-only, response passed through untyped. No stale model id / default / behavior. But it is silent on the three-way revision arg and on the fact that unknown args are forwarded, so the model has no basis for choosing among `ref`/`rev`/`commit`.
- **Schema minimality:** two concerns.
  1. **`ref` / `rev` / `commit` are three overlapping optional fields for one concept** ("which revision"), with descriptions ("Optional git ref/revision" / "Optional git revision alias" / "Optional commit id") that do not tell the model which to use, whether they compose, or the precedence if more than one is set. The handler does not arbitrate — it forwards all present ones to the remote endpoint (`:777` → `client.ts:450-453`), so the *remote* `/api/files/git-show` decides, and the model has no local signal. Per the "ruthlessly minimal MCP tool surface" principle (`docs/peer-mcp-design.md`): three near-synonymous knobs where the model cannot predict the effect is exactly the echoed/ambiguous-input smell. A single `ref` (accepting any ref/rev/commit-ish, matching git's own `<commit-ish>` model) would be strictly clearer and is what git-show itself takes.
  2. **The closed schema is unenforced and the handler pass-through defeats it.** `handler(args)` forwards `{ ...args, instance: undefined }` and the client stringifies every key (`client.ts:450-453`), so any extra property the model emits rides through as a query param on `/api/files/git-show`. This is bounded — values are URL-param-encoded onto the origin-pinned base URL (`client.ts:465-479`, the credential boundary holds; no injection to another origin), and the remote endpoint chooses what to honor — so it is a hygiene/robustness gap, not a security hole. But it means the declared surface (`path` + three revs) is not the actual surface, and a hallucinated arg name silently reaches the control plane instead of being rejected.

### 3b. System-prompt coverage

- **Omitted.** Fleet is entirely absent from `buildPeerAwarenessSnippet`. Given the whole `fleet` group is opt-in and off by default, and the snippet is built to name only live-gated surfaces, omitting a rarely-enabled operator surface is a defensible design choice rather than a defect — the `tools/list` description carries the tool. **Acceptability: acceptable** for a read-only tool, with the same caveat noted for every fleet sibling: the omission is group-wide and unconditional (fleet gets no clause even when `--fleet` is on), which is a consistency gap at the group level, not a `git_show` defect.
- **Accuracy / non-redundancy / framing compliance:** N/A (not named). No imperative/hedge/anchor to violate.

### 3c. CLAUDE.md coverage

- Mirrored CLAUDE.md: absent (same omission as 2b). Consistent with the system prompt.
- Root CLAUDE.md: absent. `docs/aiordie-fleet.md:65` is the sole doc and is accurate and non-drifted (verified against `fleetToolsEnabled()`, the origin-pinned client, and `src/lib/fleet/`). It does not document the arg shape, so it neither confirms nor contradicts the `ref`/`rev`/`commit` design — the ambiguity lives only in the tool schema.

### 3d. Cross-surface consistency

No contradictions between description ↔ system prompt ↔ CLAUDE.md ↔ code. All silent surfaces agree; the external doc agrees with the code. The inconsistencies are *within* the tool definition: (a) the description says "file/revision" but does not connect that to the three revision args, and (b) the declared closed schema is not the effective schema (unknown args pass through).

## 4. Findings

- **[Important]** `src/lib/fleet/tools.ts:771-773` — `ref` / `rev` / `commit` are three overlapping optional fields for a single "which revision" concept, with descriptions that give the model no way to choose among them, no precedence, and no compose semantics; the handler forwards all present ones and lets the remote endpoint arbitrate (`:777` → `src/lib/fleet/client.ts:450-453`). This is an ambiguous-input minimality violation (`docs/peer-mcp-design.md` "ruthlessly minimal MCP tool surface"). Fix: collapse to a single `ref` (string, optional) documented as "git ref, revision, or commit-ish (e.g. HEAD, a branch, or a commit sha)", matching git-show's own `<commit-ish>` argument; keep accepting the remote endpoint's real param name under the hood.
- **[Important]** `src/lib/fleet/tools.ts:777` + `src/lib/fleet/client.ts:450-453` — the handler forwards the entire `args` object (`{ ...args, instance: undefined }`) and the client stringifies every key into a query param, so the schema's `additionalProperties: false` (`:768`, unenforced at `src/routes/mcp/handler.ts:1173`) is defeated: any extra/hallucinated arg reaches `/api/files/git-show` as a query param. It is origin-bounded (URL-encoded onto the pinned base, credential boundary intact — not injection), so this is hygiene not a vuln, but the declared surface diverges from the effective one. Fix: pluck the known fields explicitly (`path`, plus the collapsed `ref`) before calling `client.gitShow`, mirroring `read_file`/`list_dir`/`search` which pass only their declared params (`:730,:743,:757-761`), instead of spreading `args`.
- **[Suggestion]** `src/lib/fleet/tools.ts:767` — the description leaks the raw endpoint path and gives no when-NOT / sibling-relation signal. Consider: "Show a file at a specific git revision (or a commit object) on one fleet instance — use `read_file` for the current working-tree content." Drops the URL, states the distinguishing capability, and routes the model away from `read_file` confusion.
- **[Suggestion]** system prompt — the whole `fleet` group (not just `git_show`) is unnamed in `buildPeerAwarenessSnippet` even when `--fleet` is enabled, unlike the other gated groups. A single gated inventory sentence (mirroring the workers/stand_in/browser pattern) would raise discoverability. Cross-cutting; track at the group level, not here.

## 5. Verdict

**Y (with two Important fixes).** The injected surface is correctly gated, read-only, and consistent across the (silent) system prompt / CLAUDE.md / external doc. Two definition-level issues keep it from being minimal: the `ref`/`rev`/`commit` triple gives the model three indistinguishable knobs for one concept, and the pass-through-all-args handler makes the declared closed schema a fiction (bounded by origin-pinning, so hygiene not security). The single most important fix: collapse the revision args to one `ref` and pluck declared fields explicitly instead of spreading `args`.
