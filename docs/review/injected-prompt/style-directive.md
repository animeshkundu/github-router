# STYLE_DIRECTIVE

## Identity

- **What**: A short writing / communication style directive that steers every spawned agent's prose output: be concise, use a natural human voice, no em dashes, and never attribute work to Claude / AI / LLM / Anthropic anywhere.
- **Constant**: `STYLE_DIRECTIVE`, `src/lib/claude-md-injection.ts:73-78`.
- **Injected via**: mirrored CLAUDE.md only, prepended at the TOP by `prependStyleDirectiveToMirroredClaudeMd`, `claude-md-injection.ts:674-684`, called from `src/claude.ts:1057`.
- **Surfaces**: CLAUDE.md `<claudeMd>` wrapper only. Reaches the main agent and every descendant that inherits `CLAUDE_CONFIG_DIR` (Agent-tool subagents, agent-teams teammates). It does NOT ride `--append-system-prompt`.
- **Gate**: runs inside the codex-mcp wiring block (the `try` that ends at `claude.ts:1064`), so it is present on the default path. It is best-effort (warn-and-continue) like its sibling prepends.
- **Position in final order**: prepended before OPERATING_DEFAULTS runs, so it ends up directly below OPERATING_DEFAULTS at the top of the mirrored file (see the README order map). Size: 192 bytes.

## Text (verbatim)

`src/lib/claude-md-injection.ts:73-78`:

```
Write concisely without losing detail. Use a natural human voice. Avoid em dashes. Do not attribute work to Claude, AI, LLM, or Anthropic anywhere (commits, PRs, issues, code, comments, docs).
```

## Anthropic-guideline assessment

- **Role framing**: n/a, this is a style rule, not a role. No persona or comparative framing.
- **Positive / prohibitive**: Mixed, appropriately. The first two clauses are positive ("write concisely", "use a natural human voice"). The last two are prohibitions ("avoid em dashes", "do not attribute"). Anthropic's guidance is to "Tell Claude what to do instead of what not to do", its worked example is exactly "Instead of: 'Do not use markdown in your response', Try: 'Your response should be composed of smoothly flowing prose paragraphs.'" ([Prompting best practices, "Control the format of responses"](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-4-best-practices)). By that lever, "avoid em dashes" is the prohibitive form of a rule that HAS a clean positive restatement, so it is the one clause worth flipping. The attribution rule is different: there is no clean positive form of "do not stamp Co-Authored-By trailers", and its scope is explicitly enumerated, so the prohibition is the correct shape there. Both prohibitions are concrete and bounded, not vague blanket negatives, so they read cleanly.
- **Overtrigger risk**: Low. No MUST/ALWAYS/CRITICAL/all-caps. "Do not attribute ... anywhere" is firm but its scope is explicitly enumerated ("commits, PRs, issues, code, comments, docs"), so a literal model applies it to exactly those surfaces rather than over-generalizing into refusing to ever say the word "Claude." The enumerated scope is what keeps it from overtriggering.
- **Literalness / scope**: Good, precisely because scope is stated. Opus 4.8 follows instructions precisely (["Claude's latest models are trained for precise instruction following"](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-4-best-practices), "Tool usage") and does not generalize scope on its own, so the explicit parenthetical list is exactly the right technique, it tells the precise-following model the boundary instead of leaving it to infer one.
- **Enforcement claims**: None. The directive states preferences; it does not claim they are enforced. This is correct, no hook validates prose for em dashes or attribution, so claiming enforcement would be an unbacked guarantee. (See the systemic note in the README: injected CLAUDE.md is context, not enforcement.)
- **Structure**: Four short sentences, no header. Fine for a compact rule. It is self-referentially compliant: the directive itself uses no em dashes and makes no attribution (pinned by `tests/isolated/claude-md-injection.test.ts:559-568`).

## Don't-nerf / right-balance

- **Does it help at the right time?** Yes. This encodes a genuine user preference (documented in the user's own CLAUDE.md: "No Attribution", "Avoid em dashes", natural voice). Surfacing it once at the top of the mirrored CLAUDE.md, at low-to-moderate salience, is the right amount. It is a floor-raise (the model's default prose picks up the house style) with no capability nerf.
- **CLAUDE.md-only is defensible.** Style is house-style context, the canonical CLAUDE.md use. It does not need to win over user instructions (a user can always override in-conversation), so system-prompt salience is unnecessary. Descendant reach matters here (a teammate committing code must also avoid attribution), which is why it belongs in the mirrored file that subagents inherit rather than only the main agent's system turn.

## Findings + verdict

**Finding 1 (minor, optional):** The "avoid em dashes" prohibition could be restated positively for consistency with Anthropic's "tell Claude what to do instead of what not to do" guidance, e.g. "prefer commas, colons, or separate sentences." Unlike the attribution rule, this one has a clean positive form, so it is the single clause worth flipping. Severity: Suggestion; the current negative form is concrete and bounded, so this is a nicety, not a defect.

**Finding 2 (observation, not a defect):** The directive lives ONLY in the mirrored CLAUDE.md, so a client launched with `--no-codex-mcp` that also fails the CLAUDE.md write (unwritable mirror) would lose it. But the mirror write is best-effort by design and the style rule is low-stakes (prose cosmetics), so the degradation is acceptable, unlike OPERATING_DEFAULTS, this block does not warrant a second system-prompt surface.

**Verdict**: Well-formed. Positive where it can be, prohibitive only where a positive restatement would be contrived, and every prohibition is explicitly scoped so a precise-following model applies it correctly. No nerf, no enforcement overclaim. Keep as-is (optional: positive-restate the em-dash clause).

## Sources

- [Prompting best practices](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-4-best-practices), sections cited: "Control the format of responses" (tell Claude what to do instead of what not to do), "Tool usage" (precise instruction following).
