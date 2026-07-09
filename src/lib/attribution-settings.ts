import fs from "node:fs/promises"

/**
 * Deterministic backstop for the injected "no attribution" style directive.
 *
 * github-router injects a CLAUDE.md style directive telling the agent not to
 * attribute work to Claude / AI / Anthropic. That directive is ADVISORY (prose
 * the model may or may not follow). Claude Code also exposes a HARNESS-ENFORCED
 * control that suppresses attribution at the source: the `attribution`
 * settings.json key (Claude Code v2.0.62+; string `commit` / `pr` sub-fields),
 * which supersedes the deprecated boolean `includeCoAuthoredBy`. Setting both
 * sub-fields to the empty string removes the "Generated with Claude Code"
 * commit footer and the "Co-Authored-By: Claude" byline from commits and PRs.
 * Because the harness reads and applies this itself, it holds even when the
 * model ignores the prose directive — a deterministic backstop, not a second
 * suggestion.
 *
 * PRESENCE-GUARDED. If the mirrored settings already carry `attribution` OR
 * `includeCoAuthoredBy`, the user expressed a deliberate preference in their
 * real config (which the one-way mirror snapshotted); we DO NOT override it.
 * Only a user who has expressed no preference receives github-router's
 * no-attribution default. This keeps faith with "the user's explicit direction
 * always overrides".
 *
 * The mirror is a per-launch snapshot of the user's real `~/.claude` config, so
 * this write never propagates back to the user's own settings.json. A
 * project-scope `<repo>/.claude/settings.json` still overrides the mirror
 * (global scope) at runtime, so the default remains overridable per-repo.
 *
 * Failure model matches the sibling settings writers: a transient read error
 * or a non-object settings.json throws (never clobber a file we don't
 * understand); the caller wraps this in warn-and-continue so a settings-write
 * hiccup never blocks launch.
 */
export async function injectAttributionSuppressionIntoSettingsFile(
  settingsPath: string,
): Promise<{ written: boolean; reason?: "user-set" }> {
  let existing: Record<string, unknown> = {}
  let raw: string | undefined
  try {
    raw = await fs.readFile(settingsPath, "utf8")
  } catch (err) {
    // Never clobber on a transient read error; a missing file starts clean.
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err
    raw = undefined
  }
  if (raw !== undefined) {
    // A parse failure means a real file we don't understand: do NOT replace it.
    const parsed: unknown = JSON.parse(raw)
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      existing = parsed as Record<string, unknown>
    } else {
      throw new Error(
        `settings.json at ${settingsPath} is not a JSON object; refusing to overwrite`,
      )
    }
  }
  // Respect an existing explicit attribution preference (current OR deprecated
  // key). A user who set either one deliberately wins.
  if ("attribution" in existing || "includeCoAuthoredBy" in existing) {
    return { written: false, reason: "user-set" }
  }
  const merged = { ...existing, attribution: { commit: "", pr: "" } }
  const tmp = `${settingsPath}.${process.pid}.attr.tmp`
  await fs.writeFile(tmp, `${JSON.stringify(merged, null, 2)}\n`, { mode: 0o600 })
  await fs.rename(tmp, settingsPath)
  return { written: true }
}
