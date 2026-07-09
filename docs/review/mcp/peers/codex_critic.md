# Review: `mcp__peers__codex_critic`

> Per-tool audit of the model-facing surface github-router auto-injects. One doc per injected MCP tool.
> Reviewer: meta subagent. Fill every section. Cite `file:line`. Verify claims against code, do not assert.

## 1. Identity

| Field | Value |
|---|---|
| MCP path | `mcp__peers__codex_critic` |
| Group / server | `peers` (serverInfo `github-router-peers`) |
| Wire tool name | `codex_critic` |
| Definition | `src/lib/peer-mcp-personas.ts:335` (PersonaSpec); input schema built in `src/routes/mcp/handler.ts:295-324` |
| Always-on? | yes (no `requiresGeminiCatalog`, no `capability` gate) |
| Capability gate | none. `requiresHttp: false`, so it can also route via the codex-cli stdio bridge under `--codex-cli` |
| Backing model / endpoint | `gpt-5.5` `/v1/responses` (`peer-mcp-personas.ts:336-337`) |
| Write-capable | no (`writeCapable: false`, `peer-mcp-personas.ts:342`) |

`baseInstructions = CRITIC_BASE` (`peer-mcp-personas.ts:229-235`), which is `COLD_START_CONTRACT` + `CRITIC_RUBRIC`. `agentPrompt: ""` (line 341) means the subagent's full system prompt is assembled at launch by `buildAgentPrompt` (`peer-mcp-personas.ts:458-500`), not stored. `defaultEffort: "xhigh"`, `allowedEfforts: ["low","medium","high","xhigh"]` (lines 344-345), confirmed by `tests/peer-mcp-personas.test.ts:134,141`.

## 2. Injected surfaces (verbatim)

### 2a. Tool `description` (shown in `tools/list`)

Description (`peer-mcp-personas.ts:338-339`):

> Adversarial second opinion on plans, designs, or code tradeoffs. Backed by gpt-5.5 (OpenAI, ≈922K-token input window) — strongest reasoning model in the critic lineup, different lab than Opus. Best for architecture decisions, design reviews, and tradeoff analysis where cross-lab diversity matters. Not for line-level code review (use codex_reviewer). Pass artifact verbatim.

Input schema (`handler.ts:295-324`), fields + their `description`:

- `prompt` (string, **required**): "The lead's brief — the artifact under review plus constraints."
- `context` (string, optional): "Optional additional context (extra file content, prior decisions). Concatenated to the brief before sending."
- `effort` (string, optional, `enum: ["low","medium","high","xhigh"]`): "Reasoning depth (low | medium | high | xhigh). Default \"xhigh\". Higher tiers cost more wall-clock; lower tiers are quicker sanity checks. " (the `/v1/chat/completions` gemini caveat is appended only for chat-endpoint personas, so it is absent here — codex_critic is `/v1/responses`).

`additionalProperties: false`. Note the em dash in the `prompt` description and in the tool `description` itself (see 3a).

### 2b. System prompt (`--append-system-prompt`)

`buildPeerAwarenessSnippet` (`peer-mcp-personas.ts:555-646`) names codex_critic exactly once, inside the `criticList` join emitted in the paragraph-1 sentence (`peer-mcp-personas.ts:577,642`):

> Cross-lab peer critics under `mcp__peers__*` (`codex_critic` (gpt-5.5), `codex_reviewer` (gpt-5.3-codex), … `opus_critic` (Opus 4.7)) are available at your discretion for adversarial review. Each tool's description explains its scope and when it applies. The `peer-review-coordinator` subagent fans out to the appropriate critics in parallel and aggregates findings by severity. …

So the snippet gives codex_critic a bare capability tag `` `codex_critic` (gpt-5.5) `` and defers routing ("Each tool's description explains its scope and when it applies") to surface 2a. No scope, when-to-use, or when-not clause here — by design (`peer-mcp-personas.ts:508-514`).

Subagent system prompt (the Claude Code `codex-critic` agent): `buildAgentPrompt(persona, {codexCli:false, peersKey:"peers"})` returns `# Subagent: codex-critic` + `CRITIC_BASE` verbatim + a routing block instructing the subagent to always invoke `mcp__peers__codex_critic` with `{prompt (verbatim), context (optional)}`, "Do NOT pass model or instructions — they are server-baked", then "surface its output to the lead verbatim" (`peer-mcp-personas.ts:487-499`). `CRITIC_BASE` itself carries the identity ("adversarial reviewer running on gpt-5.5"), the anti-sycophancy framing, the cold-start contract, and the 1-5 grading rubric (`peer-mcp-personas.ts:229-235`, `193-218`, `220-227`).

### 2c. CLAUDE.md (mirrored `<CLAUDE_CONFIG_DIR>/CLAUDE.md`)

The **peer-awareness marker block** covers this tool. `appendPeerAwarenessToMirroredClaudeMd` (`claude-md-injection.ts:653-663`) writes the SAME `buildPeerAwarenessSnippet` string (surface 2b) into the mirror under the `PEER_MARKER_OPEN/CLOSE` fence (`claude-md-injection.ts:20-22`). So the mirrored-CLAUDE.md clause for codex_critic is byte-identical to 2b: the `` `codex_critic` (gpt-5.5) `` capability tag inside the critic list. No separate per-tool block.

Checked-in repo root `CLAUDE.md`: the "Peer-model MCP integration" section (`CLAUDE.md:125-127`) documents the group and names `` `codex-critic` gpt-5.5 `` as an auto-injected subagent. It agrees with the code (agentName `codex-critic`, wire tool `codex_critic`, model gpt-5.5). `docs/peer-mcp-design.md` is the deep reference and independently corroborates the ≈922K-token gpt-5.5 window (`peer-mcp-design.md:177,203`), the xhigh default via SSE streaming (`peer-mcp-design.md:179,185`), and the full allowedEfforts row (`peer-mcp-design.md:185`).

## 3. Assessment

### 3a. Description quality

**Clarity & routing signal — strong.** The description does the three things Anthropic's tool-use guidance asks for and the repo pins in `tests/peer-mcp-personas.test.ts:104-109`: states scope ("plans, designs, or code tradeoffs"), when-to-use ("architecture decisions, design reviews, tradeoff analysis where cross-lab diversity matters"), and an explicit when-NOT with a redirect ("Not for line-level code review (use codex_reviewer)"). It carries the load-bearing routing signal (model identity `gpt-5.5`, pinned by `tests/peer-mcp-personas.test.ts:88`) and the cold-start "Pass artifact verbatim" contract (pinned by `tests/peer-mcp-personas.test.ts:104`). Length 375 chars, under the 400 cap (`tests/peer-mcp-personas.test.ts:109`).

**Differentiation from siblings — good.** Against the other peers the routing planes are distinct:
- vs `codex_reviewer` (`peer-mcp-personas.ts:368`): reviewer is "line-level review of a concrete diff or single file … Not suited for architecture"; codex_critic is "architecture / design / tradeoffs … Not for line-level code review". The two descriptions cross-reference each other, so a misroute in either direction self-corrects.
- vs `gemini_critic` (`peer-mcp-personas.ts:353`): gemini is framed as "third-lab triangulation … cross-checking findings from codex_critic or codex_reviewer"; codex_critic is the primary "strongest reasoning model in the critic lineup". A reader learns codex_critic is the first-choice architecture critic and gemini is the triangulation/second-opinion layer.
- vs `opus_critic` (`peer-mcp-personas.ts:404`): opus is "same lab … limited blind-spot diversity"; codex_critic is "different lab than Opus", making the cross-lab value explicit. Clear separation.

**Accuracy vs implementation — accurate.** Model `gpt-5.5` matches line 336. "≈922K-token input window" matches the design-doc figure at `peer-mcp-design.md:177,203`. "different lab than Opus" is true (OpenAI vs Anthropic). "strongest reasoning model in the critic lineup" is an editorial claim but consistent with the design doc's latency/window framing. Default effort xhigh (not stated in the description, but surfaced in the `effort` schema field) matches line 344. No stale model id, no wrong gate.

**Schema minimality — passes.** Three fields, each clears one of the three minimality bars (`docs/peer-mcp-design.md:314-320`):
- `prompt` — (a) required to call the tool; it is the artifact under review.
- `context` — (a)/(b) the second half of the brief, concatenated by `buildUserText` (`handler.ts:364-366`). Genuinely used, not echoed back.
- `effort` — (b) model-tunable; the enum is per-persona (`handler.ts:315`) so the model only ever sees tiers codex_critic actually accepts, and an out-of-range value is rejected at `handler.ts:1054-1060` / `671`. No diagnostic-only or echoed-input fields; `additionalProperties: false` keeps the surface closed. Nothing to cut.

### 3b. System-prompt coverage

**Named, minimally, by design.** codex_critic appears only as `` `codex_critic` (gpt-5.5) `` in the critic list (`peer-mcp-personas.ts:577`). The snippet deliberately delegates the when/when-not routing to the tool `description` and says so ("Each tool's description explains its scope and when it applies", `peer-mcp-personas.ts:642`). This matches the documented contract (`peer-mcp-personas.ts:508-514`, and `docs/review/mcp/README.md:17`: "Group + all critics named").

**Framing-constraint compliant.** The clause is a pure capability tag: no imperative, no hedge, no anchor disguised as description. It survives every negative pin in `tests/peer-mcp-personas.test.ts:516-552` (no `→`, no "Lead with", no "Reach for", no em dash, "at your discretion" present). Non-redundant with the description (the snippet gives the namespace + model tag; the description gives scope) and accurate (model tag `gpt-5.5` matches).

### 3c. CLAUDE.md coverage

**Accurate and non-drifted.** The mirrored peer-awareness block is the identical `buildPeerAwarenessSnippet` output (`claude-md-injection.ts:653-663`), so it inherits 2b's correctness and framing compliance. The checked-in root `CLAUDE.md:127` names `codex-critic gpt-5.5` consistently with the code. No contradiction between the injected block and the checked-in doc for this tool.

### 3d. Cross-surface consistency

For codex_critic specifically, the three surfaces agree: description (gpt-5.5, architecture critic, cross-lab), awareness snippet (`codex_critic` (gpt-5.5)), and CLAUDE.md (both the mirrored block and the root doc) all name model gpt-5.5 and the adversarial-critic role. The subagent prompt routes to `mcp__peers__codex_critic` and the wire name matches. No codex_critic-scoped contradiction found.

One adjacent, non-blocking observation: the awareness snippet's critic list labels `opus_critic` as "(Opus 4.7)" (`peer-mcp-personas.ts:585`) while the code pins opus to `claude-opus-4-6` and that tool's own description says "Opus 4.6". That inconsistency lives on the opus_critic surface, not codex_critic's, and belongs in the opus_critic doc; codex_critic's own "(gpt-5.5)" tag is correct.

## 4. Findings

- **[Suggestion]** `peer-mcp-personas.ts:339` and `handler.ts:302` — the tool `description` and the `prompt` field description each contain an em dash ("… critic lineup, different lab than Opus" uses `—`; "The lead's brief — the artifact…"). The repo style directive injected into the same session says "Avoid em dashes" (`claude-md-injection.ts:76`), and the awareness snippet is negative-pinned against em dashes (`tests/peer-mcp-personas.test.ts:551`). The persona descriptions are exempt from that pin, so this is cosmetic-only and not a correctness issue, but replacing the em dashes with commas/periods would make the injected surfaces self-consistent. Fix: swap the two `—` for a comma or period.

- **[Suggestion]** `peer-mcp-personas.ts:339` — "strongest reasoning model in the critic lineup" is a superlative that will silently go stale if a stronger non-Claude critic model is ever added or gpt-5.5 is superseded. It is currently defensible (design doc frames gpt-5.5 as the big-window, top-reasoning peer, `peer-mcp-design.md:177`), so this is a durability nit, not a defect. Fix (optional): soften to "the strongest-reasoning of the current critic lineup" or drop the superlative; the "architecture / design / tradeoffs, different lab than Opus" signal already routes correctly without it.

No Critical or Important findings. The description does not tell the model to do anything the code rejects (the effort enum and required-`prompt` schema match the handler's validation at `handler.ts:295-324,671,1054-1060`), the gate is correctly documented as always-on, and the model id / default / window figure are all accurate against code and the design doc.

## 5. Verdict

**Y** — codex_critic's injected surface is correct, minimal, consistent across all three surfaces, and well-routed (clear scope, explicit when-not with a redirect to codex_reviewer, and differentiation from the other three critics). Single most useful polish: drop the two em dashes to match the session's own style directive (Suggestion-level only).
