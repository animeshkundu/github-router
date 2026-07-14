/**
 * Single source of truth for the condensed CEO/CTO/CPO operating sequence.
 *
 * Shared by BOTH the scaffolded product playbook (`buildPlaybook` in
 * `scaffold-spec.ts`, committed into a repo and read by the GitHub cloud agents)
 * AND the operator-facing `gh-first-mate-operate` skill (read by the local
 * first-mate lead that shapes missions). Keeping ONE copy is what prevents the
 * cloud-agent surface and the operator surface from drifting apart.
 */
export const CONDENSED_OPERATING_SEQUENCE = `1. **DISCOVER:** find a struggling moment; require three corroborated sources; log hire/fire criteria.
2. **NICHE:** choose one reachable beachhead with a credible 1,000-fan path; pass a distribution test and go/no-go table.
3. **POSITION:** map do-nothing, workarounds, and competitors; prove differentiated value; test one sentence with real prospects.
4. **SCOPE:** run the riskiest-assumption test against a pre-set threshold; freeze v0.1 with must-be, performance, and at least one delight.
5. **BUILD:** ADRs, trunk/flags, test pyramid, CI/CD and DORA; verify HTTP 200, green CI, five-minute quickstart, WCAG, and Web Vitals.
6. **LAUNCH:** README and docs sell the job; launch sequentially where the beachhead lives; instrument the aha moment.
7. **MEASURE:** AARRR, time-to-first-value, Sean Ellis ≥40% very disappointed, and a flattening retention curve.
8. **ITERATE:** weekly opportunity-solution tree from real evidence; RICE validated options only; thresholded experiments and changelog.
9. **GROW:** scale retained-user channels and shareable-artifact loops within explicit economics.
10. **GOVERN:** OODA daily inside Build-Measure-Learn; log hypothesis → experiment → metric → threshold → outcome; advance only on externally verifiable checkpoints.`

/**
 * Single source of truth for the DEFINITION OF REPO GREATNESS — the shipping-
 * infrastructure bar a repo must clear to be "great", stated as checkpoints a
 * third party can verify with NO special access (a green check, a `gh api`, a
 * `curl`, a `cosign verify`). Shared by the scaffolded playbook (`buildPlaybook`),
 * the operator/CEO skills, and the eval framework, so the bar never drifts across
 * surfaces. Every item is "done" only with a real evidence handle, never a
 * self-reported claim.
 *
 * Currency note (2026): INP replaced FID; npm/crates.io OIDC Trusted Publishing is
 * GA; GitHub build-provenance attestations meet SLSA Build L3; VS Code Marketplace
 * still needs a long-lived PAT (the one OIDC gap). SEO indexing/ranking and
 * E-E-A-T are NOT deterministically gradeable by anonymous curl — treat as soft
 * signals (proxy via byline/date/architecture + Search Console).
 */
export const DEFINITION_OF_GREATNESS = `A repo is GREAT on the shipping axis only when every claim is externally verifiable by a stranger. The organizing invariant: **version file == git tag == GitHub Release == registry version == CHANGELOG heading == live-site build stamp** — most checkpoints are just cross-checks of this identity.

**Leading vs lagging — the anti-hallucination rule for greatness.** Every checkpoint is either **[LEADING]** (a file/config an agent can add in ONE commit — necessary hygiene, NEVER proof of greatness) or **[LAGGING]** (requires real humans acting over time — response times, repeat contributors, dependents, retained downloads) or **[SOFT]** (real but not deterministically gradeable). An autonomous agent can fabricate every leading artifact while producing zero community. So a repo is GREAT only when at least one LAGGING signal has actually MOVED — not when the leading boxes are merely ticked. Never treat file-presence as evidence of community, adoption, or trust.

## Universal core (every repo)
- **Branch protection via a ruleset** [LEADING] on the default branch: required checks (lint + typecheck + test + build) green, strict (up-to-date), ≥1 review, linear history, conversation resolution. Verify: \`gh api repos/$R/rules/branches/main\`.
- **Matrix CI** [LEADING] (OS × version) green on the default branch; gate on a synthetic all-green job that \`needs:\` every matrix cell. Verify: \`gh api repos/$R/commits/main/check-runs --jq '[.check_runs[].conclusion]|unique'\` == \`["success"]\`.
- **Supply-chain security** [LEADING]: CodeQL + Dependabot (deps + security + \`github-actions\`) + secret scanning + push protection on, low/zero open alerts; OpenSSF Scorecard published. Verify: \`gh api repos/$R/code-scanning/alerts?state=open\`, \`.../dependabot/alerts?state=open\`, \`api.scorecard.dev/projects/github.com/$R\`.
- **Security DISCLOSURE posture** [LEADING] (distinct from build hardening): \`SECURITY.md\` with a disclosure channel + response SLA; GitHub Private Vulnerability Reporting enabled; \`/.well-known/security.txt\` (RFC 9116) served on the site; an **OpenSSF Best Practices badge** (passing → silver → gold; state is API-readable at bestpractices.openssf.org). [LAGGING] a real advisory/CVE track record + time-to-patch.
- **Workflow hygiene** [LEADING]: \`permissions:\` least-privilege (default \`contents: read\`, escalate per-job); every \`uses:\` pinned to a 40-char SHA; reproducible installs (lockfile + \`npm ci\`/\`--frozen\`/\`--require-hashes\`). Flaky tests QUARANTINED (\`continue-on-error\`, non-required, tracked as issues) — never retried-until-green.
- **Safe to depend on** [LEADING/verifiable]: a written deprecation/stability/support-window policy + an **API-breaking-change CI gate** (\`cargo-semver-checks\` / \`@microsoft/api-extractor\` / \`japicmp\`) that fails a PR on an undeclared breaking change; migration guides for majors. [LAGGING] unplanned breaking releases trend to ~0.
- **Docs that TEACH, not just rank** [LEADING/verifiable]: Diataxis structure (tutorial / how-to / reference / explanation) + a generated **API reference** + **examples EXECUTED in CI** (doctest / tested code fences — the one docs check that resists rot); a \`<5-min\` time-to-first-success smoke test from a clean container. [SOFT] whether the quickstart is genuinely clear.
- **Legal & provenance** [LEADING/verifiable]: REUSE/SPDX headers (\`reuse lint\`), DCO or CLA enforced on PRs, a dependency-license scan in CI, correct \`NOTICE\`/attribution; \`actions/attest-build-provenance\` on release artifacts (SLSA Build L3) — verify \`gh attestation verify <artifact> --repo $R\`.
- **Quality beyond green CI** [LEADING, gate ONLY when the surface applies]: OSS-Fuzz (parsers / security-sensitive), a perf-regression gate (hot paths), accessibility CI (axe-core / Lighthouse a11y ≥ target) for any UI, i18n wired. Track mutation-testing score (Stryker / \`cargo-mutants\`) — do NOT hard-gate a raw coverage %.
- **Releases** [LEADING]: SemVer single-sourced; **Keep a Changelog** \`CHANGELOG.md\` (dated, \`[Unreleased]\`); tagged **GitHub Releases** with generated notes; release automation (release-please / semantic-release). Verify: \`gh release view vX.Y.Z --json tagName,isLatest,body,assets\`.
- **README media** [LEADING]: theme-adaptive hero (\`<picture>\`/\`#gh-dark-mode-only\`) + a demo (GIF / asciinema / linked video) + alt text on every image; repo social-preview set. Verify: \`grep\` the README + \`curl -I\` the assets return image 200.

## Community, sustainability & trust (Pillar C — the contributor funnel + who keeps it alive)
Great OSS is a project other humans JOIN, TRUST, and SUSTAIN — not just a well-shipped artifact. Most of this is LAGGING: measure the trajectory, never the file. A great score here REQUIRES a lagging signal to have moved.
- **Contributor funnel** [LAGGING]: time-to-first-response on new issues/PRs (CHAOSS; healthy ≈ ≤2 business days, a HUMAN not a bot), median PR-merge time, and **repeat-contributor rate** (contributors with ≥2 contributions across periods) — the real "is the onramp working" signal. [LEADING] \`CONTRIBUTING.md\` / \`CODE_OF_CONDUCT.md\` / \`SUPPORT.md\` / \`CODEOWNERS\` / issue + PR templates present (\`gh api repos/$R/community/profile\`) + good-first-issue / help-wanted labels — a HYGIENE FLOOR only, never proof.
- **Sustainability & governance** [LEADING] \`.github/FUNDING.yml\`, \`GOVERNANCE.md\`/\`MAINTAINERS.md\`, \`ADOPTERS.md\`; [LAGGING] **Contributor Absence Factor** (bus-factor: min contributors making 50% of contributions) ≥ 2–3, **committers from ≥2 organizations** (CNCF graduated bar), ≥3 real adopters, and **liveness** — recent last-commit / last-release on a predictable cadence (abandonment is the most common death).
- **Adoption verdict** [LAGGING]: **dependents / "Used by" count** (dependency-graph API — the un-fakeable adoption signal funders use), retained-download trend (not a launch-day spike), third-party integrations/tutorials, issue-to-star ratio (stars alone are vanity).

## By final destination (detect from the repo root)
- **Web app / docs → GitHub Pages** (\`build_type == "workflow"\`, auto-deploy on merge, protected \`github-pages\` env):
  - **Live-content proof:** stamp \`_site/BUILD_SHA.txt\`; the live edge must serve it — \`curl -fsSL "$SITE/BUILD_SHA.txt?cb=$(date +%s)"\` == \`git rev-parse HEAD\`.
  - **Google-discoverable SEO:** \`sitemap.xml\` + \`robots.txt\` (with \`Sitemap:\`) + self-referential \`rel=canonical\` + no accidental noindex (custom \`404.html\` gets \`meta robots noindex\`); full **OG + Twitter cards** + **JSON-LD \`SoftwareApplication\`** (+ \`WebSite\`/\`BreadcrumbList\`); **Lighthouse SEO ≥ 0.90**; **Core Web Vitals** LCP ≤ 2.5s / INP ≤ 200ms / CLS ≤ 0.1; HTTPS enforced + correct custom-domain DNS; **Search Console** verified + sitemap submitted + IndexNow ping from the deploy. og-image 1200×630 returns 200. Verify via \`curl\`/\`lighthouse\`/PageSpeed API.
  - Content targeting real developer queries (error strings, "X vs Y", tutorials), dated changelog.
- **JS library / CLI → npm:** OIDC Trusted Publishing (\`id-token: write\`, \`--provenance\`, NO \`NPM_TOKEN\`). Verify: \`npm view <pkg> version\`, \`npm install <pkg>\`, \`npm audit signatures\`.
- **Python → PyPI:** Trusted Publisher (\`pypa/gh-action-pypi-publish\`, \`environment: pypi\`, no token) + PEP 740 attestation. Verify: \`pip install <pkg>==X.Y.Z\`.
- **Rust → crates.io:** Trusted Publishing (\`rust-lang/crates-io-auth-action\`; first publish manual). Verify: \`cargo add <crate>@X.Y.Z\`.
- **Service / container → GHCR:** multi-arch + \`provenance: true\` + \`sbom: true\` + keyless cosign. Verify: \`cosign verify\` + \`verify-attestation\` + \`docker pull\`.
- **GitHub Action → Marketplace:** complete \`action.yml\` + a floating major tag (\`v1\`). Verify: \`uses: owner/action@v1\` resolves; listed publicly.
- **Go module → proxy (tag-driven):** tag \`vX.Y.Z\` (\`/vN\` in the module path for major ≥ 2). Verify: \`go install ...@vX.Y.Z\`; \`proxy.golang.org\`/\`sum.golang.org\` have it.

## Publish pipeline (final destination)
End to end: reusable build+test (\`workflow_call\`) → release automation → tag + GitHub Release → \`on: release: published\` publish jobs, EACH behind its own protected environment + OIDC (no long-lived tokens) → provenance attestation on every artifact. Gate same-workflow steps with \`needs:\`; use protected environments + required reviewers so "push to main" becomes "a human approves" while auth stays tokenless. NEVER \`pull_request_target\` to check out untrusted fork code.

## Soft signals & anti-cargo-cult (do NOT fake a checkmark, do NOT hard-gate)
SEO indexing/ranking is never guaranteed by Google; E-E-A-T/content quality has no exposed score. Proxy via byline/last-updated presence, content architecture, and (with auth) Search Console Performance — record as evidence, not a binary pass. Do NOT hard-gate raw test-coverage %, raw star count, "has a Discord", Diataxis "compliance" as a box-tick, or any \`community/profile\` file-presence number treated as evidence of community — taken as proof of greatness these ARE the hallucinated-progress trap. The intangibles that separate LOVED from merely-functional — a clear vision/opinion, DX that delights, great error messages, brand/name/story, a maintainer who cares — are real but SOFT: estimate them with an advisory rubric and label the score advisory, never verified.`

