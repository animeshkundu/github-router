export const meta = {
  name: "parity",
  description:
    "Feature-parity engine: detect what Anthropic / Claude Code just shipped, decide whether github-router supports it completely, and for real proxy-side gaps plan + (optionally) implement parity without regressing the probe/test suite. Stops at a draft PR; the human + windows-latest CI remain the merge gate.",
  phases: [
    { title: "Ground", detail: "verify current CC version + load last-seen baseline" },
    { title: "Discover", detail: "parallel scouts over Anthropic/Claude Code release surfaces" },
    { title: "Assess", detail: "classify each candidate against the support ledger + codebase" },
    { title: "Verify", detail: "adversarially refute each gap (real + proxy-relevant + worth doing)" },
    { title: "Plan", detail: "thorough design + codex_critic review per surviving gap" },
    { title: "Ship", detail: "worktree implement + regression gate + diff review + draft PR" },
    { title: "Synthesize", detail: "write backlog + state ledger" },
  ],
};

// ---------------------------------------------------------------------------
// Args + safety defaults.
//   mode: "scan" (audit + designed backlog, zero mutation) — DEFAULT, safest
//         "fix"  (implement + regression-gate in worktrees, leave diffs, no push)
//         "pr"   (full auto -> draft PR; the only mode that touches the remote)
//   maxPrs: cap on items carried into Ship (bounds blast radius + cost)
//   since:  override the auto last-seen baseline ("all" = full frontier audit)
// Default is "scan" rather than "pr": the first run should always be an audit,
// and a safe default prevents an accidental PR flood. mode:"pr" is the opt-in
// full-auto path.
// ---------------------------------------------------------------------------
const mode = (args && args.mode) || "scan";
const maxPrs = args && Number.isInteger(args.maxPrs) && args.maxPrs >= 0 ? args.maxPrs : 3;
const since = (args && args.since) || null;
const STATE_PATH = ".claude/parity/state.json";
const BACKLOG_PATH = ".docs/parity-backlog.md";

// Full normalized key for dedupe / idempotency fingerprint (NOT truncated, so
// distinct long feature names never collide). `slug` is the truncated form,
// used only for branch names + display labels.
const keyOf = (s) =>
  String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
const slug = (s) => keyOf(s).slice(0, 48);

// ---- Schemas (force structured returns; agents retry on mismatch) ----------
const CANDIDATES_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["candidates"],
  properties: {
    candidates: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "surfaceType", "summary"],
        properties: {
          name: { type: "string", description: "feature name, e.g. 'workflows', 'effort param'" },
          surfaceType: {
            type: "string",
            enum: ["beta-header", "body-field", "endpoint", "tool-type", "env-var", "cli-flag", "model", "setting", "harness", "other"],
          },
          sourceUrl: { type: "string" },
          version: { type: "string", description: "CC/API version or date it shipped, if known" },
          summary: { type: "string", description: "one-line: what it is + what a proxy might need to do" },
        },
      },
    },
  },
};

const ASSESS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["feature", "status", "gap"],
  properties: {
    feature: { type: "string" },
    status: {
      type: "string",
      enum: ["fully-supported", "partial", "unsupported", "intentionally-unsupported", "passthrough-covered", "not-proxy-relevant"],
    },
    evidence: { type: "string", description: "file:line citations backing the status" },
    ledgerRef: { type: "string", description: "if intentional, the ledger doc + line that records the decision" },
    gap: { type: "string", description: "what's missing (empty if no gap)" },
  },
};

const VERDICT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["realGap", "proxyRelevant", "worthDoing", "reasoning"],
  properties: {
    realGap: { type: "boolean", description: "is it genuinely unsupported (not already covered/intentional)?" },
    proxyRelevant: { type: "boolean", description: "does the PROXY need to do something, vs a pure cloud/harness feature?" },
    worthDoing: { type: "boolean" },
    severity: { type: "string", enum: ["low", "medium", "high"] },
    reasoning: { type: "string" },
  },
};

const PLAN_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["feature", "targetFiles", "mechanism", "probeRows", "regressionRisk", "design"],
  properties: {
    feature: { type: "string" },
    targetFiles: { type: "array", items: { type: "string" } },
    mechanism: { type: "string", description: "translate | strip | gate | passthrough + how" },
    probeRows: { type: "string", description: "exact probe id(s) + compat-matrix row(s) to add" },
    tests: { type: "string" },
    regressionRisk: { type: "string", description: "which existing probes/tests could this perturb" },
    design: { type: "string", description: "the full implementation plan, critic-reviewed" },
    feasible: { type: "boolean", description: "false if the design agent concludes it should not be auto-implemented" },
  },
};

const SHIP_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["feature", "outcome"],
  properties: {
    feature: { type: "string" },
    outcome: { type: "string", enum: ["pr-opened", "fix-ready", "deferred"] },
    prUrl: { type: "string" },
    branch: { type: "string" },
    deferClass: { type: "string", enum: ["fix-failed", "gate-red", "diff-rejected", "flake", "env", "already-open", "none"] },
    notes: { type: "string", description: "verify output summary / why deferred" },
  },
};

// ---------------------------------------------------------------------------
// Phase: Ground — confirm current CC version + load the last-seen baseline.
// ---------------------------------------------------------------------------
phase("Ground");
const baseline = await agent(
  `You are grounding an autonomous feature-parity run for the github-router repo (cwd = repo root).
1. Report the currently-installed Claude Code version (run \`claude --version\`).
2. Read ${STATE_PATH} if it exists (it may not). Return the recorded \`lastSeen\` version/date and the list of feature names already tracked (any status). If the file is absent, lastSeen is null and seen is [].
3. Baseline policy: ${since ? `the caller passed since="${since}" — use it.` : "no override — if lastSeen exists use it, else this is a FULL frontier audit ('all')."}
Return concise JSON.`,
  {
    phase: "Ground",
    label: "ground:baseline",
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["ccVersion", "baseline", "seenFeatures"],
      properties: {
        ccVersion: { type: "string" },
        baseline: { type: "string", description: "version/date or 'all'" },
        seenFeatures: { type: "array", items: { type: "string" } },
      },
    },
  }
);
const seen = new Set((baseline?.seenFeatures || []).map(keyOf));
log(`Grounded: CC ${baseline?.ccVersion}; baseline=${baseline?.baseline}; ${seen.size} features already tracked.`);

// ---------------------------------------------------------------------------
// Phase: Discover — parallel scouts, one per authoritative release surface.
// Each is blind to the others. They use web_search + WebFetch (fetch_url).
// ---------------------------------------------------------------------------
phase("Discover");
const BASELINE = baseline?.baseline || "all";
const SCOUTS = [
  {
    label: "scout:claude-code",
    brief: `Scout NEW Claude Code (the CLI, npm @anthropic-ai/claude-code) features since ${BASELINE}.
Sources: https://registry.npmjs.org/@anthropic-ai/claude-code (JSON: versions + times), https://github.com/anthropics/claude-code/releases.atom, https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md, https://code.claude.com/docs/llms.txt.
Surface kinds: CLI flags, settings.json keys, CLAUDE_CODE_* env vars, slash commands, hooks, agent/subagent/teams features, workflows/routines. Use WebFetch + web_search.`,
  },
  {
    label: "scout:api",
    brief: `Scout NEW Anthropic Messages API features since ${BASELINE}.
Sources: https://docs.anthropic.com/en/release-notes/overview and the API reference. Surface kinds: new anthropic-beta header values, new request body fields, new endpoints, new tool types (web_search/computer-use/etc.), thinking/effort params.`,
  },
  {
    label: "scout:models",
    brief: `Scout NEW Anthropic model IDs / context-window changes since ${BASELINE}.
Source: https://docs.anthropic.com/en/docs/models/overview and https://www.anthropic.com/news. Return each new model ID, its context window, and which Copilot slug (if any) it maps to. surfaceType="model".`,
  },
];
const scoutResults = await parallel(
  SCOUTS.map((s) => () =>
    agent(`${s.brief}\n\nReturn ONLY genuinely new/changed surfaces (not long-standing ones). Empty list is a valid answer.`, {
      phase: "Discover",
      label: s.label,
      schema: CANDIDATES_SCHEMA,
    })
  )
);

// Flatten + dedupe by slug; drop anything already tracked in state.
const byKey = new Map();
for (const r of scoutResults.filter(Boolean)) {
  for (const c of r.candidates || []) {
    const key = keyOf(c.name);
    if (!key || seen.has(key)) continue;
    if (!byKey.has(key)) byKey.set(key, c);
  }
}
let candidates = [...byKey.values()];
log(`Discovered ${candidates.length} new candidate surfaces (after dedupe vs ${seen.size} tracked).`);
if (candidates.length === 0) {
  return { mode, candidates: 0, message: "No new frontier features since baseline. Parity holds." };
}

// ---------------------------------------------------------------------------
// Phase Assess -> Verify, pipelined per candidate (no barrier: a candidate
// that finishes assessment is verified immediately while others still assess).
// ---------------------------------------------------------------------------
const LEDGER = `The support ledger (the known-decision oracle — reconcile against these so intentional non-goals are NOT re-flagged): docs/unsupported-features.md, docs/beta-headers.md, docs/claude-env-injection.md, docs/copilot-compat-matrix.md, docs/default-models.md. "Fully supported" = compat-matrix row + passing probe (scripts/probe-copilot-compat.sh) + ledger-doc entry + handler wiring + tests. The proxy auth/config mirror policy lives in src/lib/paths.ts (ensureClaudeConfigMirror: ISOLATED/SHARED/MIRRORED) and docs/auth-isolation.md — relevant for harness-surface features (e.g. does ~/.claude/workflows survive a proxy session?).`;

const assessed = await pipeline(
  candidates,
  // Stage 1: assess support status against ledger + codebase.
  (c) =>
    agent(
      `Assess whether the github-router proxy already supports this Anthropic/Claude Code feature (cwd = repo root). Use code_search + Read + ripgrep.

FEATURE: ${c.name} (${c.surfaceType}) — ${c.summary}${c.sourceUrl ? `\nSource: ${c.sourceUrl}` : ""}

${LEDGER}

Classify the status precisely and cite file:line evidence. If it is an intentional non-goal, cite the exact ledger line. Be honest: "passthrough-covered" means the proxy forwards it untouched and that is correct; "not-proxy-relevant" means it is a pure cloud/local-harness feature the proxy plays no part in.`,
      { phase: "Assess", label: `assess:${slug(c.name)}`, schema: ASSESS_SCHEMA }
    ),
  // Stage 2: for apparent gaps only, adversarially refute. Short-circuit others.
  (a, c) => {
    if (!a || (a.status !== "unsupported" && a.status !== "partial")) {
      return { assess: a, verdict: null, candidate: c };
    }
    return agent(
      `Validate this assessed parity gap before it enters the backlog. This is a FALSE-POSITIVE guard, not a reflexive veto: the assessor already classified it "${a.status}" with code evidence, so PRESUME it is a real gap unless you can show otherwise.

CLAIMED GAP: ${a.feature} — status ${a.status}. ${a.gap}
Evidence cited: ${a.evidence || "(none)"}

${LEDGER}

Rules (evidence-driven, not skeptical-by-default):
- Set realGap=false ONLY if you can cite where the proxy ALREADY handles this, OR a ledger line marking it an intentional non-goal. A genuinely unsupported/partial Anthropic feature is a real gap even if minor.
- Set proxyRelevant=false ONLY if the feature has NO wire-protocol or config-mirror surface the proxy touches (a pure client-side UI/harness feature). Note: a feature can be mostly client-side yet still have a narrow proxy sliver — e.g. it adds a new ~/.claude/ subdir whose mirror policy in src/lib/paths.ts is unclassified (defaults MIRRORED when SHARED is needed for session persistence). If such a sliver exists, proxyRelevant=true and narrow the gap to that sliver.
- worthDoing reflects priority, not permission — set it honestly but it does NOT gate inclusion; severity drives ranking.
Verify against the actual code, not the claim.`,
      { phase: "Verify", label: `verify:${slug(c.name)}`, schema: VERDICT_SCHEMA }
    ).then((verdict) => ({ assess: a, verdict, candidate: c }));
  }
);

// Partition explicitly. `assessed` entries may be: null (assess threw),
// {assess:null,...} (assess skipped), {assess,verdict:null} (a non-gap status),
// or {assess,verdict} (a gap candidate). Only items with an assessment are
// trustworthy; skipped/null ones are "unknown", never silently marked handled.
const withAssess = assessed.filter(Boolean).filter((x) => x.assess);
const unknown = assessed.filter(Boolean).filter((x) => !x.assess);
// A confirmed gap needs only realGap && proxyRelevant — `worthDoing` is a
// priority signal (folded into ranking), NOT a hard gate, so the verifier
// cannot editorialize a real-but-minor gap out of existence.
const confirmedGaps = withAssess.filter(
  (x) => x.verdict && x.verdict.realGap && x.verdict.proxyRelevant
);
const nonGaps = withAssess.filter((x) => !confirmedGaps.includes(x));
log(
  `Assessment: ${confirmedGaps.length} confirmed proxy-relevant gaps; ${nonGaps.length} covered/intentional/not-relevant; ${unknown.length} unknown (assess skipped).`
);

// Rank by severity, cap the planning set to bound cost.
const sevRank = { high: 0, medium: 1, low: 2 };
confirmedGaps.sort((a, b) => (sevRank[a.verdict.severity] ?? 1) - (sevRank[b.verdict.severity] ?? 1));
const PLAN_CAP = 8;
const toPlan = confirmedGaps.slice(0, PLAN_CAP);

// ---------------------------------------------------------------------------
// Phase: Plan — thorough design + codex_critic review, per gap.
// ---------------------------------------------------------------------------
phase("Plan");
const planned = await pipeline(toPlan, (g) =>
  agent(
    `Produce a THOROUGH implementation plan to add github-router support for this confirmed, proxy-relevant feature gap — without regressing existing behavior (cwd = repo root).

FEATURE: ${g.assess.feature}
GAP: ${g.assess.gap}
Why real/relevant: ${g.verdict.reasoning}

Mirror the repo's established "add a feature" footprint: target handler/lib + the translate/strip/gate mechanism + the EXACT probe row(s) for scripts/probe-copilot-compat.sh + compat-matrix row(s) for docs/copilot-compat-matrix.md + tests (incl. a symmetric probe and a regression test) + the ledger doc to update + CLAUDE.md. Read the relevant existing handler and a sibling feature for the pattern.

Include an explicit regression-risk analysis: which existing probes/tests could this perturb, and how you keep them green.

Then call the codex_critic MCP tool ONCE with your plan + the intent (find problems, not confirm), and fold its findings in. Set feasible=false if, after review, this should NOT be auto-implemented (too invasive, needs human design, or upstream-uncertain) — explain in design.`,
    { phase: "Plan", label: `plan:${slug(g.assess.feature)}`, schema: PLAN_SCHEMA }
  )
);
const feasiblePlans = planned.filter(Boolean).filter((p) => p.feasible !== false);

// ---------------------------------------------------------------------------
// scan mode stops here: write the designed backlog + state, return.
// ---------------------------------------------------------------------------
async function synthesize(shipResults) {
  phase("Synthesize");
  await agent(
    `Write the durable outputs for this parity run (cwd = repo root). Use \`date -u +%Y-%m-%dT%H:%M:%SZ\` via bash for timestamps (the script cannot generate time).

1. Write ${BACKLOG_PATH} (create .docs/ if needed) — human-readable markdown:
   - Run header: timestamp, CC version ${baseline?.ccVersion}, mode "${mode}".
   - CONFIRMED GAPS table: feature | severity | status | PR/branch (if any) | one-line design.
   - DEFERRED queue: feature | reason class | note.
   - COVERED / INTENTIONAL / NOT-PROXY-RELEVANT: feature | status | ledger ref (so we don't re-investigate).
2. Write ${STATE_PATH} (create .claude/parity/ if needed) as JSON: { lastSeen: "${baseline?.ccVersion}", updatedAt: <timestamp>, features: [{ name, status, fingerprint, prUrl? }] } covering every candidate seen this run (confirmed, deferred, AND covered) so reruns are idempotent. This file is gitignored runtime state — do NOT stage it.

DATA:
- Confirmed gaps + designs: ${JSON.stringify(feasiblePlans.map((p) => ({ feature: p.feature, mechanism: p.mechanism, targetFiles: p.targetFiles, regressionRisk: p.regressionRisk })))}
- Covered/intentional/not-relevant: ${JSON.stringify(nonGaps.map((x) => ({ feature: x.assess?.feature ?? x.candidate?.name, status: x.assess?.status, ledgerRef: x.assess?.ledgerRef || x.assess?.evidence })))}
- Unknown (assessment skipped — DO NOT mark handled; re-check next run): ${JSON.stringify(unknown.map((x) => x.candidate?.name).filter(Boolean))}
- Ship results: ${JSON.stringify(shipResults || [])}

Return a one-paragraph summary.`,
    { phase: "Synthesize", label: "synthesize:write", model: undefined }
  );
}

if (mode === "scan") {
  await synthesize(null);
  return {
    mode,
    ccVersion: baseline?.ccVersion,
    candidates: candidates.length,
    confirmedGaps: confirmedGaps.length,
    planned: feasiblePlans.length,
    backlog: BACKLOG_PATH,
    gaps: feasiblePlans.map((p) => ({ feature: p.feature, mechanism: p.mechanism, files: p.targetFiles })),
  };
}

// ---------------------------------------------------------------------------
// Phase: Ship — fix/pr modes. ONE worktree agent per feature does the whole
// chain (implement -> regression gate -> self diff-review -> push+draft-PR),
// because each isolation:"worktree" call gets its OWN worktree — stages cannot
// share one. Bounded by maxPrs.
// ---------------------------------------------------------------------------
phase("Ship");
const toShip = feasiblePlans.slice(0, maxPrs);
const doPush = mode === "pr";
const shipResults = await parallel(
  toShip.map((p) => () =>
    agent(
      `Implement github-router support for this feature IN AN ISOLATED WORKTREE, then ${doPush ? "open a DRAFT PR" : "leave the diff for review"}. You are on a fresh worktree off the default branch (cwd = the worktree root). Do NOT touch master.

FEATURE: ${p.feature}
PLAN (already critic-reviewed):
${p.design}
Mechanism: ${p.mechanism}
Probe/matrix rows to add: ${p.probeRows}
Target files: ${(p.targetFiles || []).join(", ")}
Regression risk to keep green: ${p.regressionRisk}

REQUIREMENTS (hard):
1. Implement the FULL footprint: handler/translate/gate + the probe row in scripts/probe-copilot-compat.sh + the row in docs/copilot-compat-matrix.md + tests (symmetric probe + a regression test that fails on the unfixed code) + ledger doc + CLAUDE.md note. Match surrounding idiom.
2. Diff guardrails: do NOT weaken/delete/skip existing probes or tests, do NOT edit lockfiles/generated/CI config, keep the diff focused.
3. REGRESSION GATE — run all of: \`bun run lint:all\`, \`bun run typecheck\`, \`bun test\`, \`bun run probe:copilot\`. If any FAILS (and it is not a pre-existing flake/env issue you can clearly attribute), STOP — do not push. Return outcome "deferred" with deferClass "gate-red" and the failing output summary.
4. SELF DIFF-REVIEW: call the codex_reviewer MCP tool on your final \`git diff\` (intent: does this add the feature without regressing? is the new probe meaningful + symmetric? hidden behavior change?). If it finds a blocking issue you cannot fix, defer with deferClass "diff-rejected".
5. NO AI ATTRIBUTION anywhere — no Co-Authored-By, no "Generated with", no AI mentions in branch, commit, or PR body. This repo forbids it; default templates inject it, so scrub the PR body.
${
  doPush
    ? `6. PUBLISH: branch \`parity/${slug(p.feature)}\`. The idempotency fingerprint is \`${keyOf(p.feature)}\` (exact, non-truncated). First check: \`gh pr list --state all --search "parity-fingerprint:${keyOf(p.feature)}"\` and remote branch existence — if a PR/branch with this fingerprint exists, STOP and return outcome "deferred" deferClass "already-open". Else commit, \`git push -u origin\`, and \`gh pr create --draft\`. PR body MUST include the line \`parity-fingerprint:${keyOf(p.feature)}\`, the feature + source, the gap, the mechanism, the probe+matrix rows added, the regression-risk analysis, and the local verify output (the failure modes you considered + tested — not just the happy path). Return outcome "pr-opened" with prUrl.`
    : `6. Do NOT push or open a PR (mode=fix). Leave the worktree changed for inspection. Return outcome "fix-ready" with a summary of the diff + the green gate output.`
}`,
      { phase: "Ship", label: `ship:${slug(p.feature)}`, isolation: "worktree", schema: SHIP_SCHEMA }
    )
  )
);

await synthesize(shipResults.filter(Boolean));
return {
  mode,
  ccVersion: baseline?.ccVersion,
  candidates: candidates.length,
  confirmedGaps: confirmedGaps.length,
  shipped: shipResults.filter(Boolean),
  prUrls: shipResults.filter(Boolean).filter((r) => r.outcome === "pr-opened").map((r) => r.prUrl),
  backlog: BACKLOG_PATH,
};
