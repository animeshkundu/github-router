# Review: `mcp__fleet__list_instances`

> Per-tool audit of the model-facing surface github-router auto-injects. One doc per injected MCP tool.
> Reviewer: meta subagent. Fill every section. Cite `file:line`. Verify claims against code, do not assert.

## 1. Identity

| Field | Value |
|---|---|
| MCP path | `mcp__fleet__list_instances` |
| Group / server | `fleet` (serverInfo `github-router-fleet`) |
| Wire tool name | `list_instances` |
| Definition | `src/lib/fleet/tools.ts:306` (via the `tool(...)` factory at `src/lib/fleet/tools.ts:283`) |
| Always-on? | gated by capability `fleet` |
| Capability gate | `fleet` → `fleetToolsEnabled()` (`src/lib/mcp-capabilities.ts:182`): `state.fleetEnabled \|\| GH_ROUTER_ENABLE_FLEET === "1"` (i.e. `--fleet` opt-in). Enforced at list time (`handler.ts:341`) AND call time (`handler.ts:961-971`, `-32601` when off). |
| Backing model / endpoint | server-side fn (no model). Fans out `FleetClient.listSessions` over registered instances (`tools.ts:311-317`). |
| Write-capable | no (read-only reachability probe) |

## 2. Injected surfaces (verbatim)

### 2a. Tool `description` (shown in `tools/list`)

> "List registered remote ai-or-die instances in the fleet registry. Tokens are never returned."

Input schema (`tools.ts:309`): `objectSchema({}, [])` — an object with `additionalProperties: false`, **no properties, no required fields**. The tool takes zero arguments.

Output shape (not in the schema, but this is what the model reads back), `tools.ts:305-318` + the `FleetInstanceProbeResult` union at `tools.ts:55-57`: `{ instances: [...] }` where each element is either
- reachable: `{ id, label, reachable: true, sessionCount, lastSeen }`, or
- unreachable: `{ id, label, reachable: false, error: <FleetErrorCode>, hint? }`.

`error` is one of the `FleetErrorCode` values (`tools.ts:872-890`); `hint` is the short actionable string from `fleetProbeHint` (`tools.ts:853-870`, e.g. NO_HOST → "tunnel relay up, no ai-or-die host connected…").

### 2b. System prompt (`--append-system-prompt`)

**Not named.** `buildPeerAwarenessSnippet` (`src/lib/peer-mcp-personas.ts:555-646`) has no `fleet` field in its `opts` and emits no fleet clause anywhere in either paragraph. The `fleet` group is entirely absent from the system prompt — not the tool, not even the group. The only model-facing text for this tool is its `description` (2a).

### 2c. CLAUDE.md (mirrored `<CLAUDE_CONFIG_DIR>/CLAUDE.md`)

**No injected block covers this tool.** The mirrored peer-awareness block is the same text as 2b (built by `buildPeerAwarenessSnippet`), which omits fleet — so the mirrored CLAUDE.md does not mention fleet either. No artifact-panel / operating-defaults / toolbelt block covers it.

Checked-in **root `CLAUDE.md`**: `rg -i fleet CLAUDE.md` → no matches. The root project CLAUDE.md has no fleet section at all.

A **maintainer design doc does exist** — `docs/aiordie-fleet.md` (the fleet integration doc; `list_instances` described at `docs/aiordie-fleet.md:62` as "probes reachability, ~5s cached") plus `docs/fleet-control-plane-contract.md` and `docs/fleet-fixes-progress-ghr.md`. These are reference docs, not model-facing, and are NOT linked from the root CLAUDE.md "Design docs" index. So the design is documented for maintainers; it is just not surfaced to the model or indexed in CLAUDE.md.

## 3. Assessment

### 3a. Description quality

- **Clarity & routing signal.** The description is a single clear sentence. For a zero-arg registry-listing tool this is adequate: the model learns *what* it returns. It carries **no "when to use / when NOT" signal** and no mention that the result is a live reachability probe (each call fans out `listSessions` to every instance, `tools.ts:311-317`, ~2s per-instance timeout at `tools.ts:40`, 5s cache at `tools.ts:41`/`246`). Given fleet is an opt-in operator surface with no system-prompt framing, the description is the *only* routing signal the model gets — a one-line note that this is the entry point (call it first to discover addressable instance ids before `list_sessions` / `create_session`) would materially improve routing. Minor.
- **Accuracy vs implementation.** Accurate. "registered remote ai-or-die instances" matches the merged static∪mesh-discovered registry (`MergedFleetRegistry.listInstances`, `discovery.ts:363-368`). "Tokens are never returned" is **verified true**: the output is built purely from `FleetInstanceInfo` (id/label — `registry.ts:99-108` and `discovery.ts:144-146` deliberately omit `token`/`tunnelToken`/`tunnelId`/`meshProxy`) plus `sessionCount`/`lastSeen` derived from a `listSessions` call; `probeInstance` (`tools.ts:242-281`) never reads `instance.token`, and the `FleetInstanceProbeResult` type (`tools.ts:55-57`) has no token-bearing field. Pinned by the test `list_instances probes reachability without exposing tokens` (`tests/fleet/tools.test.ts:382-426`), which asserts the serialized text does not contain the token substring (`tools.test.ts:423`).
- **Schema minimality.** Optimal — zero fields, `additionalProperties:false`. Nothing to echo, nothing diagnostic-only. Compliant with the "ruthlessly minimal MCP tool surface" principle by construction.

### 3b. System-prompt coverage

- **Omitted.** The `fleet` group is not named in `buildPeerAwarenessSnippet`.
- Whether this is by-design or a gap: it is **defensible for an opt-in operator surface**. The other opt-in surfaces are handled inconsistently — `browser` (also opt-in, `--browse`) IS conditionally named in the snippet (`peer-mcp-personas.ts:630-637`), and `stand_in` / `gh-first-mate` are conditionally named behind their gates. Fleet has no equivalent conditional clause even though the machinery (`groupKeys` carries a `fleet` key via `GROUP_META`, `peer-mcp-personas.ts:118`) is present. So the precedent in this exact function is to name a gated surface *when its gate is on*; fleet is the one gated surface that is not. This is a **coverage gap relative to the established pattern**, though a low-severity one — the tool still works (the description carries it), the model just isn't told the fleet capability exists unless it enumerates `tools/list`.
- Framing-constraint compliance: N/A (nothing emitted to violate).

### 3c. CLAUDE.md coverage

- The mirrored block omits fleet (consequence of 3b). Not drifted — it is simply silent.
- Root CLAUDE.md has no fleet section and the "Design docs" index does not link `docs/aiordie-fleet.md`, so a maintainer reading CLAUDE.md would not discover the fleet design doc from the index. Minor documentation-hygiene gap, not a model-facing defect.

### 3d. Cross-surface consistency

No contradictions. Description ↔ code agree (verified). System prompt / CLAUDE.md are silent (not contradictory). The design doc (`docs/aiordie-fleet.md:62`) agrees with the code ("probes reachability, ~5s cached" ↔ `INSTANCE_PROBE_CACHE_TTL_MS = 5_000`, `tools.ts:41`).

## 4. Findings

- **[Suggestion]** `src/lib/peer-mcp-personas.ts:555-646` — the `fleet` group is not named in `buildPeerAwarenessSnippet`, unlike the sibling opt-in `browser`/`stand_in`/`gh-first-mate` gated surfaces which each get a conditional clause. An operator who runs `--fleet` gets no system-prompt/CLAUDE.md hint that fleet exists; the model must enumerate `tools/list` to find it. Fix: add a `fleetAvailable` opt + a one-sentence conditional clause (mirroring the `browseAvailable` branch) so an opted-in operator's model is told the capability exists and that `list_instances` is the discovery entry point. Non-blocking; the tool is fully functional without it.
- **[Suggestion]** `src/lib/fleet/tools.ts:308` — the description gives no when-to-use / ordering signal. Since fleet has no system-prompt framing, add a short cue that this is the discovery entry point (returns the addressable instance ids that `list_sessions` / `create_session` / `read_session` require) and that each call is a live reachability probe (~5s cached). Improves routing at negligible token cost.
- **[Suggestion]** `src/lib/fleet/tools.ts:254-260` — the reachable probe result omits the instance `url`, `default`, and `allowExec` fields that `FleetInstanceInfo` carries (`registry.ts:99-108`), so the model cannot see which instance is the registry default or whether exec is allowed without a separate call. Consider surfacing `default`/`allowExec` (both already non-credential) so the model can pick the default target and know exec-capability up front. Non-blocking; `url` is arguably better withheld (not actionable for the model, and one less string to reason over).

No Critical or Important findings. The security-relevant "tokens never returned" claim is honored and test-pinned.

## 5. Verdict

Y — the injected surface is correct, minimal (zero-arg schema), consistent, and its load-bearing security claim ("tokens never returned") is verified in code and pinned by a test. Single most valuable improvement: name the opted-in `fleet` group in `buildPeerAwarenessSnippet` (the one gated surface the snippet skips) so an operator who ran `--fleet` actually gets a routing signal, rather than relying on the model to discover the capability from `tools/list`.
