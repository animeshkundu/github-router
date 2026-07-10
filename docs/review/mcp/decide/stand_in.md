# Review: `mcp__decide__stand_in`

> Per-tool audit of the model-facing surface github-router auto-injects. One doc per injected MCP tool.
> Reviewer: meta subagent. Verified against code, `file:line` cited.

## 1. Identity

| Field | Value |
|---|---|
| MCP path | `mcp__decide__stand_in` |
| Group / server | `decide` (serverInfo `github-router-decide`) |
| Wire tool name | `stand_in` |
| Definition | `src/lib/peer-mcp-personas.ts:1982` (NON_PERSONA_MCP_TOOLS) |
| Always-on? | gated |
| Capability gate | `stand_in` → `standInToolEnabled()` (`src/lib/mcp-capabilities.ts:50`); dropped from `tools/list` and fails `tools/call` -32601 when the OpenAI slot cannot resolve to gpt-5.6-sol or gpt-5.5, or when claude-opus-4-7(.7) / gemini-3.x-pro is missing from the live catalog (`src/routes/mcp/handler.ts:339`, `:941`) |
| Backing model / endpoint | server-side fn `runStandIn` (`src/lib/stand-in.ts:164`); internally fans out to gpt-5.6-sol xhigh (gpt-5.5 fallback) `/v1/responses`, claude-opus-4-7 xhigh `/v1/messages`, gemini-3.1-pro-preview high `/v1/chat/completions` (`stand-in.ts:109`) |
| Write-capable | no (advisor; recommends, never executes) |

## 2. Injected surfaces (verbatim)

### 2a. Tool `description` (shown in `tools/list`)

`src/lib/peer-mcp-personas.ts:1985-1998`:

> **Away-mode decision tiebreak.** Three-lab advisor (gpt-5.6-sol xhigh (gpt-5.5 fallback), opus-4.7 xhigh, gemini-3.1-pro high) for **when the user is unavailable and you are stuck between two or more concrete options**. Polls all three across two structured rounds (blind vote → informed re-vote with peer reasoning visible) and returns a ranked-choice verdict. Use when: you would otherwise halt and wait for the user. Do NOT use for: code review (use `peer-review-coordinator`), open-ended exploration, single-model second opinions (use `codex_critic` / `gemini_critic` / `opus_critic` directly), or as a substitute for user confirmation on irreversible actions (push, delete, drop, deploy — those still require the user even with three-lab consensus).

Input schema (`:1999-2047`):
- `decision` (string, required) — "One-sentence framing of the choice the user would otherwise make. Be specific about what's being decided, not why."
- `options` (array, required, minItems 2, maxItems 6) — "2-6 concrete options for the panel to vote on. Caller-provided — do NOT ask the panel to generate options. The verdict cites the chosen option by `id`." Item shape (`required: ["id","summary"]`):
  - `id` (string) — "Short stable identifier the verdict refers to (e.g., \"A\", \"lib-x\")."
  - `summary` (string) — "One-line description of the option."
  - `detail` (string, optional) — "Optional longer context for the option (constraints, trade-offs)."
- `context` (string, optional) — "Task / code background that informs the decision. Keep tight — the input is capped at ~6KB total across decision + options + context."

### 2b. System prompt (`--append-system-prompt`)

`buildPeerAwarenessSnippet` (`src/lib/peer-mcp-personas.ts:625-629`), appended only when `opts.standInAvailable`:

> `mcp__decide__stand_in` provides three-lab consensus for decision tiebreak when the user is unavailable.

The clause is gated exactly like the live `tools/list` (`standInAvailable` mirrors `standInToolEnabled()`), so the snippet never names a tool that isn't served. Pinned by `tests/peer-mcp-personas.test.ts:395-409` (present iff `standInAvailable`, namespaced under `decide`).

### 2c. CLAUDE.md (mirrored `<CLAUDE_CONFIG_DIR>/CLAUDE.md`)

Covered by the **peer-awareness** marker block — same text as 2b (the mirror injects `buildPeerAwarenessSnippet` via `src/lib/claude-md-injection.ts`). No separate stand_in-specific line in the mirror.

Checked-in root `CLAUDE.md` documents the tool in the peer-review-and-advisor paragraph: "`mcp__decide__stand_in` provides three-lab consensus for decision tiebreak when the user is unavailable." (matches 2b). The detailed reference is `docs/peer-mcp-design.md:449-518` "`stand_in` tool (away-mode advisor)"; every claim there (blind R1 → informed R2 → abstain, the four verdicts, `isError` false for `no_consensus`/`need_more_info`, per-model fixed effort, gate, 6KB cap, one-slot accounting) matches the code read below.

## 3. Assessment

### 3a. Description quality

- **Clarity & routing signal:** Strong. The description leads with the use trigger ("when the user is unavailable and you are stuck between two or more concrete options"), gives an explicit positive route ("Use when: you would otherwise halt and wait for the user"), and a four-way negative-route list that hands each adjacent job to its correct owner (code review → `peer-review-coordinator`; single-model → the named critics). This is the deliberately narrow auto-invocation wording the source comment calls out (`:1976-1981`).
- **Scope bound (advisor not decider):** Present and correct. The final "Do NOT use for" clause reads "or as a substitute for user confirmation on irreversible actions (push, delete, drop, deploy — those still require the user even with three-lab consensus)." This is the load-bearing safety clause and it is unambiguous: consensus does not authorize execution. Matches the `stand-in.ts:6-9` module doc, the `:1970-1974` entry comment, and `docs/peer-mcp-design.md:453-455`.
- **Accuracy vs implementation:** All facts check out. "gpt-5.6-sol xhigh (gpt-5.5 fallback), opus-4.7 xhigh, gemini-3.1-pro high" matches `STAND_IN_MODELS` (`stand-in.ts:109-113`) — gemini pinned to `high` because it rejects `xhigh` at the wire. "two structured rounds (blind vote → informed re-vote with peer reasoning visible)" matches the R1/R2 protocol (`stand-in.ts:168-231`). "ranked-choice verdict" matches the four-verdict output. Model ids in the human-readable description use display forms (opus-4.7 / gemini-3.1-pro) that resolve to the exact catalog ids in `STAND_IN_MODELS` — no stale slug.
- **Schema minimality:** Clean. `{decision, options[], context?}` — three fields, each required-to-call or directly outcome-shaping. Per the "ruthlessly minimal MCP tool surface" principle (`docs/peer-mcp-design.md:482-500`): `decision` frames the vote, `options[]` is what gets voted on, `context` is the evidence. The `options` item shape `{id, summary, detail?}` is minimal — `id` is the verdict citation key, `summary` is the vote target, `detail` is optional depth. **Per-model effort is correctly NOT exposed** — the schema has no `effort` field; effort is fixed in `STAND_IN_MODELS` and the module doc (`stand-in.ts:100-108`) states exposing it "would invite the caller to cheap out and would muddy the consensus signal." The design non-negotiable is honored at the schema boundary. No echoed-input or diagnostic-only fields.

### 3b. System-prompt coverage

- **Named:** Yes, when `standInAvailable`. Correctly gated and correctly omitted on lesser tiers.
- **Accurate & non-redundant:** The one-liner ("three-lab consensus for decision tiebreak when the user is unavailable") is a compressed restatement of the description's trigger, not a duplicate — appropriate for an awareness snippet whose job is a routing pointer, with the full when/when-not living in the description.
- **Framing-constraint compliance:** Compliant. The clause is a capability statement ("provides three-lab consensus…"), not an imperative — no "Lead with", "Reach for", "Brief them", no hedges, no anchors. Passes the framing pins in `tests/peer-mcp-personas.test.ts:534-538`.

### 3c. CLAUDE.md coverage

- **Accurate, non-drifted:** Yes. The mirrored block is the same awareness snippet (2b). The checked-in root `CLAUDE.md` line and the `docs/peer-mcp-design.md:449-518` section both agree with the code — verdict table, `isError` semantics, gate predicate, 6KB cap, and slot accounting all match what I read in `stand-in.ts`, `peer-mcp-personas.ts:2453-2552` (`runStandInToolCall`), `handler.ts:627-655`, and `mcp-capabilities.ts:50-59`.
- **Injected vs checked-in consistency:** Consistent; no contradiction.

### 3d. Cross-surface consistency

No contradictions across description ↔ system prompt ↔ CLAUDE.md ↔ code. The `isError` contract (stays falsy for `no_consensus`/`need_more_info`, set only on input-shape failure) is confirmed in `runStandInToolCall` (`peer-mcp-personas.ts:2460-2551`: every early return that sets `isError:true` is a shape/validation failure; the success path at `:2549-2551` returns the verdict JSON with no `isError` field). The 6KB pre-flight cap and "use SSE" actionable error are present and fire before slot acquisition (`handler.ts:627-655`, comment at `:821`).

## 4. Findings

- **[Suggestion]** `src/lib/peer-mcp-personas.ts:2010-2039` — the `options` array schema omits `minItems`/`maxItems` from the human-readable `description` only in the sense that the "2-6" bound lives in both the JSON-schema constraint (`minItems: 2, maxItems: 6`) and the prose ("2-6 concrete options"), so a strict client validates and a prose-only reader still learns the bound. No defect; the redundancy is helpful, not drift. No change needed.
- **[Suggestion]** `src/lib/peer-mcp-personas.ts:2044` — `context` description says the input is "capped at ~6KB total across decision + options + context." The cap is enforced only on the JSON path (`handler.ts:640-653`); the SSE path bypasses it (`handler.ts:631` scope note and `docs/peer-mcp-design.md:517`). A caller reading the schema would assume the 6KB cap is absolute. Minor, and the description's intent (keep it tight) is sound regardless of path, so this is polish only — optionally note "on the JSON path" if precision is wanted. Not blocking.

No Critical and no Important findings. Specifically, the description does **not** let the model treat `stand_in` as an executor: the scope-bound clause explicitly withholds authorization for push/delete/drop/deploy even under consensus, and the tool is server-side read-only (`runStandIn` dispatches model calls and returns a verdict envelope; it performs no repo/GitHub/filesystem mutation). No misroute-to-executor repro exists.

## 5. Verdict

**Y** — the injected surface is correct, minimal, consistent, and well-routed. The scope bound (advisor not decider) is stated on the description's safety clause, per-model effort is correctly withheld from the schema, and all three surfaces agree with the code. Single optional polish: qualify the "~6KB cap" in the `context` field description as JSON-path-only.
