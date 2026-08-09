import consola from "consola"
import { randomBytes } from "node:crypto"
import fs from "node:fs/promises"

import { PATHS } from "~/lib/paths"
import {
  CopilotTokenExchangeError,
  credentialFingerprint,
  getCopilotToken,
} from "~/services/github/get-copilot-token"
import { getDeviceCode } from "~/services/github/get-device-code"
import { getGitHubUser } from "~/services/github/get-user"
import { pollAccessToken } from "~/services/github/poll-access-token"

import {
  GITHUB_AGENT_CLIENT_ID,
  GITHUB_AGENT_SCOPES,
  GITHUB_API_BASE_URL,
  githubAgentHeaders,
} from "./api-config"
import { HTTPError } from "./error"
import { state } from "./state"

const readGithubToken = () => fs.readFile(PATHS.GITHUB_TOKEN_PATH, "utf8")

/**
 * Transient filesystem errors from a read that raced the temp+rename write.
 *
 * On Windows a read landing in that window fails with one of these even
 * though a perfectly good file exists microseconds later. Treating one as
 * fatal at startup would cost a launch for no reason.
 */
const TRANSIENT_READ_CODES = new Set(["EPERM", "EBUSY", "EACCES", "ENOENT"])

function isTransientReadError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | undefined)?.code
  return typeof code === "string" && TRANSIENT_READ_CODES.has(code)
}

/**
 * Read the credential file, retrying briefly through a racing rename.
 *
 * Same delays and the same reasoning as {@link RENAME_RETRY_DELAYS_MS} on the
 * write side: the contending handle closes almost immediately, so a short
 * bounded retry converts a spurious launch failure into a non-event. A
 * persistent failure still propagates — the caller must not believe a
 * credential was read when it was not.
 */
async function readGithubTokenWithRetry(): Promise<string> {
  let lastErr: unknown
  for (let attempt = 0; attempt <= RENAME_RETRY_DELAYS_MS.length; attempt++) {
    try {
      return await readGithubToken()
    } catch (err) {
      lastErr = err
      if (!isTransientReadError(err)) throw err
      if (attempt < RENAME_RETRY_DELAYS_MS.length) {
        await new Promise<void>((resolve) =>
          setTimeout(resolve, RENAME_RETRY_DELAYS_MS[attempt]),
        )
      }
    }
  }
  throw lastErr
}

/**
 * Backoff for a transient Windows rename failure. On Windows `fs.rename` over
 * an existing destination transiently fails with EPERM / EBUSY / EACCES when
 * anything else holds the target open for a moment (antivirus, the search
 * indexer, a backup agent). Nothing is wrong and the handle closes microseconds
 * later — but without a retry, a scan landing on the wrong millisecond throws
 * out of a credential write and costs the user a re-auth. Same delays as
 * `renameWithRetry` in `~/lib/claude-md-injection`, which documents the
 * underlying behavior at length.
 */
const RENAME_RETRY_DELAYS_MS = [50, 200, 500] as const

/**
 * Replace a credential file atomically: temp + rename, with bounded retry.
 *
 * A plain `fs.writeFile` truncates the destination before it writes, so a
 * crash, a full disk, or a kill mid-write leaves a truncated token on disk and
 * forces the user through a re-auth. `rename` within the same directory is
 * atomic on both NTFS and POSIX, so a reader sees either the old token or the
 * new one, never a partial.
 *
 * The temp name uses `randomBytes`, not `Math.random()`: this names a file that
 * briefly holds a credential, and a predictable name in a shared directory
 * invites a pre-creation race. Combined with `flag: "wx"` (fail if it exists)
 * the write refuses to follow anything an attacker pre-placed, rather than
 * silently writing the token through a planted symlink.
 *
 * Permissions: the temp file is created 0o600, and `rename` carries that mode
 * with it on POSIX — so the destination's mode is preserved, not weakened.
 * (On Windows `chmod` is a no-op anyway; see `chmodIfPossible` in `~/lib/paths`.
 * Both token files live under `CLAUDE_RUNTIME_DIR`, which is chmod'd 0o700, so
 * directory ACLs are what actually protect them there.)
 */
async function writeTokenFileAtomic(
  filePath: string,
  token: string,
): Promise<void> {
  const tmp = `${filePath}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`
  try {
    await fs.writeFile(tmp, token, { mode: 0o600, flag: "wx" })

    let lastErr: unknown
    let renamed = false
    for (let attempt = 0; attempt <= RENAME_RETRY_DELAYS_MS.length; attempt++) {
      try {
        await fs.rename(tmp, filePath)
        renamed = true
        break
      } catch (err) {
        lastErr = err
        // Don't sleep after the final attempt.
        if (attempt < RENAME_RETRY_DELAYS_MS.length) {
          await new Promise<void>((resolve) =>
            setTimeout(resolve, RENAME_RETRY_DELAYS_MS[attempt]),
          )
        }
      }
    }
    // A persistent failure (permissions, full disk) still throws: the caller
    // must not believe a credential was stored when it was not.
    if (!renamed) throw lastErr
  } catch (err) {
    await fs.unlink(tmp).catch(() => {})
    throw err
  }
}

const writeGithubToken = (token: string) =>
  writeTokenFileAtomic(PATHS.GITHUB_TOKEN_PATH, token)

const readGithubAgentToken = () =>
  fs.readFile(PATHS.GITHUB_AGENT_TOKEN_PATH, "utf8")

const writeGithubAgentToken = (token: string) =>
  writeTokenFileAtomic(PATHS.GITHUB_AGENT_TOKEN_PATH, token)

/**
 * Stops the background Copilot-token refresh started by
 * {@link setupCopilotToken}. Idempotent.
 */
export type StopCopilotTokenRefresh = () => void

/**
 * Safety margin subtracted from the derived refresh deadline, so a request
 * arriving just before expiry refreshes rather than racing it.
 */
const REFRESH_SKEW_MS = 120_000

/**
 * Bounds on a `refresh_in` we are willing to turn into a timer delay. An
 * absurd or missing upstream value must not produce a zero-length timer (a
 * hot loop hammering GitHub) or an effectively infinite one (a token that is
 * never refreshed). 60s floor, 6h ceiling, 1500s default — the value GitHub
 * actually returns today.
 */
const MIN_REFRESH_IN_S = 60
const MAX_REFRESH_IN_S = 6 * 60 * 60
const DEFAULT_REFRESH_IN_S = 1500

/** Backoff schedule after a failed refresh, then hold at the last value. */
const REFRESH_BACKOFF_MS = [5_000, 15_000, 60_000, 300_000] as const

function clampRefreshIn(refreshIn: unknown): number {
  if (typeof refreshIn !== "number" || !Number.isFinite(refreshIn)) {
    return DEFAULT_REFRESH_IN_S
  }
  return Math.min(Math.max(refreshIn, MIN_REFRESH_IN_S), MAX_REFRESH_IN_S)
}

/**
 * Adopt an exchange result into `state`.
 *
 * The generation bump is what lets an in-flight request know a newer token
 * exists (see `State.copilotTokenGeneration`), so it happens on EVERY success
 * — including one that returns a byte-identical token, which upstream
 * demonstrably does.
 */
/**
 * Floor on how far ahead the derived refresh deadline may be placed.
 *
 * The deadline is `now + refresh_in - skew`, and the skew (120s) is larger
 * than the `refresh_in` floor (60s) — so a short upstream `refresh_in` would
 * put the deadline in the PAST, the scheduler would floor its delay to 1s,
 * and the proxy would hammer the token endpoint at 1 Hz forever. The deadline
 * must always be in the future, whatever upstream says.
 */
const MIN_REFRESH_LEAD_MS = 30_000

function commitCopilotToken(token: string, refreshIn: unknown): void {
  state.copilotToken = token
  state.copilotTokenGeneration += 1
  // A successful exchange is proof the credential of record works, so any
  // outstanding "a human must act" latch is stale — clear it here, the single
  // choke point every success passes through (`setupCopilotToken` and
  // `refreshCopilotToken` both land here, after
  // `exchangeWithFreshestCredential` has already published the credential that
  // worked).
  //
  // Cleared on ANY success, not only when the fingerprint differs. If a
  // credential is rejected by a transient upstream fault and then the SAME
  // credential succeeds, a differs-only rule would leave the proxy reporting
  // `auth_required` forever on a perfectly good credential.
  state.authRequiredCredentialFingerprint = undefined
  // Derived from the DURATION, never the absolute `expires_at`: a clock
  // running ahead of GitHub's would make an absolute deadline look
  // already-past on a brand-new token and drive a refresh storm.
  const lead = Math.max(
    clampRefreshIn(refreshIn) * 1000 - REFRESH_SKEW_MS,
    MIN_REFRESH_LEAD_MS,
  )
  state.copilotTokenRefreshAt = Date.now() + lead
}

/**
 * Say, once, that a human has to do something — and say the right thing.
 *
 * Latched on the credential fingerprint: the refresh loop retries every few
 * minutes for as long as the process lives, and repeating identical advice on
 * every tick buries it. A rejection of a DIFFERENT credential is new
 * information, so the latch re-arms by fingerprint rather than being one-shot.
 *
 * The remedy branches on where the credential came from, because
 * "run `github-router auth`" is FALSE advice for an operator-supplied
 * `--github-token` / `GH_TOKEN`: `readGithubTokenIfUsable` never reads disk on
 * that path, so re-authenticating would write a file the process will not look
 * at, and the operator would be left with working instructions that do nothing.
 *
 * Emitted at `error` deliberately: `file-log-reporter`'s `ALLOWED_TYPES` keeps
 * only fatal/error/warn, so an `info` line would never reach the log file that
 * an operator actually reads.
 */
function noteAuthActionRequired(
  kind: "credential_rejected" | "entitlement_lapsed",
  credential: string,
): void {
  if (state.authRequiredCredentialFingerprint === credential) return
  state.authRequiredCredentialFingerprint = credential

  if (kind === "entitlement_lapsed") {
    consola.error(
      `Copilot entitlement lapsed for credential ${credential}: the credential `
        + `itself is still valid, so re-authenticating will NOT help. Check the `
        + `Copilot subscription or seat assignment for this account.`,
    )
    return
  }

  if (state.githubTokenSource === "explicit") {
    consola.error(
      `GitHub credential ${credential} was REJECTED by GitHub (revoked, not `
        + `expired). It was supplied via --github-token / GH_TOKEN, so `
        + `"github-router auth" will not help — replace the supplied value.`,
    )
    return
  }

  consola.error(
    `GitHub credential ${credential} was REJECTED by GitHub (revoked, not `
      + `expired). No refresh can recover this. Run "github-router auth" to `
      + `re-authenticate; every proxy running on this machine picks the new `
      + `credential up automatically, so nothing needs restarting. Note that `
      + `clients see 503 "overloaded" for this, not 401 — that remap is `
      + `deliberate, which is why this log line is the real signal.`,
  )
}

/**
 * Fetch the Copilot token and keep it fresh in the background.
 *
 * Returns a disposer that stops the refresh loop. **Long-lived callers**
 * (`start`/`claude`/`codex`, via `setupAndServe`) can ignore it — the timer
 * is `unref()`d, so it never holds the event loop open on its own. The one-shot
 * `models` command calls it, so ownership of the timer is explicit rather than
 * implied by a runtime flag. (`check-usage` does not call this function at all;
 * it only needs `setupGitHubToken`.)
 *
 * Both halves are load-bearing, for different failure modes. Without the
 * `unref()`, `github-router models` printed its full correct output and then
 * hung forever: its success path just returns (only the failure branches call
 * `process.exit`), and the un-unref'd timer pinned the event loop. Without
 * the disposer, that fix would depend on a property no caller can see, so the
 * next one-shot command would inherit the same trap.
 *
 * The schedule is a SELF-RE-ARMING `setTimeout`, not a fixed `setInterval`.
 * Three reasons: the delay tracks each response's own `refresh_in` instead of
 * the one captured at startup; a failure can back off (5s → 15s → 60s → 300s)
 * instead of waiting a full period during which the token is already dead;
 * and one timer cannot disagree with itself the way a period timer plus a
 * separate retry timer can.
 */
export const setupCopilotToken = async (): Promise<StopCopilotTokenRefresh> => {
  // The startup exchange is the MOST likely place a revoked credential is
  // discovered — a user whose session died typically restarts, which is exactly
  // this path. It does not go through `refreshCopilotToken`, so without this it
  // would throw a bare "HTTP 401" and abort launch having never named the one
  // thing that fixes it. Classify and advise, then re-throw unchanged: a
  // credential that cannot be exchanged still has to stop the launch.
  let exchanged
  try {
    exchanged = await getCopilotToken()
  } catch (error) {
    if (error instanceof CopilotTokenExchangeError) {
      if (error.kind === "credential_rejected") {
        noteAuthActionRequired("credential_rejected", error.credential)
      } else if (error.kind === "entitlement_lapsed") {
        noteAuthActionRequired("entitlement_lapsed", error.credential)
      }
    }
    throw error
  }
  const { token, refresh_in } = exchanged
  commitCopilotToken(token, refresh_in)

  consola.debug(
    `GitHub Copilot Token fetched successfully! (credential ${credentialFingerprint(state.githubToken)})`,
  )
  if (state.showToken) {
    consola.info("Copilot token:", token)
  }

  let handle: ReturnType<typeof setTimeout> | undefined
  let disposed = false
  let failures = 0

  const arm = (delayMs: number) => {
    // Checked here rather than only at the call sites because every caller
    // reaches this after an `await`, and disposal can land in that window.
    if (disposed) return
    handle = setTimeout(() => {
      void tick()
    }, delayMs)
    // A refresh timer is not a reason for the process to stay alive; it exists
    // to serve work that is already keeping it alive.
    handle.unref?.()
  }

  const tick = async () => {
    const outcome = await refreshCopilotToken("interval")
    // The disposer may have run while the exchange was in flight. Re-arming
    // now would resurrect the loop after it was explicitly stopped — the
    // classic leaked-timer-after-dispose bug.
    if (disposed) return
    if (outcome === "refreshed") {
      failures = 0
      arm(nextDelayFromState())
      return
    }
    // Any non-success (including a skipped no-op) backs off rather than
    // spinning: the token is dead or dying and hammering will not help.
    const delay =
      REFRESH_BACKOFF_MS[Math.min(failures, REFRESH_BACKOFF_MS.length - 1)]
    failures += 1
    arm(delay)
  }

  arm(nextDelayFromState())

  return () => {
    if (disposed) return
    disposed = true
    if (handle) clearTimeout(handle)
  }
}

/**
 * Delay until the next scheduled refresh, from the deadline already stored on
 * `state`. Floored at 1s so a pathological deadline can never busy-loop.
 */
function nextDelayFromState(): number {
  const deadline = state.copilotTokenRefreshAt
  if (deadline === undefined) return DEFAULT_REFRESH_IN_S * 1000
  return Math.max(deadline - Date.now(), 1000)
}

// Single-flight mutex around the refresh fetch. Concurrent triggers (interval
// + a 401-retry path) share one in-flight refresh promise so we never
// overlap network calls or race writes to state.copilotToken.
let inflightRefresh: Promise<RefreshOutcome> | undefined
// Cooldowns are keyed off the OUTCOME of the last refresh, not the attempt:
//   - lastRefreshSuccess: throttles 401-retries when the token is fresh
//     (don't pointlessly re-fetch a token we just got).
//   - lastRefreshFailure: shorter backoff so a transient upstream blip
//     doesn't suppress legitimate refresh attempts for a full 30s, but
//     still prevents a thundering-herd refresh-storm against an upstream
//     that's persistently failing.
let lastRefreshSuccess = 0
let lastRefreshFailure = 0
const REFRESH_SUCCESS_COOLDOWN_MS = 30_000
const REFRESH_FAILURE_COOLDOWN_MS = 5_000

/**
 * Clear the refresh cooldowns. TEST-ONLY.
 *
 * The cooldowns are module state that outlives any one test, so without a
 * reset a test's refresh silently suppresses the next test's. The alternative
 * — stubbing `Date.now` far into the future — leaks into every other test
 * sharing the process (it broke the cooldown assertions in `token.test.ts`),
 * so an explicit reset is both narrower and honest about what it touches.
 */
export function __resetRefreshCooldownsForTests(): void {
  lastRefreshSuccess = 0
  lastRefreshFailure = 0
}

/**
 * What a refresh attempt did. Used for LOGGING and classification only —
 * never to decide whether a request should retry. That decision belongs to
 * the generation counter (see {@link tryRefreshAndRetry}), because a "skipped"
 * outcome for one request can coincide with another request having just
 * installed a perfectly good token.
 */
export type RefreshOutcome =
  | "refreshed"
  | "skipped"
  | "credential_rejected"
  | "entitlement_lapsed"
  | "transient_failure"

/**
 * Read the credential from disk, returning it only if it is usable.
 *
 * Every failure mode here resolves to `undefined` (meaning "keep using what
 * is in memory") rather than throwing or returning a partial value. The file
 * is replaced by temp+rename (`writeTokenFileAtomic`), and on Windows a read
 * racing that rename fails with EPERM/EBUSY/EACCES/ENOENT. None of those mean
 * the in-memory credential went bad, so none of them may clear it — and a
 * filesystem error must never escape into the refresh loop and kill the timer.
 */
async function readGithubTokenIfUsable(): Promise<string | undefined> {
  if (state.githubTokenSource === "explicit") return undefined
  try {
    const raw = await readGithubToken()
    const trimmed = raw.trim()
    // A zero-length read is what a torn/partial write looks like. Adopting it
    // would replace a working credential with nothing.
    return trimmed.length > 0 ? trimmed : undefined
  } catch (err) {
    consola.debug("Could not re-read GitHub credential from disk:", err)
    return undefined
  }
}

/**
 * Perform one exchange, preferring a newer credential from disk if there is one.
 *
 * The disk token is a CANDIDATE: it is passed to the exchange directly and
 * published to `state.githubToken` only after that exchange succeeds. It is
 * never installed globally on spec — `state` is shared by every concurrent
 * request, so an unvalidated credential visible there would be sent by
 * unrelated in-flight requests and 401 them while a working credential was
 * still in hand.
 */
async function exchangeWithFreshestCredential(): Promise<{
  token: string
  refresh_in: number
}> {
  const onDisk = await readGithubTokenIfUsable()
  const inMemory = state.githubToken

  if (onDisk && onDisk !== inMemory) {
    consola.info(
      `GitHub credential on disk differs from the one in memory `
        + `(${credentialFingerprint(inMemory)} → ${credentialFingerprint(onDisk)}); trying it.`,
    )
    // Try the candidate WITHOUT publishing it. On success it becomes the
    // credential of record; on failure nothing was ever exposed to roll back.
    const result = await getCopilotToken(onDisk)
    state.githubToken = onDisk
    state.githubTokenSource = "file"
    return result
  }

  return getCopilotToken()
}

export async function refreshCopilotToken(
  reason: "interval" | "401-retry" | "expiry",
): Promise<RefreshOutcome> {
  // Single-flight: this check and the assignment below MUST NOT be separated
  // by an await. Anything awaited in between yields the event loop, letting a
  // second caller pass this guard before the first has published its promise
  // — which would launch overlapping exchanges against GitHub, exactly the
  // storm the mutex exists to prevent. The cooldown check needs to read the
  // credential from disk, so it lives INSIDE the body below rather than here.
  if (inflightRefresh) return inflightRefresh

  const run = async (): Promise<RefreshOutcome> => {
    // The `finally` that clears `inflightRefresh` must cover EVERY exit from
    // this body, including the early cooldown returns below. If a `return`
    // escaped it, the stale promise would stay published and every later
    // refresh would short-circuit to it forever — a permanently wedged
    // refresh loop, which is worse than the bug being fixed.
    try {
      // Refresh-storm protection: if a recent refresh already completed,
      // decline new reactive attempts. Interval refreshes always proceed
      // (they're spaced by the derived deadline, well outside the window).
      // Reactive attempts respect both cooldowns:
      //   - skip if a refresh succeeded within the last 30s (token is fresh)
      //   - skip if a refresh failed within the last 5s (back off briefly)
      //
      // A cooldown skip is NOT the same as "your request should give up": the
      // caller re-checks the generation counter and will still retry if some
      // other caller refreshed. See `tryRefreshAndRetry`.
      if (reason === "401-retry" || reason === "expiry") {
        const now = Date.now()
        // A credential newer than the one we last tried is new information,
        // not a repeat attempt, so it bypasses both cooldowns. Without this,
        // the window right after `github-router auth` — exactly the recovery
        // path — would be swallowed by the 30s success cooldown.
        const onDisk = await readGithubTokenIfUsable()
        const hasNewerCredential = Boolean(
          onDisk && onDisk !== state.githubToken,
        )

        if (!hasNewerCredential) {
          if (now - lastRefreshSuccess < REFRESH_SUCCESS_COOLDOWN_MS) {
            consola.debug(
              `refreshCopilotToken(${reason}) skipped: prior success within ${REFRESH_SUCCESS_COOLDOWN_MS}ms`,
            )
            return "skipped"
          }
          if (now - lastRefreshFailure < REFRESH_FAILURE_COOLDOWN_MS) {
            consola.debug(
              `refreshCopilotToken(${reason}) skipped: prior failure within ${REFRESH_FAILURE_COOLDOWN_MS}ms`,
            )
            return "skipped"
          }
        }
      }

      consola.debug(`Refreshing Copilot token (reason=${reason})`)
      try {
        const { token, refresh_in } = await exchangeWithFreshestCredential()
        commitCopilotToken(token, refresh_in)
        lastRefreshSuccess = Date.now()
        consola.debug(
          `Copilot token refreshed (credential ${credentialFingerprint(state.githubToken)}, generation ${state.copilotTokenGeneration})`,
        )
        if (state.showToken) {
          consola.info("Refreshed Copilot token:", token)
        }
        return "refreshed"
      } catch (error) {
        lastRefreshFailure = Date.now()
        // Log the STATUS and body, not just the message. Their absence is why
        // the 2026-08-08 incident could not be attributed after the fact.
        consola.error(
          `Failed to refresh Copilot token (reason=${reason}):`,
          error instanceof Error ? error.message : error,
        )
        if (error instanceof CopilotTokenExchangeError) {
          if (error.kind === "credential_rejected") {
            noteAuthActionRequired("credential_rejected", error.credential)
            return "credential_rejected"
          }
          if (error.kind === "entitlement_lapsed") {
            noteAuthActionRequired("entitlement_lapsed", error.credential)
            return "entitlement_lapsed"
          }
        }
        return "transient_failure"
      }
    } finally {
      // Only release the lock if it is still OURS. An unconditional clear
      // would let a finished attempt release a lock a newer attempt holds,
      // re-opening the overlapping-exchange window this mutex exists to
      // close. Identity-checking makes that safe no matter how the code
      // around it is later rearranged. `attempt` is assigned before any
      // await inside `run()` can settle, so it is always bound here.
      if (inflightRefresh === attempt) inflightRefresh = undefined
    }
  }

  const attempt = run()
  inflightRefresh = attempt
  return attempt
}

/**
 * Refresh the Copilot token if its derived deadline has passed.
 *
 * Called on EVERY request. The common path is one `Date.now()` and one
 * integer compare — no I/O — against an upstream call that costs hundreds of
 * milliseconds, so the overhead is not measurable. Sampling (every Nth
 * request) was considered and rejected: a session that idles and then resumes
 * may issue only a handful of requests, so a sampled guard would fail to fire
 * in precisely the scenario it exists for. Actual refreshes do not get more
 * frequent, because `refreshCopilotToken` is single-flighted and the deadline
 * moves forward on success.
 */
export async function ensureFreshCopilotToken(): Promise<void> {
  const deadline = state.copilotTokenRefreshAt
  if (deadline === undefined || Date.now() < deadline) return
  await refreshCopilotToken("expiry")
}

/**
 * Try `request()`. If it returns a 401, refresh the Copilot token (subject
 * to the single-flight + refresh-storm-protection of `refreshCopilotToken`)
 * and retry once — but ONLY if the token actually moved on.
 *
 * The retry criterion is the generation counter, not the refresh's verdict
 * and not a token-string comparison. Both alternatives are wrong:
 *
 *   - By verdict: requests A and B both hold token T0 and both 401. A
 *     refreshes to T1. B's refresh call lands inside the 30s success cooldown
 *     and reports "skipped", so a verdict-based rule would give up and fail B
 *     with a 503 — even though T1 is sitting in state and would have worked.
 *   - By string: upstream demonstrably returns a byte-identical token from
 *     two consecutive successful exchanges, so an unchanged string does not
 *     mean an unchanged credential state.
 *
 * Comparing generations answers the question the request actually has: is
 * what is in state now different from what I already tried? When it is not,
 * we skip a re-send that is guaranteed to 401 again.
 *
 * The `request` callback is responsible for capturing `state.copilotToken`
 * locally before any await; this helper does NOT re-build the request
 * itself, just re-invokes the callback after a refresh.
 */
export async function tryRefreshAndRetry(
  request: () => Promise<Response>,
  routePath: string,
): Promise<Response> {
  await ensureFreshCopilotToken()

  const generationBefore = state.copilotTokenGeneration
  const first = await request()
  if (first.status !== 401) return first

  consola.warn(
    `${routePath}: upstream returned 401, attempting one token refresh + retry`,
  )
  await refreshCopilotToken("401-retry")

  if (state.copilotTokenGeneration === generationBefore) {
    // Nothing new to try. Re-sending the same credential would buy a second
    // guaranteed 401 — which is what every request during the 2026-08-08
    // outage paid, for an hour.
    consola.debug(
      `${routePath}: no newer Copilot token available (generation ${generationBefore}); not retrying`,
    )
    return first
  }

  // Re-invoke the request with the new token in state.
  return request()
}

interface SetupGitHubTokenOptions {
  force?: boolean
}

export async function setupGitHubToken(
  options?: SetupGitHubTokenOptions,
): Promise<void> {
  try {
    // Retrying: a startup read can race an `auth` rewrite in another
    // terminal, and on Windows that surfaces as a transient EPERM/EBUSY/
    // ENOENT. Failing launch over a window that closes in milliseconds
    // would be a self-inflicted outage.
    const githubToken = await readGithubTokenWithRetry()

    if (githubToken && !options?.force) {
      state.githubToken = githubToken
      state.githubTokenSource = "file"
      if (state.showToken) {
        consola.info("GitHub token:", githubToken)
      }
      // A 401 HERE is the single most common way a revoked credential is
      // discovered: the user's session died, they restarted, and this is the
      // first call that touches GitHub. It runs BEFORE `setupCopilotToken`, so
      // without this the launch aborted on a raw HTTP 401 stack trace and the
      // remedy was never named — which is exactly how a revocation gets
      // misdiagnosed as "restarting didn't help".
      //
      // Only a 401 accuses the credential. A 403 (rate limit), a 5xx, or a
      // network fault must not send someone to re-authenticate a credential
      // that is fine.
      try {
        await logUser()
      } catch (error) {
        if (error instanceof HTTPError && error.response.status === 401) {
          noteAuthActionRequired(
            "credential_rejected",
            credentialFingerprint(githubToken),
          )
        }
        throw error
      }

      return
    }

    consola.info(
      options?.force
        ? "Re-authenticating, getting new access token"
        : "Not logged in, getting new access token",
    )
    const response = await getDeviceCode()
    consola.debug("Device code response:", response)

    consola.info(
      `Please enter the code "${response.user_code}" in ${response.verification_uri}`,
    )

    const token = await pollAccessToken(response)
    await writeGithubToken(token)
    state.githubToken = token
    state.githubTokenSource = "file"

    if (state.showToken) {
      consola.info("GitHub token:", token)
    }
    await logUser()
  } catch (error) {
    if (error instanceof HTTPError) {
      consola.error("Failed to get GitHub token:", await error.response.json())
      throw error
    }

    consola.error("Failed to get GitHub token:", error)
    throw error
  }
}

async function logUser() {
  const user = await getGitHubUser()
  consola.info(`Logged in as ${user.login}`)
}

/**
 * Set up the SECOND, write-capable GitHub token used by the first-mate
 * agent-orchestration surface (`--agents`). Mirrors `setupGitHubToken`
 * but authenticates against the GitHub CLI's OAuth client
 * (`GITHUB_AGENT_CLIENT_ID`) requesting `repo workflow read:org`, and
 * stores the result apart at `PATHS.GITHUB_AGENT_TOKEN_PATH`. The Copilot
 * App token (`state.githubToken`) is left completely untouched — this is
 * a distinct identity for a distinct capability.
 *
 * Long-lived (device-flow user token) → no refresh loop; a later 401 is
 * surfaced to the caller as a revoked grant to re-run the login. Called
 * once from `setupAndServe` when `state.agentsEnabled` is true.
 */
export async function setupGitHubAgentToken(
  options?: SetupGitHubTokenOptions,
): Promise<void> {
  try {
    const existing = (await readGithubAgentToken().catch(() => "")).trim()

    if (existing && !options?.force) {
      state.githubAgentToken = existing
      if (state.showToken) {
        consola.info("GitHub agent token:", existing)
      }
      await warnIfAgentScopesInsufficient()
      return
    }

    consola.info(
      "Agent mode (--agents): a second GitHub login is required for a write-capable token (repo, workflow, read:org).",
    )
    const response = await getDeviceCode({
      clientId: GITHUB_AGENT_CLIENT_ID,
      scope: GITHUB_AGENT_SCOPES,
    })
    consola.debug("Agent device code response:", response)

    consola.info(
      `Please enter the code "${response.user_code}" in ${response.verification_uri} to authorize github-router's cloud-agent orchestration to act on your repositories.`,
    )

    const token = await pollAccessToken(response, GITHUB_AGENT_CLIENT_ID)
    await writeGithubAgentToken(token)
    state.githubAgentToken = token

    if (state.showToken) {
      consola.info("GitHub agent token:", token)
    }
    await warnIfAgentScopesInsufficient()
  } catch (error) {
    if (error instanceof HTTPError) {
      consola.error(
        "Failed to get GitHub agent token:",
        await error.response.json(),
      )
      throw error
    }

    consola.error("Failed to get GitHub agent token:", error)
    throw error
  }
}

/**
 * Best-effort check that the agent token actually carries the scopes we
 * asked for. The GitHub CLI OAuth client is a classic OAuth App, so the
 * granted scopes are echoed in the `x-oauth-scopes` response header on
 * any authenticated call. Warn loudly (not fatal) if `repo`/`workflow`
 * are missing so the failure is diagnosable at login rather than at the
 * first write 403.
 */
async function warnIfAgentScopesInsufficient(): Promise<void> {
  try {
    const res = await fetch(`${GITHUB_API_BASE_URL}/user`, {
      headers: githubAgentHeaders(state),
    })
    if (res.status === 401) {
      consola.warn(
        "GitHub agent token was rejected (401) — the grant may have been revoked. Re-run with --agents to log in again.",
      )
      return
    }
    const scopes = (res.headers.get("x-oauth-scopes") ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
    const missing = ["repo", "workflow"].filter((s) => !scopes.includes(s))
    if (missing.length > 0) {
      consola.warn(
        `GitHub agent token is missing scope(s): ${missing.join(", ")}. `
          + "The first-mate surface needs 'repo' + 'workflow' to create issues, "
          + "assign cloud agents, and dispatch workflows. Re-run the agent login "
          + "and grant the requested scopes.",
      )
    }
  } catch (err) {
    consola.debug("Agent token scope check skipped:", err)
  }
}
