import fs from "node:fs/promises"

/**
 * Configure the serve mirror's `settings.json` permission posture so the
 * CloudCLI-spawned Claude has the FULL toolset with no permission friction — the
 * web-control-plane equivalent of `github-router claude`'s default
 * `--dangerously-skip-permissions`.
 *
 * Two CloudCLI behaviors bite, and both are fixed here:
 *
 *   1. **Prompt stalls.** CloudCLI spawns Claude via the Agent SDK with a
 *      `canUseTool` callback that posts a `permission_request` to the browser and
 *      AWAITS approval for any tool not already allowed — so every injected
 *      `mcp__*` call (and every native tool) stalls the chat. Setting
 *      `permissions.defaultMode: "bypassPermissions"` (the SDK reads it via
 *      `settingSources` before `canUseTool` fires) auto-approves everything.
 *
 *   2. **Toolset narrowing (the subtle one).** CloudCLI passes
 *      `sdkOptions.allowedTools = settings.allowedTools`, and a NON-EMPTY
 *      `allowedTools` is an availability allow-list in the SDK: tools not in it
 *      (Bash / Glob / Grep / …) become "not enabled in this context". CloudCLI's
 *      client derives that list from Claude's permissions, so the operator's
 *      mirrored `permissions.allow` (e.g. `Read(*)`, `Glob(*)`, `Bash(ls *)`)
 *      silently restricts the session to a broken subset. Under
 *      `bypassPermissions` the allow-list is redundant (everything is approved),
 *      so we CLEAR `permissions.allow` in the serve mirror — leaving CloudCLI an
 *      empty `allowedTools` and thus the full built-in toolset.
 *
 * `deny`/`ask` are preserved (a user's deliberate block still applies; the SDK
 * honors `disallowedTools` even under bypass). This only ever rewrites the
 * per-launch serve mirror, never the operator's real `~/.claude/settings.json`.
 * Atomic temp+rename, mode 0o600. A non-object settings.json throws (never
 * clobber a file we don't understand); the caller wraps this in warn-and-continue
 * so a hiccup never blocks launch.
 *
 * Opt out with `GH_ROUTER_SERVE_NO_AUTO_APPROVE=1` (the caller skips this) — the
 * mirrored mode + allow-list are then left exactly as snapshotted.
 */
export async function configureServePermissionsBypass(
  settingsPath: string,
): Promise<{ written: boolean; clearedAllow: number }> {
  let existing: Record<string, unknown> = {}
  let raw: string | undefined
  try {
    raw = await fs.readFile(settingsPath, "utf8")
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err
    raw = undefined
  }
  if (raw !== undefined) {
    const parsed: unknown = JSON.parse(raw)
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      existing = parsed as Record<string, unknown>
    } else {
      throw new Error(
        `settings.json at ${settingsPath} is not a JSON object; refusing to overwrite`,
      )
    }
  }

  const permsRaw = existing.permissions
  const perms: Record<string, unknown> =
    permsRaw && typeof permsRaw === "object" && !Array.isArray(permsRaw)
      ? { ...(permsRaw as Record<string, unknown>) }
      : {}

  const priorAllow = Array.isArray(perms.allow) ? (perms.allow as unknown[]).length : 0
  const alreadyBypass = perms.defaultMode === "bypassPermissions"
  if (alreadyBypass && priorAllow === 0) {
    return { written: false, clearedAllow: 0 }
  }

  perms.defaultMode = "bypassPermissions"
  // Clear the allow-list: CloudCLI turns it into a restrictive availability
  // allow-list; under bypass it is redundant, so an empty list restores the full
  // built-in toolset. deny/ask are left intact.
  perms.allow = []

  const merged = { ...existing, permissions: perms }
  const tmp = `${settingsPath}.${process.pid}.mcpperm.tmp`
  await fs.writeFile(tmp, `${JSON.stringify(merged, null, 2)}\n`, { mode: 0o600 })
  await fs.rename(tmp, settingsPath)
  return { written: true, clearedAllow: priorAllow }
}
