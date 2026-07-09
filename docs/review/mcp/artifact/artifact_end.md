# Review: `mcp__peers__artifact_end`

> Per-tool audit of the model-facing surface github-router auto-injects. One doc per injected MCP tool.
> Reviewer: meta subagent. Fill every section. Cite `file:line`. Verify claims against code, do not assert.

## 1. Identity

| Field | Value |
|---|---|
| MCP path | `mcp__peers__artifact_end` |
| Group / server | `peers` (serverInfo `github-router-peers`) |
| Wire tool name | `artifact_end` (no MCP-facing rename; `ARTIFACT_TOOLS` spread verbatim) |
| Definition | `src/lib/artifact/tools.ts:170` (factory `src/lib/artifact/tools.ts:31`) |
| Always-on? | gated by capability `artifact` |
| Capability gate | `artifact` → `artifactToolsEnabled()` (`src/lib/mcp-capabilities.ts:212`) |
| Backing model / endpoint | server-side fn → `ArtifactClient.end()` (`src/lib/artifact/client.ts:301`), POSTs `/api/artifact/<session>/end` to the ai-or-die tab API |
| Write-capable | no filesystem write; mutates review lifecycle state (ends the panel session) |

The group is `peers`, NOT a dedicated `artifact` group: `ARTIFACT_GROUP: McpGroup = "peers"` (`src/lib/artifact/tools.ts:13`), and the tool factory hardcodes `group: ARTIFACT_GROUP` (`src/lib/artifact/tools.ts:39`). `GROUP_META.peers.serverInfoName === "github-router-peers"` (`src/lib/peer-mcp-personas.ts:112`). So the directive's `mcp__peers__artifact_*` prefix is **correct** — no prefix mismatch. `ARTIFACT_TOOLS` is spread into the tool list with no `.map()` rename (`src/lib/peer-mcp-personas.ts:2058`), unlike browser/search/workers, so the MCP-facing name equals the wire name `artifact_end`.

## 2. Injected surfaces (verbatim)

### 2a. Tool `description` (shown in `tools/list`)

Description string (`src/lib/artifact/tools.ts:172`):

> End/close the ai-or-die Artifact review panel when the review loop is complete. Only works inside an ai-or-die tab-backed Claude session.

Input schema (`src/lib/artifact/tools.ts:173`): `objectSchema({}, [])` → `{ type: "object", required: [], additionalProperties: false, properties: {} }`. **No input fields.** The handler ignores args entirely (`async (_args, signal) => …`, `src/lib/artifact/tools.ts:174`).

Output on success (`src/lib/artifact/tools.ts:178-182`): `{ ...response, ok: true, next_step: "Artifact review loop ended." }` where `response` is `ArtifactEndResponse` (`{ ok, status? }`). On a missing env trio it returns the `NOT_IN_AIORDIE_TAB` isError envelope (`src/lib/artifact/tools.ts:411`).

### 2b. System prompt (`--append-system-prompt`)

**ABSENT.** `buildPeerAwarenessSnippet` (`src/lib/peer-mcp-personas.ts:555-646`) is the only builder of the peer-awareness system-prompt block, and it never names any `artifact_*` tool — the string `artifact` does not appear in its output (`para2Parts` covers code/web/workers/orchestrate/stand_in/browser only). Not the group, not the tool. This is by design: the artifact tools are covered by a **separate** injected block, the artifact-panel directive (2c), which is gated on `AIORDIE_SESSION_ID` rather than on the always-registered peer awareness.

### 2c. CLAUDE.md (mirrored `<CLAUDE_CONFIG_DIR>/CLAUDE.md`)

Covered by the **artifact-panel directive** block, marker fence `ARTIFACT_MARKER_OPEN`/`_CLOSE` (`src/lib/claude-md-injection.ts:36-38`), prepended by `prependArtifactPanelDirectiveToMirroredClaudeMd()` (`src/lib/claude-md-injection.ts:731`). It is wired in `src/claude.ts:807-814`, gated on `AIORDIE_SESSION_ID` being non-empty — so it only lands inside an ai-or-die tab, mirroring the `artifactToolsEnabled()` runtime gate.

The clause naming `artifact_end`, verbatim from `ARTIFACT_PANEL_DIRECTIVE` (`src/lib/claude-md-injection.ts:52`):

> …tell the user to review, then drain their feedback with `mcp__peers__artifact_await` (pass back the returned `cursor` each call), revise, `mcp__peers__artifact_reply`, and `mcp__peers__artifact_end` when done.

The directive's tool prefix `mcp__peers__` matches the code group (`peers`). The `gh-artifact-review` skill is named as carrying "the fuller playbook" (`src/lib/claude-md-injection.ts:58`); it is materialized only inside a tab (`src/claude.ts:808`).

Checked-in repo root `CLAUDE.md`: the project-root `CLAUDE.md` has no artifact-tool section (grep for `artifact` at `CLAUDE.md:105,161` hits only "keep-awake" prose, unrelated). The user's private global instructions carry a near-identical "Review in the artifact panel" directive naming `mcp__peers__artifact_end` — consistent with the code. No drift.

## 3. Assessment

### 3a. Description quality

- **Clarity & routing signal.** "End/close … when the review loop is complete" gives a clear WHEN-to-use. The "Only works inside an ai-or-die tab-backed Claude session" tail is the WHEN-NOT signal (and matches the runtime gate + the `missingEnvResult` envelope). Adequate for a lifecycle-terminal verb.
- **End-vs-dismiss distinction.** Weakly signaled at the tool level. `artifact_end` says "End/close … when the review loop is complete"; `artifact_dismiss` (`src/lib/artifact/tools.ts:139`) says "Hide the … panel UI while keeping the review alive". Read side by side the distinction is inferable (end = terminal, dismiss = reversible hide), but `artifact_end`'s own description does not contrast itself against dismiss, so a model that reads only this one tool's description could pick `end` when it meant a temporary hide. The directive (2c) disambiguates ("`artifact_dismiss` to hide the panel while keeping the review alive" vs "`artifact_end` when done"), so in the normal injected path the model has the contrast. Minor.
- **Accuracy vs implementation.** Correct. `end()` POSTs `/end` and maps a `NOT_FOUND` (already-ended) to a successful `{ ok, status:"ended" }` (`src/lib/artifact/client.ts:316-321`), so a duplicate/retry-after-success end is idempotent — the description's "when complete" framing does not overpromise, and a double-call is safe.
- **Schema minimality.** Ideal: zero input fields (`objectSchema({}, [])`). Nothing echoed, nothing diagnostic. The `next_step: "Artifact review loop ended."` output is a terminal no-op hint (there is no next step), harmless but non-actionable; acceptable as a loop-terminator marker.

### 3b. System-prompt coverage

- **Omitted — by design, not a gap.** The peer-awareness snippet is always-on (peer critics register regardless of tab context), whereas the artifact tools only exist inside an ai-or-die tab. Naming them in the always-present snippet would advertise tools that are absent from `tools/list` on every non-tab launch — exactly the anti-pattern `buildPeerAwarenessSnippet` avoids elsewhere (it gates the workers/stand_in/browser sentences on their availability flags). The tab-gated CLAUDE.md directive is the right carrier.
- **Framing compliance** is a non-issue here since the tool is not in the snippet.

### 3c. CLAUDE.md coverage

- **Accurate, not drifted.** The directive names `mcp__peers__artifact_end` with the correct `peers` prefix and correct terminal semantics ("when done"). It is regenerated per launch (`src/lib/claude-md-injection.ts:37`) and idempotent via its own marker fence, so it cannot accumulate stale copies.
- **Injected block vs root CLAUDE.md consistency.** Consistent. The repo root `CLAUDE.md` deliberately does not document artifact tools (they are tab-only, not a proxy-core feature); the user-global directive matches the injected `ARTIFACT_PANEL_DIRECTIVE` text. No contradiction.

### 3d. Cross-surface consistency

No contradictions. Group (`peers`) is consistent across the tool definition, the `GROUP_META` serverInfo, the CLAUDE.md directive prefix, and the user-global directive. Gate is symmetric: list-time drop (`src/routes/mcp/handler.ts:343`), call-time -32601 (`src/routes/mcp/handler.ts:983-993`), and a direct-handler friendly isError (`src/lib/artifact/tools.ts:175-176` → `missingEnvResult`). Wire name unchanged (no rename map). Description, directive, and client behavior agree that `end` terminates the review loop.

## 4. Findings

- **[Suggestion]** `src/lib/artifact/tools.ts:172` — the description does not contrast `end` against `dismiss`, so a model reading only this tool's row (outside the injected directive path, e.g. a BYO `start`/`codex` client hitting the union `/mcp`) could conflate "end" with "hide". Fix: append a one-clause contrast, e.g. "This is TERMINAL — use artifact_dismiss to hide the panel while keeping the review alive." Low impact because the normal `claude` path also injects the disambiguating directive.
- **[Suggestion]** `src/lib/artifact/tools.ts:181` — `next_step: "Artifact review loop ended."` is a non-actionable terminal marker (there is no next step). Per the ruthlessly-minimal principle this field earns its place only as an explicit end-of-loop signal; consider dropping it or making it explicitly "No further artifact calls; continue the task." Non-blocking.

No Critical or Important findings. Specifically, the group-prefix mismatch the brief flagged as a Critical risk does **not** exist: `ARTIFACT_GROUP` is `peers` and the directive uses `mcp__peers__`, so they agree.

## 5. Verdict

**Y.** The injected surface for `artifact_end` is correct, minimal (zero-arg), consistent across all three surfaces, and correctly routed (`peers` group matches the directive prefix; idempotent already-ended handling is safe). Single most useful improvement: add a one-clause end-vs-dismiss contrast to the description for the BYO-client path that never sees the directive.
