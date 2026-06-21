# Floor-raising agent surface: research + orchestrate + floor-keeper + a consent-gated Stop-gate

> **Status:** design, hardened after a three-lab adversarial review (gpt-5.5 / gemini-3.1-pro / opus). The review reversed two earlier decisions (default-on Stop-gate → consent-gated; inject-into-every-session → top-level only) and forced honest scoping of what is actually "deterministic." Those corrections are folded in below.

## Context

PR #67 shipped the orchestration tools (`mcp__orchestrate__decompose` / `verify_workflow` / `run_workflow` / `attest_step`) and worker modes `mcp__workers__plan` / `mcp__workers__test`, on top of `workers` (explore/review/implement), `peers` (cross-lab critics/reviewers), and `search` (code/web). Claude rarely reaches for them on its own, and nothing ties them into a single discipline. This plan injects a coordinated agent surface into the **top-level** `github-router claude` session to make the agent more reliable, better-grounded, and more honest about its own uncertainty.

## Honest threat model and limits (read this first)

The review's central correction: **do not conflate mechanism-determinism with correctness.** What is and is not guaranteed:

- **Deterministic, but narrow:** the Stop-gate's exit code is deterministic, but only (a) in a repo the user has consented to run code in, (b) for the slice of correctness the checks actually cover, and (c) when the executable oracle is **not itself model-authored in the same flow**. A green gate does **not** mean "correct" — it means "the checks that ran, passed."
- **The wrong-spec hole is real and unsolved by gates.** If the model misreads the task, it can tag its wrong root cause "verified", generate acceptance criteria for the wrong fix, have a different lab write tests against those wrong criteria, and pass every gate — all layers green on code that does the wrong thing. **The only defense is user-blessed acceptance criteria + a human checkpoint.** This is an *irreducible residual*, labeled as such everywhere it applies; the gates are not claimed to catch it.
- **Probabilistic, by nature:** skills, the steering hook, the saturation tags (`verified-source` / `cross-lab-agreed`), blind-spot tagging, and severity reconciliation are all **model-mediated** — they raise quality *in expectation*, not deterministically. Only `verified-executable` (backed by an actual run) and the Stop-gate exit code are deterministic. The plan labels these two profiles separately and never sells the model-mediated parts as a floor.
- **Cross-lab reduces correlated blind spots, it does not eliminate error.** Different labs (OpenAI/Google/Anthropic) fail on different inputs; that is the entire value. It is non-monotone (a critic can invent a problem or be unavailable), so it only raises the floor when a **code rule consumes its output** (the executable gate, `attest_step`'s lineage check), and even then only within the limits above.

## Session scoping (load-bearing — the review's #2 Critical)

The hooks and steering apply to the **top-level user session ONLY**. Every internal session the proxy or a workflow spawns (workers, peer critics, the floor-keeper subagent, native-`Workflow` subagents) is marked `GH_ROUTER_INTERNAL_SESSION=1` in its env, and **both hooks stand down when that marker is set.** Rationale:

- Workers operate on intentionally-incomplete intermediate states (the implementer stops before the test-worker runs). A Stop-gate firing inside them would block the wrong session, make a worker try to fix the whole repo, and violate the test-authorship separation.
- The steering hook injecting "go orchestrate" into a worker's prompt causes multiplicative orchestration nesting (the review estimated 40-60 sub-sessions per prompt). Internal sessions never get steered.
- Internal sessions may *run* the gate as an advisory tool and report status; they are never *blocked* by it.

**No nesting:** a native-`Workflow` node may not invoke `/gh-orchestrate`, and the orchestrator carries a depth/`call`-budget token; exceeding it stops with a diagnostic, never silently recurses.

## The recipe every component follows

`cross-lab proposal → code-driven decision`. Different-lab models surface findings/tests; the binding decision is an executable result (the gate is green, an authored test runs and passes) — within the limits above. Where no executable oracle exists, the component **says so** (irreducible residual) instead of pretending determinism.

## Component R — Research skill (`gh-research`, the saturation engine)

A standalone, user-invocable skill (`/gh-research`) that returns a confidence-tagged, root-cause brief. It delegates heavy gather to parallel `mcp__workers__explore` workers (own context) + cross-lab critics, returning a compact brief. The loop is **bounded** (the review's #4 Critical — saturation alone never terminates):

- *Enumerate the unknowns as an explicit worklist*, then fan out **in parallel** to close each: `mcp__search__code` semantic → lexical, git blame, `mcp__search__web`, parallel `mcp__workers__explore`. Add newly-discovered unknowns to the worklist.
- *Form a root-cause hypothesis* (bugs → causal chain; features → integration points + constraints).
- *Adversarially verify load-bearing claims against primary sources.* Prefer executable proof (**reproduce** the bug / run the failing test = `verified-executable`, the only deterministic tag). Else read the actual lines, have `mcp__workers__review` confirm, and have a **blind, different-lab critic** try to refute — *blind* meaning it gets the diff/symptom and AC only, **not** the proposed root cause, so it cannot anchor on our framing (review suggestion).
- *Termination is bounded, not just "saturated":* hard caps — max rounds (default 3), max parallel workers, a token/`call` budget. The loop ends at the **first** of: saturation (worklist closed, a further round surfaces nothing material, root cause ≥ `verified-source`) **or** a cap. On a cap-hit it returns with the **open unknowns explicitly flagged as residual**, never loops forever and never silently claims completeness.
- *Honest tags:* only `verified-executable` is deterministic; `verified-source` / `cross-lab-agreed` are model self-assessment (the model can misread source and still tag `verified-source`). The brief states this, so downstream and the user know which findings are load-bearing-verified vs advisory.
- *Persist + freshness:* write the full brief to a durable file with **freshness metadata** (`HEAD` commit + working-tree diff hash + timestamp). Reference by pointer post-compaction; dependent phases **re-read and check freshness**, and treat the brief as stale (re-verify) if the commit/diff hash moved (review: stale-brief hole). Never re-inject the whole brief into the per-turn prefix.

## Component A — Orchestrate skill (`gh-orchestrate`)

`SKILL.md` whose objective is blind-spot elimination, right-sized to the ask (a 3-line fix does **not** traverse the full pipeline — the review's analysis-paralysis warning). Phases:

- **0 Scope + user-blessed AC.** Capture explicit acceptance criteria from the user. This is the **only** gate against the wrong-spec hole; everything downstream judges against it.
- **1 Research (delegate to `/gh-research`).** Wait for its bounded brief; a cap-hit-with-residuals brief is surfaced to the user, not silently treated as complete.
- **2 Blind-spot analysis** (executable-checkable vs judgment-only).
- **3 Decompose** `mcp__orchestrate__decompose({ ask, context: brief + blind-spots })`.
- **4 Plan** `mcp__workers__plan`.
- **5 Compose a native `Workflow`**, each node annotated with the blind spot it kills and **deterministic vs advisory** (honestly). Role→tool: research→`explore`/`search`; plan→`worker_plan`; implement→`worker_implement` (`worktree:true`); test→`worker_test` **different lab, advisory practice not enforced — see invariant note**; review→`codex_reviewer`+`gemini_reviewer` (advisory); `baseline`+`selector`→**opt-in / right-sized** (it doubles cost, so it is not default for every workflow — review #4); verify→cross-lab + `attest_step` (producer ≠ checker lab). Workflow-spawned workers are `GH_ROUTER_INTERNAL_SESSION=1` (no gate, no steer, no nesting).
- **6 Verify** `mcp__orchestrate__verify_workflow`; fix drift (bounded ≤3).
- **7 Checkpoint, then run.** Present the goal, node→tool map, per-node deterministic/advisory annotation, **the residual-risk list (incl. the wrong-spec residual)**, and a cost estimate. The human checkpoint is where intent errors are caught. Then run.

The `selector`'s `max(orchestrated, baseline)` must be decided by the **executable gate result**, not model judgment; if no executable oracle exists for the ask, the selector is advisory and the plan says so. For a hard `max(orchestrated, baseline)` guarantee, `mcp__orchestrate__run_workflow` (the frozen kernel) remains the alternative.

## Component B — Floor-keeper (`gh-floor-keeper` skill + injected `floor-keeper` subagent)

The done-checkpoint cross-lab verification. The subagent runs as an **internal session** (`GH_ROUTER_INTERNAL_SESSION=1`), so it has **no Stop-gate on itself** — it cannot deadlock authoring a test that fails initially (review: self-deadlock). It *runs* the gate as a tool and reports it. Given the diff + AC: (1) run the executable gate (advisorily, as a command), (2) fan the diff to `codex_reviewer` (OpenAI) + `gemini_reviewer` (Google), (3) consult `advisor`, (4) reconcile by severity, (5) return go/no-go where the **gate result is binding for what it covers** and cross-lab is advisory — explicitly flagging that a green gate does not rule out wrong-spec. Missing-test authoring is **bounded** (cap attempts; ask the user before creating a large new test harness) and routed to a different lab as advisory practice. Reuses `/gh-research` for claim verification.

## Component C — Stop-gate, consent-gated per repo (deterministic enforcement, scoped)

The `Stop` hook runs the sealed gate over the working-tree diff and exit-2 blocks the turn ending when red. **Reversed from default-on to consent-gated** (the review's #1 Critical — auto-running a repo's `test`/`lint`/`typecheck` scripts is arbitrary code execution without consent):

- **Per-repo trust (consent once).** Default OFF. The first time the gate would run in a repo, the user is prompted to consent (a recorded per-repo trust keyed by repo root + git remote). Once trusted, it runs automatically for that repo. `GH_ROUTER_ENABLE_STOP_GATE` force-on / `GH_ROUTER_DISABLE_STOP_GATE` force-off still apply. **Never executes an untrusted repo's scripts.**
- **Top-level session only** (`GH_ROUTER_INTERNAL_SESSION` stand-down) — workers/subagents are never blocked.
- **Baseline isolation** (review: pre-existing reds trap the session). Capture which checks were green at session start; **block only on regressions the diff caused**, never on pre-existing failures. A repo that is red before Claude touches it never traps the user.
- **Gate command hygiene.** Prefer non-mutating checks (typecheck/test); never an `eslint --fix`-style mutating command as a gate. Hard per-command timeout; the consent prompt shows the exact command(s) so the user confirms applicability (covers the bun-vs-npm / monorepo / long-e2e weakness).
- **`stop_hook_active` vs "block twice" (review #3 Critical).** The per-prompt budget (keyed by `session_id` + prompt id, atomic) is the termination guarantee; the `stop_hook_active` re-entry signal must **not** blanket-stand-down the second block or `maxBlocks=2` is defeated. Re-examine the existing stand-down so a genuine second post-block check still fires; reserve the re-entry guard for true hook recursion only.
- **Per-prompt budget** (default 2), reset on `UserPromptSubmit`. Since the gate is top-level only, the "2 × workers" multiplication is gone.
- **Fail-open timeout is surfaced, not silent** (review): a timed-out/unrun gate is reported to the transcript as an explicit `unknown` state distinct from green/red — never presented as a pass.

## Component S — Prompt-steering hook (`UserPromptSubmit`, sets the goal; top-level only)

A `UserPromptSubmit` hook (additive-context, **fail-open, never blocking**, top-level only via the internal-session stand-down) that, when a cheap complexity heuristic fires, injects an **advisory** goal directive (run `/gh-research` to saturation, then `/gh-orchestrate` if it's an implementation task). Honest framing: this **raises the prior**, it does not force execution (a hook cannot inject a tool_call or run an in-model skill; the research loop is minutes-long and `UserPromptSubmit` blocks the turn, so it stays goal-only). Trivial prompts get nothing (no analysis-paralysis tax). Both the Stop-gate's per-prompt budget reset (C) and this goal-steer (S) fire on `UserPromptSubmit` → one `internal-prompt-submit` subcommand. Opt-out `GH_ROUTER_DISABLE_PROMPT_STEER`.

## Cross-cutting note — test authorship is advisory, not an enforced invariant (review correction)

Earlier this was called an "invariant." The Stop-gate cannot verify *who* authored a test (the implementer can write it via Bash before the floor-keeper runs), so calling it an invariant was a confabulation. It is an **advisory practice** the skills steer (`mcp__workers__test` defaults to gpt-5.5 xhigh, a different lab than an Anthropic implementer). True enforcement would need file-provenance tracking, which is out of scope and noted as such. The plan does not claim the separation is guaranteed.

## Shared injection infrastructure (reuse, don't reinvent)

- **Skill writer** — `writeInjectedSkill(name, md)` → `<CLAUDE_CONFIG_DIR>/skills/<name>/SKILL.md`, where the folder name equals the frontmatter `name` (no slash — `gh-research`, not `/gh-research`; the slash is only the user's invocation form). **Atomic temp+rename** so a concurrent child can never read a partial file (review: skill-cache race); written before child spawn so the dir exists at session start. Reuse `isUnderClaudeConfigMirrorRealpath` + `renameWithRetry`. No per-skill sweep (per-launch mirror is GC'd wholesale).
- **Drift resistance** (review: hardcoded tool names/slugs silently break) — a **boot-time consistency test** asserts every tool name referenced in the skill bodies exists in the live MCP tool surface (extend the existing `assertMcpToolSurfaceConsistent`). Prefer templating the resolved group keys (`mcp__<group>__<tool>`) into the skill text at injection time rather than freezing literals. A rename then fails CI instead of silently producing prompt-theater.
- **Agent writer** — reuse `writePeerAgentMdFiles` for the `floor-keeper` subagent; add `floor-keeper` to the sweep allowlist regex.
- **Settings hook-merge** — reuse `injectStopHookIntoSettingsFile` / `mergeStopHookIntoSettings`. Both the budget reset (C) and the steer (S) are one `internal-prompt-submit` `UserPromptSubmit` entry; the Stop gate is a separate `Stop` entry.
- **Awareness** — extend `buildPeerAwarenessSnippet` with the three skills + when to use them + the honest-limits note; reaches the top-level agent and descendants.
- **Internal-session marker** — set `GH_ROUTER_INTERNAL_SESSION=1` in the env of every worker / critic / floor-keeper / Workflow-spawned session; the hook subcommands stand down when it is set.
- **Gating + opt-outs** — skills + agent gate on `workerToolsEnabled()`; per-surface opt-outs (`GH_ROUTER_DISABLE_{RESEARCH_SKILL,ORCHESTRATION_SKILL,FLOOR_KEEPER,STOP_GATE,PROMPT_STEER}`).

## Feasibility (confirmed)

- Skills load from `<CLAUDE_CONFIG_DIR>/skills/<name>/SKILL.md` by filesystem presence (folder == frontmatter `name`; `description` required). `server-setup.ts:335` lists "skills" as mirror-preserved. **Verify** the installed Claude Code version's skill-load timing + `UserPromptSubmit` additive-context semantics before relying on them (the repo already does version-specific binary checks).
- `skills/` is **MIRRORED** (snapshot, not symlink), so writing our subdir never touches the user's real `~/.claude/skills/`.
- The Stop-gate, peer-agent `.md` injection, and settings hook-merge already exist and are unit-tested; this plan reverses a default, scopes the hooks, adds baseline isolation, adds two skills + one agent.

## Files

- `src/lib/injected-skills/` (new) — `research-skill.ts` / `orchestrate-skill.ts` / `floor-keeper-skill.ts` + `write.ts`.
- `src/lib/claude-md-injection.ts` — export `isUnderClaudeConfigMirrorRealpath` + `renameWithRetry` (or factor `mirror-write.ts`).
- `src/lib/codex-mcp-config.ts` — add the `floor-keeper` persona; set `GH_ROUTER_INTERNAL_SESSION=1` in spawned worker/critic/subagent env.
- `src/lib/paths.ts` — `floor-keeper` in the sweep allowlist.
- `src/lib/orchestration/stop-gate-hook.ts` — per-repo trust store + consent, baseline-isolation (regression-only blocking), internal-session stand-down, `stop_hook_active`/`maxBlocks` fix, timeout→explicit-unknown.
- `src/lib/worker-agent/` + the orchestrate Workflow path — propagate `GH_ROUTER_INTERNAL_SESSION`; no-nesting depth/call budget.
- `src/claude.ts` — write skills + floor-keeper agent after mirror; register the `Stop` + `UserPromptSubmit` hooks (top-level only); pass `workspace` for trust/harness checks.
- `src/lib/peer-mcp-personas.ts` — awareness block + extend `assertMcpToolSurfaceConsistent` to cover skill-body tool references.
- `tests/` — injected-skill writer (name==folder, atomic write, opt-out, mirror-guard); floor-keeper agent; stop-gate (consent-gating, baseline-isolation regression-only, internal-session stand-down, block-twice actually fires, timeout=unknown); steering (top-level only, fail-open); drift test (skill-body tool names exist).
- `CLAUDE.md`, `docs/agent-orchestration-design.md`, `package.json` (version bump).

## Verification (end-to-end)

1. `bun test` new/changed suites; `bun run typecheck && bun run lint:all`.
2. Launch in this repo: `/gh-research` + `/gh-orchestrate` + `/gh-floor-keeper` listed; skill files present; floor-keeper agent `.md` present; `Stop` + `UserPromptSubmit` hooks in mirrored `settings.json`.
3. **Scoping:** confirm a spawned `worker_explore` / floor-keeper session carries `GH_ROUTER_INTERNAL_SESSION=1` and its Stop/UserPromptSubmit hooks stand down (no gate, no steer, no nesting).
4. **Consent:** in a fresh repo, confirm the gate does **not** run until the user consents; after consent, it runs; confirm a malicious `test` script is never auto-run pre-consent.
5. **Baseline isolation:** a repo with a pre-existing failing test does not trap the session; only a regression the diff introduces blocks.
6. **Block-twice:** break typecheck → gate blocks twice then stands down (not once); new user prompt resets; timed-out gate reports `unknown`, not pass.
7. **Bounded research:** `/gh-research` returns at a cap with residuals flagged, never loops forever; tags distinguish `verified-executable` from advisory.
8. **Orchestrate right-sizing + no nesting:** a trivial prompt skips the pipeline; a Workflow node cannot launch `/gh-orchestrate`; checkpoint shows the residual-risk list including the wrong-spec residual.
9. **Drift test:** renaming a tool fails the skill-body consistency test in CI.
10. Opt-outs each remove their surface; non-Bun/no-script/untrusted repos leave the gate off; Windows CI parity.

## Suggested sequencing (phaseable into PRs)

1. **Shared infra + internal-session scoping + Stop-gate hardening** (consent-gating, baseline-isolation, block-twice fix, timeout=unknown). Smallest, and it is the safety-critical core — nothing else ships until the gate is safe and scoped.
2. **Research skill (R)** — bounded saturation engine; foundation for A and B.
3. **Floor-keeper (B)** — internal-session subagent + skill, reusing R.
4. **Orchestrate skill (A)** — right-sized, no-nesting, opt-in baseline; depends on R.

## Implementation status (deltas from the design above)

Landed on `feat/floor-raising-agent-surface` (verified: typecheck + lint clean; stop-gate 46 tests, hook/skill 17 tests; security core reviewed by gpt-5.3-codex + gemini-3.1-pro with findings fixed):

- **Scoping is payload-based, not an env marker.** Verified against the official hooks docs: stand down when the hook payload has a non-null `agent_type`/`agent_id` (`isSubagentContext`, fail-closed). Supersedes every `GH_ROUTER_INTERNAL_SESSION` reference above. Pi workers fire no Claude Code hooks, so they need no marker.
- **Consent UX is `--trust-gate`** (not an interactive prompt): `github-router claude --trust-gate` records per-repo consent (pinned to the repo's root-commit fingerprint); otherwise the launcher prints a one-time opt-in notice when a harness is detected. Force via `GH_ROUTER_ENABLE_STOP_GATE`, off via `GH_ROUTER_DISABLE_STOP_GATE`.
- **Per-prompt block budget** (`maxBlocks=2`) reset by the `UserPromptSubmit` hook; the `stop_hook_active` stand-down was removed (absent from the current payload, and it defeated block-twice).
- **Baseline isolation v1** records the first eval's failing checks as the baseline (keyed by session+cwd+gate, written only on a completed eval) and blocks only on later regressions + gate-weakening. Known limitation: a regression introduced *before* the first eval is baselined-in; a `SessionStart(startup)` pre-capture is the future upgrade.
- **Skills shipped:** `gh-research`, `gh-orchestrate`, `gh-floor-keeper` (content + injection). A drift test asserts every `mcp__*` tool name in the skill bodies is real.
- **Deferred:** the named `floor-keeper` *subagent* persona (the `gh-floor-keeper` skill delivers the behavior by invoking the cross-lab reviewers + gate directly); widening the sealed gates beyond Bun; the `SessionStart` baseline pre-capture.
- **Known follow-ups (gemini integration review):** (1) the Stop-gate is currently coupled to `--codex-mcp` (the enhancement-layer master switch) — decoupling it so the deterministic gate runs under `--no-codex-mcp` is a clean follow-up; (2) `injectStopHookIntoSettingsFile` uses an un-retried `fs.rename` — adding the `renameWithRetry` pattern would harden the two `settings.json` writes against transient Windows `EBUSY`/`EPERM`.

## Default posture update (the Stop-gate is now ON by default)

Per the maintainer's decision, the Stop-gate is **enabled by default** via **consent-by-launching** (supersedes the "default OFF / `--trust-gate` required" framing above):

- When `github-router claude` launches in a repo with a detectable Bun harness and the gate is not disabled, the launcher **auto-trusts that repo** (records it, pinned to the root-commit) and registers the Stop hook, printing a one-time notice. No `--trust-gate` needed (the flag remains for explicit/scripted use).
- The gate still runs **only the launched repo's own** `typecheck`/`test`/`lint`, is **baseline-isolated** (blocks only on regressions), **top-level-only**, and **per-prompt-bounded**. Because trust is recorded and the runtime hook re-checks it, a mid-session `cd` into an UNtrusted repo still won't run that repo's scripts.
- **Opt out** entirely with `GH_ROUTER_DISABLE_STOP_GATE=1`.
- **Security note:** on-by-default means the first launch in a repo runs that repo's scripts at stop. The launch notice precedes any gate execution, and the gate only runs the dev scripts a developer working in that repo runs anyway. Users who open untrusted repos should set `GH_ROUTER_DISABLE_STOP_GATE=1`.

## Language-agnostic Stop-gate (generalized beyond Bun/TS)

The original gate only auto-enabled for Bun/TS repos: `detectHarnessGateId` required a `typecheck` npm script and all sealed gates hard-coded `bun run …`. A repo with no `typecheck` script (e.g. a plain-JS or Python/Rust/Go project) silently got no gate **and no message saying why** — it read as a broken hook. This generalization (corrected by a second three-lab panel: gpt-5.5 / gemini-3.1-pro / opus-4.7) makes the gate work for any project while keeping the sealed-kernel invariant intact.

**Resolution order (launcher, `claude.ts`), first match wins → a `GateDescriptor`:**
1. **`sealed`** — the bun/TS fast-path, byte-identical to the legacy behavior (`bun` on PATH + a `typecheck` script → sealed `default-ci`/`typecheck-test`).
2. **`parsed`** — the deterministic parser (`src/lib/orchestration/harness-parse.ts`) reads the project's OWN config — `package.json` scripts (runner chosen by lockfile), CI `run:` steps (`.github/workflows/*.yml`, `.gitlab-ci.yml`), Make/just/Taskfile targets, and `Cargo.toml`/`go.mod`/`pyproject.toml` conventions — and emits canonical `typecheck`/`lint`/`test` commands. **Evidence-pinned by construction:** it only emits a command present verbatim in a source (or a fixed manifest command like `cargo check`/`go vet ./...`). No model, no latency, no prompt-injection surface. The panel's key point: reading the project's real CI/scripts is *parsing*, not guessing, so it handles non-standard names (`make lint`, `pnpm verify`, `nox -s typecheck`) that a hard-coded table would miss.
3. **`discovered`** — the OPT-IN last-resort model fallback (`src/lib/orchestration/gate-discovery.ts`), enabled with `GH_ROUTER_ENABLE_GATE_DISCOVERY=1` (default OFF): when parsing finds nothing, a read-only worker reads an allowlisted, byte-capped set of config/doc files and proposes commands. Two guards make a model-authored command safe to auto-run in an already-trusted repo: **sanitize** (`sanitizeDiscoveredCheck` rejects shell metacharacters, destructive/stateful verbs — on a whitespace-normalized copy so `npm  install` can't slip through — mutating `--fix`/`:fix` shapes, interactive/watch shapes, and an executable not on PATH) and **evidence-pin** (the command must appear verbatim in a collected source — the model cannot invent or be prompt-injected into a command that isn't already real in the repo). Discovery runs **once, in the background**, persists a human-readable record under `<APP_DIR>/stop-gate/discovered/<hash>` keyed by `(repoFingerprint, sourcesHash)` (re-validated id + re-sanitized on read), and **arms on the next launch** (no launch-time model latency). It re-discovers when `sourcesHash` changes. The cache bounds the *command set*, NOT what those commands execute — it is not a safety boundary. **Caveat / follow-up:** discovery currently uses the tool-enabled `explore` worker, which can read repo files (secret files — `.env*`/`*.pem`/keys — are blocked at the worker IO layer) and send non-secret content to the model; this is why it is opt-in. A no-tools rewrite that passes only the deterministically-collected, capped signal text inline is the planned hardening.
4. **off, with a visible reason** — nothing resolved: the launcher now prints `Structural Stop-gate not enabled: no checks found … Force a sealed gate with GH_ROUTER_ENABLE_STOP_GATE=1.` This is the fix for the original silent skip.

**Runtime (`internal-stop-hook.ts`).** The launcher arms a resolver via env: `GH_ROUTER_STOP_GATE_ID` (sealed, unchanged), `GH_ROUTER_STOP_GATE_PARSED` (re-derive the parser at the stop-time tree — stateless, no cache), or `GH_ROUTER_STOP_GATE_DISCOVERED` (read the cached record). `decideStopHook` gained an injected `resolveChecks` that returns `{checks, workdir, descriptorKey, baselineKey}`; checks run in the descriptor's **`workdir`** (the repo/package root the evidence was found in, NOT the Stop payload `cwd` — the monorepo fix), and any null/miss fails OPEN.

**Two panel-Critical fixes folded in:**
- **Baseline captured at LAUNCH (pre-mutation).** The legacy baseline was recorded at the *first stop*, after the agent had already mutated the tree — so an agent-introduced failure became the baseline and was never blocked. For the dynamic paths the launcher now runs the static checks once at launch (background, fire-and-forget) and seeds the baseline under a launch-stable key `launchBaselineKey(workdir, descriptorKey, perLaunchToken)`; the hook recomputes the same key (reading the token from its env) and reads it, so an agent-introduced failure is a *regression*. HEAD is deliberately NOT in the key (an agent commit would otherwise erase the baseline); the per-launch token isolates concurrent sessions. A changed check set degrades to first-stop baselining. Capture is best-effort pre-mutation (the agent does not edit until well after a user prompt); the worst case is the legacy first-stop baseline, never a wedge. (The sealed bun/TS path keeps its legacy first-stop baseline.)
- **Loud max-block stand-down.** After the per-prompt `maxBlocks` limit the gate still allows the stop (termination guard), but now emits a loud stderr line instead of a silent exit 0, so a forced pass with unresolved failures is never invisible.

**Static vs test.** Only `typecheck`/`lint` are always-on; the full test suite is opt-in (`GH_ROUTER_STOP_GATE_RUN_TESTS=1`) since it runs project code and is slow on every stop. `build` is deliberately NOT a check id — a full bundle/SEA build is the slow-command/false-red footgun the design avoids; compile-checking stays under `typecheck` (`go vet`, `cargo check`, `tsc`).

**Per-language gate-weakening.** `detectGateWeakening` (`gate-immutability.ts`) now selects patterns by the diff line's file extension — ts/py/go/rust suppressions plus a shared common set; an unknown extension uses the common set only (fails open). This generalizes beyond TS/JS and removes cross-language false positives.

**Kernel wall (unchanged).** `run_workflow`/`verify_workflow` stay strictly sealed: `sealedGateIds()` is the only gate source there and never includes a `parsed`/`discovered` id. The dynamic descriptors are consumed only by the local Stop hook.

**Flags:** `GH_ROUTER_STOP_GATE_RUN_TESTS=1` (run the test suite as a check), `GH_ROUTER_ENABLE_GATE_DISCOVERY=1` (opt into the model fallback; default off — parser-only), `GH_ROUTER_DISABLE_STOP_GATE=1` (off entirely). Implementation: `harness-parse.ts` (parser), `gate-discovery.ts` (fallback), `stop-gate-hook.ts` (`resolveChecks` + `captureLaunchBaseline` + `launchBaselineKey`), `internal-stop-hook.ts` (runtime resolver), `claude.ts` (launch resolution + messages). Tests: `tests/orchestration-harness-parse.test.ts`, `tests/orchestration-gate-discovery.test.ts`, extended `tests/orchestration-gate-immutability.test.ts` + `tests/orchestration-stop-gate-hook.test.ts`.
