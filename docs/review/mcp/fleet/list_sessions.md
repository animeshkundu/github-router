# Review: `mcp__fleet__list_sessions`

> Per-tool audit of the model-facing surface github-router auto-injects. One doc per injected MCP tool.
> Reviewer: meta subagent. Fill every section. Cite `file:line`. Verify claims against code, do not assert.

## 1. Identity

| Field | Value |
|---|---|
| MCP path | `mcp__fleet__list_sessions` |
| Group / server | `fleet` (serverInfo `github-router-fleet`) |
| Wire tool name | `list_sessions` |
| Definition | `src/lib/fleet/tools.ts:320` (factory `tool()` at `src/lib/fleet/tools.ts:283`) |
| Always-on? | gated by capability `fleet` |
| Capability gate | `fleet` → `fleetToolsEnabled()` (`src/lib/mcp-capabilities.ts:182`) = `state.fleetEnabled || GH_ROUTER_ENABLE_FLEET === "1"`; no local dependency check |
| Backing model / endpoint | server-side fn (calls the remote ai-or-die instance's `/api/sessions` via `FleetClient.listSessions`, `src/lib/fleet/tools.ts:326`) |
| Write-capable | no (read-only enumeration) |

Gate is enforced on BOTH surfaces: `tools/list` (`src/routes/mcp/handler.ts:341`) and `tools/call` (`src/routes/mcp/handler.ts:961-971`, returns `-32601 unknown tool` when off). Capability tag set at `src/lib/fleet/tools.ts:294`.

## 2. Injected surfaces (verbatim)

### 2a. Tool `description` (shown in `tools/list`)

Description string (`src/lib/fleet/tools.ts:322`):

> `List sessions on one fleet instance, returning globally-addressable session ids.`

Input schema (`src/lib/fleet/tools.ts:323`, via `objectSchema` → `type:"object"`, `additionalProperties:false`, `required:[]`):

- `instance` (string, optional) — `"Instance id or label. Defaults to the registry default, or the sole instance."`

No required fields. `instance` is read through `optionalString(args, "instance")` and passed to `resolve()` (`src/lib/fleet/tools.ts:325`); a blank/whitespace value collapses to `undefined` and takes the default path.

### 2b. System prompt (`--append-system-prompt`)

NOT named. `buildPeerAwarenessSnippet` (`src/lib/peer-mcp-personas.ts:555-646`) has no fleet branch at all — the `fleet` group is neither in its `opts` nor in any `para2Parts` push. The snippet names `peers`, `search`, `workers`, `orchestrate`, `decide`, and `browser` only. So neither this tool NOR the `fleet` group NOR any sibling fleet tool appears in the appended system prompt. The whole fleet surface is invisible to the system prompt; the model discovers it only via `tools/list`.

This is consistent with the mirrored CLAUDE.md, which is built from the same function (see 2c).

### 2c. CLAUDE.md (mirrored `<CLAUDE_CONFIG_DIR>/CLAUDE.md`)

No injected marker block covers this tool. The mirrored peer-awareness block is produced by the SAME `buildPeerAwarenessSnippet` call (`src/claude.ts:1019`, appended at `src/claude.ts:1035-1045`), so it carries zero fleet text. The other injected blocks (style directive, operating-defaults, toolbelt, artifact-panel directive) do not mention fleet either.

Checked-in repo `CLAUDE.md` (project root): zero occurrences of "fleet" (case-insensitive grep, no matches). The root CLAUDE.md documents every other MCP server split but omits fleet entirely — there is no "six/seven intent-named MCP servers" fleet row.

Operator-facing docs DO exist and agree with the code: `docs/aiordie-fleet.md` documents the `/mcp/fleet` surface, the `--fleet` / `GH_ROUTER_ENABLE_FLEET=1` opt-in, the registry file, tunnel auth, and the globally-unique session id routing (`docs/aiordie-fleet.md:6-13`). These are human/operator docs, not a model-facing injected surface, and `list_sessions` is not individually named there. `docs/fleet-control-plane-contract.md` and `docs/fleet-fixes-progress-ghr.md` are internal contract/progress docs.

## 3. Assessment

### 3a. Description quality

- **Clarity & routing signal.** The one-liner is accurate and states the two load-bearing facts: scope is ONE instance (not the whole fleet) and the returned ids are globally addressable. "globally-addressable session ids" is truthful: `globalizeSession` re-encodes each summary's `sessionId` via `encodeSessionId(instanceId, localId)` → `"instanceId:localId"` (`src/lib/fleet/tools.ts:329,936-938`; `encodeSessionId` at `src/lib/fleet/client.ts:298-300`), and every downstream tool (`read_session`, `session_status`, `send_message`, …) requires exactly that `instanceId:localSessionId` form. So the description correctly signals that its output is the addressing key for the rest of the fleet surface. There is no explicit when-NOT-to-use, but for a pure enumeration tool that is acceptable — the natural contrast (`list_instances` first to enumerate instances, then `list_sessions` per instance) is legible from the sibling descriptions.
- **Accuracy vs implementation.** No stale facts. There is no model id, default, or behavior claim that drifts. The `instance` default behavior ("registry default, or the sole instance") is delegated to `resolve()` → `getRegistry().resolveInstance(arg)`; the description's wording matches the sibling read-only tools (`read_file`/`list_dir`/`search`) verbatim, which is the resolver's documented contract.
- **Schema minimality.** Minimal and clean. Single optional field, all model-tunable and actionable; `additionalProperties:false` and `required:[]` are correct. No echoed-input or diagnostic-only fields in the schema. (Output-side: the handler wraps results as `{resolvedInstance, sessions}` — `resolvedInstance` is `{id, label}` only via `publicInstance`, `src/lib/fleet/tools.ts:1086-1088`, so no token/url leaks; `sessions` carries the globalized ids the caller needs next. Output is actionable, not diagnostic bloat.)

### 3b. System-prompt coverage

- **Omitted — by design, with a real caveat.** Fleet is an opt-in remote-control surface (off by default, `--fleet`), and the design keeps the whole group out of the awareness snippet. This is defensible: it avoids advertising a capability that is absent on the default (non-fleet) launch, and mirrors how the snippet already gates `browser`/`decide`/`workers` behind their availability flags. The one asymmetry worth noting: `browser`, `decide`, and `workers` ARE conditionally named when their gate is on, whereas `fleet` is NEVER named even when `fleetToolsEnabled()` is true. When an operator runs `--fleet`, the fleet group is registered (`src/claude.ts:567`) and its tools appear in `tools/list`, but the system prompt gives the model no orientation on WHEN to reach for fleet vs local workers. The task frames this ("confirm the only model-facing surface is the tool `description` and judge acceptability") — it is acceptable but not ideal: routing between "drive a remote ai-or-die session" and "spawn a local worker" is exactly the kind of cross-tool choice the snippet exists to seed, and fleet is the one enabled group left without a sentence.
- **Framing-constraint compliance.** N/A for the snippet (nothing to comply with — no fleet text). The tool description itself contains no imperatives, hedges, or anchors.

### 3c. CLAUDE.md coverage

- **Injected block:** none, consistent with 2b (same source function). No drift, because there is nothing to drift.
- **Checked-in root CLAUDE.md:** fleet is entirely undocumented there. Every other auto-injected MCP server is described in the root CLAUDE.md "server split" section; fleet is the sole omission. This is a documentation gap for a maintainer reading the repo, not a model-facing defect (the model never reads the root CLAUDE.md's server-split prose as an injected instruction). The operator-facing `docs/aiordie-fleet.md` fills the human gap and agrees with the code.

### 3d. Cross-surface consistency

No contradictions. The three model-facing surfaces reduce to one (the description), and it matches the implementation exactly: scope = one instance, output = globalized ids, gate = `fleet` capability enforced list-time and call-time. The description, the `globalizeSession`/`encodeSessionId` behavior, and the downstream tools' `instanceId:localSessionId` expectation all line up.

## 4. Findings

- **[Suggestion]** `src/lib/peer-mcp-personas.ts:555` (`buildPeerAwarenessSnippet`) — when `fleetToolsEnabled()`, the fleet group is registered and listed but gets no system-prompt / CLAUDE.md sentence, unlike every other conditionally-enabled group (browser/decide/workers each get one). Fix: add a gated one-liner (e.g. threaded via a `fleetAvailable` opt) naming `mcp__fleet__*` as the remote ai-or-die session-control surface and the one routing cue ("drive a session on a remote instance vs a local worker"), so the model has orientation on when to use it. Non-blocking: the description is self-sufficient for a model that already inspects `tools/list`.
- **[Suggestion]** root `CLAUDE.md` — the "intent-named MCP servers" section enumerates every injected server except `fleet`. Add a fleet row for maintainer parity with `docs/aiordie-fleet.md`. Documentation-only; no model-facing impact.

No Critical or Important findings for `list_sessions`. Its injected surface is correct, minimal, and self-consistent; the schema is a single optional field with no minimality violations; the gate is enforced on both `tools/list` and `tools/call`.

## 5. Verdict

Y — the injected surface (a single accurate one-line description + one optional `instance` field) is correct, minimal, consistent, and well-routed for an enumeration tool. Single most important improvement: give the `fleet` group one gated sentence in `buildPeerAwarenessSnippet` when enabled, so the model gets remote-vs-local routing orientation the description alone can't supply.
