# Max prompt-tuning evaluation protocol

## Status and causal claim

This protocol is preregistered before collecting live Max prompt-tuning data. It evaluates a **prompt-only treatment**: the baseline and treatment must use identical Max lead/subagent models, efforts, tool schemas, MCP gates, request preprocessing, and dispatch ACL. Only the injected operating text, awareness text, native role descriptions/prompts, peer descriptions/prompts, and Advisor wording may differ.

A commit-to-commit comparison that also changes models or tools is a whole-profile comparison and must not be reported as evidence about prompt wording alone.

Live runs consume Copilot quota. Do not run them without explicit operator approval immediately before execution.

## Guidance basis

The treatment follows current first-party guidance:

- [Anthropic prompting best practices](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices): clear, direct instructions with explicit outcomes and constraints; avoid unnecessary over-prompting.
- [Anthropic tool definitions](https://platform.claude.com/docs/en/agents-and-tools/tool-use/define-tools): detailed descriptions should explain what a tool does, when and when not to use it, and important limitations.
- [Anthropic parallel tool use](https://platform.claude.com/docs/en/agents-and-tools/tool-use/parallel-tool-use): independent read-only operations are usually safe to run together; side effects, shared state, and true dependencies favor sequencing.
- [OpenAI reasoning best practices](https://developers.openai.com/api/docs/guides/reasoning-best-practices): keep instructions concise and direct, specify the desired result, and do not request visible chain-of-thought.
- [OpenAI prompting](https://developers.openai.com/api/docs/guides/prompting): version prompt text and evaluate every revision on representative fixtures.
- [Google prompting strategies](https://ai.google.dev/gemini-api/docs/prompting-strategies): prioritize critical instructions, define role/scope/output precisely, split complex work, parallelize independent subtasks, chain dependencies, and avoid redundant or conflicting rules.
- [xAI multi-agent guidance](https://docs.x.ai/developers/model-capabilities/text/multi-agent): use multiple agents selectively for complex, multi-perspective work because breadth increases token use and can add latency; use fewer agents for narrow or speed-sensitive work.

## Immutable arm manifest

Each arm must record and verify before the first prompt:

- absolute checkout path and exact git SHA;
- clean working-tree status;
- SHA-256 of every prompt-bearing source and generated prompt artifact;
- Claude Code executable path and version;
- catalog fingerprint;
- launch profile (`max`) and observed lead model;
- generated native roster, models, efforts, and MCP groups;
- randomized schedule seed and fixture revision.

Reject a dirty arm, mismatched declared revision, reused mutable `CLAUDE_CONFIG_DIR`, or model/tool/ACL mismatch. Run from detached temporary worktrees at the declared SHAs and remove them and their config directories afterward.

## Headless routing battery

Use `scripts/eval-delegation.ts` in Max mode with two complete launcher command prefixes. A Max arm command must launch `github-router claude -m max --`; the evaluator appends only Claude Code headless flags and does not add a child `--model` override.

```bash
GH_ROUTER_RUN_DELEGATION_EVAL=1 \
GH_ROUTER_DELEGATION_EVAL_PROFILE=max \
GH_ROUTER_DELEGATION_ARM_A_COMMAND='["<baseline>/github-router","claude","--model","max","--"]' \
GH_ROUTER_DELEGATION_ARM_B_COMMAND='["<candidate>/github-router","claude","--model","max","--"]' \
bun scripts/eval-delegation.ts
```

The harness creates a distinct temporary home/config source for each arm, copies
the non-secret, non-volatile parts of that arm's explicit
`GH_ROUTER_DELEGATION_ARM_{A,B}_CONFIG_DIR` when supplied (or the operator's
canonical `~/.claude` source otherwise), scrubs coordinator/team mode from the
copied settings, and removes both copies after the run. It never copies Claude
credentials or mutable session/history directories. Max launcher arms receive the
isolated home through both `HOME` and `USERPROFILE`, because the launcher creates
its own `CLAUDE_CONFIG_DIR` mirror from `os.homedir()`; GitHub authentication is
passed separately through `GH_TOKEN`.

The versioned Max battery must use independently worded prompts that do not name roles and cover:

1. broad multi-file discovery versus a one-command lookup;
2. interface/migration planning versus a trivial edit;
3. settled bounded implementation versus unresolved product or architecture design;
4. bounded mixed execution versus a clear specialist task;
5. repository-aware verification/reproduction versus review of a self-contained artifact;
6. open ideation versus a settled choice;
7. one fresh peer lens versus several distinct coordinator-worthy risk lenses;
8. routine completion versus one consequential unresolved Advisor question.

Report separately, with numerator, denominator, Wilson interval, exclusions, and paired transitions:

- spontaneous native delegation on eligible prompts;
- routing conditional on delegation;
- direct-action restraint;
- native reviewer versus peer/coordinator discrimination;
- coordinator overuse on one-lens and deterministic controls;
- Advisor selection on positive triggers and restraint on routine work; repeated-call restraint requires a separate multi-turn evaluation because this first-action harness stops after the initial routing event;
- time to first productive action;
- invocation errors and requested-but-never-started discrepancies.

There is no combined score. More delegation is not inherently better.

## Invocation validity

The evaluator must fail closed around the three previously observed invocation hazards:

- never append router-only flags to a raw `claude` command;
- always pair `--print --output-format stream-json` with `--verbose`;
- scrub `CLAUDE_CODE_COORDINATOR_MODE` and `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` from both child environment and any copied ambient settings.

Timeouts and non-zero exits, except the evaluator's intentional post-observation kill, are excluded from every behavioral denominator and reported separately. If either arm in a pair errors, exclude that pair from transition counts.

## Parallelism evaluation

Headless `claude --print` has been observed to emit at most one tool call per assistant message. A clean headless run with `maxToolBatch === 1` remains **inconclusive**, not a parallelism pass or failure. A clean run with zero tool calls remains a genuine failure to fan out; invocation errors remain a separate exclusion.

Measure actual batching only after a driver proves it can capture multiple ordinary tool calls in one assistant message. On Windows 11:

1. use an interactive Claude Code session or a verified ConPTY driver;
2. run two independently worded prompts with two or three independent tracks;
3. run five randomized paired repetitions per prompt and arm;
4. record the first Agent-bearing message, same-message call count, selected roles, scope overlap, and time to first dispatch;
5. count serial dispatch as parallel only if wall-clock overlap is independently demonstrated;
6. count repeated generic briefs or overlapping scopes as failures even when several agents launch.

If no interactive-capable driver is available, report parallelism as unmeasured.

## Full-outcome pilot

The first-call evaluator measures selection, not work quality. Run a separate paired completion pilot on a copied fixture:

- broad evidence gathering with known citations;
- a bounded implementation with executable acceptance checks;
- a seeded defect requiring repository-aware reproduction;
- an open design decision with materially different feasible options.

Score correctness and acceptance checks first, then citation/finding validity, wall-clock, redundant calls, and scope overlap. Agent count and model agreement are diagnostics only. Any subjective comparison must be blinded to the arm.

## Acceptance reporting

Predeclare numerical thresholds and sample size before live collection. Always report:

- every arm SHA and prompt hash;
- CLI version and catalog fingerprint;
- schedule seed and raw prompt battery;
- every exclusion and reason;
- all endpoint numerators, denominators, and Wilson intervals;
- whether fan-out was measured, inconclusive, or unmeasured;
- any difference between selection-only and full-outcome results.

A null or underpowered result must remain described as such. Do not infer routing quality, correctness, latency, or parallelism from a delegation-rate increase alone.
