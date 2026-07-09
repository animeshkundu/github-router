# Review: `mcp__peers__artifact_reply`

> Per-tool audit of the model-facing surface github-router auto-injects.
> Reviewer: meta subagent. Verified against code; every claim cites `file:line`.

## 1. Identity

| Field | Value |
|---|---|
| MCP path | `mcp__peers__artifact_reply` |
| Group / server | `peers` (serverInfo `github-router-peers`) |
| Wire tool name | `artifact_reply` |
| Definition | `src/lib/artifact/tools.ts:152-169` (factory `tool()` at `:31-51`) |
| Always-on? | gated |
| Capability gate | `artifact` → `artifactToolsEnabled()` (`src/lib/mcp-capabilities.ts:212-218`); list-time filter `src/routes/mcp/handler.ts:343`, call-time reject `:983-993` |
| Backing model / endpoint | server-side fn — POSTs `/agent-reply` to the ai-or-die tab HTTP API (`src/lib/artifact/client.ts:285-293`); no model call |
| Write-capable | yes — renders a chat bubble in the human review panel (single-shot, not retried, to avoid duplicate bubbles: `client.ts:283-285`) |

The group is `peers`: the factory hardcodes `const ARTIFACT_GROUP: McpGroup = "peers"` (`tools.ts:13`) and every tool sets `group: ARTIFACT_GROUP` (`tools.ts:39`). Registered into the surface via `...ARTIFACT_TOOLS` (`peer-mcp-personas.ts:2058`).

## 2. Injected surfaces (verbatim)

### 2a. Tool `description` (shown in `tools/list`)

Description (`tools.ts:154`):

> Send the agent's reply back to the ai-or-die Artifact review panel after applying or responding to human feedback. Only works inside an ai-or-die tab-backed Claude session.

Input schema (`tools.ts:155-157`) — one required field:

- `text` (string, required): "Agent reply text to deliver to the human Artifact review panel."

Schema is `additionalProperties:false`, `required:["text"]` (`objectSchema` at `tools.ts:464-471`). `requiredString` rejects a missing/empty/non-string `text` with an `INVALID_ARGUMENT` `ArtifactToolInputError` (`tools.ts:161`, `:350-359`).

Success output (not schema-declared, returned by the handler at `tools.ts:163-167`): the server response spread, plus `ok:true` and `next_step:"Wait for further human review, or continue if the review loop is complete."` The server response type is an open bag `ArtifactAgentReplyResponse { [key: string]: unknown }` (`client.ts:130-132`) with no known fields.

### 2b. System prompt (`--append-system-prompt`)

ABSENT. `buildPeerAwarenessSnippet` (`peer-mcp-personas.ts:555-...`) names the critics, `code`/`web`, workers, orchestrate, `stand_in`, and browser tools, but never any `artifact_*` tool. A grep for `artifact_reply|artifact_open|artifact_await|artifact_poll|artifact_` across the whole file returns exactly one hit, `:736`, which is a doc-comment on the `NonPersonaMcpTool.capability` field ("- \"artifact\" (artifact_open / artifact_poll / artifact_reply) requires ..."), not snippet text. So the peer-awareness system-prompt block does not mention this tool at all — not the tool, not even the `peers` group in an artifact context.

Coverage instead comes from a SEPARATE injected block, `ARTIFACT_PANEL_DIRECTIVE` (`src/lib/claude-md-injection.ts:48-58`), which is prepended to the mirrored CLAUDE.md only (see 2c) — it is NOT part of `--append-system-prompt`. The clause that names this tool (`claude-md-injection.ts:52`):

> ... tell the user to review, then drain their feedback with `mcp__peers__artifact_await` (pass back the returned `cursor` each call), revise, `mcp__peers__artifact_reply`, and `mcp__peers__artifact_end` when done.

Prefix used: `mcp__peers__artifact_reply`. This MATCHES the code's group (`peers`). No prefix mismatch.

### 2c. CLAUDE.md (mirrored `<CLAUDE_CONFIG_DIR>/CLAUDE.md`)

Covering block: the artifact-panel directive, injected by `prependArtifactPanelDirectiveToMirroredClaudeMd` (`claude-md-injection.ts:731-741`) under its own marker fence (`ARTIFACT_MARKER_OPEN/CLOSE`, `:36-38`), gated by the caller on `AIORDIE_SESSION_ID` (comment `:728-729`). It positions `artifact_reply` in the review loop: author HTML, `artifact_open`, `artifact_await` (drain feedback), revise, **`artifact_reply`**, `artifact_end` (`:52`). All tool references in the directive use the `mcp__peers__artifact_*` prefix (`:50-53`), consistent with the code.

The checked-in repo `CLAUDE.md` (project root, `C:\Users\anikundu\Software\github-router\CLAUDE.md`) has NO artifact/ai-or-die directive — a grep for `artifact_reply|artifact panel|ai-or-die|artifact_*` returns no matches. The artifact panel is a launch-time-injected surface, not documented in the repo's own CLAUDE.md, which is consistent (the panel only exists inside an ai-or-die tab). The global user-level CLAUDE.md carries a near-identical copy of the directive, but that is per-user config, not the checked-in file.

The fuller playbook is deferred to the `gh-artifact-review` skill (named at `claude-md-injection.ts:58`).

## 3. Assessment

### 3a. Description quality

- **Clarity & routing.** Good. "Send the agent's reply back ... after applying or responding to human feedback" places the tool correctly in the loop (it is the agent→human turn after `artifact_await`). The "Only works inside an ai-or-die tab-backed Claude session" tail is the when-NOT signal and matches the gate exactly (`artifactToolsEnabled()` requires the env trio). When the gate is off the tool is absent from `tools/list` (`handler.ts:343`) and rejected at `tools/call` (`handler.ts:983-993`); a direct handler call with no env returns a friendly `NOT_IN_AIORDIE_TAB` isError (`tools.ts:159-160`, `missingEnvResult` at `:411-419`) — so the description's constraint is enforced three ways.
- **Accuracy vs implementation.** No stale facts. No model id or default to drift (server-side fn, not a persona). The single-shot no-retry behavior (`client.ts:283-285`) is an internal correctness property the model need not know, and the description correctly omits it.
- **Schema minimality.** Passes the ruthlessly-minimal bar. Exactly one input field, `text`, which is required to call the tool. No echoed inputs. The success output adds `ok:true` and a `next_step` string — `next_step` is actionable routing the model uses next call, consistent with the sibling artifact tools' pattern, so it earns its place. The `...response` spread of the open `ArtifactAgentReplyResponse` bag is the one soft spot (see Findings): the server response has no declared fields, so whatever the ai-or-die server returns is passed through to the model unfiltered — a diagnostic-only field could leak into context. Today the type is empty so there is nothing to leak, but it is not defensively trimmed the way persona/`code` outputs are.

### 3b. System-prompt coverage

- **Omitted by design.** `artifact_reply` (and the whole artifact suite) is intentionally NOT in `buildPeerAwarenessSnippet`. The awareness snippet is the always-on peer/worker/search inventory; the artifact tools are tab-conditional and get their own tab-gated directive (`ARTIFACT_PANEL_DIRECTIVE`) instead. This is the right split: naming a tab-only tool in the always-present system prompt would advertise a capability that is absent in most sessions.
- **Non-redundant.** Because it is absent from the snippet, there is no snippet↔description redundancy to assess.
- **Framing compliance.** The directive that does cover it (`claude-md-injection.ts:48-58`) uses soft steer language ("Default to ...", "Skip the panel only for trivial one-line answers") and names `artifact_reply` inside a workflow sentence, not as an imperative anchor. Consistent with the framing-constraint intent.

### 3c. CLAUDE.md coverage

- **Accurate, not drifted.** The mirrored directive's `mcp__peers__artifact_reply` reference agrees with the code's `peers` group. The loop it describes (open → await → revise → reply → end) matches the actual tool set and their handlers' `next_step` chaining.
- **Injected vs checked-in consistency.** The checked-in repo CLAUDE.md has no artifact section, which is correct (tab-only surface). No contradiction.

### 3d. Cross-surface consistency

No contradictions. Group `peers` is consistent across code (`tools.ts:13,39`), the mirrored directive (`claude-md-injection.ts:52`), and the docs (`docs/research/artifact-panel-v2-producer-brief.md:25`). The team-lead's flagged hypothesis — that the directive's hardcoded `mcp__peers__artifact_*` might mismatch the real group — does NOT hold: the real group IS `peers`.

## 4. Findings

- **[Suggestion]** `src/lib/artifact/tools.ts:163-164` — the handler spreads the untyped server response (`...response` where `ArtifactAgentReplyResponse` is `{ [key:string]: unknown }`, `client.ts:130-132`) directly into the model-facing result. If the ai-or-die server ever returns diagnostic fields, they reach the model's context unfiltered, unlike the `code`/persona outputs that are trimmed to a minimal envelope. Today the type is empty so there is no live leak. Fix: return only the fields the model acts on (`ok`, `next_step`), or narrow `ArtifactAgentReplyResponse` to the known-useful fields and pick them explicitly, matching the minimal-surface principle in `docs/peer-mcp-design.md`.

- **[Suggestion]** `mcp__peers__artifact_reply` groups a human-panel I/O tool under `peers` (the adversarial-critic server) rather than an intent-named `artifact` server. This is a pre-existing whole-suite decision (all eight artifact tools share it, `tools.ts:13`), not specific to `artifact_reply`, and the mirrored directive is internally consistent with it — so it is cosmetic, not a defect. Noting only that the server name gives the model no routing signal that `peers` also hosts panel I/O; the tab-gated directive carries that signal instead.

No Critical or Important findings. The specifically-flagged prefix-mismatch concern is disproven (group is `peers`, directive says `peers`).

## 5. Verdict

Y — the injected surface for `artifact_reply` is correct, minimal, consistent, and well-routed. Group `peers` matches the directive's `mcp__peers__artifact_*` prefix (no mismatch), the gate is enforced at list/call/handler, and coverage lives in the right (tab-gated) directive rather than the always-on snippet. Single most useful improvement: trim the untyped `...response` spread so the tool cannot pass server diagnostics into model context.
