# Review: `mcp__peers__codex_implementer`

> Per-tool audit of the model-facing surface github-router auto-injects. One doc per injected MCP tool.
> Reviewer: meta subagent. Fill every section. Cite `file:line`. Verify claims against code, do not assert.

## 1. Identity

| Field | Value |
|---|---|
| MCP path | `mcp__peers__codex_implementer` — **NOT actually registered** (see 3a). Real surface is the `codex-implementer` subagent routing to `mcp__codex-cli__codex` (stdio). |
| Group / server | nominally `peers` (serverInfo `github-router-peers`), but the write persona is excluded from the peers `tools/list` |
| Wire tool name | `codex_implementer` (`toolNameHttp`, `peer-mcp-personas.ts:426`) |
| Definition | `src/lib/peer-mcp-personas.ts:423-439` (`PERSONAS_WRITE`) |
| Always-on? | gated: subagent registered only when `--codex-cli` resolves to a live `cli` backend (`personasFor` pushes `PERSONAS_WRITE` iff `opts.codexCli`, `peer-mcp-personas.ts:663-665`) |
| Capability gate | `resolveCodexCliBackend()` (`codex-mcp-config.ts:68-82`) — requires `--codex-cli` AND codex 0.129+ on PATH; else falls back to HTTP-only and the persona is dropped |
| Backing model / endpoint | `gpt-5.3-codex` via `mcp__codex-cli__codex` stdio bridge (`sandbox: workspace-write`, `approval-policy: on-request`). The `PersonaSpec.endpoint` field is `/v1/responses` (`:428`) but that HTTP dispatch path is never reached for this persona. |
| Write-capable | yes — but the write happens ONLY inside the external `codex mcp-server` sandbox, not through the proxy's persona/HTTP layer |

## 2. Injected surfaces (verbatim)

### 2a. Tool `description` (shown in `tools/list`)

The `PersonaSpec.description` string (`peer-mcp-personas.ts:429-430`):

> "Targeted implementation of a self-contained coding task. Backed by gpt-5.3-codex with workspace-write access. Pass spec + files verbatim."

Input schema: this persona is NOT surfaced through `toolEntries()` (see 3a), so it advertises no HTTP `tools/list` schema. The description string is instead attached to the `codex-implementer` **subagent** definition (`codex-mcp-config.ts:299-302`, `out[persona.agentName].description = persona.description`), i.e. it is the subagent's `description:` frontmatter, not an MCP-tool description.

**Subagent system prompt** — `baseInstructions` (`IMPLEMENTER_BASE`, `peer-mcp-personas.ts:296-320`), verbatim:

> "You are codex-implementer, a focused implementation specialist running on gpt-5.3-codex with workspace-write access. You execute scoped, well-specified coding tasks end-to-end: read the relevant files, make the change, verify it, report back.
>
> You are not a planner. If the brief is vague or missing acceptance criteria, ask the lead for the missing piece BEFORE editing anything. A wasted edit is worse than a clarifying question.
>
> [COLD_START_CONTRACT]
>
> What "done" looks like for an implementation task:
>   - Exactly the files specified by the brief have been changed (or you reported back why a different scope was needed).
>   - The change is minimal — surrounding cleanup is out of scope unless requested.
>   - You ran the relevant test(s) / typecheck / linter for the touched files and report the results.
>   - The summary you return enumerates each file changed with a one-line description.
> [Status / Files changed / Verification / Notes reply format]
> Resilience reminder:
>   If your session terminates abnormally before "Status: complete", the lead will retry once. On recovery, ask the lead to confirm what's already been done before re-applying changes — duplicate edits are worse than a slow restart."

**Subagent routing block** — `buildAgentPrompt` with `useStdio` true (`peer-mcp-personas.ts:467-479`), verbatim for the write-capable branch:

> "Always invoke the `mcp__codex-cli__codex` tool with these arguments:
>   - `prompt`: the lead's brief, copied verbatim
>   - `model`: "gpt-5.3-codex"
>   - `base-instructions`: the persona text below (paste verbatim, do not paraphrase)
>   - `sandbox`: "workspace-write"
>   - `approval-policy`: "on-request""

### 2b. System prompt (`--append-system-prompt`)

`buildPeerAwarenessSnippet` names this tool ONLY through `codexCliClause` (`peer-mcp-personas.ts:587-589`), and only when `opts.codexCli` is true. Verbatim:

> " `mcp__codex-cli__codex` dispatches to `codex-implementer` (gpt-5.3-codex with workspace-write) for end-to-end coding tasks."

This clause is appended to the end of the first snippet paragraph (`peer-mcp-personas.ts:642`). Note the snippet correctly names the **stdio** tool `mcp__codex-cli__codex`, not a `mcp__peers__codex_implementer` tool — so the system prompt is more accurate than the description string and the root CLAUDE.md (see 3c/3d). The wire name `codex_implementer` never appears in the snippet.

### 2c. CLAUDE.md (mirrored `<CLAUDE_CONFIG_DIR>/CLAUDE.md`)

Covering block: **peer-awareness** — the exact same text as 2b. The mirrored CLAUDE.md is written by `appendPeerAwarenessToMirroredClaudeMd` (`claude-md-injection.ts:653-663`), which injects the identical `buildPeerAwarenessSnippet` output under the peer-marker fence. So the `codexCliClause` sentence reaches descendant agents verbatim; no separate CLAUDE.md text exists for this tool.

Checked-in root `CLAUDE.md` reference (`CLAUDE.md:129`, "Six intent-named MCP servers"): lists the `peers` group as containing "the critics + `gemini_reviewer` … + `codex_implementer` in `--codex-cli`". This phrasing implies `codex_implementer` is a `peers`-group HTTP tool alongside the critics, which does not match the code (see 3c). The design doc `docs/peer-mcp-design.md:12` repeats the same implication ("the critics: `codex_critic` … + `codex_implementer` in `--codex-cli` mode").

## 3. Assessment

### 3a. Description quality

- **The HTTP tool does not exist.** `toolEntries()` (`handler.ts:287-326`) and `activePersonas()` (`handler.ts:267-285`) build the `peers` `tools/list` exclusively from `PERSONAS_READ`. `PERSONAS_WRITE` is never referenced anywhere in `handler.ts`. A `tools/call` for `codex_implementer` would fall through the persona lookup (`handler.ts:884`, `activePersonas().find(...)`) and the non-persona lookup and return the unknown-tool error. So the tool `description` at `:429-430` is only ever consumed as **subagent frontmatter**, never as an MCP `tools/list` entry. The Identity framing in the review brief ("`mcp__peers__codex_implementer` (HTTP) OR `mcp__codex-cli__codex` (stdio)") is half wrong: only the stdio surface is real.
- **"workspace-write access" is a property of the codex-cli sandbox, not the persona.** `dispatchModelCall` for `/v1/responses` (`handler.ts:728-748`) issues a plain non-streaming `createResponses` call with no `tools` array, no file access, and no sandbox — it returns text via `extractResponsesText`. If the HTTP path were ever wired up, calling `codex_implementer` would produce a text answer and mutate nothing. Write capability exists solely because the `codex-implementer` subagent routes to `mcp__codex-cli__codex` with `sandbox: "workspace-write"` (`peer-mcp-personas.ts:475`), which spawns `codex mcp-server` (`codex-mcp-config.ts:155-165`). The description's "Backed by gpt-5.3-codex with workspace-write access" is therefore accurate ONLY for the stdio subagent, and only because of the external codex sandbox.
- **Description omits the write-scope discipline.** For the one write-capable surface in the entire injected tool set, the `description` (`:429-430`) says nothing about scope discipline, minimal-diff, or ask-before-editing. That guidance lives in `baseInstructions` (`:298`, `:302-306`) but the description is what the lead reads when routing. A write tool's description should signal "this mutates files; keep scope tight" so the lead pastes a bounded brief. Compare the read personas, whose descriptions all carry an explicit "Not for X" routing negative; the write persona carries none.
- Accuracy of stated facts: model `gpt-5.3-codex` matches `:427`. "Pass spec + files verbatim" matches the cold-start contract (`:220-227`) and is pinned by test (`peer-mcp-personas.test.ts:177-181`). No stale model id.
- Schema minimality: N/A for the HTTP surface (no schema is emitted). The stdio routing block passes exactly `prompt` / `model` / `base-instructions` / `sandbox` / `approval-policy` — all required by the codex mcp-server call, none echoed or diagnostic-only.

### 3b. System-prompt coverage

- **Named**, conditionally (`codexCli` only) and correctly, via `codexCliClause` (`:587-589`). The clause names the real stdio tool `mcp__codex-cli__codex` and correctly describes it as dispatching to `codex-implementer (gpt-5.3-codex with workspace-write)`. This is the most accurate of the three surfaces.
- Non-redundant with the description: the snippet frames it as the coding-task dispatcher; the description frames the task shape. No contradiction.
- Framing-constraint compliance: the clause is factual present tense ("dispatches to … for end-to-end coding tasks") with no imperative, hedge, or anchor. Compliant with the negative pins in `tests/peer-mcp-personas.test.ts`.
- Minor: the clause does not signal write/mutation risk in the snippet either, but the snippet is a capability inventory and the description is the routing surface, so this is a description-layer concern (3a), not a snippet gap.

### 3c. CLAUDE.md coverage

- Mirrored CLAUDE.md (peer-awareness block) is byte-identical to the system prompt (2b) and thus accurate — it names `mcp__codex-cli__codex`, not a phantom HTTP tool.
- **Checked-in root CLAUDE.md is drifted.** `CLAUDE.md:129` lists `codex_implementer` as a member of the `peers` group alongside the critics, implying an HTTP `mcp__peers__codex_implementer` tool. The code excludes `PERSONAS_WRITE` from the peers `tools/list`; the only thing that registers the name under "peers" is the `assertMcpToolSurfaceConsistent` uniqueness guard (`peer-mcp-personas.ts:2113`), which iterates `[...PERSONAS_READ, ...PERSONAS_WRITE]` purely to reserve the name and prevent a collision — it does not surface the tool. `docs/peer-mcp-design.md:12` carries the same misleading grouping.
- The design doc is otherwise silent on this write persona: `docs/peer-mcp-design.md` has exactly one hit for `codex_implementer` (the group-membership line at `:12`) and none of the "Worker tools" or minimality worked-examples cover it. For the sole write-capable injected surface, that is thin documentation.

### 3d. Cross-surface consistency

- **description ↔ code**: description implies an HTTP tool that is not registered; write capability attributed to the persona actually lives in the external codex sandbox. Divergence.
- **system prompt ↔ code**: consistent (names the real stdio tool).
- **root CLAUDE.md / design doc ↔ code**: both group `codex_implementer` under `peers` as if it were an HTTP tool; the code registers it only as a stdio-routed subagent. Divergence.
- **description ↔ system prompt**: description says "codex_implementer … workspace-write"; snippet says "mcp__codex-cli__codex dispatches to codex-implementer". Same intent, different named entry point; the snippet is the correct one.

## 4. Findings

- **[Important]** `CLAUDE.md:129` (and `docs/peer-mcp-design.md:12`) list `codex_implementer` inside the `peers` group as though it were an HTTP tool alongside the critics. In code, `PERSONAS_WRITE` is excluded from the peers `tools/list` (`handler.ts:267-285` build from `PERSONAS_READ` only; `PERSONAS_WRITE` unreferenced in `handler.ts`); the name is registered under "peers" solely by the uniqueness guard at `peer-mcp-personas.ts:2113`. The only real surface is the `codex-implementer` subagent routing to `mcp__codex-cli__codex` (stdio). Fix: reword the root CLAUDE.md and design-doc lines to state that in `--codex-cli` mode a `codex-implementer` **subagent** is added (routing to the `codex-cli` stdio server), not a `peers` HTTP tool.

- **[Important]** `peer-mcp-personas.ts:429-430` — the write persona's `description` (its subagent frontmatter) does not signal write-scope discipline. This is the single mutation-capable injected surface; the routing signal the lead reads should say the tool edits files and wants a bounded, self-contained brief. Fix: add a short scope-discipline clause, e.g. "Edits files in place through the codex-cli sandbox; give it an exact, self-contained brief (files + acceptance criteria) — it is not a planner." (mirrors the "Not for X" negatives every read persona carries).

- **[Suggestion]** `peer-mcp-personas.ts:429-430` — "workspace-write access" reads as if the persona/HTTP layer performs the write. The write is entirely a property of the external `codex mcp-server` sandbox (`sandbox: workspace-write` + `approval-policy: on-request`, `peer-mcp-personas.ts:475-476`); a plain `/v1/responses` dispatch (`handler.ts:728-748`) mutates nothing. Consider "runs in the codex-cli workspace-write sandbox (approvals on-request)" so the mechanism and the human-in-the-loop gate are legible to the lead.

- **[Suggestion]** `PersonaSpec.endpoint` for this persona is `/v1/responses` (`peer-mcp-personas.ts:428`), but that dispatch path is unreachable for the write persona (never in `activePersonas()`). The field is dead for this entry. Not harmful (it satisfies the shared `PersonaSpec` shape and the uniqueness guard), but a one-line code comment on `PERSONAS_WRITE` noting "endpoint is unused — this persona is stdio-routed only, never dispatched via `dispatchModelCall`" would prevent a future contributor from assuming an HTTP path exists.

- **[Suggestion]** `docs/peer-mcp-design.md` documents this write-capable surface in a single grouping line and nowhere else. Add a short subsection covering the stdio-only routing, the codex sandbox as the write mechanism, the `--codex-cli` gate, and how it relates to the other two implementation surfaces (below), so the sole write persona is not the least-documented injected tool.

### Routing-confusion risk across the three implementation surfaces

There are three overlapping "implement" surfaces the lead can reach, and their boundaries are not stated anywhere in the injected guidance:

1. `codex-implementer` subagent (this tool) — gpt-5.3-codex via codex-cli stdio sandbox, `--codex-cli` only.
2. `implementer` native subagent — gpt-5.6-sol, with gpt-5.5 fallback, injected when the catalog has gpt-5.6-sol or gpt-5.5 with tool_calls (`codex-mcp-config.ts:308-316`), uses Claude Code's own Edit/Write/Bash.
3. `implement` / `worker-implement` worker — gpt-5.6-sol, gated by `workerToolsEnabled()`.

All three are write-capable coders; two run gpt-5.6-sol, one runs gpt-5.3-codex; one needs an external CLI, one is integrated, one is a background worker. The `codexCliClause` says only "for end-to-end coding tasks" with no discriminator against surfaces 2/3. This is a real misroute risk: in a `--codex-cli` session the lead sees `codex-implementer`, `implementer`, and `worker-implement` all advertising bounded implementation and has no stated basis to choose. Not a defect in this tool alone, but the `codex_implementer` description/clause is the natural place to add the one-line discriminator (e.g. "prefer this only when you specifically want the codex sandbox / on-request approvals; otherwise the `implementer` subagent or `worker-implement` are the default coding surfaces").

## 5. Verdict

**N** — the injected surface is not fully correct or consistent: the description and the root CLAUDE.md / design doc present `codex_implementer` as a `peers` HTTP tool with intrinsic workspace-write, when in code it is a stdio-only `codex-implementer` subagent whose write capability lives entirely in the external codex-cli sandbox and which never appears in the peers `tools/list`. The system-prompt clause is accurate; the description and docs are not. Single most important fix: correct the `peers`-group grouping in `CLAUDE.md:129` + `docs/peer-mcp-design.md:12` to describe a stdio-routed `codex-implementer` subagent (not an HTTP tool), and add write-scope discipline to the persona description at `peer-mcp-personas.ts:429-430`.
