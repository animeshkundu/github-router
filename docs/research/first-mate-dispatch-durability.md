# Issue #5 — Dispatch durability (outbox). Peer-reviewed design.

## Problem
`startTask()` creates a cloud-agent task (irreversible; consumes quota, opens a
branch/PR) and runs BEFORE `upsertUnit()` persists the returned `taskId` to the
durable JSON ledger. A crash / write-fail in that window leaves disk in the
pre-dispatch state (`provider:"none", taskId:null` → `isUndispatched()`), so the
next `advance()` re-dispatches → a DUPLICATE orphaned task. Three sites:
`dispatchWave→dispatchUnit` (initial plan task), `applyModelAnswer` approve
(build task), `applyModelAnswer` refine (new plan task). The `dispatchUnit`
issue-assignment fallback is a fourth irreversible side effect.

## Cross-lab peer review (codex_critic gpt-5.5 + gemini_critic gemini-3.1-pro)
Both converged:
- **Persist-intent-before-act + "pending intent is not undispatched" is the correct floor.**
- **Time-window adoption is unsafe** — "a single untracked task created after
  requestedMs" can adopt the WRONG task (concurrent sibling dispatch, another
  actor, clock skew, read-after-write lag). Never adopt by time.
- **Correlate by an exact, provider-visible ID.** Embed the dispatch UUID in the
  task payload (prompt tail `<!-- fm-dispatch:{id} -->`; issue body for the
  fallback). Recovery adopts ONLY on an exact ID match; otherwise escalate.
- **Classify failures:** definitive (4xx validation/quota/auth → request rejected,
  no task → clear intent, handle normally) vs unknown (timeout/5xx/network/crash
  → keep pending; recovery resolves). Don't wedge units on routine 4xx.
- **No client retries around the POST** (a retry after a lost-success double-creates)
  unless server idempotency is proven.
- Persist-intent write failing = HARD STOP (don't call startTask).
- Adding `unit.dispatch` must round-trip the ledger (the #15 field-drop class) —
  add a regression test.
- Send `Idempotency-Key: {id}` defensively (free safety if honored; correctness
  rests on the correlation-ID recovery regardless).

## Design (as implemented — safe core)
1. `unit.dispatch?: { id: string; requestedMs: number; attempts: number }` —
   `id` is the correlation ID + `Idempotency-Key`.
2. `dispatchWithOutbox(unit, deps, startFn)`:
   a. set `unit.dispatch = {id, requestedMs, attempts+1}`; `upsertUnit` — persist
      intent BEFORE the side effect. If this write throws, propagate (hard stop).
   b. `startFn(id)` → `startTask` with the id embedded in the prompt tail and sent
      as `Idempotency-Key`; the POST does NOT auto-retry.
   c. on success: set `taskId`/`provider`, `unit.dispatch = undefined`; `upsertUnit`.
   d. on throw: leave `dispatch` pending; do NOT fall back to another side effect.
3. `isUndispatched := provider==="none" && taskId===null && dispatch===undefined`.
4. Recovery: a unit with `dispatch` set + no `taskId` is surfaced as an
   `escalate_human` ("dispatch interrupted") carrying the correlation ID, rather
   than silently wedged or blindly re-dispatched.

## Deferred follow-up (documented, not silent)
Automated recovery-by-correlation (list recent tasks, read each candidate's
session log for `fm-dispatch:{id}`, adopt on exact match, else bounded
re-dispatch when confirmed no task exists) is a heavier enhancement. The safe
floor above (never blind re-dispatch; escalate on uncertain recovery) is what
ships now; auto-adopt is a bounded follow-up gated on exact correlation.
