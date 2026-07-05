export const DOD_TEXT = `Definition of Done — the agent MUST satisfy ALL of the following before declaring work complete:

1. Run the FULL test, lint, and typecheck suite and paste the ACTUAL verbatim output. Never claim success — show the output.
2. Add tests that would fail without the change. Exercise the new behavior directly; a happy-path-only test does not count.
3. Verify each acceptance criterion listed above one-by-one before declaring done. Do not skip any.
4. Do NOT stub, skip, or disable existing tests, and do NOT add TODO comments to bypass failures. Report blockers instead of going green by omission.
5. Do NOT silently reduce scope. If a blocker prevents full delivery, report it explicitly rather than quietly delivering less.
6. Handle edge cases and error paths for every changed code path.
7. If the repo contains learnings, ADR, or changelog documents, update them to reflect this change ("leave the repo better for the next agent").`

export function renderDod(acceptanceCriteria: string[]): string {
  const parts: string[] = []
  if (acceptanceCriteria.length > 0) {
    parts.push(`Acceptance criteria to verify:\n${acceptanceCriteria.join("\n")}`)
  }
  parts.push(DOD_TEXT)
  return parts.join("\n\n")
}
