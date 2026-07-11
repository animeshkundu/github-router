import fs from "node:fs/promises"

import { STRIPPED_AUTH_ROUTING_ENV_KEYS } from "./stripped-env-keys"

/**
 * CLAUDE_CODE_* / auth / routing env keys that must NOT reach the CloudCLI-spawned
 * serve agent through the mirror `settings.json` `env` block. CloudCLI applies
 * that block via the Agent SDK's `settingSources`, so anything a user set in their
 * real `~/.claude/settings.json` (for their own workflow) is mirrored in and
 * mis-shapes the single serve chat agent — the exact mechanism behind the
 * coordinator-mode bug.
 *
 *   - {@link STRIPPED_AUTH_ROUTING_ENV_KEYS} (shared with the process-env strip in
 *     `launch.ts`): auth/routing/remote keys that would re-route the agent OFF the
 *     github-router proxy (`ANTHROPIC_BASE_URL`, `CLAUDE_CODE_USE_BEDROCK/VERTEX/
 *     FOUNDRY`, a personal gateway), inject real auth over the synthetic
 *     credential (`ANTHROPIC_API_KEY`/`AUTH_TOKEN`/`OAUTH_TOKEN`), pin a
 *     non-Copilot `ANTHROPIC_MODEL`, or activate the unimplemented Bridge/remote
 *     path. The settings.json `env` block is a SECOND vector for the same keys the
 *     process-env strip already blocks.
 *   - `CLAUDE_CODE_COORDINATOR_MODE`: strips the single agent to delegation-only
 *     (Glob/Read/Bash fail "not enabled in this context").
 *   - `CLAUDE_CODE_SUBAGENT_MODEL`: a rank-#1 hard override that would retarget
 *     the injected implementer/peer-critic subagents off their frontmatter models.
 *
 * `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` is intentionally NOT stripped — purely
 * additive, matching `github-router claude` parity.
 */
const SERVE_STRIP_ENV_KEYS = [
  ...STRIPPED_AUTH_ROUTING_ENV_KEYS,
  "CLAUDE_CODE_COORDINATOR_MODE",
  "CLAUDE_CODE_SUBAGENT_MODEL",
] as const

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
 * Set the serve mirror's `settings.json` `permissions.defaultMode` to
 * `bypassPermissions` — the web-control-plane equivalent of `github-router
 * claude`'s default `--dangerously-skip-permissions`. Without it, CloudCLI's
 * Agent-SDK `canUseTool` callback posts a browser `permission_request` and AWAITS
 * approval for every not-yet-allowed tool, stalling the chat on each injected
 * `mcp__*` and native call.
 *
 * PRESERVES the user's `allow`/`deny`/`ask` posture verbatim — their curated
 * permission rules carry into serve unchanged, so a session switched off bypass
 * (plan / default mode via the composer) behaves exactly as their own Claude Code
 * would. We used to CLEAR `allow` on a since-debunked theory that a non-empty
 * allow narrows the toolset; empirically it does NOT (a 13-rule allow yields the
 * full 27-tool set incl Glob/Bash/Edit), and CloudCLI's `allowedTools` comes only
 * from the client `localStorage['claude-settings']` seed (`[]`), never from
 * `permissions.allow`. The real toolset-narrowing was `CLAUDE_CODE_COORDINATOR_MODE`,
 * stripped separately by {@link sanitizeServeSettingsEnv}. Not clearing `allow`
 * is what keeps serve at parity with the user's own Claude Code permission posture.
 *
 * Only ever rewrites the per-launch serve mirror, never the operator's real
 * `~/.claude/settings.json`. Atomic temp+rename, mode 0o600. A non-object
 * settings.json throws (never clobber a file we don't understand); the caller
 * wraps this in warn-and-continue so a hiccup never blocks launch.
 *
 * Opt out with `GH_ROUTER_SERVE_NO_AUTO_APPROVE=1` (the caller skips this) — the
 * mirrored `defaultMode` is then left exactly as snapshotted.
 */
export async function configureServePermissionsBypass(
  settingsPath: string,
): Promise<{ written: boolean }> {
  const existing = (await readSettingsObject(settingsPath)) ?? {}
  const permsRaw = existing.permissions
  const perms: Record<string, unknown> =
    permsRaw && typeof permsRaw === "object" && !Array.isArray(permsRaw)
      ? { ...(permsRaw as Record<string, unknown>) }
      : {}

  if (perms.defaultMode === "bypassPermissions") return { written: false }
  perms.defaultMode = "bypassPermissions"
  // allow / deny / ask are left UNTOUCHED — the user's curated posture carries
  // into serve. (Clearing allow was a no-op fix for a misdiagnosed toolset bug.)
  await writeSettingsObject(settingsPath, { ...existing, permissions: perms }, "servebypass")
  return { written: true }
}
