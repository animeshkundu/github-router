# Injected prompt blocks, review

github-router's `claude` subcommand injects several system-prompt / CLAUDE.md text blocks into the spawned Claude Code session. This directory reviews each block against current Anthropic prompt-engineering guidance, under the governing lens: **raise the floor, never nerf** and **the right thing, at the right time, in the right amount**.

The assessments are grounded in the current [Prompting best practices](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-4-best-practices) page (the classic `docs.claude.com/.../claude-4-best-practices` and `.../be-clear-and-direct` URLs now 302-redirect to this consolidated page). The load-bearing guidance:

- **Golden rule**: "Show your prompt to a colleague with minimal context on the task and ask them to follow it. If they'd be confused, Claude will be too." Every injected block is checked against this, a context-free colleague should be able to act on it.
- **Positive over prohibitive**: "Tell Claude what to do instead of what not to do" (example: "Do not use markdown" → "compose smoothly flowing prose paragraphs").
- **Add context / motivation**: "Providing context or motivation behind your instructions ... can help Claude better understand your goals ... Claude is smart enough to generalize from the explanation."
- **Overtrigger on aggressive language**: Opus 4.5+ "may now overtrigger. The fix is to dial back any aggressive language. Where you might have said 'CRITICAL: You MUST use this tool when...', you can use more normal prompting like 'Use this tool when...'."
- **Precise instruction following**: "Claude's latest models are trained for precise instruction following" and benefit from explicit direction and specificity ("Being specific about your desired output can help enhance results").
- **Role framing is functional**: "Setting a role ... Even a single sentence makes a difference", worked example a functional specialization, not a named persona. No official page addresses named-celebrity framing, so that critique rests on the general specificity principle.
- **Enforcement vs context**: an injected system-prompt / CLAUDE.md block STEERS behavior; it is not a hard guardrail. None of these blocks is validated by a hook (the one deterministic artifact lever is a separate `PostToolUse(ExitPlanMode)` hook, not this text), so none should, and none does, claim an enforcement guarantee.

Per-block docs:

- [`operating-defaults-directive.md`](operating-defaults-directive.md)
- [`style-directive.md`](style-directive.md)
- [`artifact-panel-directive.md`](artifact-panel-directive.md)
- [`toolbelt-awareness.md`](toolbelt-awareness.md)
- [`peer-awareness-snippet.md`](peer-awareness-snippet.md)

## Inventory

| Block | Builder / constant | System prompt (`--append-system-prompt`) | Mirrored CLAUDE.md | Gate | Size |
|---|---|---|---|---|---|
| OPERATING_DEFAULTS_DIRECTIVE / `buildOperatingDefaultsDirective` | `claude-md-injection.ts:143-266` | Digest only, leads the arg (`claude.ts:1229-1234`), unconditional (even `--no-codex-mcp`) | Full availability-aware directive, top (`claude.ts:1236-1238`) | digest always; full directive uses the launch's native availability | variable |
| STYLE_DIRECTIVE | `claude-md-injection.ts:73-78` | No | Yes, top (`claude.ts:1057`) | codex-mcp block; best-effort | 192 B |
| ARTIFACT_PANEL_DIRECTIVE | `claude-md-injection.ts:48-58` | No | Yes, top (`claude.ts:811`) | `AIORDIE_SESSION_ID` set (`claude.ts:807`) | 2148 B |
| Toolbelt awareness | `toolbelt/index.ts:89-97` | No | Yes, bottom (`claude.ts:470`) | `toolbeltEnabled()` + non-empty tool list | 1 line |
| Peer-awareness snippet | `peer-mcp-personas.ts:555-646` | Yes, rides after OPERATING_DEFAULTS (`claude.ts:1086-1087`) | Yes, bottom (`claude.ts:1042`) | codex-mcp block; contents gated per live catalog | < 4900 B (max) |

## Assembly and order map

### The single `--append-system-prompt` arg

Exactly one `--append-system-prompt` is pushed per session (pinned at `tests/isolated/cli-claude.test.ts:969-979`). It carries, in order:

```
OPERATING_DEFAULTS_DIGEST  +  "\n\n"  +  peerAwarenessSummary   (when the peer summary was built)
OPERATING_DEFAULTS_DIGEST                                      (when it was not, e.g. --no-codex-mcp)
```

Assembly is at `src/claude.ts:1229-1234`. The digest leads at highest attention weight; the peer-awareness summary rides along only when codex-mcp wiring built it. The full availability-aware directive, STYLE, ARTIFACT, and the toolbelt line are never on this surface.

The full directive is instead rendered for the mirrored CLAUDE.md with `buildOperatingDefaultsDirective(nativeAvailability)`. This distinction is intentional: the digest is roster-neutral and always safe for the main agent, while the full directive names only the conditional native agents this launch actually emitted.

### The mirrored CLAUDE.md, top-to-bottom

Three blocks prepend to the top, two append to the bottom, each with its own idempotent marker fence (so they coexist and are regenerated per launch). Because each prepend takes the very top slot, the LAST prepend to run ends up topmost; appends stack in call order.

Call order in the handler: toolbelt-append (`470`) → artifact-prepend (`811`) → peer-append (`1042`) → style-prepend (`1057`) → operating-defaults-prepend (`1091`).

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

The full operating directive no longer describes a fixed roster. Its builder accepts the same `NativeAgentAvailability` flags that the launch path derives from the emitted definitions and passes to `buildPeerAwarenessSnippet`. That closes the prior class of routing drift where an instruction named an agent absent from the Task `subagent_type` enum.

The system-prompt digest intentionally does not list agents. It remains valid when peer-MCP setup is unavailable and keeps the primary behavioral defaults at high salience without creating a dangling roster reference.

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
