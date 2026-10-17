/**
 * `az account get-access-token` plumbing shared by every router-owned Azure
 * client (Bluebird, Azure DevOps MCP, Kusto).
 *
 * Three layers live here, in order of escalation:
 *
 *   1. `runAzCliAccessToken` — one silent `az account get-access-token`.
 *   2. `acquireAzToken` — the ladder: a silent mint, then (only for a
 *      credential-shaped failure, and only when the caller allows it) ONE
 *      interactive `az login`, then one re-mint.
 *   3. `AzCliAccessTokenCache` — the process-lifetime cache over (2).
 *
 * Failures are classified (`classifyAzFailure`) because the remedy differs:
 * a dead session needs `az login`, a tenant that does not contain the resource
 * needs a different account or `AZURE_TENANT_ID`, and a missing `az` needs an
 * install. The interactive ladder fires for exactly one of those classes.
 *
 * The functions here throw a plain `Error` carrying an already-sanitized,
 * credential-free detail; each caller wraps it in its own error class so a
 * failure is attributed to the service that asked for the token. Nothing here
 * ever logs, returns, or embeds the token in a message.
 */

import consola from "consola"

import {
  resolveExecutable,
  runCommandCapture,
  runCommandInherit,
  type RunOpts,
  type RunResult,
} from "./exec"
import { sanitizeRemoteDetail, waitForSignal } from "./remote-mcp-client"

/** Azure CLI invocation budget: a hung `az` must not wedge a tool call. */
const AZ_TIMEOUT_MS = 20_000
const AZ_MAX_STDOUT_BYTES = 1024 * 1024

/**
 * The process-spawning surface, behind one object so tests can replace it
 * without `mock.module` (which bun applies process-globally and cannot undo,
 * and which this module's suites must not leak into the lanes that share a
 * process). Every test that exercises the interactive ladder swaps this: on a
 * machine with a real `az` on PATH an unswapped ladder test would open a
 * browser, which is exactly the kind of side effect a suite must never have.
 */
interface AzCliExecDeps {
  resolveExecutable: (name: string) => string | null
  runCommandCapture: (cmd: Array<string>, opts: RunOpts) => Promise<RunResult>
  runCommandInherit: (cmd: Array<string>, opts: RunOpts) => Promise<RunResult>
}

const defaultExecDeps: AzCliExecDeps = {
  resolveExecutable,
  runCommandCapture,
  runCommandInherit,
}

let execDeps: AzCliExecDeps = defaultExecDeps

export function __setAzCliExecDepsForTests(over: Partial<AzCliExecDeps>): void {
  execDeps = { ...execDeps, ...over }
}

export function __resetAzCliExecDepsForTests(): void {
  execDeps = defaultExecDeps
}

/**
 * Interactive-login budgets. These are deliberately far longer than
 * `AZ_TIMEOUT_MS` because a human is in the loop, which is also why the ladder
 * must never run under a caller's short deadline: `runCommandCapture`'s abort
 * path tree-kills the child, so a 20 s launch-probe deadline would kill a
 * browser sign-in at 20 s and both waste it and misreport the cause. The
 * launch probes therefore pass `allowInteractiveLogin: false` and keep the
 * silent-mint behaviour they had before the ladder existed.
 */
export const AZ_LOGIN_BROWSER_TIMEOUT_MS = 120_000
export const AZ_LOGIN_DEVICE_CODE_TIMEOUT_MS = 300_000

/** Backoff before another interactive attempt after one that failed. */
export const AZ_INTERACTIVE_LOGIN_BACKOFF_MS = 5 * 60_000

/**
 * Tenant knob. Every resource this module mints for lives in one tenant; when
 * the signed-in account is in another, `az` can be told which tenant to use
 * without a second `az login` (which would just re-select the same default).
 */
export const AZURE_TENANT_ENV = "AZURE_TENANT_ID"

export interface AzCliToken {
  token: string
  /**
   * Epoch milliseconds at which the token stops working, when the installed
   * `az` reports it. `null` means "unknown" and callers must decide their own
   * refresh policy rather than treating it as expired.
   */
  expiresAtMs: number | null
}

/** Refresh this far ahead of the reported expiry. */
export const AZ_TOKEN_REFRESH_MARGIN_MS = 5 * 60_000

export type AzFailureKind =
  /** `az` is not on PATH: nothing to log into. */
  | "az-missing"
  /** The CLI has no usable session (never logged in, or the session expired). */
  | "login-required"
  /** The account's tenant does not carry the resource (or the app/consent). */
  | "tenant"
  /** The CLI did not answer in time. */
  | "timeout"
  | "unknown"

/** Carries the classification alongside the message so callers need no re-parse. */
export class AzCliFailure extends Error {
  readonly kind: AzFailureKind

  constructor(kind: AzFailureKind, message: string) {
    super(message)
    this.name = "AzCliFailure"
    this.kind = kind
  }
}

/**
 * Observed `az` stderr shapes. These are fixtures, not guesses:
 *
 *   - `ERROR: Please run 'az login' to setup account.` (dead session)
 *   - `ERROR: V2Error: invalid_resource AADSTS500011: The resource principal
 *     named <id> was not found in the tenant named <t>. You might have sent
 *     your authentication request to the wrong tenant.` (wrong tenant)
 *
 * The AADSTS codes are the ones that mean "the session cannot produce a token
 * any more" rather than "the token was refused": the refresh token expired or
 * was revoked, or Conditional Access demanded interactive auth.
 */
const TENANT_FAILURE_PATTERNS = [/invalid_resource/i, /AADSTS500011/i, /wrong tenant/i]
const LOGIN_REQUIRED_PATTERNS = [
  /az login/i,
  /AADSTS(?:50078|50158|50173|53000|53003|65001|70043|700082|700084)/i,
  /refresh token (?:has expired|is not valid|expired)/i,
  /interactive authentication is needed/i,
  /token request failed/i,
]

/**
 * Classify a mint failure. A typed `AzCliFailure` answers directly; anything
 * else is matched against the observed CLI text, because callers legitimately
 * pass wrapped errors (`describeAzFailure(label, err)` receives whatever the
 * inner path threw).
 */
export function classifyAzFailure(err: unknown): AzFailureKind {
  if (err instanceof AzCliFailure) return err.kind
  const text = err instanceof Error ? err.message : String(err)
  if (/not found on PATH/.test(text)) return "az-missing"
  // Tenant before login-required: the invalid_resource text names a tenant
  // remedy, and misreading it as a dead session sends the operator to
  // `az login`, which re-selects the same wrong tenant and changes nothing.
  if (TENANT_FAILURE_PATTERNS.some((re) => re.test(text))) return "tenant"
  if (LOGIN_REQUIRED_PATTERNS.some((re) => re.test(text))) return "login-required"
  if (/timed out/i.test(text)) return "timeout"
  return "unknown"
}

/** `--tenant <id>` when configured. Applied to the mint and to interactive login. */
function azTenantArgs(): Array<string> {
  const tenant = process.env[AZURE_TENANT_ENV]?.trim()
  return tenant ? ["--tenant", tenant] : []
}

/**
 * Parse the `expires_on` / `expiresOn` fields of `az account get-access-token
 * --output json`. `expires_on` (epoch seconds) is present on modern az; the
 * older `expiresOn` string is local-time-without-zone, so it is only a
 * fallback and is parsed as local time. An unparseable value yields `null`,
 * never a fabricated deadline — a wrong deadline in either direction is worse
 * than none (too late sends a dead token, too early mints tokens in a loop).
 */
function parseAzExpiry(payload: Record<string, unknown>): number | null {
  const epoch = payload.expires_on
  if (typeof epoch === "number" && Number.isFinite(epoch) && epoch > 0) {
    // Some az versions report milliseconds; normalize by magnitude.
    const ms = epoch > 1e11 ? epoch : epoch * 1000
    if (ms > Date.now() - 86_400_000) return ms
  }
  if (typeof epoch === "string" && /^\d+$/.test(epoch.trim())) {
    const n = Number(epoch.trim())
    const ms = n > 1e11 ? n : n * 1000
    if (Number.isFinite(ms) && ms > Date.now() - 86_400_000) return ms
  }
  const text = payload.expiresOn
  if (typeof text === "string") {
    const parsed = Date.parse(text)
    if (Number.isFinite(parsed)) return parsed
  }
  return null
}

/**
 * Acquire an access token for `resource` through Azure CLI. `withExpiry` asks
 * for the JSON envelope so the caller can cache against a real deadline; the
 * default keeps the minimal `--query accessToken --output tsv` invocation.
 *
 * SILENT: this never starts an interactive login. Use `acquireAzToken` for the
 * escalation ladder.
 */
export async function runAzCliAccessToken(
  resource: string,
  opts: { signal?: AbortSignal; withExpiry?: boolean } = {},
): Promise<AzCliToken> {
  const { signal } = opts
  const executable = execDeps.resolveExecutable("az")
  if (!executable) {
    throw new AzCliFailure("az-missing", "Azure CLI executable `az` was not found on PATH.")
  }
  const args = ["account", "get-access-token", "--resource", resource, ...azTenantArgs()]
  if (opts.withExpiry) {
    args.push("--output", "json")
  } else {
    args.push("--query", "accessToken", "--output", "tsv")
  }
  const result = await execDeps.runCommandCapture(
    [executable, ...args],
    {
      timeoutMs: AZ_TIMEOUT_MS,
      maxStdoutBytes: AZ_MAX_STDOUT_BYTES,
      ...(signal ? { signal } : {}),
    },
  )
  if (result.timedOut) throw new AzCliFailure("timeout", "timed out")
  if (result.code !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim()
    const message = `exited with code ${result.code ?? "unknown"}${detail ? `: ${detail.slice(0, 500)}` : ""}`
    throw new AzCliFailure(classifyAzFailure(message), message)
  }
  const stdout = result.stdout.trim()
  if (!opts.withExpiry) {
    if (!stdout) throw new AzCliFailure("login-required", "az returned an empty access token")
    return { token: stdout, expiresAtMs: null }
  }
  let payload: unknown
  try {
    payload = JSON.parse(stdout)
  } catch {
    throw new AzCliFailure("unknown", "az returned an unparseable access-token response")
  }
  if (typeof payload !== "object" || payload === null) {
    throw new AzCliFailure("unknown", "az returned an unparseable access-token response")
  }
  const record = payload as Record<string, unknown>
  const token = typeof record.accessToken === "string" ? record.accessToken.trim() : ""
  if (!token) throw new AzCliFailure("login-required", "az returned an empty access token")
  return { token, expiresAtMs: parseAzExpiry(record) }
}

/** Per-stage outcome, kept tiny so tests can drive the ladder without a real az. */
async function attemptAzLogin(
  executable: string,
  args: Array<string>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<boolean> {
  try {
    // Inherited stdio, deliberately: `--use-device-code` prints the code and
    // URL the human has to read, and capturing them would strand the user at a
    // prompt they cannot see. The capture-side caps in `runInternal` are moot
    // in this mode.
    const result = await execDeps.runCommandInherit([executable, ...args], {
      timeoutMs,
      ...(signal ? { signal } : {}),
    })
    return result.code === 0
  } catch (err) {
    consola.debug("azure-cli-token: `az login` could not be run:", err)
    return false
  }
}

/**
 * One interactive login: the browser flow first, then device code. Returns
 * `false` (never throws) when neither completed, so the caller keeps the
 * ORIGINAL mint error as the reported cause rather than a login error that
 * describes only the fallback.
 */
export async function runAzInteractiveLogin(signal?: AbortSignal): Promise<boolean> {
  const executable = execDeps.resolveExecutable("az")
  if (!executable) return false
  consola.warn(
    "Azure CLI has no usable session. Starting an interactive `az login`; "
      + "if the browser cannot complete the sign-in, a device-code login follows.",
  )
  const tenant = azTenantArgs()
  if (await attemptAzLogin(executable, ["login", ...tenant], AZ_LOGIN_BROWSER_TIMEOUT_MS, signal)) {
    return true
  }
  if (signal?.aborted) return false
  consola.warn(
    "Browser sign-in did not complete. Falling back to `az login --use-device-code`; "
      + "open the printed URL and enter the printed code.",
  )
  return attemptAzLogin(
    executable,
    ["login", "--use-device-code", ...tenant],
    AZ_LOGIN_DEVICE_CODE_TIMEOUT_MS,
    signal,
  )
}

interface InteractiveLoginState {
  /** Shared in-flight attempt: concurrent callers wait on ONE login. */
  inflight: Promise<boolean> | null
  /** A login that completed successfully; never pop a second one. */
  succeeded: boolean
  /** When the last COMPLETED attempt failed, for the retry backoff. */
  failedAtMs: number | null
}

const interactiveLoginState: InteractiveLoginState = {
  inflight: null,
  succeeded: false,
  failedAtMs: null,
}

/** Test seam. Production never needs to clear this. */
export function __resetAzInteractiveLoginStateForTests(): void {
  interactiveLoginState.inflight = null
  interactiveLoginState.succeeded = false
  interactiveLoginState.failedAtMs = null
}

/**
 * The once-per-process gate around `runAzInteractiveLogin`.
 *
 * Two properties are load-bearing. **Completed attempts only**: the guard is
 * written when an attempt SETTLES, so an interrupted caller cannot consume it
 * (a guard burned by an abort is indistinguishable from a permanent failure,
 * which is the one case this exists to survive). **Shared flight**: concurrent
 * callers await one login instead of opening two browsers.
 *
 * The login runs under its OWN controller rather than the caller's signal for
 * the same reason: one caller giving up must not kill a sign-in the others are
 * waiting on. Waiters still detach on their own signal via `waitForSignal`.
 */
async function interactiveLoginOnce(signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return false
  const state = interactiveLoginState
  if (state.succeeded) return false
  if (state.failedAtMs !== null && Date.now() - state.failedAtMs < AZ_INTERACTIVE_LOGIN_BACKOFF_MS) {
    return false
  }
  const pending: Promise<boolean> = state.inflight ?? startInteractiveLoginAttempt()
  return waitForSignal(pending, signal)
}

/** Start (and publish) the shared login flight. Never called with one in flight. */
function startInteractiveLoginAttempt(): Promise<boolean> {
  const state = interactiveLoginState
  const controller = new AbortController()
  const flight = runAzInteractiveLogin(controller.signal).then(
    (ok) => {
      if (ok) {
        state.succeeded = true
        state.failedAtMs = null
      } else {
        state.failedAtMs = Date.now()
      }
      return ok
    },
    (err) => {
      state.failedAtMs = Date.now()
      throw err
    },
  )
  const tracked = flight.finally(() => {
    if (state.inflight === tracked) state.inflight = null
  })
  state.inflight = tracked
  return tracked
}

export interface AcquireAzTokenOpts {
  signal?: AbortSignal
  withExpiry?: boolean
  /**
   * Allow ONE interactive `az login` before reporting failure, and only when
   * the silent failure is credential-shaped. Call-time paths set this; the
   * launch probes must not (see the timeout comment above).
   */
  allowInteractiveLogin?: boolean
}

/**
 * The ladder: silent mint → (optional, credential-shaped only) interactive
 * login → one re-mint. The original error survives any login failure, because
 * it is the one that names the real cause.
 *
 * Never escalates for `az-missing` (that needs an install), for `tenant` (a
 * login would re-select the same tenant), or for a timeout.
 */
export async function acquireAzToken(
  resource: string,
  opts: AcquireAzTokenOpts = {},
): Promise<AzCliToken> {
  try {
    return await runAzCliAccessToken(resource, opts)
  } catch (err) {
    if (opts.signal?.aborted) throw opts.signal.reason ?? err
    if (!opts.allowInteractiveLogin) throw err
    if (classifyAzFailure(err) !== "login-required") throw err
    if (!execDeps.resolveExecutable("az")) throw err
    if (!(await interactiveLoginOnce(opts.signal))) throw err
    return await runAzCliAccessToken(resource, opts)
  }
}

/**
 * Process-lifetime access-token cache keyed by resource (Kusto keys on the
 * cluster URI, which is its audience).
 *
 * Two properties matter and both are load-bearing:
 *
 *   - **Single-flight refresh.** Concurrent callers that see the same expired
 *     entry await ONE `az` invocation. Without this, a burst of tool calls
 *     spawns a burst of `az` processes, each of which is a `.cmd` shim on
 *     Windows.
 *   - **Never cache an unknown deadline.** When `az` does not report an expiry
 *     the token is used but not cached, because a cache entry with no deadline
 *     can only be either immortal (serving a dead token) or arbitrary (minting
 *     in a loop).
 *
 * Caching moves refresh from reactive to proactive, so an invalidate path is
 * required alongside it: a 401 means the cached token is dead, and a retry that
 * reads the same entry returns the same rejected value until it expires. Every
 * caller of this cache invalidates at its own 401 arm (`forceRefresh` here, or
 * `invalidate` from a client that owns that decision).
 */
export class AzCliAccessTokenCache {
  private readonly entries = new Map<string, { token: string; expiresAtMs: number }>()
  private readonly flights = new Map<string, Promise<AzCliToken>>()
  private readonly marginMs: number

  constructor(marginMs: number = AZ_TOKEN_REFRESH_MARGIN_MS) {
    this.marginMs = marginMs
  }

  /** Cached-or-fresh token for `resource`. */
  async get(
    resource: string,
    opts: Pick<AcquireAzTokenOpts, "signal" | "allowInteractiveLogin"> & {
      /**
       * Drop a cached entry before reading, so a 401-driven re-mint cannot be
       * served the rejected value. Still joins an in-flight mint (which is
       * already fresh) rather than spawning a second `az`.
       */
      forceRefresh?: boolean
    } = {},
  ): Promise<string> {
    const { signal } = opts
    if (opts.forceRefresh) this.entries.delete(resource)
    const cached = this.entries.get(resource)
    if (cached && cached.expiresAtMs - this.marginMs > Date.now()) return cached.token

    const existing = this.flights.get(resource)
    if (existing) {
      const minted = await waitForSignal(existing, signal)
      return minted.token
    }

    // The STARTING caller's flag governs the flight: two callers racing for
    // the same resource share one `az` process, and this window is one process
    // lifetime (~20s). A probe that joins a call-time flight simply waits.
    const allowInteractiveLogin = opts.allowInteractiveLogin === true
    const flight = (async (): Promise<AzCliToken> => {
      const minted = await acquireAzToken(resource, {
        withExpiry: true,
        allowInteractiveLogin,
      })
      if (minted.expiresAtMs !== null) {
        this.entries.set(resource, { token: minted.token, expiresAtMs: minted.expiresAtMs })
      }
      return minted
    })()
    // Publish the TRACKED promise, not the raw one. Storing `flight` while the
    // cleanup compares against `tracked` reads as correct and never matches, so
    // the completed flight stays in the map and the next caller to arrive after
    // an `invalidate()` joins it and is handed the token that was just rejected
    // (measured: `AzCliAccessTokenCache` invalidate → get returned the old
    // token with zero `az` invocations).
    const tracked = flight.finally(() => {
      if (this.flights.get(resource) === tracked) this.flights.delete(resource)
    })
    this.flights.set(resource, tracked)
    const minted = await waitForSignal(tracked, signal)
    return minted.token
  }

  /** Drop a cached token so the next `get` re-mints (used on a 401). */
  invalidate(resource: string): void {
    this.entries.delete(resource)
  }

  clear(): void {
    this.entries.clear()
  }
}

/**
 * Standard wrapping of an `az` failure into a caller-owned error class, with
 * per-class advice: the whole point of classifying is that "run `az login`"
 * is the wrong instruction for a tenant or install problem.
 */
export function describeAzFailure(label: string, err: unknown): string {
  const detail = sanitizeRemoteDetail(err)
  switch (classifyAzFailure(err)) {
    case "az-missing":
      return `${label} token acquisition failed (${detail}). Install the Azure CLI, then run \`az login\` and retry.`
    case "login-required":
      return `${label} token acquisition failed (${detail}). The Azure CLI session is missing or expired; run \`az login\` and retry.`
    case "tenant":
      return `${label} token acquisition failed (${detail}). The signed-in account's tenant does not hold ${label}; sign in with an account from the tenant that owns it, or set ${AZURE_TENANT_ENV}, then retry.`
    case "timeout":
      return `${label} token acquisition failed (${detail}). The Azure CLI did not answer; retry, and run \`az login\` if the session is stale.`
    default:
      return `${label} token acquisition failed (${detail}). Run \`az login\` and retry.`
  }
}
