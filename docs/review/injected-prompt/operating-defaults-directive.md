# OPERATING_DEFAULTS_DIRECTIVE

## Identity

- **What**: The full, availability-aware operating default written at the top of the mirrored CLAUDE.md. It frames delegation, direct verification, adversarial review, product quality, and engineering quality.
- **Builder**: `buildOperatingDefaultsDirective(opts)` in `src/lib/claude-md-injection.ts`. `OPERATING_DEFAULTS_DIRECTIVE` is its all-available compatibility form; launch paths that know the catalog use the builder.
- **Companion system-prompt block**: `OPERATING_DEFAULTS_DIGEST`, a separate condensed directive that does not enumerate native agents. It leads the sole `--append-system-prompt` argument.
- **Injected via two surfaces**:
  1. The digest enters the main agent's `--append-system-prompt` in `src/claude.ts`.
  2. The full builder result is prepended to the mirrored CLAUDE.md in both `src/claude.ts` and `src/lib/serve/enhancements.ts`, reaching the main agent and descendants.
- **Gate**: The digest is always injected. The full CLAUDE.md prepend is best-effort after the launch has resolved native-agent availability.

## Availability-aware native roster

Four native agents are conditional: `scout`, `implementer-fast`, `generic-fast`, and `generic-cheap`. They are dropped rather than inheriting the lead model when their qualifying catalog chain does not resolve. The builder accepts corresponding booleans through `NativeAgentAvailability` and names only the agents actually emitted.

This preserves a routing invariant: the directive must not suggest a Task `subagent_type` that has no emitted `.md` definition. The same availability object is also passed to `buildPeerAwarenessSnippet`, keeping the operating directive, awareness inventory, and generated native roster aligned.

The unconditional specialist list remains `implementer`, `reviewer`, `brainstorm`, and `scribe`. When present, `implementer-fast` sits beside `implementer` for well-specified mechanical changes; `generic-fast` and `generic-cheap` remain grouped as catch-alls for work no specialist fits.

## Current directive shape

The generated full directive starts with the override boundary, then an orchestration paragraph assembled from the available native reach clauses. It tells the lead to launch independent agents concurrently in a single message rather than serially. It retains the direct-work carve-out: delegation is for wide or slow work where the main thread needs only a conclusion, not a reflex for narrow, single-command, surgical, or last-mile work.

The remaining fixed content states the review boundary, the quality bar, and engineering-excellence expectations. `OPERATING_DEFAULTS_DIGEST` separately carries the shorter high-salience version for every main-agent turn, including the evidence-first and peer-review-versus-direct-verification distinctions.

## Behavior and limits

- **Prompting, not enforcement.** The directive is an overridable operating default. It does not itself create a native agent, force delegation, or validate a model's decision.
- **Availability is enforced by construction.** Each conditional agent is omitted when its resolver returns no qualifying model; the builder then removes it from the full directive rather than advertising an unavailable route.
- **Tool availability differs by agent.** `scout` and `brainstorm` have a read-only `tools:` allowlist. The three catch-alls omit `tools:` and therefore inherit the parent's full toolset. Their prompts ask them not to spawn further subagents, but that request is not a tool-level restriction.
- **Reasoning effort is not per-agent.** A native's frontmatter selects its resolved model; effort follows the normal Claude Code picker and translation path. Capability limits remain model-specific, including Gemini Flash clamping above-`high` selections and Luna allowing its fuller advertised ladder.

## Findings + verdict

- **Resolved routing defect.** The former static operating directive named `scout` unconditionally even when the catalog could drop it. `buildOperatingDefaultsDirective` now renders only the emitted conditional natives, including the new generic tiers.
- **No material new routing defect found.** The availability booleans are carried through both launch paths alongside native model resolution and peer-awareness construction.

**Verdict: Y.** The operating directive now describes the actual per-launch native roster while preserving the direct-work and evidence-first guardrails that prevent indiscriminate delegation.
