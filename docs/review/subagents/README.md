# Subagent routing-line review

Per-subagent audit of every Claude Code SUBAGENT that `github-router claude` injects into the spawned session. Subagents pre-load only `name` + `description` (the routing tier that Opus reads to decide delegation); the body/system-prompt loads on invocation. These docs review each `description` as a DELEGATION TRIGGER against the Anthropic subagent rubric — third person, states the trigger, specific not vague, accurately previews the body, no overtrigger imperatives — under the governing lens "raise the floor, never nerf" and "the right thing, at the right time, in the right amount."

The peer-critic descriptions are the SAME strings used as the corresponding `mcp__peers__*` tool descriptions (already reviewed as tools under `docs/review/mcp/peers/`). Here they are reviewed as subagent routing lines: does the tool-register string work as a delegation trigger?

## Where the subagents come from

| Producer | Emits | File:line |
|---|---|---|
| `buildPeerAgentDefinitions` | the whole `--agents` set; writes one `.md` per agent into `<CLAUDE_CONFIG_DIR>/agents/` | `src/lib/codex-mcp-config.ts` |
| `personasFor` | which peer critics are active (gemini gated on catalog; codex-implementer on `--codex-cli`) | `src/lib/peer-mcp-personas.ts:648-667` |
| `buildAgentPrompt` | each critic's system prompt (identity + base instructions + routing block) | `peer-mcp-personas.ts:458-500` |
| `buildCoordinatorAgent` | the coordinator description + fan-out prompt | `codex-mcp-config.ts:196-278` |
| `dispatcherDescription` / `dispatcherPrompt` / `dispatcherTools` | the six `worker-*` background dispatchers | `src/lib/worker-dispatch.ts:203-265` |
| `writePeerAgentMdFiles` | the per-launch `peer-<pid>-<rand>-<name>.md` files | `codex-mcp-config.ts:492-544` |

## Inventory

| Subagent | Own model | Routes to / does | Gate | Doc | Verdict |
|---|---|---|---|---|---|
| `codex-critic` | inherited (Claude) | relays to gpt-5.6-sol critic (MCP) | always | [codex-critic.md](codex-critic.md) | Y (soft trigger) |
| `codex-reviewer` | inherited | relays to gpt-5.3-codex reviewer (MCP) | always | [codex-reviewer.md](codex-reviewer.md) | Y (soft trigger) |
| `gemini-critic` | inherited | relays to gemini-3.1-pro critic (MCP) | `requiresGeminiCatalog` | [gemini-critic.md](gemini-critic.md) | Y |
| `gemini-reviewer` | inherited | relays to gemini-3.1-pro reviewer (MCP) | `requiresGeminiCatalog` | [gemini-reviewer.md](gemini-reviewer.md) | Y |
| `opus-critic` | inherited | relays to claude-opus-5 critic (MCP; 4.6 fallback) | always | [opus-critic.md](opus-critic.md) | Y |
| `codex-implementer` | inherited | relays to gpt-5.3-codex writer (stdio) | `--codex-cli` | [codex-implementer.md](codex-implementer.md) | N (S3 overlap) |
| `implementer` (native) | gpt-5.6-sol → gpt-5.5, else lead | edits files itself (full toolset) | always emitted; preferred model needs `tool_calls` | [implementer.md](implementer.md) | Y |
| `reviewer` (native) | gemini-3.1-pro-preview → frontier, else lead | assesses artifacts and isolates failures (full toolset) | always emitted; preferred model needs `tool_calls` | [reviewer.md](reviewer.md) | Y |
| `brainstorm` (native) | gemini-3.1-pro-preview → frontier, else lead | read-only divergent options | always emitted; preferred model needs `tool_calls` | [brainstorm.md](brainstorm.md) | Y |
| `scout` (native) | gpt-5.6-luna → gemini-3.7-flash | read-only low-cost repository exploration | qualifying 1M `tool_calls` model required; otherwise omitted | [scout.md](scout.md) | Y |
| `scribe` (native) | gpt-5.6-terra → frontier, else lead | repository-grounded documentation maintenance (full toolset) | always emitted; preferred model needs `tool_calls` | [scribe.md](scribe.md) | Y |
| `implementer-fast` (native) | gpt-5.6-terra → gemini-3.1-pro-preview | well-specified mechanical implementation (full toolset) | qualifying 1M `tool_calls` model required; otherwise omitted | [implementer-fast.md](implementer-fast.md) | Y |
| `reviewer-fast` (native) | gemini-3.7-flash only | lower-stakes cross-lab assessment, full toolset | qualifying 1M `tool_calls` model required; otherwise omitted | (undocumented — no per-agent `.md` yet) | not yet reviewed |
| `general-purpose-fast` (native) | gpt-5.6-luna only | fastest measured, lowest-cost full-toolset catch-all | qualifying 1M `tool_calls` model required; otherwise omitted | [general-purpose-fast.md](general-purpose-fast.md) | Y |
| `peer-review-coordinator` | inherited | fans out to critics, aggregates | always | [peer-review-coordinator.md](peer-review-coordinator.md) | N (F1 unbacked trigger) |
| `worker-explore` | inherited (worker: gpt-5.6-luna high) | bg dispatch read-only research | `workerToolsAvailable` | [worker-explore.md](worker-explore.md) | Y |
| `worker-implement` | inherited (worker: gpt-5.6-sol) | bg dispatch read/write coding | `workerToolsAvailable` | [worker-implement.md](worker-implement.md) | Y |
| `worker-review` | inherited (worker: gemini-3.1-pro) | bg dispatch self-navigating review | `workerToolsAvailable` | [worker-review.md](worker-review.md) | Y |
| `worker-plan` | inherited (worker: claude-opus-5) | bg dispatch ordered plan | `workerToolsAvailable` | [worker-plan.md](worker-plan.md) | Y (minor gap) |
| `worker-test` | inherited (worker: gpt-5.6-sol) | bg dispatch adversarial tests | `workerToolsAvailable` | [worker-test.md](worker-test.md) | Y |
| `worker-browse` | inherited (worker: gpt-5.6-luna high) | bg dispatch browser agent | `browseAvailable` | [worker-browse.md](worker-browse.md) | N (A3 field bug) |

Two shapes of subagent: RELAY shims (the five critics, codex-implementer, and the six worker dispatchers, which run on the inherited lead model and forward through MCP) and the seven NATIVE agents. `implementer` prefers the OpenAI frontier chain; `reviewer` and `brainstorm` prefer Gemini then that frontier chain (`reviewer` deliberately NOT sharing `implementer`'s model, or a review of implementer-produced work would be one model checking its own output); `scribe` prefers gpt-5.6-terra then the frontier chain. When a preferred chain misses, those four omit `model:` and inherit the lead. `scout`, `implementer-fast`, and `general-purpose-fast` are omitted when their qualifying chains miss, because inheriting the lead would defeat their cost purpose. `scout` walks Luna → Gemini Flash and enforces a 1M floor; `general-purpose-fast` is Luna-only. All three conditional natives require both `tool_calls` and 1M context. `scout` and `brainstorm` carry a read-only `tools:` allowlist, while the other five natives omit `tools:` and inherit the full toolset. The `worker-*` dispatchers are separately pinned to `mcp__<workersKey>__*` only, so they cannot recurse.

## Systemic findings

### S1 — Shared tool/subagent description tension (the soft-trigger register)

The five peer-critic descriptions are ONE string serving TWO surfaces: the `mcp__peers__*` tool description AND the subagent routing line. Tool descriptions are written in the capability-blurb register ("Adversarial second opinion on plans, designs, or code tradeoffs"), which is correct for a tool but a WEAKER delegation trigger than the "Use when…" / "Use proactively" idiom Claude Code's auto-delegation loop keys on. So the critics have soft subagent triggers (codex-critic, codex-reviewer especially; gemini-critic and gemini-reviewer carry more explicit "cross-check… when you want a third perspective" / "Use alongside codex_reviewer" clauses and rate higher).

This is not a defect if the intended entry point for critic fan-out is `peer-review-coordinator` (which DOES carry "use proactively") — the individual critics are leaves the coordinator selects, and the coordinator's own prompt routes by artifact type (`codex-mcp-config.ts:226-242`). Under that model the soft critic triggers are intentional. The risk is that a lead delegating DIRECTLY to a critic (bypassing the coordinator) gets a weaker routing signal. Recommendation: leave the shared strings as-is (they must stay good tool descriptions), and treat the coordinator as the documented critic entry point. If direct-to-critic delegation is desired, the descriptions would need a subagent-specific trigger clause, which conflicts with the tool register — a genuine tension, best resolved by routing through the coordinator.

### S2 — Coordinator "use proactively" is unbacked (~60% soft-steer, fallback never wired)

The coordinator description promises "Use proactively before non-trivial plans and after non-trivial commits." The code comment (`codex-mcp-config.ts:189-194`) estimates ~60% reliability for the "use proactively" polling loop and describes a deterministic fallback: flip an ExitPlanMode PreToolUse hook to default-on if an acceptance test shows <7/10 sessions delegate. **That fallback is NOT wired.** The only ExitPlanMode hook in `src/claude.ts` (`:817-823`) is the artifact-auto-open hook — it opens the finalized plan in the ai-or-die human review panel, gated on `AIORDIE_SESSION_ID`; it does NOT invoke the coordinator. A repo-wide search for a coordinator-invoking hook finds none. So:

- "before non-trivial plans" delegates ~6/10 by the code's own estimate (soft steer only).
- "after non-trivial commits" has no hook anchor at all (no commit hook exists) — soft-steer-only by construction.

The description over-promises against what the harness reliably delivers. Recommendation: either wire the deterministic ExitPlanMode PreToolUse hook the comment specifies (env-disable-able), or soften the description to stop promising proactive review the harness does not deliver. Detail in [peer-review-coordinator.md](peer-review-coordinator.md) §5.

### S3 — Foreground implementation-surface overlap (routing clarity)

Two foreground write-capable implementation subagents coexist, with descriptions that do not cross-reference or differentiate:

| Subagent | Model | Nature | Description scope phrase |
|---|---|---|---|
| `implementer` (native) | gpt-5.6-sol (gpt-5.5 fallback) | foreground, integrated, edits itself | "well-scoped coding tasks — edits, small features, fixes… integrated subagent" |
| `codex-implementer` | gpt-5.3-codex | foreground, integrated, `--codex-cli` only | "Targeted implementation of a self-contained coding task" |
| `worker-implement` | gpt-5.6-sol (worker) | **background**, autonomous, worktree-isolated | "autonomous coding worker… non-blocking… completion notification" |

`worker-implement` differentiates cleanly (background/autonomous/worktree vs foreground/integrated). The unresolved overlap is between the two FOREGROUND writers: under `--codex-cli` a lead sees both `implementer` and `codex-implementer` with similar bounded-task framing and no signal for which to pick. The intended material distinction is Codex CLI sandboxing for `codex-implementer`. Recommendation: document that split in a routing description. Detail in [implementer.md](implementer.md) §5 and [codex-implementer.md](codex-implementer.md) §6.

### S4 — "Use proactively" overtrigger risk on Opus 4.5+ (measured, not acute)

The coordinator, the six `worker-*` dispatchers, and the specialist natives including `implementer-fast` use "Use proactively"; the peer critics do not. On stronger auto-delegating models "Use proactively for ANY <mode>-mode worker task" could in principle over-fire, but the dispatchers are scoped by the non-blocking rationale ("so a long run never blocks your turn") AND enforced by the PreToolUse guard (`worker-dispatch.ts:154-197`) — a raw worker call from the main agent is DENIED and redirected to the dispatcher, so "use this dispatcher" is a correctness steer, not gratuitous overtrigger; the model must go through the dispatcher to run a worker at all. The coordinator's doubled checkpoint imperative ("before… AND after…") is the highest-overtrigger phrasing in the set, but S2 shows the practical failure mode is UNDER-firing (soft steer), not over-firing. Net: overtrigger risk is low-to-moderate and structurally bounded; the description/framing split is deliberate.

The framing split is by design and documented: `buildPeerAwarenessSnippet` (`peer-mcp-personas.ts:555-646`) — the injected system-prompt awareness block — is negatively pinned AGAINST imperatives, arrows, hedges, and anchors (`tests/peer-mcp-personas.test.ts`, framing-constraint pins), per the rationale at `peer-mcp-personas.ts:508-554`: "tool descriptions carry the routing signal (when/when-not); the awareness snippet should describe capabilities in factual present tense and let the model decide." So imperatives live in the DESCRIPTION fields (where Claude Code's rubric wants them for auto-delegation) and are forbidden in the awareness snippet (which is pure capability inventory). This is a coherent division, not a contradiction: the snippet inventories, the descriptions trigger.

## Recommendations (priority order)

1. **Keep opus-critic labels aligned:** the current surface prefers Opus 5 with the old 4.6-1m → 4.6 chain as fallback; its default effort stays high and xhigh is available on Opus 5.
2. **Fix A3 in [worker-browse.md](worker-browse.md):** `dispatcherPrompt` (`worker-dispatch.ts:236`) tells the browse dispatcher to pass `prompt`, but the browse tool requires `task` with `additionalProperties: false` (`peer-mcp-personas.ts:1922-1923`). Branch `dispatcherPrompt` on `mode === "browse"` to pass `task`, and add a regression test (Important — confirmed field-name mismatch unique to browse).
3. **Reconcile S2 (coordinator):** wire the deterministic ExitPlanMode fallback the code comment specifies, or soften the description to match soft-steer reality.
4. **Address S3 (implement overlap):** differentiate `implementer` from `codex-implementer` at the description level, or document the Codex-CLI sandboxing split.
5. **S1 (soft critic triggers):** leave the shared strings; document the coordinator as the critic entry point.

## Method note

Every claim here is verified against the code cited. The A3 browse mismatch, the coordinator's unwired ExitPlanMode fallback, and the opus 4.6/4.7 label drift were each confirmed by reading the source (not inferred): `peer-mcp-personas.ts:1920-1948` (browse schema requires `task`), `src/claude.ts:817-823` (ExitPlanMode hook is artifact-open only), and `peer-mcp-personas.ts:322,401,585` (opus version labels). Model defaults for the workers are from the repo root `CLAUDE.md` "worker tools" section; the subagents' OWN models are from the emitted frontmatter (per `codex-mcp-config.ts:314` and the model-frontmatter assertions in `tests/isolated/codex-mcp-config.test.ts`). The `reviewer-fast` row added above is verified only against `CLAUDE.md`'s own documented resolver behavior, not against a fresh read of its `.md` routing line — it has no per-agent audit page yet (unlike every other native).

**Fast launch profile.** A `-m fast` Luna-led launch profile is designed to replace the whole native roster on that profile with exactly `scout`/`implementer-fast`/`reviewer-fast`, each carrying a NEW `effort:` frontmatter field pinning both model AND reasoning effort (`scout`→Luna/high, `implementer-fast`→Luna/max, `reviewer-fast`→Grok 4.6/medium) instead of the resolver chains and picker-driven effort this document audits above. It also drops every other native (`implementer`, `reviewer`, `brainstorm`, `scribe`, `general-purpose-fast`, the coordinator) and the six worker dispatchers from that profile entirely. This profile is now implemented; keep this audit table profile-aware rather than assuming the standard roster applies unchanged. See the "Fast launch profile" section of [`../../default-models.md`](../../default-models.md).
