# 001 — Autonomous feature-parity workflow

## Status

Accepted — 2026-05-31. Scan mode implemented; fix/pr modes implemented behind the `mode` arg and
gated by a manual first-audit. Engine lives at `.claude/workflows/parity.js`.

## Context

github-router exists to make GitHub Copilot speak Claude Code's language. Anthropic ships Claude
Code + the Messages API quickly — new `anthropic-beta` headers, body fields, tool types,
`CLAUDE_CODE_*` gates, slash commands, models, and harness features (agent teams, advisor,
workflows/routines) land continuously. Keeping the proxy at parity has been the bulk of recent
work, and it was entirely manual: a human notices a new feature, checks the codebase + the five
support-ledger docs, and wires translate/strip/gate + a probe row + a compat-matrix row + tests +
a ledger update.

We wanted that loop to run autonomously, thoughtfully, and to a high bar — driving real
improvements to development speed and quality without regressing existing behavior.

## Decision

Encode the loop as a re-runnable Claude Code **Workflow** (`Workflow({name:"parity"})`), not a
bespoke runner. Pipeline: ground → discover (parallel scouts over npm/releases.atom/docs) → assess
each candidate against the ledger oracle → adversarially refute each gap (real + proxy-relevant +
worth doing) → plan thoroughly with a `codex_critic` pass → (fix/pr) implement the full footprint
in an isolated worktree, run the repo's own regression gate, self-review the diff, open a **draft**
PR.

Load-bearing choices:

- **The support ledger + the symmetric probe suite are both oracle and regression gate.** "Supported"
  = compat-matrix row + passing probe + ledger entry + handler wiring + tests. "Didn't regress" =
  the full `probe:copilot --strict` + `bun test` stay green. We reuse existing truth instead of
  inventing a parallel notion of correctness.
- **One worktree agent per feature does implement → gate → diff-review → publish.** Each
  `isolation:"worktree"` call gets its *own* worktree, so the whole chain must run in a single agent
  to share state and to push before Workflow auto-cleans the worktree.
- **Draft PRs only; human + `windows-latest` CI remain the merge gate.** Local-green ≠ Windows-green
  by design — the draft PR is where CI runs.
- **Default mode is `scan`, not `pr`.** A safe default prevents accidental PR floods; full-auto is
  the explicit `mode:"pr"` opt-in. `maxPrs` (default 3) bounds blast radius.
- **Runtime state (`.claude/parity/state.json`) is gitignored** and never staged, so feature PRs stay
  clean. Only `.docs/parity-backlog.md` is tracked human-facing output.

## Consequences

- **Positive:** parity gaps surface continuously with designs attached; the first expected finding is
  first-class workflows support (the `~/.claude/workflows` mirror policy in `src/lib/paths.ts`
  defaults to `MIRRORED` and was never explicitly classified). Reviews are cross-lab and adversarial;
  every shipped change carries a probe + matrix row + regression test by construction.
- **Negative / limits:** rails are prompt-enforced + draft-only, not a hard security boundary
  (subagents hold real `bash`/`git`/`gh`) — acceptable for an on-demand, user-watched tool; running
  it **unattended** would require a push-only token + a non-LLM publisher first. No distributed lock,
  so run one `parity` at a time. Discovery depends on Anthropic's public release surfaces staying
  reachable + parseable.
- **Verification:** first run `mode:"scan"` (audit only); then `mode:"fix"` on the top gap to confirm
  the regression gate holds; then `mode:"pr", maxPrs:1` to confirm a single clean draft PR with no
  attribution and idempotent reruns.
