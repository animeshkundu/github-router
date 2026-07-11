import fs from "node:fs/promises"

/**
 * CLAUDE_CODE_* env vars that must NOT reach the CloudCLI-spawned serve agent.
 * CloudCLI applies the mirror `settings.json` `env` block via the Agent SDK's
 * `settingSources`, so anything here that a user set in their real
 * `~/.claude/settings.json` (for their own FleetView/coordinator workflow) is
 * mirrored in and mis-shapes the single serve chat agent.
 *
 * `CLAUDE_CODE_COORDINATOR_MODE`: puts the agent into orchestrator-only mode,
 * stripping every direct tool (Glob/Read/Bash/Grep/Edit/Write) down to
 * delegation-only (Task/SendMessage/Workflow) — so a direct `Glob` call fails
 * with "Glob exists but is not enabled in this context". Serve is a
 * single-agent chat surface, never a coordinator, so this is always wrong here.
 * (`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` is intentionally NOT stripped — it is
 * purely additive, matching `github-router claude` parity.)
 */
const SERVE_STRIP_ENV_KEYS = ["CLAUDE_CODE_COORDINATOR_MODE"] as const

async function readSettingsObject(
  settingsPath: string,
): Promise<Record<string, unknown> | null> {
  let raw: string
  try {
    raw = await fs.readFile(settingsPath, "utf8")
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null
    throw err
  }
  const parsed: unknown = JSON.parse(raw)
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    return parsed as Record<string, unknown>
  }
  throw new Error(`settings.json at ${settingsPath} is not a JSON object; refusing to overwrite`)
}

async function writeSettingsObject(
  settingsPath: string,
  obj: Record<string, unknown>,
  suffix: string,
): Promise<void> {
  const tmp = `${settingsPath}.${process.pid}.${suffix}.tmp`
  await fs.writeFile(tmp, `${JSON.stringify(obj, null, 2)}\n`, { mode: 0o600 })
  await fs.rename(tmp, settingsPath)
}

/**
 * Remove serve-inappropriate CLAUDE_CODE_* keys (see {@link SERVE_STRIP_ENV_KEYS})
 * from the serve mirror `settings.json` `env` block. UNCONDITIONAL — unlike the
 * permission bypass this is NOT gated by `GH_ROUTER_SERVE_NO_AUTO_APPROVE`,
 * because a user who only wants permission prompts still needs a working toolset.
 * Serve mirror only; never the operator's real `~/.claude/settings.json`. Atomic
 * temp+rename, mode 0o600. Returns the keys it removed (empty if none present).
 */
export async function sanitizeServeSettingsEnv(
  settingsPath: string,
): Promise<{ removed: string[] }> {
  const existing = await readSettingsObject(settingsPath)
  if (!existing) return { removed: [] }

  const envRaw = existing.env
  if (!envRaw || typeof envRaw !== "object" || Array.isArray(envRaw)) {
    return { removed: [] }
  }
  const env = { ...(envRaw as Record<string, unknown>) }
  const removed: string[] = []
  for (const key of SERVE_STRIP_ENV_KEYS) {
    if (key in env) {
      delete env[key]
      removed.push(key)
    }
  }
  if (removed.length === 0) return { removed: [] }

  await writeSettingsObject(settingsPath, { ...existing, env }, "serveenv")
  return { removed }
}

/**
 * Native Claude Code tools worth auto-approving alongside our injected MCP
 * servers so PLAN mode is frictionless for research. These are read-only
 * discovery tools that plan mode would otherwise prompt for.
 *
 * Deliberately MINIMAL and safe:
 *   - `WebSearch` / `WebFetch` — network reads; exactly the research surface a
 *     planner reaches for, and they prompt by default in plan mode.
 *   - EXCLUDES `Read`/`Glob`/`Grep` — Claude Code already runs them in plan mode
 *     without a rule (its built-in safe list), so a rule would be redundant.
 *   - EXCLUDES `Bash` — can mutate (`rm`, redirects); blanket-allow is unsafe.
 *     Curated `Bash(<readonly cmd> *)` rules are the user's own call.
 *   - EXCLUDES `Task`/`Skill`/`Workflow`/`SendMessage` — spawn/delegate; a
 *     subagent launched in plan mode isn't guaranteed to inherit plan's
 *     read-only restriction, so auto-approving them is a plan-mode-bypass vector.
 *   - EXCLUDES `Edit`/`Write`/`NotebookEdit` etc. — plan mode gates them by
 *     design and we must not override that.
 */
export const NATIVE_RESEARCH_ALLOW_RULES = ["WebSearch", "WebFetch"] as const

/**
 * Merge arbitrary allow rules into a mirror `settings.json` `permissions.allow`
 * so the listed tools auto-run WITHOUT a permission prompt in every mode —
 * including plan mode, where a matched allow rule bypasses the prompt for any
 * tool NOT on plan mode's file-edit/shell-write restricted list (MCP tools and
 * read-only natives like WebSearch/WebFetch). See {@link NATIVE_RESEARCH_ALLOW_RULES}
 * for the native additions and the "Configure permissions" Claude Code doc for
 * the plan-mode semantics.
 *
 * Rules are literal allow strings (`mcp__peers`, `WebSearch`, …). Existing
 * `allow` entries and `deny`/`ask` are preserved; merge is idempotent (no write
 * when every rule is already present). Mirror only; never the operator's real
 * settings. Atomic temp+rename, mode 0o600.
 */
export async function injectAllowRules(
  settingsPath: string,
  rules: readonly string[],
): Promise<{ added: string[] }> {
  const want = [...new Set(rules.filter(Boolean))]
  if (want.length === 0) return { added: [] }

  const existing = (await readSettingsObject(settingsPath)) ?? {}
  const permsRaw = existing.permissions
  const perms: Record<string, unknown> =
    permsRaw && typeof permsRaw === "object" && !Array.isArray(permsRaw)
      ? { ...(permsRaw as Record<string, unknown>) }
      : {}
  const allow = Array.isArray(perms.allow) ? [...(perms.allow as unknown[])] : []
  const present = new Set(allow.filter((x): x is string => typeof x === "string"))
  const added = want.filter((rule) => !present.has(rule))
  if (added.length === 0) return { added: [] }

  perms.allow = [...allow, ...added]
  await writeSettingsObject(settingsPath, { ...existing, permissions: perms }, "allowrules")
  return { added }
}

/**
 * Build the full plan-mode allow-rule set: a bare `mcp__<server>` rule per
 * injected MCP server (whole-server allow) plus the native research tools. The
 * server keys are the RESOLVED mcpServers config keys (collision-aware —
 * `peers` or `gh-router-peers`, `codex-cli`, …) so each rule matches the server
 * name the model actually sees.
 */
export function planModeAllowRules(serverKeys: readonly string[]): string[] {
  return [
    ...[...new Set(serverKeys.filter(Boolean))].map((k) => `mcp__${k}`),
    ...NATIVE_RESEARCH_ALLOW_RULES,
  ]
}

/**
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
 *   2. **Prompt stalls, redundant allow-list.** CloudCLI passes
 *      `sdkOptions.allowedTools = settings.allowedTools`; the client seeds that
 *      from `localStorage['claude-settings']` (serve injects `allowedTools: []`).
 *      An EMPTY `allowedTools` is a no-op (the SDK only emits `--allowedTools`
 *      when the array is non-empty, so `[] ≡ undefined`), so it neither breaks
 *      nor restores anything — we still clear the mirrored `permissions.allow`
 *      defensively so CloudCLI can never derive a non-empty (restrictive)
 *      allow-list from a user's `Read(*)`/`Glob(*)` grants. NOTE: the actual
 *      toolset-narrowing seen in serve was NOT this — it was
 *      `CLAUDE_CODE_COORDINATOR_MODE` in the mirrored `env` block, stripped
 *      separately by {@link sanitizeServeSettingsEnv} (unconditional).
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
