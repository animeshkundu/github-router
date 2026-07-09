# Toolbelt awareness one-liner

## Identity

- **What**: A single sentence advertising which curated CLI tools (`rg`, `fd`, `jq`, `sd`, `ast-grep`/`sg`, `yq`, ...) were materialized onto the spawned agent's PATH, so the model calls them as native binaries instead of falling back to slower built-ins.
- **Builder**: `buildToolbeltAwareness(commands)`, `src/lib/toolbelt/index.ts:89-97`.
- **Injected via**: mirrored CLAUDE.md only, appended at the bottom by `appendToolbeltAwarenessToMirroredClaudeMd`, `src/lib/claude-md-injection.ts:713-723`, called from `src/claude.ts:470`.
- **Surfaces**: CLAUDE.md `<claudeMd>` wrapper only. It reaches the main agent and every descendant (Agent-tool subagents, agent-teams teammates) that inherits `CLAUDE_CONFIG_DIR`. It does NOT ride `--append-system-prompt`.
- **Gate**: `toolbeltEnabled()` (`src/claude.ts:463`) AND a non-empty command list (`buildToolbeltAwareness` returns `null` when `commands.length === 0`, and the caller guards `if (toolbeltLine)` at `claude.ts:468`). Only tools NOT already on the user's PATH are listed (gap-fill), so the line names exactly what the proxy added.
- **Position in final order**: appended before the peer-awareness block, so it sits just below the user's own CLAUDE.md content (see the README order map).

## Text (verbatim)

Builder template (`src/lib/toolbelt/index.ts:92-96`):

```
Fast CLI tools are available on your PATH; prefer them when applicable: <tool descriptions>.
```

Each command renders through `TOOL_DESC` (`toolbelt/index.ts:76-83`) when known, else its bare name:

```
rg (fast regex search), fd (fast file finder), jq (JSON processor),
sd (find & replace), ast-grep / sg (structural code search & rewrite),
yq (YAML / TOML / XML processor)
```

A representative fully-rendered line (all six mapped tools present):

```
Fast CLI tools are available on your PATH; prefer them when applicable: rg (fast regex search), fd (fast file finder), jq (JSON processor), sd (find & replace), ast-grep / sg (structural code search & rewrite), yq (YAML / TOML / XML processor).
```

## Anthropic-guideline assessment

- **Role framing**: n/a. This is a capability note, not a role assignment. It states a fact ("these tools are on your PATH") and a soft preference ("prefer them when applicable"). No persona, no comparative framing.
- **Positive / prohibitive**: Positive. "Prefer them when applicable" tells the model what TO do. There is no "don't use X" phrasing. Clean.
- **Overtrigger risk**: Low. "Prefer ... when applicable" is a soft steer, not an imperative. There is no MUST/ALWAYS/CRITICAL, so it does not risk the forceful-language over-response Anthropic warns about for newer models ("dial back any aggressive language ... 'CRITICAL: You MUST use this tool when...' → 'Use this tool when...'", [Prompting best practices, "Tool usage"](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-4-best-practices)). The "when applicable" qualifier explicitly scopes it, which is the right register, the model still chooses the built-in when it fits better.
- **Literalness / scope**: Good. The sentence is self-contained and its scope is explicit ("on your PATH", "when applicable"). A model reading it literally does exactly the intended thing: reach for these named binaries for the tasks they fit. It does not over-generalize into "only ever use CLI tools."
- **Enforcement claims**: None in the injected text. It correctly describes a fact (PATH contents) rather than promising enforcement. This is honest: the tools genuinely are on PATH, so the note is verifiable context, not an unbacked guarantee.
- **Structure**: A single sentence, no markdown headers. Appropriate for a one-liner, headers would be over-structuring a single fact.

## Don't-nerf / right-balance

- **Does it help at the right time?** Yes. Without it, the model has no signal that `rg`/`fd`/`sd`/etc. were injected onto PATH by the proxy; it would reach for them only if it happened to guess they exist. Naming them once, factually, at low salience (bottom of CLAUDE.md) is the right amount: enough to make the model aware, not so forceful it overrides better judgment. This is a floor-raise (new capability surfaced) with no nerf (the model keeps full discretion via "when applicable").
- **CLAUDE.md-only is defensible.** The tool set is a project/environment fact, which is exactly what CLAUDE.md context is for. It does not need system-prompt salience because it is not a behavioral directive that must win over user instructions, it is background awareness. Descendant reach (subagents/teammates that also have Bash) is the reason it belongs in the mirrored CLAUDE.md rather than only the main agent's system turn.

## Findings + verdict

**Finding 1 (documentation defect, flag):** The docstring on `appendToolbeltAwarenessToMirroredClaudeMd` at `src/lib/claude-md-injection.ts:709-710` states:

> "The main agent gets the same line via `--append-system-prompt`."

This is false. The toolbelt line is produced by `buildToolbeltAwareness` and its ONLY consumer is `appendToolbeltAwarenessToMirroredClaudeMd` at `src/claude.ts:470` (verified: the sole `--append-system-prompt` push, at `claude.ts:1084-1088`, carries only `OPERATING_DEFAULTS_DIRECTIVE` plus the peer-awareness snippet, never the toolbelt line). The toolbelt awareness is CLAUDE.md-only. The docstrings on the peer-awareness (`:651`), style (`:667`... via callers), operating-defaults (`:690`), and artifact helpers are accurate about their own delivery; only the toolbelt docstring overclaims a second surface it does not have.

- **Severity**: Suggestion (a comment-only inaccuracy; no runtime impact). It is worth fixing because it misleads a future contributor into thinking the main agent has the toolbelt awareness at system-prompt salience, which could lead them to remove the CLAUDE.md append as "redundant" and silently strip the ONLY surface the toolbelt line has.
- **Fix**: Change the docstring to state the true delivery, "The main agent reads the same line from the mirrored CLAUDE.md; unlike the operating-defaults / peer-awareness blocks, the toolbelt line is NOT pushed via `--append-system-prompt`."

**Finding 2 (content, minor):** The `TOOL_DESC` map (`toolbelt/index.ts:76-83`) covers only six tools; `scc`, `difft`/difftastic, and `gron` (which the toolbelt provisions per the project CLAUDE.md) fall through to their bare command name if exposed. Bare names are still usable (the model knows `gron`), so this is cosmetic, not a defect. No action required unless a friendlier descriptor is wanted.

**Verdict**: The injected text itself is well-formed, positive, soft, correctly scoped, honest about being a fact rather than an enforced rule. No nerf. The only real issue is the docstring lie (Finding 1), which is a code-comment fix, not an injected-text change.

## Sources

- [Prompting best practices](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-4-best-practices), section cited: "Tool usage" (dial-back-aggressive-language overtrigger fix).
