import fs from "node:fs/promises"

/**
 * Configure the serve mirror's `settings.json` permission posture so the
 * CloudCLI-spawned Claude runs without permission friction — the web-control-
 * plane equivalent of `github-router claude`'s default `--dangerously-skip-
 * permissions`.
 *
 * Why this matters for `serve`: CloudCLI spawns Claude via the Agent SDK with
 * `settingSources: ['project','user','local']` and a `canUseTool` callback. Two
 * things bite:
 *   1. Any tool not already allowed reaches `canUseTool`, which posts a
 *      `permission_request` to the browser and AWAITS approval — so every
 *      injected `mcp__peers__*` / `mcp__workers__*` / … call stalls the chat.
 *   2. The operator's real `~/.claude/settings.json` (snapshotted into the
 *      mirror) may set `permissions.defaultMode: "plan"`, which the SDK honors —
 *      putting the session in plan mode so native write tools (Edit/Write/Bash)
 *      are refused.
 * In a terminal `claude` the launcher forces `--dangerously-skip-permissions`
 * (see `buildLaunchCommand`), so neither bites. The control plane needs the same.
 *
 * `bypass: true` (the serve default) sets `permissions.defaultMode` to
 * `"bypassPermissions"` — the SDK resolves this from settings before invoking
 * `canUseTool`, so all tools auto-approve and plan mode is lifted. We also
 * allow-list our OWN resolved server keys (`mcp__<key>`) as a conservative
 * fallback for the case where CloudCLI's UI sends an explicit non-default
 * permissionMode that overrides the settings default — our injected tools then
 * still work while everything else prompts.
 *
 * PRESERVE-AND-MERGE: an existing `permissions` object (allow/deny/ask) is kept;
 * we union our entries into `allow` and never touch `deny`/`ask` (a user deny of
 * one of our servers still wins). Atomic temp+rename, mode 0o600. A non-object
 * settings.json throws (never clobber a file we don't understand); the caller
 * wraps this in warn-and-continue so a hiccup never blocks launch.
 *
 * Opt out with `GH_ROUTER_SERVE_NO_AUTO_APPROVE=1` (the caller checks this) — the
 * mirrored `defaultMode` and the interactive prompts are then left untouched.
 */
export async function injectMcpPermissionsIntoSettingsFile(
  settingsPath: string,
  serverKeys: ReadonlyArray<string>,
  opts: { bypass?: boolean } = {},
): Promise<{ written: boolean; added: string[]; bypass: boolean }> {
  const bypass = opts.bypass === true
  const desired = serverKeys.filter((k) => k.length > 0).map((k) => `mcp__${k}`)
  if (desired.length === 0 && !bypass) return { written: false, added: [], bypass: false }

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
  const currentAllow = Array.isArray(perms.allow)
    ? (perms.allow as unknown[]).filter((e): e is string => typeof e === "string")
    : []

  const seen = new Set(currentAllow)
  const added: string[] = []
  for (const entry of desired) {
    if (!seen.has(entry)) {
      seen.add(entry)
      added.push(entry)
    }
  }

  const modeChanges = bypass && perms.defaultMode !== "bypassPermissions"
  if (added.length === 0 && !modeChanges) return { written: false, added: [], bypass }

  if (added.length > 0) perms.allow = [...currentAllow, ...added]
  if (bypass) perms.defaultMode = "bypassPermissions"

  const merged = { ...existing, permissions: perms }
  const tmp = `${settingsPath}.${process.pid}.mcpperm.tmp`
  await fs.writeFile(tmp, `${JSON.stringify(merged, null, 2)}\n`, { mode: 0o600 })
  await fs.rename(tmp, settingsPath)
  return { written: true, added, bypass }
}

