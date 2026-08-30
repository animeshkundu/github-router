import { randomBytes, randomUUID } from "node:crypto"

import type { ModelsResponse } from "~/services/copilot/get-models"
import type { LaunchProfileId } from "./launch-profile"

/**
 * One authenticated `github-router claude` (or `serve`) launch's identity
 * and capability scope, keyed by `launchId` in `state.launchRegistry`.
 *
 * Replaces the earlier scalar `state.peerMcpNonce` assumption — a single
 * process-global nonce cannot express "which profile is this caller", so
 * a concurrent fast + standard launch (or a reconnect) had no way to keep
 * their identities from being interchangeable. Each entry carries BOTH
 * credentials a launch presents on the wire:
 *
 *   - `nonce`  — the `/mcp` bearer (Streamable HTTP `Authorization` header).
 *   - `secret` — the `/v1/messages` identity-preflight bearer, deliberately
 *     a SEPARATE credential from `nonce` so leaking one surface's token
 *     (say, via a client log) does not also authenticate the other.
 *
 * `allowedGroups` / `allowedPersonas` are the narrowing declaration for
 * scoped MCP surfaces: `undefined` means UNRESTRICTED (the standard/BYO
 * launch shape today), and a concrete `ReadonlySet` is a restricted profile's
 * hard allow-list. This module only stores and looks up the declaration;
 * enforcing it against `tools/list` / `tools/call` is the MCP route
 * handler's job.
 */
export interface LaunchRegistryEntry {
  /** Opaque per-launch id. Primary key into `state.launchRegistry`. */
  launchId: string
  /** `/mcp` Streamable HTTP bearer for this launch. */
  nonce: string
  /** `/v1/messages` identity-preflight bearer for this launch. */
  secret: string
  /** Which launch profile authenticated this entry. */
  profileId: LaunchProfileId
  /** Scoped MCP group allow-list. `undefined` = unrestricted. */
  allowedGroups?: ReadonlySet<string>
  /** Persona (peers-group) tool-name allow-list. `undefined` = unrestricted. */
  allowedPersonas?: ReadonlySet<string>
  createdAt: number
}

/**
 * Registry key backing the `state.peerMcpNonce` back-compat accessor
 * below. Not a real launch id (no `registerLaunch` caller ever produces
 * this string), so it can never collide with a genuine per-launch UUID.
 */
const DEFAULT_LAUNCH_ID = "__default__"

export interface State {
  githubToken?: string
  copilotToken?: string

  /**
   * Where `githubToken` came from, which decides whether the proxy may
   * re-read it from disk.
   *
   * `"file"` — read from `PATHS.GITHUB_TOKEN_PATH`. A re-read is allowed, so
   * an out-of-band `github-router auth` heals a running proxy without a
   * restart.
   *
   * `"explicit"` — supplied by the operator via `--github-token` / `GH_TOKEN`.
   * The file is NEVER read on this path: silently replacing a
   * caller-supplied credential with whatever happens to be on disk would
   * override an explicit instruction. It also means "run `github-router
   * auth`" is false advice for this source — the remediation is to replace
   * the supplied value.
   */
  githubTokenSource?: "file" | "explicit"

  /**
   * Monotonic counter bumped on every SUCCESSFUL Copilot token exchange.
   *
   * This is the retry criterion for `tryRefreshAndRetry`, and it is
   * deliberately not "did the token string change": two consecutive
   * successful exchanges were observed returning an identical token, so a
   * string comparison would silently suppress legitimate retries. Nor is it
   * the refresh's own verdict — with requests A and B both holding a stale
   * token, A can refresh while B's later 401 is cooled down to a no-op, and
   * a verdict of "nothing happened" would fail B even though a good token is
   * already in `copilotToken`. Comparing generations answers the question
   * each request actually has: "is what is in state now different from what
   * I already tried?"
   */
  copilotTokenGeneration: number

  /**
   * Wall-clock ms after which `copilotToken` should be refreshed — already
   * skew-adjusted, so the per-request check is a plain `Date.now() >=` compare.
   *
   * Derived from the exchange's `refresh_in` (a DURATION) and never from its
   * absolute `expires_at`. A local clock running ahead of GitHub's would make
   * an absolute timestamp look already-past on a brand-new token and drive a
   * refresh storm; a duration is immune, because it is anchored to the same
   * clock that later reads it.
   */
  copilotTokenRefreshAt?: number

  /**
   * Second, WRITE-capable GitHub token for the first-mate
   * agent-orchestration surface (`--agents`). Minted by a separate
   * device-flow login against the GitHub CLI's OAuth client
   * (`GITHUB_AGENT_CLIENT_ID`, scopes `repo workflow read:org`) and
   * stored at `PATHS.GITHUB_AGENT_TOKEN_PATH`, apart from `githubToken`
   * (the Copilot App token, read:user). The first-mate GitHub service
   * layer uses this for ALL its calls (reads included, so it also works
   * on private repos). Undefined until the agent login has run.
   */
  githubAgentToken?: string

  accountType: string
  copilotApiUrl?: string
  models?: ModelsResponse
  vsCodeVersion?: string
  copilotVersion?: string

  manualApprove: boolean
  rateLimitWait: boolean
  showToken: boolean
  extendedBetas: boolean

  /**
   * Opt-in flag for the browser-control MCP tools (`browser_*`). Set by
   * `setupAndServe` from the `--browse` CLI flag or
   * `GH_ROUTER_ENABLE_BROWSE=1` env var. When false, all `browser_*`
   * tools are dropped from `tools/list` AND `tools/call` returns
   * -32601 — same defense-in-depth pattern as `workerToolsEnabled()` /
   * `standInToolEnabled()`. See `browserToolsEnabled()` in
   * `src/routes/mcp/handler.ts`.
   */
  browseEnabled: boolean

  /**
   * Opt-in flag for the fleet session-control MCP tools (`mcp__fleet__*`).
   * Set by `setupAndServe` from the `--fleet` CLI flag or
   * `GH_ROUTER_ENABLE_FLEET=1` env var. When false, all fleet tools are
   * dropped from `tools/list` AND `tools/call` returns -32601 — same
   * defense-in-depth pattern as `workerToolsEnabled()` /
   * `standInToolEnabled()`. See `fleetToolsEnabled()` in
   * `src/lib/mcp-capabilities.ts`.
   */
  fleetEnabled: boolean

  /**
   * Opt-in flag for the first-mate agent-orchestration MCP tools
   * (`mcp__first-mate__*`) and the in-process GitHub cloud-agent driving
   * layer. Set by `setupAndServe` from the `--agents` CLI flag or
   * `GH_ROUTER_ENABLE_AGENTS=1`. When false, the first-mate tools are
   * dropped from `tools/list` AND `tools/call` returns -32601 — same
   * defense-in-depth pattern as `fleetToolsEnabled()`. Additionally
   * requires `state.githubAgentToken` present (the write login), so the
   * surface is invisible rather than 401-ing when unauthenticated. See
   * `agentToolsEnabled()` in `src/lib/mcp-capabilities.ts`.
   */
  agentsEnabled: boolean

  /**
   * When true, --power-browse was passed (or GH_ROUTER_ENABLE_POWER_BROWSE=1
   * is set). Exposes the FULL browser MCP surface (~18 tools) on /mcp,
   * including the L0/L1 primitives that hand DOM details (refs,
   * bboxes, role/name dumps) to the lead model. Default --browse mode
   * exposes only the 6 lead-model tools (act, observe, extract,
   * navigate, screenshot, open_tab). Always implies browseEnabled.
   */
  powerBrowseEnabled: boolean

  /**
   * Humanlike pacing override:
   *   "on"   - --humanlike CLI flag or GH_ROUTER_HUMANLIKE=1 env;
   *            inject Beta-distributed inter-action delays, Bezier
   *            mouse paths, per-keystroke jitter, scroll chunking
   *            into every browser_* action dispatch.
   *   "off"  - GH_ROUTER_BROWSER_NO_HUMANLIKE=1; HARD disable, wins
   *            over "on" so tests are reproducible.
   *   "auto" - default; pacing engages only when bot-challenge
   *            detection fires (Phase 4-future).
   *
   * Lead model never sees this state — it's an internal concern.
   */
  humanlikeForce: "on" | "off" | "auto"

  // Rate limiting configuration
  rateLimitSeconds?: number
  lastRequestTimestamp?: number

  // Persistent session identifiers to match VS Code fingerprint
  sessionId: string
  machineId: string

  /**
   * Keyed per-launch registry for the loopback `/mcp` endpoint AND the
   * `/v1/messages` identity preflight. Set by the `claude` subcommand
   * (via `registerLaunch` in `./launch-registry`) after `setupAndServe`
   * and before spawning Claude Code; removed by the launch's own
   * cleanup. When empty, `/mcp` rejects all requests — closes the
   * loopback-no-auth gap (DNS rebinding, malicious browser-ext native
   * messaging, sibling-process probe) exactly as the old scalar nonce
   * did when unset.
   *
   * Multiple entries coexist for concurrent fast/standard launches (or a
   * launch plus a reconnect); each is looked up by its OWN nonce/secret,
   * so two launches' authenticated identities never cross.
   */
  launchRegistry: Map<string, LaunchRegistryEntry>

  /**
   * @deprecated Back-compat accessor over the registry's DEFAULT_LAUNCH_ID
   * entry (profileId "standard", unrestricted `allowedGroups`/
   * `allowedPersonas`) — defined below via `Object.defineProperty`, not a
   * real stored field. Reading returns that entry's nonce; writing creates
   * or updates it (or deletes it on `undefined`). Exists so single-launch
   * call sites and tests that already do `state.peerMcpNonce = NONCE`
   * keep working unmodified while `checkAuth` and the identity preflight
   * consult the real keyed registry underneath. New code should call
   * `registerLaunch` / `findLaunchByNonce` / `findLaunchBySecret` from
   * `./launch-registry` directly instead of reading/writing this field.
   */
  peerMcpNonce?: string

  /**
   * Set by `github-router serve` (a single machine-wide control plane serving
   * many repos). When true, repo-scoped worker tools require an explicit/So-derived
   * `workspace` and must NOT silently default to the proxy launch cwd.
   */
  serveMode?: boolean
}

export const state: State = {
  accountType: "enterprise",
  copilotTokenGeneration: 0,
  manualApprove: false,
  rateLimitWait: false,
  showToken: false,
  extendedBetas: false,
  browseEnabled: false,
  fleetEnabled: false,
  agentsEnabled: false,
  powerBrowseEnabled: false,
  humanlikeForce: "auto",
  sessionId: randomUUID(),
  machineId: randomBytes(32).toString("hex"),
  launchRegistry: new Map(),
}

// `peerMcpNonce` is not a plain data field — it's a live view onto
// `state.launchRegistry.get(DEFAULT_LAUNCH_ID)`. Defined via
// `Object.defineProperty` (rather than a class) so `state` stays the
// plain object literal every existing importer already destructures /
// mutates directly.
Object.defineProperty(state, "peerMcpNonce", {
  enumerable: true,
  configurable: true,
  get(): string | undefined {
    return state.launchRegistry.get(DEFAULT_LAUNCH_ID)?.nonce
  },
  set(value: string | undefined) {
    if (value === undefined) {
      state.launchRegistry.delete(DEFAULT_LAUNCH_ID)
      return
    }
    const existing = state.launchRegistry.get(DEFAULT_LAUNCH_ID)
    state.launchRegistry.set(DEFAULT_LAUNCH_ID, {
      launchId: DEFAULT_LAUNCH_ID,
      nonce: value,
      // A caller that only ever touches `peerMcpNonce` exposes MCP only and has
      // no Messages identity secret.
      // Never reuse the MCP bearer across surfaces: an empty secret cannot match
      // any non-empty custom header, while registered Claude launches always use
      // `registerLaunch` with independently generated credentials.
      secret: existing?.secret ?? "",
      profileId: existing?.profileId ?? "standard",
      allowedGroups: existing?.allowedGroups,
      allowedPersonas: existing?.allowedPersonas,
      createdAt: existing?.createdAt ?? Date.now(),
    })
  },
})
