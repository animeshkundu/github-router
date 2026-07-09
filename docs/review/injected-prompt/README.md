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
| OPERATING_DEFAULTS_DIRECTIVE | `claude-md-injection.ts:101-117` | Yes, leads the arg (`claude.ts:1084-1088`), unconditional (even `--no-codex-mcp`) | Yes, top (`claude.ts:1091`) | none (system push always) | 1137 B |
| STYLE_DIRECTIVE | `claude-md-injection.ts:73-78` | No | Yes, top (`claude.ts:1057`) | codex-mcp block; best-effort | 192 B |
| ARTIFACT_PANEL_DIRECTIVE | `claude-md-injection.ts:48-58` | No | Yes, top (`claude.ts:811`) | `AIORDIE_SESSION_ID` set (`claude.ts:807`) | 2148 B |
| Toolbelt awareness | `toolbelt/index.ts:89-97` | No | Yes, bottom (`claude.ts:470`) | `toolbeltEnabled()` + non-empty tool list | 1 line |
| Peer-awareness snippet | `peer-mcp-personas.ts:555-646` | Yes, rides after OPERATING_DEFAULTS (`claude.ts:1086-1087`) | Yes, bottom (`claude.ts:1042`) | codex-mcp block; contents gated per live catalog | < 4900 B (max) |

## Assembly and order map

### The single `--append-system-prompt` arg

Exactly one `--append-system-prompt` is pushed per session (pinned at `tests/isolated/cli-claude.test.ts:969-979`). It carries, in order:

```
OPERATING_DEFAULTS_DIRECTIVE  +  "\n\n"  +  peerAwarenessSnippet   (when the peer snippet was built)
OPERATING_DEFAULTS_DIRECTIVE                                        (when it was not, e.g. --no-codex-mcp)
```

Assembly at `src/claude.ts:1084-1088`. OPERATING_DEFAULTS leads (highest attention weight); the peer snippet rides along only when codex-mcp wiring ran (pinned `cli-claude.test.ts:942-967`). STYLE, ARTIFACT, and the toolbelt line are NEVER on this surface.

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

- **OPERATING_DEFAULTS_DIRECTIVE**, system prompt (leads the arg) AND CLAUDE.md top.
- **Peer-awareness snippet**, system prompt (after OPERATING_DEFAULTS) AND CLAUDE.md bottom.

The double exposure is intentional and asymmetric-audience: the system-prompt push reaches ONLY the main agent (subagents/teammates do not get `--append-system-prompt`), while the CLAUDE.md copy reaches descendants that inherit `CLAUDE_CONFIG_DIR`. The main-agent overlap is the cost of covering both audiences with one mechanism each. It is pinned at `tests/isolated/cli-claude.test.ts:958-962` (the CLAUDE.md-appended peer snippet is a substring of the system-prompt value once OPERATING_DEFAULTS leads it).

The other three blocks are single-surface: STYLE and ARTIFACT are CLAUDE.md-top only, toolbelt is CLAUDE.md-bottom only. They do not need system-prompt salience because they are house-style / environment-conditional / capability-fact context, not behavioral defaults that must win over user instructions.

## Systemic findings

### 1. The named-persona framing decision (OPERATING_DEFAULTS), specificity compensation recommended

The "aim high" principle appends named-celebrity calibration bars (the Jobs and Ive bar / the Gates bar / the Bezos bar). Anthropic's specificity guidance treats "be as good as <famous expert>" as a soft fail versus concrete behavioral specificity, because a named entity is a dense high-variance vector that can pull in persona noise at the highest-salience position. The current form is the MITIGATED hybrid (principle-led, name as calibration, explicit `Adopt the principles, not a persona: no impersonation, name-dropping, or theatrics` guardrail, exact-case regression-pinned at `tests/claude-md-injection.test.ts:582-585`), which the design comment (`claude-md-injection.ts:94-96`) records as the resolution of a cross-lab critic flag.

**Recommendation**: since each of the three principles is already stated functionally and concretely, drop the parenthetical names and let the specified behavior carry the signal. That removes the high-variance vector AND makes the no-theatrics guardrail unnecessary, netting a shorter, cleaner block. This is a Suggestion-level optimization toward the specificity bar, not a fix for a correctness defect, the current form is defensible and tested.

### 2. The toolbelt docstring lie (documentation defect)

`appendToolbeltAwarenessToMirroredClaudeMd`'s docstring at `src/lib/claude-md-injection.ts:709-710` claims "The main agent gets the same line via `--append-system-prompt`." This is false: the toolbelt line is CLAUDE.md-only (its sole consumer is the CLAUDE.md append at `claude.ts:470`; the `--append-system-prompt` push at `claude.ts:1084-1088` carries only OPERATING_DEFAULTS + the peer snippet). Severity: Suggestion (comment-only), but worth fixing because it could mislead a contributor into removing the CLAUDE.md append as "redundant" and silently stripping the toolbelt line's ONLY surface. See [`toolbelt-awareness.md`](toolbelt-awareness.md) Finding 1.

### 3. The ARTIFACT directive hardcodes `mcp__peers__artifact_*` (group-key drift)

Unlike the peer-awareness snippet, which renders MCP prefixes from the resolved `groupKeys` (so they track the `gh-router-peers` fallback on a `peers` collision), the ARTIFACT directive is a static string with the bare `peers` prefix baked in (one wildcard mention plus seven named `artifact_*` tools). On a user-side `peers` MCP collision, the directive would tell the model to call `mcp__peers__artifact_open`, which would not resolve to the proxy's server. Severity: Important but narrow (only fires when a user has an MCP server literally named `peers`). Fix: parameterize on the resolved peers key. Cross-reference the mcp/artifact review, this is the same group-key-drift class the resolution machinery was built to prevent, missed on this one static block. See [`artifact-panel-directive.md`](artifact-panel-directive.md) Finding 1.

### 4. Double-exposure rationale (not a defect)

The two double-exposed blocks are the right ones: OPERATING_DEFAULTS is the behavioral default the proxy most wants to win, and the peer snippet is core capability awareness, both need main-agent system-prompt salience AND descendant CLAUDE.md reach. The single-surface blocks are correctly single-surface. No change; documented here so a future contributor does not "fix" the overlap by dropping one surface and losing an audience.

## Recommendations (priority order)

1. **Fix the ARTIFACT `mcp__peers__artifact_*` hardcode** (Important), parameterize on the resolved peers group key so the directive survives a `peers` collision.
2. **Correct the toolbelt docstring** (Suggestion), state that the toolbelt line is CLAUDE.md-only, not `--append-system-prompt`, so nobody strips its only surface.
3. **Consider dropping the celebrity names from OPERATING_DEFAULTS** (Suggestion), lean into the already-present specificity; removes the high-variance vector and the theatrics guardrail.
4. **Keep the peer-awareness framing pins and the STYLE self-compliance pins**, they are the guardrails against future overtrigger/attribution drift. Optionally positive-restate the STYLE "avoid em dashes" clause.

**Overall verdict**: The injected set is, on the whole, well-behaved against current Anthropic guidance: positive/descriptive registers dominate, no aggressive imperatives (no MUST/ALWAYS/CRITICAL/all-caps) that risk newer-model overtrigger, scope is stated explicitly where a precise-following model needs it (override headers, enumerated trigger sets, do-it-directly carve-outs), and no block claims an enforcement guarantee that no hook backs. The peer-awareness snippet is the model block. The three actionable items are the ARTIFACT group-key hardcode (Important), the toolbelt docstring inaccuracy (Suggestion), and the optional specificity refinement of the named-persona calibration (Suggestion). None is a floor-lowering nerf; the corrections tighten correctness and honesty without removing capability.

## Sources

- [Prompting best practices](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-4-best-practices), the current consolidated page. Sections referenced across these docs: "Be clear and direct" (golden rule, specificity), "Add context to improve performance", "Give Claude a role", "Control the format of responses" (positive over prohibitive), "Tool usage" (precise instruction following, dial-back-aggressive-language overtrigger fix), "Overthinking and excessive thoroughness" (targeted-over-blanket tool defaults), "Subagent orchestration" (well-defined tools + natural delegation + overuse hazard).
- No official Anthropic page addresses named-celebrity / "be as good as <famous expert>" role framing specifically; the OPERATING_DEFAULTS critique of that pattern rests on the general specificity and functional-role principles above.
