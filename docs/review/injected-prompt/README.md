# Injected prompt blocks, review

github-router's `claude` subcommand injects several system-prompt / CLAUDE.md text blocks into the spawned Claude Code session. This directory reviews each block against current Anthropic prompt-engineering guidance, under the governing lens: **raise the floor, never nerf** and **the right thing, at the right time, in the right amount**.

The assessments are grounded in current first-party guidance from [Anthropic prompting](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices), [Anthropic tool definitions](https://platform.claude.com/docs/en/agents-and-tools/tool-use/define-tools), [Anthropic parallel tool use](https://platform.claude.com/docs/en/agents-and-tools/tool-use/parallel-tool-use), [OpenAI reasoning](https://developers.openai.com/api/docs/guides/reasoning-best-practices), [OpenAI prompting](https://developers.openai.com/api/docs/guides/prompting), [Google prompting](https://ai.google.dev/gemini-api/docs/prompting-strategies), and [xAI multi-agent guidance](https://docs.x.ai/developers/model-capabilities/text/multi-agent). The load-bearing guidance:

- **Golden rule**: "Show your prompt to a colleague with minimal context on the task and ask them to follow it. If they'd be confused, Claude will be too." Every injected block is checked against this, a context-free colleague should be able to act on it.
- **Positive over prohibitive**: "Tell Claude what to do instead of what not to do" (example: "Do not use markdown" → "compose smoothly flowing prose paragraphs").
- **Add context / motivation**: "Providing context or motivation behind your instructions ... can help Claude better understand your goals ... Claude is smart enough to generalize from the explanation."
- **Overtrigger on aggressive language**: Opus 4.5+ "may now overtrigger. The fix is to dial back any aggressive language. Where you might have said 'CRITICAL: You MUST use this tool when...', you can use more normal prompting like 'Use this tool when...'."
- **Precise instruction following**: "Claude's latest models are trained for precise instruction following" and benefit from explicit direction and specificity ("Being specific about your desired output can help enhance results").
- **Role framing is functional**: "Setting a role ... Even a single sentence makes a difference", worked example a functional specialization, not a named persona. No official page addresses named-celebrity framing, so that critique rests on the general specificity principle.
- **Enforcement vs context**: an injected system-prompt / CLAUDE.md block STEERS behavior; it is not a hard guardrail. None of these blocks is validated by a hook (the one deterministic artifact lever is a separate `PostToolUse(ExitPlanMode)` hook, not this text), so none should, and none does, claim an enforcement guarantee.
- **Layer ownership**: stable decision policy belongs in the system-level digest; a compact native roster remains resident for routing salience; detailed what/when/when-not/caveat contracts belong in Agent or MCP descriptions; execution prompts specify scope, output, stop conditions, and verification. The mirrored awareness block is the only full, gate-aware capability inventory.
- **Parallelism is conditional**: independent, non-overlapping read or analysis work can be issued together; true dependencies, shared state, and conflicting side effects stay sequential. Multi-agent breadth is selective because it consumes more tokens and can add latency.
- **Evidence, not reasoning theater**: prompts ask for outcomes, checkable evidence, success criteria, and calibrated findings rather than visible chain-of-thought or agreement counts.

The Max-specific preregistered behavior protocol is [`../subagents/MAX-PROMPT-EVAL.md`](../subagents/MAX-PROMPT-EVAL.md). It separates headless routing and restraint from interactive batching and full-outcome quality.

Per-block docs:

- [`operating-defaults-directive.md`](operating-defaults-directive.md)
- [`style-directive.md`](style-directive.md)
- [`artifact-panel-directive.md`](artifact-panel-directive.md)
- [`toolbelt-awareness.md`](toolbelt-awareness.md)
- [`peer-awareness-snippet.md`](peer-awareness-snippet.md)

## Inventory

| Block | Builder / constant | System prompt (`--append-system-prompt`) | Mirrored CLAUDE.md | Gate | Size |
|---|---|---|---|---|---|
| Operating defaults | `buildOperatingDefaultsDirective` / `buildOperatingDefaultsDigest` in `src/lib/claude-md-injection.ts` | Digest only, first in the single argument | Full directive, top | Digest always; full directive uses launch availability | Variable |
| Style | `STYLE_DIRECTIVE` in `src/lib/claude-md-injection.ts` | No | Yes, top | Peer-MCP block; best-effort | Small |
| Artifact panel | `ARTIFACT_PANEL_DIRECTIVE` in `src/lib/claude-md-injection.ts` | No | Yes, top | ai-or-die session | Variable |
| Toolbelt awareness | `buildToolbeltAwareness` in `src/lib/toolbelt/index.ts` | No | Yes, bottom | Toolbelt enabled and non-empty | One line |
| Peer awareness | `buildPeerAwarenessSnippet` / `buildPeerAwarenessSummary` in `src/lib/peer-mcp-personas.ts` | Compact native roster and epistemic boundaries after the operating digest | Full gate-aware inventory, bottom | Peer-MCP block; full inventory follows live gates | Max resident digest+summary ≤ 2820 B and mirrored directive+snippet ≤ 4283 B (pre-change ceilings) |

## Assembly and order map

### The single `--append-system-prompt` arg

Exactly one `--append-system-prompt` is pushed per session (pinned in `tests/isolated/cli-claude.test.ts`). It carries, in order:

```
OPERATING_DEFAULTS_DIGEST  +  "\n\n"  +  peerAwarenessSummary   (when the peer summary was built)
OPERATING_DEFAULTS_DIGEST                                      (when it was not, e.g. --no-codex-mcp)
```

Assembly is in the `github-router claude` launch path in `src/claude.ts`. The digest leads at highest attention weight; the peer-awareness summary rides along only when peer-MCP wiring built it. The full directive, style, Artifact, and toolbelt blocks are never on this surface.

The full directive is instead rendered for the mirrored CLAUDE.md with `buildOperatingDefaultsDirective(nativeAvailability)`. This distinction is intentional: the digest is roster-neutral and always safe for the main agent, while the adjacent summary carries the compact profile roster and the full awareness snippet carries launch-gated capabilities.

### The mirrored CLAUDE.md, top-to-bottom

Three blocks prepend to the top, two append to the bottom, each with its own idempotent marker fence (so they coexist and are regenerated per launch). Because each prepend takes the very top slot, the LAST prepend to run ends up topmost; appends stack in call order.

The launch handler appends toolbelt awareness, prepends the conditional Artifact block, appends peer awareness, prepends style, and finally prepends operating defaults. The resulting order is pinned by the injection and CLI-launch tests rather than by brittle source-line references.

Resulting file, top to bottom:

```
OPERATING_DEFAULTS_DIRECTIVE      (last prepend, topmost)
STYLE_DIRECTIVE
ARTIFACT_PANEL_DIRECTIVE          (only inside an ai-or-die tab)
[ user's own CLAUDE.md content ]
Toolbelt awareness line           (first append, higher)
Peer-awareness snippet            (last append, lowest)
```

(ARTIFACT is present only when `AIORDIE_SESSION_ID` is set; toolbelt only when `toolbeltEnabled()` and the tool list is non-empty; the peer snippet's contents vary with the live catalog.)

### Double-exposure map (what the MAIN agent sees twice)

Two blocks reach the main agent on BOTH surfaces:

- **Operating defaults**, as the roster-neutral digest in the system prompt and the full availability-aware directive at the CLAUDE.md top.
- **Peer awareness**, as a compact summary in the system prompt and the full snippet at the CLAUDE.md bottom.

The two surfaces are intentional and asymmetric-audience: the system-prompt push reaches only the main agent, while the CLAUDE.md copy reaches descendants that inherit `CLAUDE_CONFIG_DIR`. They are now deliberately complementary rather than byte-identical. The full directive needs launch-specific native availability to avoid naming a dropped `scout` or generic catch-all; the digest stays roster-neutral and can therefore be injected even when peer-MCP wiring is unavailable.

The other three blocks are single-surface: STYLE and ARTIFACT are CLAUDE.md-top only, toolbelt is CLAUDE.md-bottom only. They do not need system-prompt salience because they are house-style / environment-conditional / capability-fact context, not behavioral defaults that must win over user instructions.

## Systemic findings

### 1. Availability-aware operating defaults are now aligned

The full operating directive carries policy rather than a duplicated roster. Standard-profile conditional roles still use the same `NativeAgentAvailability` flags as generation; fixed Fast/Max rosters appear once in their resident awareness summaries. This closes the prior class of routing drift where an instruction named an agent absent from the Task `subagent_type` enum.

The operating digest intentionally does not list agents. When peer-MCP wiring succeeds, the adjacent awareness summary names the fixed Max/Fast roster once so routing remains salient; when it fails, the digest remains valid without inventing unavailable MCP capabilities.

### 2. The artifact directive follows resolved group keys

`ARTIFACT_PANEL_DIRECTIVE(peersKey)` derives its tool prefix from the resolved peers key. This preserves artifact-tool routing when a user-owned `peers` MCP entry causes the proxy to use its numbered fallback key.

### 3. Complementary dual surfaces are deliberate

The main agent receives a short operating-defaults digest and a peer-awareness summary in the system prompt. The mirrored CLAUDE.md carries the detailed operating directive and full awareness inventory for descendants. The difference is intentional: only the latter can be safely availability-aware for conditionally emitted native agents.

## Recommendations

1. Keep the native availability object threaded through every launch path that emits agents or awareness text.
2. Keep the system-prompt digest roster-neutral unless it receives the same availability contract.
3. Update the inventories whenever a conditional native is added, removed, or changes its resolution rule.

**Overall verdict**: The injected surfaces accurately separate high-salience, roster-neutral defaults from the full launch-specific instructions. Conditional native agents are no longer advertised when absent, while the main agent retains the delegation and verification guidance needed to choose a route.

## Sources

- `src/lib/claude-md-injection.ts`
- `src/claude.ts`
- `src/lib/serve/enhancements.ts`
- `src/lib/codex-mcp-config.ts`
- `tests/isolated/claude-md-injection.test.ts`
