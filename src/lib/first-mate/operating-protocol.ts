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
