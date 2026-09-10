# Frontier Lab Prompt Architectures & CLI Agent Steering: Comparative Analysis

**Date:** 2026-09-08  
**Scope:** Direct code-level analysis of official CLI coding agents from the three frontier AI labs:
- **Anthropic Claude Code** (`@anthropic-ai/claude-code`, private snapshot from `cc-backup`)
- **OpenAI Codex CLI** (`openai/codex`, open-source Rust/TypeScript agent harness)
- **Google Gemini CLI** (`google-gemini/gemini-cli`, open-source TypeScript agent harness)

---

## 1. Executive Summary & Frontier Synthesis

Across late 2025 and 2026, the three frontier AI labs converged on command-line autonomous software engineering agents. While their underlying foundation models (Claude Opus/Sonnet, GPT-5/5.2/Codex, Gemini 3.x/3.8 Flash) possess distinct token economics, latency profiles, and reasoning characteristics, each lab developed sophisticated system prompts and harness conventions to tame LLM failure modes.

### Key Divergences and Unique Strengths

| Dimension | Anthropic (Claude Code) | OpenAI (Codex CLI) | Google (Gemini CLI) |
| :--- | :--- | :--- | :--- |
| **Agent Tone & Stance** | Professional, collaborative, measured, zero fluff; strictly anti-sycophantic. | Friendly, collaborative co-builder; pragmatic peer; adapts to user rhythm. | Senior software engineer; rigorous, concise, authoritative, structured. |
| **Action Stance** | "Execute actions with care": rigorous blast-radius and reversibility checks; explicit confirmation for destructive actions. | "Autonomy and Persistence": bias toward direct execution; keep going until done within current turn; do not stop at analysis. | "Directives vs. Inquiries": Inquiries are strictly read-only analysis; Directives demand autonomous, persistent execution through to verified completion. |
| **Context Economics** | Static prompt cache boundary (`SYSTEM_PROMPT_DYNAMIC_BOUNDARY`) to maximize prompt-cache hits across turns. | Compact answers (<10 lines); omit full plans in text after calling planning tool; no code dump. | "Context Efficiency Mandate": teaches the model that early tokens compound turn costs; use parallel grep with context to avoid file reads. |
| **Code Modification** | Strict anti-goldplating: "Three similar lines of code is better than a premature abstraction." Minimal diffs, no unrequested refactors. | Surgical precision in existing codebases; high ambition in scratch greenfield tasks; root-cause fixes over surface patches. | Idiomatic, strict type safety, zero hacks (no `as any` or casts). Add automated tests for every change. |
| **Commenting Policy** | "Default to writing no comments. Only add one when the WHY is non-obvious... Don't explain WHAT the code does." | Rare, concise comments only ahead of complex code blocks; no inline noise. | Strictly idiomatic documentation; no explanatory fluff in tool calls or trivial comments. |
| **Planning System** | Two tiers: lightweight `TaskCreate`/`TaskUpdate` (3+ steps) and conversational `EnterPlanMode` / `ExitPlanMode` with multi-phase interview. | Two tiers: `update_plan` (progress checklist, 5-7 words per step, 1 in_progress) vs. Conversational Plan Mode (`<proposed_plan>`). | Two tiers: `write_todos` / task tracker vs. `EnterPlanMode` with structured plans directory and explicit state transition overrides. |
| **Adversarial Verification**| Dedicated `verification` agent with explicit adversarial probes (concurrency, boundary, idempotency, orphan operations); strict `PASS`/`FAIL`/`PARTIAL`. | Rubric-based peer review with discrete actionable criteria, severity P0-P3, and exact JSON output schema. | Mandatory empirical reproduction before bug fixes; 3-strike strategic re-evaluation rule before changing architecture. |

---

## 2. Anthropic Claude Code Prompt Architecture

### 2.1 Prompt Organization & Prompt Caching
Claude Code structures `getSystemPrompt` around a static/dynamic boundary:
- **`SYSTEM_PROMPT_DYNAMIC_BOUNDARY`**: All prompt text before this marker uses `scope: "global"`, allowing cross-organization prompt cache sharing. Sections include:
  - `# System`: Markdown rendering, permission modes, tag treatment (`<system-reminder>`), prompt injection defenses, hook notifications.
  - `# Doing tasks`: Task scope discipline, reading before proposing changes, avoiding time estimates, diagnosing root causes before switching tactics.
  - `# Executing actions with care`: Explicit categorizations of destructive vs. irreversible vs. externally-visible operations; rules for safe Git operations (always create new commits, use HEREDOC for commit messages, no `--no-verify`).
  - `# Using your tools`: Dedicated tools over Bash (`Read`, `Edit`, `Write`, `Glob`, `Grep`); parallel tool calling guidance.
  - `# Tone and style`: No emojis unless asked, concise responses, `file_path:line_number` citation format, no colons before tool calls.
- **Dynamic Post-Boundary Sections**: User memories (`MEMORY.md`), session-specific guidance (e.g., interactive login `! <cmd>`), available skills, and environment details.

### 2.2 Anti-Goldplating & Code Cleanliness Principles
Claude Code contains the industry's most explicit instructions against LLM over-engineering:
- *"Don't add features, refactor code, or make 'improvements' beyond what was asked. A bug fix doesn't need surrounding code cleaned up. A simple feature doesn't need extra configurability."*
- *"Don't add error handling, fallbacks, or validation for scenarios that can't happen. Trust internal code and framework guarantees. Only validate at system boundaries."*
- *"Don't create helpers, utilities, or abstractions for one-time operations. Don't design for hypothetical future requirements. Three similar lines of code is better than a premature abstraction."*
- *"Default to writing no comments. Only add one when the WHY is non-obvious: a hidden constraint, a subtle invariant, a workaround for a specific bug, behavior that would surprise a reader."*
- *"Avoid backwards-compatibility hacks like renaming unused _vars, re-exporting types, adding `// removed` comments for removed code."*

### 2.3 Sub-Agent Archetypes
Claude Code defines several specialized sub-agents via `BuiltInAgentDefinition`:
1. **`Explore` (Haiku / fast)**:
   - **Role**: Fast read-only search specialist.
   - **Enforcement**: Capitalized, emphatic prohibition: `=== CRITICAL: READ-ONLY MODE - NO FILE MODIFICATIONS ===`.
   - **Tooling**: Disallows `Edit`, `Write`, `NotebookEdit`, `Agent`. Disallows file redirection or state-changing bash commands.
   - **Guidance**: Spawns multiple parallel tool calls for grepping and reading files to return results as quickly as possible.
2. **`Plan` (Inherit / Opus)**:
   - **Role**: Software architect and planning specialist.
   - **Process**: 4-phase exploration, solution design, and sequencing.
   - **Output Constraints**: Mandatory `### Critical Files for Implementation` (3-5 files). Strict line caps (40 lines max in lean variants) to eliminate prose padding and ensure fast scanning.
3. **`verification` (Inherit / Sonnet / Opus)**:
   - **Role**: Dedicated adversarial tester. Core frame: *"Your job is not to confirm the implementation works — it's to try to break it."*
   - **Counteracting LLM Bias**: Explicitly calls out two failure modes:
     1. *Verification avoidance*: Reading code and writing "PASS" without running tests.
     2. *Seduced by the first 80%*: Passing when buttons look pretty but edge cases crash.
   - **Adversarial Probes**: Mandates testing concurrency races, boundary values (`-1`, `0`, `MAX_INT`, empty string), idempotency, and orphan operations.
   - **Output Schema**: Rigid verification blocks containing `Command run`, `Output observed`, and terminal line `VERDICT: PASS | FAIL | PARTIAL`.

---

## 3. OpenAI Codex CLI Prompt Architecture

### 3.1 Personality & Operating Stance
OpenAI's GPT-5 and GPT-5.2 Codex prompts (`gpt_5_codex_prompt.md`, `gpt_5_2_prompt.md`) emphasize:
- **Equal Co-builder & Collaborative Peer**: "Treat the user as an equal co-builder; preserve the user's intent and coding style rather than rewriting everything."
- **Autonomy & Persistence**:
  - *"Persist until the task is fully handled end-to-end within the current turn whenever feasible: do not stop at analysis or partial fixes; carry changes through implementation, verification, and a clear explanation of outcomes unless the user explicitly pauses or redirects you."*
  - *"Unless the user explicitly asks for a plan, asks a question about the code, is brainstorming potential solutions... assume the user wants you to make code changes or run tools to solve the user's problem. In these cases, it's bad to output your proposed solution in a message, you should go ahead and actually implement the change."*
- **Ambition vs. Precision Split**:
  - *Greenfield / New tasks*: Feel free to be ambitious, creative, and build rich modern UI/UX.
  - *Existing codebases*: Surgical precision, treat surrounding codebase with respect, minimal diffs.

### 3.2 The `AGENTS.md` Hierarchical Guidance Model
Codex standardizes repo-level steering through `AGENTS.md`:
- Files can exist anywhere in the repo hierarchy; scope covers the directory tree rooted at that file.
- Deeper nested files take precedence over root files.
- Prompt/developer instructions take precedence over `AGENTS.md`.

### 3.3 Planning: Checklist (`update_plan`) vs. Conversational Plan Mode
OpenAI separates progress tracking from architectural design:
- **`update_plan` (Micro-planning)**:
  - Purpose: Real-time progress checklist rendered directly in the TUI/CLI status widget.
  - Structure: 1-sentence steps (5-7 words each), statuses: `pending`, `in_progress`, `completed`.
  - Invariant: Exactly one step `in_progress` at any time; never batch complete retroactively; update before scope pivots.
- **Conversational Plan Mode (`plan.md`)**:
  - Entered explicitly; strict read-only.
  - Phase 1 (Ground in environment): Search and explore before asking; resolve discoverable facts first.
  - Phase 2 (Intent chat): Clarify goal and trade-offs.
  - Phase 3 (Implementation chat): Decision-complete specification.
  - Two classes of unknowns:
    1. *Discoverable facts*: explore first, never ask questions answerable from repo truth.
    2. *Preferences/trade-offs*: ask early using `request_user_input` with 2-4 mutually exclusive options plus a recommended default.
  - Deliverable: Wrapped in `<proposed_plan>` XML blocks for client extraction and rendering.

### 3.4 Code Review Rubric
Codex's `rubric.md` provides an industrial-grade review rubric:
- Focus: Bugs introduced by the patch (not pre-existing bugs), provably affected call sites, discrete and actionable.
- Comment length: At most 1 paragraph, snippets <= 3 lines, concrete reproduction scenario.
- Priority tagging: `[P0]` (drop everything, blocking release), `[P1]` (urgent, next cycle), `[P2]` (normal), `[P3]` (low/nit).
- Output format: Clean JSON schema containing `findings`, `overall_correctness` ("patch is correct" / "patch is incorrect"), and `overall_explanation`.

---

## 4. Google Gemini CLI Prompt Architecture

### 4.1 Token Economics & Context Efficiency Mandate
Gemini CLI stands out for embedding an explicit mental model of token costs and multi-turn economics directly into the core mandates:
- **Turn Cost Reality**: *"The agent passes the full history with each subsequent message. The larger context is early in the session, the more expensive each subsequent turn is. Unnecessary turns are generally more expensive than other types of wasted context."*
- **Surgical Search**: Grep with `-C` (context) or before/after parameters to gather enough lines to make string edits unambiguous in one shot, skipping unnecessary file reads.
- **Parallel Searches**: Run multiple narrow/scoped searches in parallel rather than broad sequential queries.

### 4.2 Directive vs. Inquiry Framework
Gemini CLI draws a sharp boundary to prevent unwanted autonomous side effects:
- **Directives**: Unambiguous requests for action ("Fix bug X", "Implement endpoint Y"). The agent must work autonomously, persistently resolving obstacles and executing to completion.
- **Inquiries**: Analysis, exploration, or advice ("Can you explain how auth works?", "What could we do about latency?"). The agent must **NOT** modify files. It performs read-only analysis and yields to the user.

### 4.3 Engineering Standards & Validation Lifecycle
- **Lifecycle**: `Research -> Strategy -> Execution (Plan -> Act -> Validate)`.
- **Validation Mandate**: *"Validation is the only path to finality. Never assume success or settle for unverified changes. Rigorous, exhaustive verification is mandatory... For bug fixes, you must empirically reproduce the failure with a new test case or reproduction script before applying the fix."*
- **The 3-Strike Strategic Re-evaluation Rule**:
  *"If you have attempted to fix a failing implementation more than 3 times without success, you must: 1. Stop and remind yourself of the original task description. 2. List your current assumptions and identify which ones might be wrong. 3. Propose a different architectural approach rather than continuing to patch the current one."*
- **Anti-hack standard**: Never use type casts (`as any`), suppression comments (`@ts-ignore`), or prototype hacks unless explicitly instructed.
- **Post-Edit Rule**: After an edit tool execution, the agent MUST ALWAYS generate a brief user-facing text response summarizing what changed and the next verification step (never return an empty response with 0 text tokens).

### 4.4 Sub-Agent Specialization (`codebase_investigator`)
Gemini CLI features `codebase_investigator` for deep architecture exploration:
- **Scratchpad Discipline**: Enforces "Thinking on Paper" with dynamic sections:
  1. `Checklist` of investigation goals.
  2. `Questions to Resolve` (must be completely empty before declaring completion).
  3. `Key Findings` with file paths and architectural roles.
  4. `Irrelevant Paths to Ignore` to avoid backtracking dead ends.
- **Structured JSON Report**: Returns `SummaryOfFindings`, `ExplorationTrace`, and `RelevantLocations` with reasoning and key symbols.

---

## 5. Synthesis: Core Insights for `github-router` Fast Mode

The `github-router` fast profile runs:
- **Lead Agent**: `gemini-3.8-flash` (1M context, high speed)
- **Explore**: `gpt-5.6-luna` (high effort, ultra-fast tool execution)
- **Plan**: `gpt-5.6-sol` (high effort, architectural rigor)
- **general-purpose**: `gpt-5.6-luna` (max effort, execution speed)
- **implementer**: `gemini-3.8-flash` (high effort, fast surgical coding)
- **reviewer**: `claude-sonnet-5` (1M context, xhigh effort, deep adversarial verification)
- **Advisor**: `gpt-5.6-sol` (1M context, high effort, lead-only trajectory guidance)
- **Oracle**: `claude-opus-5` (1M context, high effort, architectural trade-off consultant)
- **Astra**: `gpt-6-astra` (200K context, high effort, terminal escalation)

### Specific Improvements Derived from Frontier Labs:

1. **For Lead & Implementer (Gemini 3.8 Flash)**:
   - Adopt Gemini's **Directive vs. Inquiry** stance: don't hesitate on clear directives; autonomously execute and verify, but never mutate on pure questions.
   - Adopt Gemini's **3-Strike Re-evaluation Rule**: when tests fail 3 times, reset assumptions and change architectural approach rather than thrashing.
   - Adopt Anthropic's **Anti-Goldplating** and **Zero-Unnecessary-Comments** rules to prevent Gemini models from over-commenting or adding premature abstractions.
   - Adopt Gemini's **Post-Edit Rule**: summarize the diff and state the immediate verification command.

2. **For Explore (`gpt-5.6-luna`)**:
   - Adopt Anthropic's strict **Read-Only / No File Modifications** prohibition framing (`=== CRITICAL: READ-ONLY MODE ===`).
   - Adopt Codex's tool preference (`rg` and parallel tool batches).
   - Adopt Gemini's **Context Efficiency**: search with context lines to reduce subsequent read operations.

3. **For Plan (`gpt-5.6-sol`)**:
   - Adopt Codex's **Two Kinds of Unknowns** principle: discoverable facts must be explored from repo truth; only preferences/trade-offs should be escalated with options.
   - Adopt Anthropic's **40-line plan budget**: eliminate prose fluff, focus on critical files (3-5), interfaces, execution steps, and a single concrete verification command.
   - Adopt Codex's **Decision-Complete Specification**: the plan must leave zero ambiguity for the implementer.

4. **For Reviewer (`claude-sonnet-5`)**:
   - Adopt Anthropic's **Adversarial Verification Philosophy**: "Your job is not to confirm the implementation works — it's to try to break it."
   - Explicitly warn against the two failure modes: verification avoidance (saying PASS based on reading) and seduction by the first 80%.
   - Adopt Codex's **Discrete Finding Schema** with priorities `[P0]` through `[P3]`, exact file:line references, and actionable failure scenarios.
   - Require concrete verification evidence: command run + output observed.
