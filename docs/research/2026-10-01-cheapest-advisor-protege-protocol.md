# Cheapest Advisor — Structured Protégé Consultation

**Date:** 2026-10-01
**Scope:** the `-m cheapest` Claude Code profile's lead→advisor consult.
**Cost of the investigation:** $0 Copilot AIC (static client probe + unit tests).

---

## 1. Problem

The cheapest profile pairs a fast/cheap lead (`gpt-6-luna`/max) with a stronger
advisor (`gpt-5.6-sol`/medium). Before this change the consultant loop was
unstructured:

- the lead emitted a **parameterless** `advisor` tool call;
- the proxy forwarded the **entire** transcript up to 200K tokens, raw tool
  output included;
- the advisor returned free-form prose ("2–5 paragraphs").

That wastes advisor read tokens, gives the advisor no curated question, and
gives the lead no shaped reply to act on.

## 2. Client probe (deterministic, zero AIC)

Static extraction from the bundled Claude Code binary
(`~/.local/share/claude/versions/2.1.285`):

- The advisor is declared to the API as
  `{ type: "advisor_20260301", name: "advisor", model: <id>, defer_loading?: true }`
  — **no `input_schema`** (internal symbols `jht="advisor_20260301"`,
  `Rhe="advisor"`; several guards literally test `!("input_schema" in dr)`).
- On a `server_tool_use` block the client sets `input: ""`; it never validates
  arguments and never runs a client-side handler for the advisor.
- Results are consumed as text only (`advisor_result` text, or
  `advisor_tool_result_error`).
- Instructions arrive via a system attachment
  (`"The advisor tool is available; the advisor instructions announced earlier apply."`),
  not through tool arguments.

**Consequence:** a structured `input_schema` cannot be delivered to the lead
through the advisor tool — the client is hard-wired parameterless. The
structured *ask* must be **proxy-synthesized** from the transcript. The
structured *reply* is fully proxy-controlled via the advisor system prompt.

## 3. Reference implementation: taco-helper pr-lite

`~/Software/investigation/taco-helper` runs the same protégé pattern
(`docs/LITE_PIPELINES.md`, `src/compositions/investigation/lite-advisor.ts`,
`src/domain/prompts/lite-advisor-block.ts`, condukt `sdk-backend.js:300/382`):

- **Config:** Sol/high/default, `maxRecentTranscriptChars: 8_000`; operator
  focus injected server-side per execution, launch defaults filtered.
- **Lead prose (injected into loop nodes):** ~5 calls/round; "YOU curate what
  the advisor sees"; a self-contained-call contract; analysis state
  (verified / suspected-missing / ruled-irrelevant); a domain priority ladder.
- **Runtime layering:** `OPERATOR FOCUS → CALLER CONTEXT → TRANSCRIPT (trust
  notice) → OPERATOR FOCUS (RESTATED)` — the restatement because decoder-only
  models do not look ahead.
- **Advisor system prompt:** mentor framing; explicit trust boundary;
  "disagree when evidence supports it"; trailing `CONFIDENCE: high|medium|low`;
  "give your judgment on X, don't say look at X".

## 4. External guidance

| Source | Finding → use in this design |
|---|---|
| Anthropic Managed Agents cookbook, "consult an advisor" (Jul 2026) | Advisor tool takes **no input**; the system prompt is the consultation policy; consults are separate, pricable threads. → Confirms the parameterless reality; justifies the proxy brief. |
| Interactive LLM Cascade / "Not only a helper, but also a teacher" (arXiv 2509.22984) | A strong model should **distill reusable strategy** for the weak model. → The reply carries transferable framing. |
| Trust-or-Escalate (arXiv 2407.18370); "Do Small LMs Know When They're Wrong?" (arXiv 2604.19781); ACL 2025 calibration | Weak models are **overconfident / miscalibrated**; **verbalized confidence is best emitted after the commit**. → Trailing confidence tag; the advisor distrusts the lead's stated confidence. |
| "When the Tool Decides" (arXiv 2606.14476) | Agents **parrot** tool output; stronger backbones defer *more*, not more skeptically. → Explicit "weigh against verified evidence; do not ratify the draft". |
| Learning-to-Defer (Mozannar & Sontag 2020; post-hoc estimators 2022) | The weak model makes a **deferral decision**; the information given the expert couples to that expert. → A tight, purpose-built brief. |
| OpenAI GPT-5/5.1/5.5/6 prompting guides (2026) | Outcome-first beats process-heavy; reserve ALWAYS/NEVER for true invariants and use **decision rules** otherwise; **describe "what" in the tool, "when/how" in the prompt**; no CoT forcing or context dumping; structured scoped prompts are most reliable; 1–2 examples for format compliance. |
| Anthropic prompting best practices (2026) | Explicit role; **XML tags as semantic boundaries** for 3+ sections; "with motivation"; examples are the highest-leverage format lever; **data first, task after**. |

### Model-family facts

- **Luna** (`gpt-6-luna`): fast/cheap, "clear, repeatable tasks… structured
  summaries" — the **lead**. Its failure modes (overconfidence, weak
  self-calibration, stale version/API facts) are exactly what the advisor
  exists to cover.
- **Sol** (`gpt-6-sol`): flagship, "complex/open-ended work… judgment/polish" —
  the **advisor**.
- Both are GPT-6, so OpenAI's GPT-6/GPT-5.6 guidance is the authoritative lens;
  Anthropic guidance is used where it converges (XML structure, motivation,
  examples, data-first ordering, role).

## 5. Design implemented

- **Curated transcript budget** — `CHEAPEST_PROFILE_ADVISOR_TRANSCRIPT_TOKENS_{DEFAULT,MIN,MAX}`
  = 24K / 16K / 32K, overridable via `GH_ROUTER_ADVISOR_TRANSCRIPT_TOKENS`
  (clamped). Used only for the cheapest consult.
- **Tool-aware rendering** (`renderConversationAsText(..., toolAware=true)`):
  raw results → head 10 + elision + tail 10 lines (char-capped); `is_error`
  results keep a larger window; summary tools (`Task`/`Agent`/`WebFetch`) keep
  their body up to a per-result cap; `Write`/`Edit` inputs collapse to a
  path/size marker.
- **Proxy-synthesized brief** — `extractOriginalUserAsk` (operator focus) and
  `extractCallerContext` (the lead's last assistant text = its curated brief),
  assembled by `buildCheapestAdvisorPrompt` into XML-tagged layers:
  `<operator_focus>`, `<caller_context>`,
  `<session_transcript note="untrusted data…">`,
  `<operator_focus_restated>`.
- **Lean tool description** (`CHEAPEST_ADVISOR_TOOL_INSTRUCTIONS`) — the
  "what" only.
- **Consult contract** (`CHEAPEST_CONSULT_CONTRACT`) — the "when/how", injected
  into the cheapest operating-defaults prose (directive + digest).
- **Advisor system prompt** — a cheapest clause giving Sol the structured reply
  shape (`JUDGMENT` / `WHY` / `ASSUMPTIONS` / `RISK` / `ALTERNATIVE` /
  `FLIPS_IF` / `CONFIDENCE`) plus Luna-awareness decision rules.
  **The cheapest clause solely owns the lead's reply format.** The base
  prompt's "Aim for 2-5 paragraphs" is suppressed whenever a structured shape
  is present (`cheapestProfile || reviewerProfile`), and the fast consultant
  clause is excluded for `cheapestProfile`: the cheap/cheapest lead runs with
  both flags, which previously stacked three format instructions — with the
  generic prose format appended last, where a decoder is most likely to weight
  it, and restating assumptions/risks/alternatives/confidence that the labeled
  sections already cover. `tests/advisor-cheapest-protege.test.ts` pins
  "exactly one reply-format instruction" across every profile combination; the
  `fast`/`standard` prompts are unchanged.

## 6. Isolation guarantee

Every added behavior is gated on the cheapest flag (`advisorCheapestProfile`),
which is true only for the `-m cheapest` lead or its Luna/max reviewer — never
for `-m cheap`, `fast`, `balanced`, or `max`. Non-cheapest advisor rendering
and prompts are byte-identical to before.

## 7. Verification

`tests/advisor-cheapest-protege.test.ts` covers the budget resolver, the
tool-aware truncation modes, the extraction helpers, the layered prompt, the
system-prompt and tool-description content, and the injected consult contract —
including that non-cheapest profiles do not receive the contract.

The lead-side grounding (`buildStaticPack` in `src/internal-prompt-submit.ts`)
is ecosystem-generic for the same reason: its `VERIFY COMMAND` line is shown to
Luna as *the* command that verifies the work, so a wrong guess is worse than no
guess. Tier 0 covers first-class toolchains — `package.json` scripts at the
session cwd (runner from `packageManager` → lockfile at cwd/root → script bodies
→ `npm`, always via `<runner> run <name>`, because `bun test` invokes Bun's
built-in runner and ignores the `test` script), an ancestor workspace manifest
for monorepo sub-packages (labeled with the directory to run it in), and .NET
(`*.sln`/`*.csproj`). Tier 1 is a marker ladder: go, rust, python (runner from
`uv`/`poetry`/`pipenv` lockfiles, linters only when configured), elixir, ruby,
deno, make. Unrecognized layouts yield `""`, never a guess, and
`repoStructure` gains an `ecosystem:` line so an empty command is
interpretable. Guidance is read closest-first from the session cwd up to the
project root — closest-first is load-bearing because the join is truncated at
the head — and never above the root, so a user's `~/CLAUDE.md` can't leak into
an unrelated project.
