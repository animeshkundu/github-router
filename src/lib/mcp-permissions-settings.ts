import fs from "node:fs/promises"

/**
 * Pre-approve github-router's OWN injected MCP servers in the mirror
 * `settings.json` so the SDK-spawned Claude doesn't block on a permission prompt
 * for each `mcp__*` call.
 *
 * Why this matters for `serve`: CloudCLI spawns Claude via the Agent SDK with
 * `settingSources: ['project','user','local']` and a `canUseTool` callback. Any
 * tool that isn't already allowed by permission-mode or a settings rule reaches
 * `canUseTool`, which posts a `permission_request` to the browser and AWAITS the
 * user's approval — so every injected `mcp__peers__*` / `mcp__workers__*` / …
 * call stalls the chat until the user clicks approve. In a terminal `claude` the
 * user approves interactively; the web control plane needs these trusted, we-
 * injected tools to just work.
 *
 * The SDK resolves settings.json `permissions.allow` BEFORE invoking
 * `canUseTool`, so allow-listing our server keys (`mcp__<key>` matches every
 * tool of that server) short-circuits the prompt. We only ever allow OUR OWN
 * servers (the resolved group keys) — never a blanket bypass — so the user's
 * other tools still prompt normally.
 *
 * PRESERVE-AND-MERGE: an existing `permissions` object (allow/deny/ask) is kept;
 * we union our entries into `allow` and never touch `deny`/`ask`. A user's
 * explicit `deny` of one of our servers still wins (the SDK applies deny over
 * allow). Atomic temp+rename, mode 0o600 — matches the sibling settings writers.
 * A non-object settings.json throws (never clobber a file we don't understand);
 * the caller wraps this in warn-and-continue so a hiccup never blocks launch.
 *
 * Opt out with `GH_ROUTER_SERVE_NO_AUTO_APPROVE=1` (the caller checks this).
 */
export async function injectMcpPermissionsIntoSettingsFile(
  settingsPath: string,
  serverKeys: ReadonlyArray<string>,
): Promise<{ written: boolean; added: string[] }> {
  const desired = serverKeys.filter((k) => k.length > 0).map((k) => `mcp__${k}`)
  if (desired.length === 0) return { written: false, added: [] }

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
  if (added.length === 0) return { written: false, added: [] }

  perms.allow = [...currentAllow, ...added]
  const merged = { ...existing, permissions: perms }
  const tmp = `${settingsPath}.${process.pid}.mcpperm.tmp`
  await fs.writeFile(tmp, `${JSON.stringify(merged, null, 2)}\n`, { mode: 0o600 })
  await fs.rename(tmp, settingsPath)
  return { written: true, added }
}
