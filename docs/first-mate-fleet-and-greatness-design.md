# First-mate: fleet-conductor + repo-greatness — design spec

> v0.1 (2026-07-14). Design for owner approval, not yet implemented. Backed by two research passes this session (delegation architecture; repo-greatness shipping infrastructure). Realizes: (1) the DEFAULT first-mate driver is a per-repo CEO meta-subagent, conducted by one armed loop; (2) "repo greatness" = robust CI, CD, a Google-discoverable Pages site with screenshots+video, releases, package publishing, and a publish pipeline — as VERIFIABLE checkpoints.

## Why (the two asks)

1. **CEO meta-subagent as the default per-repo driver.** Today the main session drives first-mate directly (thin `gh-first-mate` loop + heartbeat). It should instead be a **fleet conductor**: one armed deterministic loop that drives N repos, each by a per-repo CEO meta-subagent with the full protocol + authority. Only the main REPL can arm a durable cron (a subagent can't self-cron), so the conductor is structurally the main session.
2. **Expanded definition of greatness.** A successful public repo needs robust CI + CD, a Google-discoverable GitHub Pages site (screenshots + video), releases, package publishing where applicable, and a publish pipeline to the repo's final destination — each stated as an externally verifiable checkpoint the CEO drives toward and the eval scores.

The linchpin tying both: a single-source **`DEFINITION_OF_GREATNESS`** constant the conductor carries, each CEO drives toward, the scaffold seeds, the strategy store tracks per-item with evidence, and the eval scores.

## Part A — Fleet-conductor architecture

**Model (recommended: fresh-CEO-per-wake re-hydration).** The main session is a thin fleet conductor; per-repo CEOs are short-lived and re-hydrate from disk. This preserves first-mate's axiom ("the model holds none of the state; it re-hydrates from the ledger every wake", `types.ts:8`) and bounds context at fleet scale. A long-lived CEO (SendMessage-resume) was rejected: its transcript grows unboundedly → compaction thrash + N held contexts.

**Armed-loop mechanics (each heartbeat wake, on the main session):**
1. **One global `advance()` sweep** (no `mission_id`) — sweeps the whole portfolio; **tier1 auto-answers already fired inside the tool** for the safe `author_fix`/`answer_agent_question`/`decompose` envelope (the cost governor — most wakes surface little).
2. **Partition** the residual `needsModel` (escalated `review_plan`/`judge_review` + tier1-declined) + `needsHuman` + board rows by mission/repo.
3. **Surgical per-repo CEO fan-out** — for each mission with an open judgment request OR a due strategic checkpoint (phase-advance, greatness-item verification, kill/pivot), spawn a **fresh** CEO meta-subagent (`Agent`, `Tools: *`) in parallel. Hand it: `missionId`, its board slice, its request payloads, and the strategy pointer. The CEO loads `gh-first-mate` + `gh-first-mate-operate` + `DEFINITION_OF_GREATNESS`, reads its strategy record, **verifies deliverables against external evidence** (delegating heavy reads to `worker-explore`/`worker-review`), answers its mission's `needsModel` (returns verdicts — does NOT call `advance` itself, to avoid heartbeat-lease contention), updates its strategy record, returns a compact summary + `needsHuman` to courier, and dies.
4. **Courier + re-arm** — relay `needsHuman` packets to the user; batch all CEO verdicts into ONE applying `advance`; re-arm the ONE `[fm-heartbeat]` cron from the MIN `nextWakeSeconds` across the portfolio (create-fresh-then-reap-rest convergence; dead-man's-switch; survives idle/compaction/restart/clear).

**Caps:** fleet fan-out cap (≤K CEOs/wake, queue the rest) vs. `MAX_INFLIGHT_TOOLS_CALL` (128); `max_in_flight_per_provider`; per-mission `maxConcurrentBuilds` (disjoint `fileScopes`). Spawn only on demand — a mission grinding with no `needsModel`/checkpoint spawns zero CEOs.

**The one new durable artifact — the strategy store** (`strategy.json` under `PATHS.FIRST_MATE_DIR`, CAS via `durable-store.commitJsonCas`, like `decisions.ts`/`registry.ts`). Per-mission `StrategyRecord`:
- `missionId`, `repos`, `currentPhase` (index into `CONDENSED_OPERATING_SEQUENCE`)
- `activeBet` `{ hypothesis, metric, threshold, decisionRule: kill|pivot|continue }` (pre-registered before the experiment)
- `greatnessChecklist` — per `DEFINITION_OF_GREATNESS` item `{ item, status: done|pending, evidence: <run id|URL|PR|Pages URL|release tag|published version> }`
- `decisionLog` (append-only `hypothesis→experiment→metric→threshold→outcome` + evidence links)
- `openAssumptions`, `nextStrategicAction` + trigger, `updatedMs`, `updatedByWake`
This is the strategic counterpart to the mechanical ledger — what stops fresh CEOs drifting/re-litigating. Nothing today holds it (`decisions.json` = human merge/abandon approvals; `Mission` = static config).

**Files (no controller/guard/MCP-registration change needed — subagents already see `mcp__first-mate__*`):**
- NEW `src/lib/injected-skills/first-mate-conduct-skill.ts` — the fleet-conductor skill (main-session only; arms the heartbeat, sweep, fan-out, courier, re-arm; carries/refs the full brain).
- `src/lib/injected-skills/first-mate-skill.ts` — reframe as the per-CEO driving protocol (drop heartbeat-arming from the CEO path; keep advance/answer/verify/context-discipline).
- NEW `src/lib/first-mate/strategy-store.ts` + `StrategyRecord` in `types.ts` (CAS).
- `src/lib/first-mate/tools.ts` — add `read_strategy`/`write_strategy` (CAS-safe; first-mate group, subagents inherit).
- `src/lib/first-mate/operating-protocol.ts` — add `DEFINITION_OF_GREATNESS` (single source of truth).
- `src/lib/injected-skills/index.ts` + `src/claude.ts` (`isFirstMateSkillName`, gating filter, operator banner → `/gh-first-mate-conduct`).

**Residual limitation (harness-level, out of scope):** a subagent can't arm cron, so the main session must remain the fleet's heartbeat owner. The north-star fix is a budgeted/killable self-waking subagent (a Claude Code feature).

## Part B — Definition of repo greatness (verifiable)

**Meta-invariant:** `version file == git tag == GitHub Release == registry version == CHANGELOG heading == live-site build stamp`. Most checkpoints are cross-checks of this identity. Every item is externally verifiable by a third party with no special access (a green check, a `gh api`, a `curl`, a `cosign verify`).

**Universal core (all repos):** default-branch **ruleset** (required lint/typecheck/test/build green + strict + ≥1 review + linear history); **matrix CI** (OS × version) green; CodeQL + Dependabot (deps+security+actions) + secret-scanning + push-protection; least-privilege `permissions:` + SHA-pinned `uses:` + OpenSSF Scorecard; reproducible installs + **flaky quarantine (never retry-until-green)**; SemVer single-sourced + Keep-a-Changelog + tagged Releases with generated notes + release automation (release-please/semantic-release); README theme-adaptive hero + demo (GIF/asciinema/video) + alt text + repo social-preview; **build-provenance attestation** (`actions/attest-build-provenance`, SLSA L3).

**By final destination (detected from repo root):**
- **Web app / docs → GitHub Pages:** Actions-based deploy (`build_type=workflow`), auto-deploy on merge, protected `github-pages` env; **live-content proof** (`BUILD_SHA.txt` on the edge == HEAD); full SEO (sitemap + robots + canonical + no accidental noindex; OG + Twitter + JSON-LD `SoftwareApplication`; Lighthouse SEO ≥90; CWV LCP≤2.5s/INP≤200ms/CLS≤0.1; HTTPS + custom-domain DNS; Search Console + sitemap + IndexNow); og-image 1200×630; content targeting real queries.
- **JS/CLI → npm:** OIDC Trusted Publishing (no token) + `--provenance`; `npm install` works; `npm audit signatures`.
- **Python → PyPI:** Trusted Publisher (OIDC, env) + PEP 740 attestation; `pip install` works.
- **Rust → crates.io:** Trusted Publishing (OIDC; first publish manual); `cargo add` resolves.
- **Service → GHCR:** multi-arch + `provenance:true`+`sbom:true` + keyless cosign; `cosign verify` + `docker pull`.
- **Action → Marketplace:** complete `action.yml` + floating major tag; `uses: owner/action@v1` resolves.
- **Go → proxy:** tag `vX.Y.Z` (`/vN` for major≥2); `go install ...@vX.Y.Z`.

**Encoding:** `DEFINITION_OF_GREATNESS` in `operating-protocol.ts` (each item = checkpoint + evidence-handle + `gh`/`curl` proof), referenced by `scaffold-spec.ts` (seed the workflows: `pages.yml`, `release.yml`, `publish-*.yml` per destination, `codeql.yml`, `dependabot.yml`, a Pages SEO scaffold with sitemap/robots/OG/JSON-LD, a Playwright/VHS media-capture workflow), the conductor + CEO skills, and the eval framework (a "shipping infrastructure" scored dimension + hard checkpoints). Time-sensitive facts to encode as current (2026): INP replaced FID; npm/crates OIDC GA; SLSA L3 attestations; VS Code Marketplace still needs a long-lived PAT (the one OIDC gap). Non-`curl`-gradeable soft signals: SEO indexing/ranking (never guaranteed) + E-E-A-T (proxy via byline/date/architecture + GSC).

## Phasing (proposed)

- **Phase 1 — Greatness bar (Ask 2).** `DEFINITION_OF_GREATNESS` constant + scaffold workflows/site + playbook + eval dimension. Self-contained, high-value, low-risk; benefits the current single-CEO model immediately.
- **Phase 2 — Fleet conductor (Ask 1).** Conductor skill + strategy store + strategy tools + reframe `gh-first-mate` + CEO skill + banner. The architectural change for multi-repo scale.

Each phase: implement → cross-lab review (safety-touching pieces) → tests (skill drift/SSOT; strategy-store CAS; scaffold file assertions) → gate (typecheck/lint/`bun test`) → version bump → PR.

## Verification
- Skills: SSOT/drift tests (both surfaces embed `DEFINITION_OF_GREATNESS`; conductor references operate + greatness).
- Strategy store: CAS/fencing unit tests (concurrent daemon/heartbeat write), schema round-trip.
- Scaffold: assert each greatness workflow/file is seeded per detected repo type; `enhance` mode appends.
- Eval: the shipping-infra dimension computes from real GitHub state (`gh api rules`, deploy status, `curl` OG/sitemap, release/registry cross-check).
- End-to-end: a real CEO run drives a repo to the bar; the eval scores the greatness checklist against live evidence.
