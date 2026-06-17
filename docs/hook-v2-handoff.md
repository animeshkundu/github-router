# Hook V2 — implementation handoff (resume after context clear)

**Goal:** implement the advisory-only cross-lab review hooks per [`docs/hook-v2-design.md`](hook-v2-design.md) (the approved, twice-3-lab-reviewed plan). Read that design doc first.

**Branch:** `feat/floor-raising-agent-surface`. PR **#69** is open on this branch (the floor-raising agent surface v1 — skills + v1 hooks + default-on stop-gate). The hook-V2 commits are stacked on top of the same branch. **Decide PR strategy on resume:** either grow #69 or split hook-V2 into a follow-up PR. Nothing about hook-V2 should merge until the integration below is complete (the committed stores are unused → CI `knip` will flag them red until they're wired in).

## What is DONE and committed (local + pushed)

- **Skill optimizations** (`perf(skills)` commit): `gh-orchestrate` now runs `decompose ∥ worker_plan` as one parallel batch (Phase 3+4 merged — they're independent) and teaches pipeline-by-default Workflow composition (Phase 5); `gh-research` got a single-turn-parallel nudge. Typecheck + drift + frontmatter tests green.
- **Stores** (`feat(stop-review)` commit) in `src/lib/orchestration/stop-gate-policy.ts`: `fileReviewDebounce(stateDir)` (`shouldReview`/`markReviewed`, keyed by sha256(session_id), per-session last-reviewed diff-hash) and `fileFindingsStore(stateDir)` (`read`/`write` atomic temp+rename/`clear`). **Currently UNUSED → wire them in next or CI stays red.**

## Load-bearing DECISIONS (do not re-litigate — they came from two adversarial review rounds)

- **Advisory-only. The LLM review NEVER blocks.** The deterministic gate (v1: sealed typecheck/test/lint + baseline isolation, unconditional) is the ONLY hard blocker. A *blocking* LLM reviewer was rejected twice as non-monotone (coerced degradation: a confident-wrong / wrong-asserting test pressures Claude into degrading correct code; the contest valve is rendered by the accused and loses). Do NOT reintroduce blocking, `worker_test`, worktrees, repro-tests, or a synthesized/persisted AC.
- **Stop reviewer = `worker_review` (read-only) on the LIVE working tree** (not `worker_test`, not a worktree — a git worktree checks out HEAD and would review stale code; read-only on the live tree sees the real uncommitted diff and mutates nothing).
- **No synthesized AC.** The reviewer judges against the user's actual prompt + plan. The UserPromptSubmit goal is *user-derived* (restate the user's own ask), advisory, not persisted/enforced.

## REMAINING work (tasks 10-11)

1. **VERIFY the `/mcp` over-HTTP wire format FIRST** (the one real unknown — don't guess). Read `src/routes/mcp/route.ts` + `src/routes/mcp/handler.ts`: is a `tools/call` response SSE-framed or plain JSON? What's the result envelope? This determines the client below.
2. **MCP-over-HTTP client** (new, e.g. `src/lib/orchestration/hook-mcp-client.ts`): POST a JSON-RPC `tools/call` to `${serverUrl}/mcp/<group>` with header `Authorization: Bearer <nonce>`, parse the text result. Used by the review runner (`workers/review`) and the prompt hook (`search/code`). The per-launch `nonce` + `serverUrl` come from the peer-MCP runtime (`writePeerMcpRuntimeFiles` in `src/lib/codex-mcp-config.ts` — it already mints a 32-byte hex nonce for the `/mcp` Authorization header).
3. **`internal-stop-review.ts`** (new detached subcommand, register in `src/main.ts` + banner-suppress it): reads {session_id, cwd, diff, prompt, transcript_path, findings-path} from argv/stdin, calls `workers/review` via the client (read-only, model gpt-5.5, the custom accountability prompt: judge the diff against the user's prompt + plan for wrong-spec / vacuous-tests / incompleteness; surface findings; do NOT author/run tests), writes the findings text to `fileFindingsStore`. It may run up to the worker wall-clock cap; it's detached so nothing waits on it.
4. **Stop hook wiring** (`src/internal-stop-hook.ts` / `src/lib/orchestration/stop-gate-hook.ts`): after the deterministic gate is GREEN, if there is a substantive diff and `fileReviewDebounce.shouldReview(session, diffHash)` → spawn `internal-stop-review` **detached + unref'd** (it must outlive the hook), `markReviewed`, and **return exit 0 immediately**. The deterministic-regression path is unchanged (still blocks unconditionally). The review NEVER affects the exit code.
5. **UserPromptSubmit V2** (`src/lib/orchestration/prompt-submit-hook.ts` + `src/internal-prompt-submit.ts`): keep the budget reset; (a) cheap-classify — trivial prompt → static "search lexical+semantic in parallel" nudge + surface any pending findings, return; (b) substantive → parallel `search/code` (lexical + semantic) via the client + ONE gpt-5.5 inference call (prompt + search results → scope + user-derived measurable goal + `/gh-research`+`/gh-orchestrate` nudge if large) → inject + grounding + pending findings; clear the findings store after surfacing; fail-open to the existing regex heuristic on any error/timeout. Raise the `UserPromptSubmit` hook `timeout` (default 30s) via the registered hook's `timeout` field if the single call needs it.
6. **Launcher** (`src/claude.ts`): set the proxy `serverUrl` + the peer-MCP `nonce` into the spawned child env (e.g. `GH_ROUTER_HOOK_MCP_URL`, `GH_ROUTER_HOOK_NONCE`) so the hooks (and the detached review runner they spawn) can reach the proxy; add `GH_ROUTER_DISABLE_STOP_REVIEW=1` (keep the deterministic gate, drop the LLM layer).
7. **Tests (different-lab author, e.g. `worker_test` gpt-5.5):** the review-never-blocks invariant (Stop returns exit 0 regardless of findings), deterministic-regression-still-unconditional, debounce (skip identical diff), findings round-trip + next-turn surfacing + clear, prompt-hook cheap-classify + fail-open, no-AC-store. Then a **fresh cross-lab review** of the implementation (codex_reviewer + gemini_reviewer) before merge.

## Verify commands

`bun run typecheck` · `bun test tests/orchestration-*.test.ts tests/injected-skills*.test.ts` · `bun run lint:all`. (Full `bun test` does not complete in a bare dev env — the colbert sidecar + browser tests hang without provisioning; those areas are untouched here.)

## Risks / gotchas

- The `/mcp` wire format (step 1) — verify, don't guess.
- Detached spawn must inherit the proxy URL + nonce env and `unref()` so it survives the hook's exit; Windows-safe spawn (use the repo's exec helpers / `resolveExecutable`).
- The committed stores are unused until wired → `knip` red until then.
- Version bump per PR (repo rule). No AI attribution in commits/PR (repo rule). Don't push to remote / open-update a PR for outward review without the user.
