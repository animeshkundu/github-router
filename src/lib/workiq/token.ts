/**
 * Work IQ authentication: one browser sign-in, then a durable rotating refresh
 * token shared by every `github-router` process on the machine.
 *
 * The flow is a loopback authorization-code request with PKCE against
 * `login.microsoftonline.com/<tenant>`, using the public native client the Work
 * IQ plugin ships. It was verified end to end against the live service before
 * this module existed: the authorize URL returns a code for an account with a
 * live Entra session without further interaction, the code exchange returns an
 * access token with `scp=WorkIQ.Act WorkIQ.Read WorkIQAgent.Ask`, the refresh
 * grant rotates the refresh token, and the refreshed access token is accepted
 * by the MCP endpoint.
 *
 * Three properties are load-bearing:
 *
 *   1. The refresh deadline is derived from `expires_in` (a DURATION) anchored
 *      to this process's clock, never from an absolute timestamp, so a clock
 *      running ahead of Entra's cannot mark a fresh token expired and drive a
 *      refresh storm. Same rule as the Copilot token in `~/lib/token`.
 *   2. The refresh is single-flight. Several `tools/call`s can arrive at once
 *      and a refresh ROTATES the refresh token, so two concurrent grants would
 *      make one of them present an already-consumed token.
 *   3. On `invalid_grant` the token file is re-read from disk and the grant is
 *      retried once with whatever refresh token is newest. That is what lets
 *      two proxy processes share one login file across a rotation, mirroring
 *      the disk-re-read rule the GitHub credential already follows.
 *
 * Tokens are never logged. Successful exchanges log a SHA-256 fingerprint
 * prefix, which distinguishes "this process holds a stale token" from "the
 * token on disk is dead" without putting the credential in a log line.
 */

import { spawn } from "node:child_process"
import { createHash, randomBytes } from "node:crypto"
import fs from "node:fs/promises"
import http from "node:http"
import path from "node:path"
import process from "node:process"

import consola from "consola"

import { credentialFingerprint } from "~/services/github/get-copilot-token"

import { PATHS } from "../paths"
import { writeTokenFileAtomic } from "../token"
import {
  WORKIQ_DEFAULT_TENANT,
  WORKIQ_PUBLIC_CLIENT_ID,
  WORKIQ_SCOPE,
  WORKIQ_TENANT_ENV,
  WORKIQ_TOKEN_ENV,
  WORKIQ_TOKEN_PATH_ENV,
} from "./constants"

/** Refresh this long before the access token actually expires. */
export const WORKIQ_REFRESH_SKEW_MS = 5 * 60 * 1000

/** `expires_in` fallback when Entra omits it (it normally does not). */
const DEFAULT_EXPIRES_IN_S = 3600

/** How long `workiq auth` waits for the browser before giving up. */
const DEFAULT_AUTH_TIMEOUT_MS = 5 * 60 * 1000

const LOGIN_BASE = "https://login.microsoftonline.com"

/** The durable token file. Shape is versioned so a future change can migrate. */
export interface WorkiqTokenFile {
  version: 1
  clientId: string
  tenant: string
  scope: string
  accessToken: string
  refreshToken: string
  /** Wall-clock ms derived from `expires_in`, anchored to THIS clock. */
  expiresAtMs: number
  /**
   * Display-only account name from the id token (`preferred_username`). Never
   * used for an authorization decision.
   */
  account?: string
}

/**
 * A failed sign-in or refresh.
 *
 * `remedy` is the actionable one-liner the CLI and the launch provisioning
 * path print. It always names the command that fixes the state, because every
 * terminal error here has exactly one fix.
 */
export class WorkiqAuthError extends Error {
  readonly remedy: string
  /** Entra's error code (`invalid_grant`, `interaction_required`, …). */
  readonly errorCode?: string

  constructor(message: string, opts: { errorCode?: string; remedy?: string } = {}) {
    super(message)
    this.name = "WorkiqAuthError"
    this.errorCode = opts.errorCode
    this.remedy = opts.remedy ?? AUTH_REMEDY
  }
}

export const AUTH_REMEDY = "Run `github-router workiq auth`."

/** Resolved tenant segment: `GH_ROUTER_WORKIQ_TENANT` over the default. */
export function workiqTenant(): string {
  const env = process.env[WORKIQ_TENANT_ENV]?.trim()
  return env || WORKIQ_DEFAULT_TENANT
}

/** Resolved token file path: `GH_ROUTER_WORKIQ_TOKEN_PATH` over APP_DIR. */
export function workiqTokenPath(): string {
  const env = process.env[WORKIQ_TOKEN_PATH_ENV]?.trim()
  return env || path.join(PATHS.APP_DIR, "workiq-token.json")
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value)
}

/**
 * Parse the token file leniently about extra fields and strictly about the
 * ones the refresh grant needs. A file that fails this is treated as absent,
 * which routes the caller to the `workiq auth` remedy rather than to a
 * confusing `invalid_request` from Entra.
 */
function parseTokenFile(raw: string): WorkiqTokenFile | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!isRecord(parsed)) return null
  if (typeof parsed.accessToken !== "string" || !parsed.accessToken) return null
  if (typeof parsed.refreshToken !== "string" || !parsed.refreshToken) return null
  if (!isFiniteNumber(parsed.expiresAtMs)) return null
  return {
    version: 1,
    clientId: typeof parsed.clientId === "string" ? parsed.clientId : WORKIQ_PUBLIC_CLIENT_ID,
    tenant: typeof parsed.tenant === "string" ? parsed.tenant : workiqTenant(),
    scope: typeof parsed.scope === "string" ? parsed.scope : WORKIQ_SCOPE,
    accessToken: parsed.accessToken,
    refreshToken: parsed.refreshToken,
    expiresAtMs: parsed.expiresAtMs,
    ...(typeof parsed.account === "string" ? { account: parsed.account } : {}),
  }
}

/** Read the token file, or null when it is absent or unreadable. */
export async function readWorkiqTokenFile(
  filePath: string = workiqTokenPath(),
): Promise<WorkiqTokenFile | null> {
  let raw: string
  try {
    raw = await fs.readFile(filePath, "utf8")
  } catch {
    return null
  }
  return parseTokenFile(raw)
}

/** Persist the token file atomically (0600, temp + rename). */
export async function writeWorkiqTokenFile(
  file: WorkiqTokenFile,
  filePath: string = workiqTokenPath(),
): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true }).catch(() => {})
  await writeTokenFileAtomic(filePath, `${JSON.stringify(file, null, 2)}\n`)
}

/** Delete the durable login. `workiq logout`. */
export async function deleteWorkiqTokenFile(
  filePath: string = workiqTokenPath(),
): Promise<boolean> {
  try {
    await fs.unlink(filePath)
    return true
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false
    throw err
  }
}

// ---------------------------------------------------------------------------
// PKCE and authorize URL
// ---------------------------------------------------------------------------

/** A fresh PKCE S256 verifier/challenge pair. */
export function createWorkiqPkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url")
  const challenge = createHash("sha256").update(verifier).digest("base64url")
  return { verifier, challenge }
}

export interface AuthorizeUrlOptions {
  tenant: string
  redirectUri: string
  codeChallenge: string
  state: string
  clientId?: string
  loginHint?: string
}

/** The authorize URL. Pure, so the shape is pinned by a unit test. */
export function buildWorkiqAuthorizeUrl(opts: AuthorizeUrlOptions): string {
  const url = new URL(`${LOGIN_BASE}/${encodeURIComponent(opts.tenant)}/oauth2/v2.0/authorize`)
  url.searchParams.set("client_id", opts.clientId ?? WORKIQ_PUBLIC_CLIENT_ID)
  url.searchParams.set("response_type", "code")
  url.searchParams.set("response_mode", "query")
  url.searchParams.set("redirect_uri", opts.redirectUri)
  url.searchParams.set("scope", WORKIQ_SCOPE)
  url.searchParams.set("code_challenge", opts.codeChallenge)
  url.searchParams.set("code_challenge_method", "S256")
  url.searchParams.set("state", opts.state)
  if (opts.loginHint) url.searchParams.set("login_hint", opts.loginHint)
  return url.toString()
}

/** Decode a JWT payload without verifying it. Display-only. */
function decodeIdTokenPayload(idToken: string | undefined): Record<string, unknown> | null {
  if (!idToken) return null
  const parts = idToken.split(".")
  if (parts.length < 2) return null
  try {
    const payload = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8"))
    return isRecord(payload) ? payload : null
  } catch {
    return null
  }
}

function accountFromIdToken(idToken: string | undefined): string | undefined {
  const payload = decodeIdTokenPayload(idToken)
  if (!payload) return undefined
  for (const key of ["preferred_username", "upn", "unique_name", "email", "name"]) {
    const value = payload[key]
    if (typeof value === "string" && value.trim()) return value.trim()
  }
  return undefined
}

// ---------------------------------------------------------------------------
// Token endpoint
// ---------------------------------------------------------------------------

interface TokenEndpointResponse {
  access_token?: unknown
  refresh_token?: unknown
  expires_in?: unknown
  id_token?: unknown
  error?: unknown
  error_description?: unknown
}

function describeEndpointFailure(
  status: number,
  body: TokenEndpointResponse | null,
): WorkiqAuthError {
  const code = typeof body?.error === "string" ? body.error : undefined
  const description =
    typeof body?.error_description === "string" && body.error_description.trim()
      ? body.error_description.trim()
      : undefined
  const head = code ? `Work IQ sign-in failed (${code})` : `Work IQ sign-in failed (HTTP ${status})`
  const message = description ? `${head}: ${description}` : head
  return new WorkiqAuthError(message, { errorCode: code })
}

async function postTokenEndpoint(
  tenant: string,
  form: Record<string, string>,
  signal?: AbortSignal,
): Promise<TokenEndpointResponse> {
  const res = await fetch(`${LOGIN_BASE}/${encodeURIComponent(tenant)}/oauth2/v2.0/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams(form).toString(),
    ...(signal ? { signal } : {}),
  })
  let body: TokenEndpointResponse | null
  try {
    const parsed: unknown = await res.json()
    body = isRecord(parsed) ? (parsed as TokenEndpointResponse) : null
  } catch {
    body = null
  }
  if (!res.ok) throw describeEndpointFailure(res.status, body)
  if (!body) throw new WorkiqAuthError("Work IQ sign-in failed: the token endpoint returned no JSON.")
  return body
}

/**
 * Turn a token endpoint response into the durable file shape.
 *
 * `expires_in` is treated as a DURATION from now; a missing or malformed value
 * falls back to an hour, which only makes the next refresh later than it could
 * have been, never earlier than the token's real expiry in the common case.
 */
function tokenFileFromResponse(
  body: TokenEndpointResponse,
  context: { tenant: string; previous?: WorkiqTokenFile },
): WorkiqTokenFile {
  const accessToken = typeof body.access_token === "string" ? body.access_token : ""
  if (!accessToken) {
    throw new WorkiqAuthError("Work IQ sign-in failed: the token endpoint returned no access token.")
  }
  const refreshToken =
    typeof body.refresh_token === "string" && body.refresh_token
      ? body.refresh_token
      // Entra omits the refresh token when the grant did not request
      // `offline_access`; keeping the previous one is the only sane recovery.
      : (context.previous?.refreshToken ?? "")
  if (!refreshToken) {
    throw new WorkiqAuthError(
      "Work IQ sign-in failed: the token endpoint returned no refresh token, so the login would not survive this process.",
      { remedy: AUTH_REMEDY },
    )
  }
  const expiresInRaw = typeof body.expires_in === "string" ? Number(body.expires_in) : body.expires_in
  const expiresIn = isFiniteNumber(expiresInRaw) && expiresInRaw > 0 ? expiresInRaw : DEFAULT_EXPIRES_IN_S
  const account =
    accountFromIdToken(typeof body.id_token === "string" ? body.id_token : undefined)
    ?? context.previous?.account
  return {
    version: 1,
    clientId: WORKIQ_PUBLIC_CLIENT_ID,
    tenant: context.tenant,
    scope: WORKIQ_SCOPE,
    accessToken,
    refreshToken,
    expiresAtMs: Date.now() + expiresIn * 1000,
    ...(account ? { account } : {}),
  }
}

/**
 * Exchange a refresh token. Rotates and persists the new refresh token before
 * returning, so a crash after a successful grant cannot lose the only valid
 * token (the old one is already consumed upstream).
 */
async function exchangeRefreshToken(
  file: WorkiqTokenFile,
  refreshToken: string,
  signal?: AbortSignal,
): Promise<WorkiqTokenFile> {
  const body = await postTokenEndpoint(
    file.tenant,
    {
      client_id: file.clientId || WORKIQ_PUBLIC_CLIENT_ID,
      grant_type: "refresh_token",
      scope: file.scope || WORKIQ_SCOPE,
      refresh_token: refreshToken,
    },
    signal,
  )
  const next = tokenFileFromResponse(body, { tenant: file.tenant, previous: file })
  await writeWorkiqTokenFile(next)
  cached = next
  consola.debug(
    `Work IQ: refreshed the access token (fingerprint ${credentialFingerprint(next.accessToken)}).`,
  )
  return next
}

/**
 * Refresh an access token through the refresh grant, retrying once on
 * `invalid_grant` after re-reading the file. Exported for the CLI's `status`
 * path and for tests.
 */
export async function refreshWorkiqAccessToken(
  file: WorkiqTokenFile,
  signal?: AbortSignal,
): Promise<WorkiqTokenFile> {
  try {
    return await exchangeRefreshToken(file, file.refreshToken, signal)
  } catch (err) {
    if (!(err instanceof WorkiqAuthError) || err.errorCode !== "invalid_grant") throw err
    const disk = await readWorkiqTokenFile()
    if (disk && disk.refreshToken !== file.refreshToken) {
      consola.info(
        "Work IQ: the token file was rotated by another process; retrying with the newest refresh token.",
      )
      return await exchangeRefreshToken(disk, disk.refreshToken, signal)
    }
    throw err
  }
}

// ---------------------------------------------------------------------------
// Single-flight accessor
// ---------------------------------------------------------------------------

let cached: WorkiqTokenFile | null = null
let inflight: Promise<string> | null = null

/** Test seam: forget the in-memory cache and any in-flight refresh. */
export function resetWorkiqTokenStateForTesting(): void {
  cached = null
  inflight = null
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw signal.reason ?? new Error("aborted")
}

async function refreshPath(opts: { signal?: AbortSignal; forceRefresh?: boolean }): Promise<string> {
  throwIfAborted(opts.signal)
  const file = cached ?? (await readWorkiqTokenFile())
  if (!file) {
    throw new WorkiqAuthError(
      `No Work IQ login found at ${workiqTokenPath()}.`,
      { remedy: AUTH_REMEDY },
    )
  }
  cached = file
  if (!opts.forceRefresh && file.expiresAtMs - WORKIQ_REFRESH_SKEW_MS > Date.now()) {
    return file.accessToken
  }
  const next = await refreshWorkiqAccessToken(file, opts.signal)
  throwIfAborted(opts.signal)
  return next.accessToken
}

/**
 * The bearer the MCP client sends. Reads, in order:
 *
 *   1. `WORKIQ_MCP_TOKEN` (tests / manual runs) — nothing else runs.
 *   2. The in-memory token, if it is still comfortably unexpired.
 *   3. The durable file, refreshing first when it is inside the skew window or
 *      `forceRefresh` is set (the 401 path).
 *
 * Concurrent callers share ONE refresh. The guard and its assignment are
 * deliberately adjacent (no `await` between them): anything awaited in between
 * would yield the event loop and let a second caller past the guard.
 */
export function ensureWorkiqToken(
  opts: { signal?: AbortSignal; forceRefresh?: boolean } = {},
): Promise<string> {
  const env = process.env[WORKIQ_TOKEN_ENV]?.trim()
  if (env) return Promise.resolve(env)
  if (!opts.forceRefresh && cached && cached.expiresAtMs - WORKIQ_REFRESH_SKEW_MS > Date.now()) {
    return Promise.resolve(cached.accessToken)
  }
  if (inflight) return attachSignal(inflight, opts.signal)
  const promise = refreshPath(opts)
  inflight = promise
  void promise.finally(() => {
    if (inflight === promise) inflight = null
  }).catch(() => {})
  return promise
}

/**
 * Wait for a shared refresh but let the CALLER's signal abandon the wait.
 *
 * The shared promise itself must keep running: another caller may still need
 * it, and the refresh rotates the refresh token, so abandoning it midway would
 * waste the one grant. `race` only stops this caller from waiting.
 */
function attachSignal(promise: Promise<string>, signal?: AbortSignal): Promise<string> {
  if (!signal) return promise
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error("aborted"))
  return new Promise<string>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason ?? new Error("aborted"))
    signal.addEventListener("abort", onAbort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort)
        resolve(value)
      },
      (err) => {
        signal.removeEventListener("abort", onAbort)
        reject(err)
      },
    )
  })
}

// ---------------------------------------------------------------------------
// Loopback authorization-code flow
// ---------------------------------------------------------------------------

/**
 * Open the default browser. Best effort by contract: the caller always prints
 * the URL too, so a headless or locked-down machine is a paste, not a failure.
 */
export function openWorkiqBrowser(url: string): void {
  try {
    if (process.platform === "win32") {
      spawn("rundll32.exe", ["url.dll,FileProtocolHandler", url], {
        stdio: "ignore",
        detached: true,
      }).unref()
      return
    }
    const command = process.platform === "darwin" ? "open" : "xdg-open"
    spawn(command, [url], { stdio: "ignore", detached: true }).unref()
  } catch {
    // Ignored on purpose; the URL has already been printed.
  }
}

export interface LoopbackAuthOptions {
  tenant?: string
  loginHint?: string
  timeoutMs?: number
  signal?: AbortSignal
  /** Test seam: receives the authorize URL instead of/in addition to opening it. */
  onAuthorizeUrl?: (url: string) => void
  /** Test seam: replace the browser launch entirely. */
  openBrowser?: (url: string) => void
}

/** The page shown after the browser round-trips. Plain, self-contained HTML. */
function resultPage(title: string, detail: string): string {
  const escape = (value: string): string =>
    value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escape(title)}</title>`
    + `<style>body{font:16px/1.5 system-ui,sans-serif;margin:4rem auto;max-width:32rem;padding:0 1.5rem}</style>`
    + `</head><body><h1>${escape(title)}</h1><p>${escape(detail)}</p></body></html>`
}

/**
 * Run the interactive sign-in and persist the result.
 *
 * The listener binds with `listen(0)` and no host, which is dual-stack: a
 * browser that resolves `localhost` to `::1` must reach it, and binding
 * `127.0.0.1` would silently leave that connection refused. Entra accepts any
 * port on a `http://localhost` loopback redirect.
 */
export async function runLoopbackAuth(
  opts: LoopbackAuthOptions = {},
): Promise<WorkiqTokenFile> {
  const tenant = opts.tenant ?? workiqTenant()
  const timeoutMs = opts.timeoutMs ?? DEFAULT_AUTH_TIMEOUT_MS
  const { verifier, challenge } = createWorkiqPkce()
  const expectedState = randomBytes(24).toString("base64url")

  let settle: { resolve: (code: string) => void; reject: (err: unknown) => void } | null = null
  const codePromise = new Promise<string>((resolve, reject) => {
    settle = { resolve, reject }
  })

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost")
    const params = url.searchParams
    const respond = (status: number, title: string, detail: string): void => {
      res.statusCode = status
      res.setHeader("Content-Type", "text/html; charset=utf-8")
      res.end(resultPage(title, detail))
    }

    // A mismatched state is not the flow's answer and never settles it: it is
    // some other request hitting the ephemeral port. Answer 400 and keep
    // waiting for the real redirect.
    if (params.get("state") !== expectedState) {
      respond(400, "Unexpected sign-in response", "The state value did not match this sign-in attempt.")
      return
    }
    const error = params.get("error")
    if (error) {
      const description = params.get("error_description") ?? ""
      respond(400, "Work IQ sign-in failed", description || error)
      settle?.reject(
        new WorkiqAuthError(
          description ? `Work IQ sign-in failed (${error}): ${description}` : `Work IQ sign-in failed (${error}).`,
          { errorCode: error },
        ),
      )
      settle = null
      return
    }
    const code = params.get("code")
    if (!code) {
      respond(400, "Work IQ sign-in failed", "The redirect carried no authorization code.")
      return
    }
    respond(200, "Work IQ sign-in complete", "You can close this window and return to the terminal.")
    settle?.resolve(code)
    settle = null
  })

  const port = await new Promise<number>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, () => {
      const address = server.address()
      if (address && typeof address === "object") resolve(address.port)
      else reject(new WorkiqAuthError("Could not determine the sign-in listener port."))
    })
  })
  const redirectUri = `http://localhost:${port}/`

  const authorizeUrl = buildWorkiqAuthorizeUrl({
    tenant,
    redirectUri,
    codeChallenge: challenge,
    state: expectedState,
    ...(opts.loginHint ? { loginHint: opts.loginHint } : {}),
  })

  consola.info("Opening the browser to sign in to Work IQ. If it does not open, visit:")
  consola.info(authorizeUrl)
  opts.onAuthorizeUrl?.(authorizeUrl)
  ;(opts.openBrowser ?? openWorkiqBrowser)(authorizeUrl)

  const timeout = setTimeout(() => {
    settle?.reject(
      new WorkiqAuthError(
        `Work IQ sign-in did not complete within ${Math.round(timeoutMs / 60_000)} minutes.`,
      ),
    )
    settle = null
  }, timeoutMs)
  timeout.unref?.()

  const onAbort = (): void => {
    settle?.reject(opts.signal?.reason ?? new Error("aborted"))
    settle = null
  }
  opts.signal?.addEventListener("abort", onAbort, { once: true })

  let code: string
  try {
    code = await codePromise
  } finally {
    clearTimeout(timeout)
    opts.signal?.removeEventListener("abort", onAbort)
    server.close()
    // `close` waits for keep-alive sockets; the browser may hold one open.
    server.closeAllConnections?.()
  }

  const body = await postTokenEndpoint(
    tenant,
    {
      client_id: WORKIQ_PUBLIC_CLIENT_ID,
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      code_verifier: verifier,
      scope: WORKIQ_SCOPE,
    },
    opts.signal,
  )
  const file = tokenFileFromResponse(body, { tenant })
  await writeWorkiqTokenFile(file)
  cached = file
  consola.success(
    `Work IQ: signed in${file.account ? ` as ${file.account}` : ""} `
      + `(token fingerprint ${credentialFingerprint(file.accessToken)}).`,
  )
  return file
}
