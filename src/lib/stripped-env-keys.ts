/**
 * Auth / routing / remote / wire-fingerprint environment keys that must never
 * reach a github-router-spawned Claude or Codex child — through ANY channel.
 *
 * Two channels carry these keys to a spawned agent, and both must be defended:
 *   1. The PARENT PROCESS ENV — a user's shell exports. Stripped by
 *      `sanitizeParentEnv` (`src/lib/launch.ts`) before the proxy's overrides.
 *   2. The serve mirror `settings.json` `env` BLOCK — a user's own
 *      `~/.claude/settings.json`, snapshot-mirrored and applied to the
 *      SDK-spawned claude via `settingSources`. Stripped by
 *      `sanitizeServeSettingsEnv` (`src/lib/mcp-permissions-settings.ts`).
 *
 * If any of these survived, a Bedrock/Vertex/gateway user's config would
 * re-route the session OFF the github-router proxy, inject real auth that wins
 * over the synthetic `.credentials.json`, or activate Claude Code's
 * unimplemented Bridge/remote code path. `CLAUDE_CODE_COORDINATOR_MODE` (a
 * toolset-stripper) is NOT here — it's serve-specific, added to the serve list
 * directly. `ANTHROPIC_SMALL_FAST_MODEL` is deliberately NOT stripped (users
 * legitimately rely on it; `resolveModel` translates unrecognized values).
 */
export const STRIPPED_AUTH_ROUTING_ENV_KEYS = [
  // Claude Code auth surface
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_CUSTOM_HEADERS",
  "ANTHROPIC_MODEL",
  "CLAUDE_CODE_OAUTH_TOKEN",
  // Alternate OAuth source (loads from an open file descriptor); stripping
  // prevents a third auth source alongside the synthetic .credentials.json.
  "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
  // Defense-in-depth: a parent- or settings-set CLAUDE_CONFIG_DIR would
  // redirect the session's config dir away from the router-owned mirror.
  "CLAUDE_CONFIG_DIR",
  // Claude Code Bridge / IDE remote-session surface — activates a remote code
  // path (POST /v1/code/sessions, /v1/environments/bridge, …) the proxy does
  // not implement. Stripping forces a local-only session.
  "CLAUDE_BRIDGE_OAUTH_TOKEN",
  "CLAUDE_BRIDGE_BASE_URL",
  "CLAUDE_BRIDGE_SESSION_INGRESS_URL",
  "SESSION_INGRESS_URL",
  "CLAUDE_CODE_REMOTE",
  "CLAUDE_CODE_CONTAINER_ID",
  "CLAUDE_CODE_REMOTE_SESSION_ID",
  "CLAUDE_CODE_SESSION_ID",
  // Emits `x-anthropic-additional-protection` — pure wire-fingerprint noise
  // that breaks the VS Code stealth posture.
  "CLAUDE_CODE_ADDITIONAL_PROTECTION",
  // Codex CLI auth surface
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "CODEX_HOME",
  // ai-or-die per-tab session-bind / artifact-review surface — must not leak
  // into a nested launch and hijack the parent tab's sidecar / bearer token.
  "AIORDIE_CLAUDE_BIND",
  "AIORDIE_TOKEN",
  "AIORDIE_INSECURE_TLS",
] as const
