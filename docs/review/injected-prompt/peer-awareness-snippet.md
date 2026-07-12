# Peer-awareness snippet

## Identity

- **What**: A two-paragraph tool-awareness block ("## Peer review and advisor") that inventories the proxy-specific capabilities the model has: the cross-lab peer critics (`codex_critic`, `codex_reviewer`, `gemini_critic`/`gemini_reviewer`, `opus_critic`), the `peer-review-coordinator`, the built-in `advisor`, the `mcp__search__code` semantic-first search, the `web` search, the `worker-*` background dispatchers, the `orchestrate` workflow tools, `stand_in`, the injected skills, and (conditionally) `browser` and `codex-cli`. It also states the load-bearing inheritance fact: spawned subagents inherit this whole toolset.
- **Builder**: `buildPeerAwarenessSnippet(opts)`, `src/lib/peer-mcp-personas.ts:555-646`. Framing-constraint comment at `:502-554`.
- **Injected via TWO surfaces (double exposure to the main agent)**:
  1. `--append-system-prompt`, rides AFTER `OPERATING_DEFAULTS_DIRECTIVE` in the single system-prompt arg (`src/claude.ts:1084-1088`), only when the snippet was built (i.e. codex-mcp wiring ran).
  2. Mirrored CLAUDE.md BOTTOM, appended by `appendPeerAwarenessToMirroredClaudeMd` (`claude-md-injection.ts:653-663`), called from `src/claude.ts:1042`. Reaches descendants that inherit `CLAUDE_CONFIG_DIR` but not `--append-system-prompt`.
- **Surfaces**: system prompt (main agent) AND mirrored CLAUDE.md bottom (descendants). Main agent sees it twice.
- **Gate**: built inside the codex-mcp wiring block; contents are conditionally assembled to match the live `tools/list` (worker mentions gated on `workerToolsEnabled()`, `stand_in` on `standInToolEnabled()`, gemini on `geminiAvailable`, browser on `browseAvailable`, first-mate skill on `agentToolsEnabled()`, codex-cli on `codexCli`). It never names a tool absent from the live catalog.
- **Position in final CLAUDE.md order**: appended at the very bottom (below the toolbelt line).
- **Size**: MINIMAL config < 2000 bytes; MAXIMAL (all gates on) < 4900 bytes (pinned at `tests/peer-mcp-personas.test.ts:333,346`).

## Text (verbatim)

The snippet is assembled dynamically. Paragraph 1 template (`peer-mcp-personas.ts:642`):

```
Cross-lab peer critics under `mcp__peers__*` (`codex_critic` (gpt-5.6-sol), `codex_reviewer` (gpt-5.3-codex), `gemini_reviewer` (gemini-3.1-pro, line-level code review), `gemini_critic` (gemini-3.1-pro), `opus_critic` (Opus 4.7)) are available at your discretion for adversarial review. Each tool's description explains its scope and when it applies. The `peer-review-coordinator` subagent fans out to the appropriate critics in parallel and aggregates findings by severity. Claude Code's built-in `advisor` tool catches approach drift and confabulation. Subagents you spawn inherit all of these.
```

Paragraph 2 is the capability inventory joined from `para2Parts` (`peer-mcp-personas.ts:595-637`): the `mcp__search__code` semantic-first description, the `worker-*` dispatcher list, the `orchestrate` tools, the injected-skills sentence, `mcp__search__web`, `stand_in`, and `browser`, each sentence gated as above. See the source for the full conditional assembly.

## Anthropic-guideline assessment

- **Role framing**: n/a, capability inventory, not a role. It describes what tools exist and their factual properties, deferring the "when to invoke" decision to each tool's own `description` field (the routing layer). The comment at `:507-514` records this as deliberate and aligned with Opus 4.8 guidance (tool descriptions carry routing; the awareness snippet describes capabilities and lets the model decide). This matches Anthropic's subagent-orchestration guidance: "Ensure well-defined subagent tools ... Let Claude orchestrate naturally: Claude will delegate appropriately without explicit instruction" ([Prompting best practices, "Subagent orchestration"](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-4-best-practices)), i.e. the routing signal belongs in tool definitions, not in prescriptive prose.
- **Positive / prohibitive**: Positive / descriptive. It states capabilities in factual present tense ("`code` is the one-stop code search", "`worker-*` are background Agent subagents"). No "don't use X" phrasing.
- **Overtrigger risk**: Very low, and actively defended. The framing constraint (comment `:516-528`) explicitly bans imperatives ("Lead with X", "Brief them to Y"), hedges ("you might want to consider"), and anchors disguised as description ("cheapest first move", "saves them the discovery step"). These are negative-pinned in `tests/peer-mcp-personas.test.ts:516-552`. The phrase "available at your discretion" is positively pinned (`:522`) as the non-prescriptive register. No MUST/ALWAYS/CRITICAL, no arrows (`→` negative-pinned `:524`), no forced routing. This is exactly the register Anthropic recommends for newer models, the descriptive "Use this tool when..." form rather than "CRITICAL: You MUST use..." ([Prompting best practices, "Tool usage"](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-4-best-practices)), and it is also the fix Anthropic prescribes for subagent overuse: replace blanket "Default to using [tool]" with "Use [tool] when it would enhance your understanding" (ibid., "Overthinking and excessive thoroughness"). This is the cleanest block in the injection set on the overtrigger axis.
- **Literalness / scope**: Good. Because it is descriptive rather than prescriptive, there is little for a literal model to over-apply, it reads an inventory and each tool's own description supplies scope. The one scope statement it does make ("Subagents you spawn inherit all of these") is a factual claim that is true (subagents inherit via the mirrored `.claude.json`), so a literal reading is correct.
- **Enforcement claims**: None. It describes availability, not enforcement. The inheritance claim is a verifiable fact, not a guarantee the model must uphold.
- **Structure**: Markdown `##` header + two paragraphs, tool names in backticks. Scannable. The wording budget is deliberately non-uniform (comment `:522-528`): each tool gets only the wording needed for correct/safe/high-value use, with importance signaled by cost-of-misuse rather than proportional length. This is a sound information-density principle.

## Don't-nerf / right-balance

- **Does it help at the right time?** Yes, and it is the load-bearing awareness surface. The proxy injects a large, non-obvious tool set (six MCP servers). Without this inventory the model would not know `mcp__search__code`'s semantic mode exists, that `worker-*` are non-blocking, or that subagents inherit the toolset. Naming them once, factually, at high salience is exactly right. It raises the floor (the surface becomes usable) with zero nerf (all routing stays with the model via each tool's own description).
- **Descriptive register is the correct choice.** By refusing to prescribe when to call each tool and deferring to tool descriptions, the snippet avoids the anchoring failure where a system-prompt line ("always run code_search first") over-fires. This is a well-reasoned, tested boundary, the block is a model for how to surface capability without dictating behavior.
- **Double exposure, worth it?** Yes. The main agent needs it at system-prompt salience (it is core capability awareness), and descendants need it via CLAUDE.md (they do the delegated work and must know the same tools exist). The two audiences differ, so the overlap on the main agent is acceptable. At < 4900 bytes it is the largest injected block, but it also carries the most information; the density principle keeps it from bloating.

## Findings + verdict

**Finding 1 (positive, keep):** This block already satisfies the strong framing pins (no imperatives, no hedges, no anchors, "at your discretion", no arrows, < 4900 bytes, gated to the live catalog). It is the best-behaved injection on the overtrigger and prescriptiveness axes. The negative-pin test suite (`tests/peer-mcp-personas.test.ts:516-552`) is a good guardrail against future drift; keep it.

**Finding 2 (consistency, minor):** The snippet correctly avoids em dashes (negative-pinned `:551`) so it does not contradict its sibling STYLE_DIRECTIVE. Good self-consistency across injected blocks. No action.

**Finding 3 (observation):** The `mcp__peers__*` / `mcp__search__*` prefixes in the snippet are rendered from the resolved group keys (`groupKeys`), so on a config-key collision with a user-side MCP server the paths track the fallback name (`gh-router-<group>`) rather than drifting. This is correct; the artifact-panel directive by contrast hardcodes `mcp__peers__artifact_*` (see that doc and the README cross-reference).

**Verdict**: The strongest block in the set. Descriptive not prescriptive, tested against imperatives/hedges/anchors, gated to the live catalog, honest about being an inventory. No nerf, no overtrigger, no enforcement overclaim. Double exposure is justified. No changes recommended beyond keeping the existing framing pins.

## Sources

- [Prompting best practices](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-4-best-practices), sections cited: "Subagent orchestration" (well-defined tools + let Claude orchestrate naturally), "Tool usage" (descriptive over aggressive language), "Overthinking and excessive thoroughness" (replace blanket "Default to [tool]" with targeted "Use [tool] when...").
