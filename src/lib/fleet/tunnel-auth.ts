import { realpathSync } from "node:fs"
import path from "node:path"

import { resolveExecutable, runManagedExeCapture } from "../exec"

// ---------------------------------------------------------------------------
// Dev Tunnel `connect`-scope access-token provider.
//
// A PRIVATE VS Code Dev Tunnel redirects unauthenticated requests to GitHub
// auth (a 302 the FleetClient refuses). The programmatic bypass is the header
// `X-Tunnel-Authorization: tunnel <token>`, where <token> is a `connect`-scope
// access token minted by the `devtunnel` CLI. Those tokens are 24h, fixed, and
// NOT refreshable, so we mint lazily and re-mint before expiry.
//
// This module is the auth provider only — header attachment + origin scoping
// live in `client.ts`. The `devtunnel` invocation is behind an injected runner
// so tests never spawn a real process.
// ---------------------------------------------------------------------------

export type TunnelAuthErrorCode =
  | "NOT_INSTALLED"
  | "NOT_LOGGED_IN"
  | "TUNNEL_NOT_FOUND"
  | "MINT_FAILED"
  | "TIMEOUT"
  | "PARSE"

export class TunnelAuthError extends Error {
  code: TunnelAuthErrorCode

  constructor(code: TunnelAuthErrorCode, message: string) {
    super(message)
    this.name = "TunnelAuthError"
    this.code = code
  }
}

export interface TunnelTokenConfig {
  /** The devtunnel tunnel id — a `name` or `name.cluster` from `devtunnel list`. */
  tunnelId: string
}

export interface DevtunnelRunResult {
  stdout: string
  stderr: string
  code: number | null
  timedOut: boolean
}

/** Injected so tests never spawn a real `devtunnel`. */
export type DevtunnelRunner = (args: ReadonlyArray<string>) => Promise<DevtunnelRunResult>

export interface TunnelTokenProvider {
  getToken(cfg: TunnelTokenConfig): Promise<string>
  invalidate(cfg: TunnelTokenConfig): void
}

const REFRESH_MARGIN_MS = 5 * 60_000
const MIN_REMINT_INTERVAL_MS = 30_000
const DEVTUNNEL_TIMEOUT_MS = 10_000
const MINT_FAILURE_BACKOFF_MS = 30_000
const MAX_PLAUSIBLE_TTL_MS = 48 * 60 * 60_000
const MAX_STDOUT_BYTES = 256 * 1024

// Same charset the registry enforces — re-checked here because the provider is
// exported and could be called directly; a leading `-` would be parsed as a flag
// by the `devtunnel` CLI (the runner uses shell:false, so this is arg-confusion,
// not shell injection, but we refuse it anyway).
const TUNNEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

// "eyJ" is the base64url of '{"' — every JWT header begins with it. Used ONLY to
// redact credential-shaped substrings before logging/surfacing; never to trust.
const JWT_REDACT_RE = /eyJ[A-Za-z0-9._-]{20,}/g
// A `Bearer`/`tunnel` scheme followed by a printable, non-space token. Case
// insensitive, and the token class `[!-~]+` admits any opaque (non-JWT) bearer.
const SCHEME_TOKEN_RE = /(bearer|tunnel) +[!-~]+/gi

/** Strip credential-shaped substrings from any string before it is logged or surfaced. */
export function redactTunnelSecrets(s: string): string {
  return s.replace(JWT_REDACT_RE, "<redacted-token>").replace(SCHEME_TOKEN_RE, "$1 <redacted-token>")
}

function safeRealpath(p: string): string {
  try {
    return realpathSync(p)
  } catch {
    return path.resolve(p)
  }
}

/**
 * Guard the resolved `devtunnel` path: it must be a trusted ABSOLUTE path that
 * is not the current working directory's own binary. `resolveExecutable` already
 * excludes cwd; this is defense-in-depth against a cwd-local / relative
 * resolution ever reaching a child-process spawn. Both paths are canonicalized
 * (realpath, resolving `..` and symlinks) before the cwd-containment check, so a
 * non-canonical path like `/safe/../cwd/devtunnel` or a symlink cannot evade it.
 * Returns the (original) path to spawn, or throws.
 */
export function assertTrustedDevtunnelPath(
  resolved: string | null,
  cwd: string | null = typeof process.cwd === "function" ? path.resolve(process.cwd()) : null,
): string {
  if (!resolved) {
    throw new TunnelAuthError(
      "NOT_INSTALLED",
      "the devtunnel CLI was not found on PATH; install it and run `devtunnel user login` on this (control-plane) machine",
    )
  }
  if (!path.isAbsolute(resolved)) {
    throw new TunnelAuthError("NOT_INSTALLED", "refusing to run a non-absolute devtunnel binary")
  }
  // devtunnel ships as a NATIVE binary (`devtunnel` / `devtunnel.exe`), and we
  // spawn it with shell:false. A `.cmd`/`.bat`/`.ps1` shim cannot be launched
  // that way (and would reintroduce a cmd.exe quoting surface), so reject it with
  // an actionable message rather than failing later with an opaque spawn error.
  const ext = path.extname(resolved).toLowerCase()
  if (ext === ".cmd" || ext === ".bat" || ext === ".ps1") {
    throw new TunnelAuthError(
      "NOT_INSTALLED",
      "resolved devtunnel is a script shim (.cmd/.bat/.ps1); github-router runs the native devtunnel(.exe) — ensure the native binary precedes any shim on PATH",
    )
  }
  const realResolved = safeRealpath(resolved)
  const realCwd = cwd ? safeRealpath(cwd) : null
  if (realCwd && (realResolved === realCwd || realResolved.startsWith(realCwd + path.sep))) {
    throw new TunnelAuthError("NOT_INSTALLED", "refusing to run a cwd-local devtunnel binary")
  }
  return resolved
}

/**
 * The real runner: resolve `devtunnel` to a trusted absolute path (PATH-resolved,
 * cwd-excluded) and run it with `shell:false` (native binary).
 */
export function realDevtunnelRunner(): DevtunnelRunner {
  return async (args) => {
    const resolved = assertTrustedDevtunnelPath(resolveExecutable("devtunnel"))
    const res = await runManagedExeCapture(resolved, args, {
      timeoutMs: DEVTUNNEL_TIMEOUT_MS,
      maxStdoutBytes: MAX_STDOUT_BYTES,
    })
    return { stdout: res.stdout, stderr: res.stderr, code: res.code, timedOut: res.timedOut }
  }
}

function looksLikeJwt(s: string): boolean {
  const parts = s.split(".")
  if (parts.length !== 3) return false
  return parts.every((p) => p.length > 0 && /^[A-Za-z0-9_-]+$/.test(p))
}

/** Recursively collect JWT-shaped strings from arbitrary parsed JSON. */
function collectJwts(value: unknown, out: Set<string>): void {
  if (typeof value === "string") {
    // Require the "eyJ" header prefix as well as the dotted shape, so an
    // incidental dotted string in the JSON (a semver, an ip) is never mistaken
    // for a token and never inflates the ambiguity count below.
    if (value.startsWith("eyJ") && looksLikeJwt(value)) out.add(value)
    return
  }
  if (Array.isArray(value)) {
    for (const v of value) collectJwts(v, out)
    return
  }
  if (value && typeof value === "object") {
    for (const v of Object.values(value as Record<string, unknown>)) collectJwts(v, out)
  }
}

/**
 * Extract the single access token from `devtunnel token --json` output. Prefers
 * structured JSON; falls back to a token-shaped scan. Refuses to guess when zero
 * or more-than-one distinct tokens are present (so we never send a wrong JWT).
 */
function extractToken(stdout: string): string {
  const found = new Set<string>()
  try {
    collectJwts(JSON.parse(stdout) as unknown, found)
  } catch {
    // not JSON — fall through to a token-shaped scan
  }
  if (found.size === 0) {
    for (const tok of stdout.split(/[^A-Za-z0-9._-]+/)) {
      if (tok.startsWith("eyJ") && looksLikeJwt(tok)) found.add(tok)
    }
  }
  if (found.size === 0) {
    throw new TunnelAuthError("PARSE", "no tunnel access token found in devtunnel output")
  }
  if (found.size > 1) {
    throw new TunnelAuthError("PARSE", "devtunnel output contained more than one token; refusing to guess")
  }
  return [...found][0]!
}

/** Parse a JWT `exp` claim (seconds) into epoch milliseconds. Throws on a missing/non-numeric exp. */
export function parseJwtExpMs(jwt: string): number {
  const parts = jwt.split(".")
  if (parts.length !== 3) throw new TunnelAuthError("PARSE", "tunnel token is not a JWT")
  let payload: unknown
  try {
    payload = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8"))
  } catch {
    throw new TunnelAuthError("PARSE", "tunnel token payload was not decodable")
  }
  const exp = (payload as { exp?: unknown } | null)?.exp
  if (typeof exp !== "number" || !Number.isFinite(exp)) {
    throw new TunnelAuthError("PARSE", "tunnel token has no numeric exp claim")
  }
  return exp * 1000
}

function classifyMintFailure(res: DevtunnelRunResult): TunnelAuthError {
  if (res.timedOut) return new TunnelAuthError("TIMEOUT", "devtunnel token request timed out")
  const stderr = (res.stderr || "").toLowerCase()
  const tail = redactTunnelSecrets((res.stderr || "").trim()).slice(-300)
  const suffix = tail ? ` [${tail}]` : ""
  if (/log ?in|sign ?in|not authenticated|unauthor|401/.test(stderr)) {
    return new TunnelAuthError(
      "NOT_LOGGED_IN",
      `devtunnel is not logged in (or lacks access to this tunnel) on the control-plane machine; run \`devtunnel user login\`${suffix}`,
    )
  }
  if (/not found|404|does not exist|no such tunnel/.test(stderr)) {
    return new TunnelAuthError(
      "TUNNEL_NOT_FOUND",
      `devtunnel could not find the tunnel; verify tunnelId with \`devtunnel list\`${suffix}`,
    )
  }
  return new TunnelAuthError("MINT_FAILED", `devtunnel token failed (exit ${res.code})${suffix}`)
}

/**
 * Create a per-process token provider: lazy mint, per-tunnel in-memory cache,
 * single-flight, and short negative backoff on non-timeout failures.
 */
export function createTunnelTokenProvider(runner: DevtunnelRunner = realDevtunnelRunner()): TunnelTokenProvider {
  const cache = new Map<string, { token: string; expMs: number; mintedAt: number }>()
  const inflight = new Map<string, Promise<string>>()
  const backoff = new Map<string, { until: number; err: TunnelAuthError }>()

  async function mint(cfg: TunnelTokenConfig): Promise<string> {
    if (!TUNNEL_ID_RE.test(cfg.tunnelId)) {
      throw new TunnelAuthError("MINT_FAILED", "invalid tunnelId; must match a devtunnel tunnel name")
    }
    const args = ["token", cfg.tunnelId, "--scopes", "connect", "--json"]
    let res: DevtunnelRunResult
    try {
      res = await runner(args)
    } catch (err) {
      if (err instanceof TunnelAuthError) throw err
      throw new TunnelAuthError("MINT_FAILED", redactTunnelSecrets(err instanceof Error ? err.message : String(err)))
    }
    if (res.timedOut) throw new TunnelAuthError("TIMEOUT", "devtunnel token request timed out")
    if (res.code !== 0) throw classifyMintFailure(res)

    const token = extractToken(res.stdout)
    const expMs = parseJwtExpMs(token)
    const now = Date.now()
    if (expMs <= now) throw new TunnelAuthError("PARSE", "devtunnel minted an already-expired token")
    if (expMs - now > MAX_PLAUSIBLE_TTL_MS) {
      throw new TunnelAuthError("PARSE", "devtunnel token TTL is implausibly long; refusing")
    }
    // Cache-write only if strictly newer — guards a late/reordered mint from
    // clobbering a fresher token. `mintedAt` rate-limits re-minting (below).
    const existing = cache.get(cfg.tunnelId)
    if (!existing || expMs > existing.expMs) cache.set(cfg.tunnelId, { token, expMs, mintedAt: now })
    return cache.get(cfg.tunnelId)!.token
  }

  function mintOnce(cfg: TunnelTokenConfig): Promise<string> {
    const key = cfg.tunnelId
    return (async () => {
      try {
        const token = await mint(cfg)
        backoff.delete(key)
        return token
      } catch (err) {
        const e = err instanceof TunnelAuthError
          ? err
          : new TunnelAuthError("MINT_FAILED", redactTunnelSecrets(String(err)))
        if (e.code !== "TIMEOUT") backoff.set(key, { until: Date.now() + MINT_FAILURE_BACKOFF_MS, err: e })
        // If a still-valid token is cached (a proactive re-mint within the
        // margin failed), ride it out rather than break a working tunnel.
        const c = cache.get(key)
        if (c && c.expMs > Date.now()) return c.token
        throw e
      } finally {
        inflight.delete(key)
      }
    })()
  }

  return {
    async getToken(cfg) {
      const key = cfg.tunnelId
      const now = Date.now()
      const cached = cache.get(key)
      // Serve the cached token when it is comfortably fresh, OR when it is still
      // valid and was minted very recently — the latter bounds CLI spawns to at
      // most once per MIN_REMINT_INTERVAL_MS per tunnel even if devtunnel hands
      // back a token whose TTL is shorter than the refresh margin (no per-request
      // mint storm).
      if (cached && cached.expMs > now) {
        const comfortablyFresh = cached.expMs - now > REFRESH_MARGIN_MS
        const recentlyMinted = now - cached.mintedAt < MIN_REMINT_INTERVAL_MS
        if (comfortablyFresh || recentlyMinted) return cached.token
      }

      const inf = inflight.get(key)
      if (inf) return inf

      const bo = backoff.get(key)
      if (bo && now < bo.until) {
        if (cached && cached.expMs > now) return cached.token
        throw bo.err
      }

      const p = mintOnce(cfg)
      inflight.set(key, p)
      return p
    },
    invalidate(cfg) {
      cache.delete(cfg.tunnelId)
      backoff.delete(cfg.tunnelId)
    },
  }
}
