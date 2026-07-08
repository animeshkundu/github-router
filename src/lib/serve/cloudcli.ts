import { spawn, type ChildProcess } from "node:child_process"
import { randomBytes } from "node:crypto"
import fs from "node:fs/promises"
import http from "node:http"
import path from "node:path"

import consola from "consola"

import { runCommandCapture, resolveExecutable } from "../exec"
import { PATHS } from "../paths"
import { buildEnv } from "../worker-agent/bash"

export const CLOUDCLI_PACKAGE = "@cloudcli-ai/cloudcli"
/** Pinned, tested known-good version. Never `@latest` (see docs/serve-control-plane.md). */
export const CLOUDCLI_PINNED_VERSION = "1.36.1"

/**
 * Build the env handed to the CloudCLI child. Starts from `buildEnv()` — the
 * vetted secret-stripping ALLOWLIST used for worker bash (drops GITHUB_TOKEN,
 * GH_ROUTER_*, ANTHROPIC_AUTH_TOKEN, OPENAI_API_KEY, COPILOT_TOKEN by omission)
 * — then layers the non-secret Anthropic/Claude vars. The spawned claude still
 * authenticates because that rides the synthetic `.credentials.json` FILE in
 * CLAUDE_CONFIG_DIR, not an env token. Load-bearing: CloudCLI exposes a browser
 * terminal that can read its own env, so no secret may live there.
 */
export function composeCloudCliChildEnv(
  anthropicVars: Record<string, string>,
): NodeJS.ProcessEnv {
  return { ...buildEnv(), ...anthropicVars }
}

const SERVER_ENTRY_REL = path.join(
  "dist-server",
  "server",
  "index.js",
)

export interface ResolvedCloudCli {
  /** Absolute path to the CloudCLI server entry (dist-server/server/index.js). */
  serverEntry: string
  version: string | null
}

/** Where the package's server entry lives under a given install root. */
function serverEntryUnderRoot(root: string): string {
  return path.join(root, "node_modules", CLOUDCLI_PACKAGE, SERVER_ENTRY_REL)
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}

async function readVersion(pkgRoot: string): Promise<string | null> {
  try {
    const raw = await fs.readFile(
      path.join(pkgRoot, "node_modules", CLOUDCLI_PACKAGE, "package.json"),
      "utf8",
    )
    return (JSON.parse(raw) as { version?: string }).version ?? null
  } catch {
    return null
  }
}

/**
 * Resolve the CloudCLI server entry, in order:
 *   1. an explicit `--cloudcli-path` (a package dir OR an install root),
 *   2. an existing pinned install in the router-owned dir,
 *   3. (unless `noInstall`) install the pinned version into the router-owned dir.
 * Never installs globally, never `@latest`.
 */
export async function resolveCloudCli(opts: {
  cliPath?: string
  noInstall: boolean
  version?: string
}): Promise<ResolvedCloudCli> {
  const version = opts.version ?? CLOUDCLI_PINNED_VERSION

  // 1. explicit path — accept either a package dir or an install root.
  if (opts.cliPath) {
    const direct = path.join(opts.cliPath, SERVER_ENTRY_REL)
    const underRoot = serverEntryUnderRoot(opts.cliPath)
    if (await exists(direct)) return { serverEntry: direct, version: null }
    if (await exists(underRoot))
      return { serverEntry: underRoot, version: await readVersion(opts.cliPath) }
    throw new Error(
      `--cloudcli-path "${opts.cliPath}" does not contain a CloudCLI install (looked for ${SERVER_ENTRY_REL}).`,
    )
  }

  // 2. existing router-owned install.
  const root = PATHS.CLOUDCLI_HOME
  const entry = serverEntryUnderRoot(root)
  if (await exists(entry)) {
    return { serverEntry: entry, version: await readVersion(root) }
  }

  // 3. install the pinned version locally into the router-owned dir.
  if (opts.noInstall) {
    throw new Error(
      `CloudCLI is not installed and --no-install was given. Install it with:\n  npm i --prefix "${root}" ${CLOUDCLI_PACKAGE}@${version}`,
    )
  }
  await installCloudCli(root, version)
  if (!(await exists(entry))) {
    throw new Error(
      `CloudCLI install completed but the server entry is missing (${entry}).`,
    )
  }
  return { serverEntry: entry, version: await readVersion(root) }
}

async function installCloudCli(root: string, version: string): Promise<void> {
  const npm = resolveExecutable("npm")
  if (!npm) {
    throw new Error(
      "npm not found on PATH — cannot install CloudCLI. Install Node.js/npm, or pass --cloudcli-path to an existing install.",
    )
  }
  await fs.mkdir(root, { recursive: true, mode: 0o700 })
  // A local package.json so `npm i` installs into <root>/node_modules
  // instead of walking up to a parent project.
  const pkgJson = path.join(root, "package.json")
  if (!(await exists(pkgJson))) {
    await fs.writeFile(
      pkgJson,
      JSON.stringify({ name: "gh-router-cloudcli-host", private: true }, null, 2),
    )
  }
  consola.info(
    `Installing ${CLOUDCLI_PACKAGE}@${version} (one-time, ~a minute; builds native deps)…`,
  )
  const { code, stderr } = await runCommandCapture(
    [
      npm,
      "install",
      `${CLOUDCLI_PACKAGE}@${version}`,
      "--prefix",
      root,
      "--no-audit",
      "--no-fund",
      "--loglevel=error",
    ],
    { timeoutMs: 10 * 60_000 },
  )
  if (code !== 0) {
    throw new Error(
      `CloudCLI install failed (npm exit ${code}). This often means no network, a corporate proxy, or missing Windows build tools for native deps.\nInstall manually then re-run with --cloudcli-path:\n  npm i --prefix "${root}" ${CLOUDCLI_PACKAGE}@${version}\n${stderr.slice(0, 400)}`,
    )
  }
}

export interface CloudCliProcess {
  child: ChildProcess
  port: number
  databasePath: string
}

/** Spawn CloudCLI on a loopback port with the given (already-filtered) env. */
export function spawnCloudCli(opts: {
  serverEntry: string
  port: number
  env: NodeJS.ProcessEnv
}): CloudCliProcess {
  const databasePath = path.join(PATHS.CLOUDCLI_HOME, "auth.db")
  const node = resolveExecutable("node") ?? process.execPath
  const child = spawn(node, [opts.serverEntry], {
    env: {
      ...opts.env,
      SERVER_PORT: String(opts.port),
      HOST: "127.0.0.1", // loopback only — never 0.0.0.0
      DATABASE_PATH: databasePath, // router-owned, isolated from a user's standalone CloudCLI
      // Do NOT set VITE_IS_PLATFORM: it disarms server auth and still shows a
      // login wall in the OSS bundle. Keep JWT auth on; auto-login is done by
      // the reverse proxy injecting the token.
      VITE_IS_PLATFORM: "",
    },
    stdio: "ignore",
    windowsHide: true,
  })
  return { child, port: opts.port, databasePath }
}

// ---- health + JWT --------------------------------------------------------

function req(
  port: number,
  method: "GET" | "POST",
  urlPath: string,
  body?: unknown,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body)
    const r = http.request(
      {
        host: "127.0.0.1",
        port,
        path: urlPath,
        method,
        headers: data
          ? { "content-type": "application/json", "content-length": Buffer.byteLength(data) }
          : {},
      },
      (res) => {
        let b = ""
        res.on("data", (d) => (b += d))
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: b }))
      },
    )
    r.on("error", reject)
    if (data) r.write(data)
    r.end()
  })
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Poll /api/auth/status until the server answers. Returns `needsSetup`. */
export async function waitForCloudCliReady(
  port: number,
  timeoutMs = 60_000,
): Promise<{ needsSetup: boolean }> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const r = await req(port, "GET", "/api/auth/status")
      if (r.status === 200) {
        const parsed = JSON.parse(r.body) as { needsSetup?: boolean }
        return { needsSetup: parsed.needsSetup === true }
      }
    } catch {
      // not up yet
    }
    await sleep(1000)
  }
  throw new Error(`CloudCLI did not become ready within ${timeoutMs}ms`)
}

const secretFile = () => path.join(PATHS.CLOUDCLI_HOME, ".serve-secret.json")

async function loadPassword(username: string): Promise<string | null> {
  try {
    const raw = await fs.readFile(secretFile(), "utf8")
    const parsed = JSON.parse(raw) as { username?: string; password?: string }
    if (parsed.username === username && parsed.password) return parsed.password
  } catch {
    // no file yet
  }
  return null
}

async function persistPassword(username: string, password: string): Promise<void> {
  // mode 0o600 + a 0o700 parent dir. On Windows the mode bits are ignored, but
  // the dir lives under the per-user home, which is user-ACL'd by default; the
  // password is a low-value local login for a loopback-only, Origin-gated app.
  await fs.mkdir(PATHS.CLOUDCLI_HOME, { recursive: true, mode: 0o700 })
  await fs.writeFile(
    secretFile(),
    JSON.stringify({ username, password }),
    { mode: 0o600 },
  )
}

/**
 * Ensure a CloudCLI user exists and return a valid JWT. On a fresh (isolated)
 * DB we register (persisting the password only AFTER success); on an existing
 * DB we log in with the persisted password.
 */
export async function mintJwt(
  port: number,
  username: string,
  needsSetup: boolean,
): Promise<string> {
  const existing = await loadPassword(username)
  if (needsSetup) {
    const password = existing ?? randomBytes(24).toString("base64url")
    const r = await req(port, "POST", "/api/auth/register", { username, password })
    if (r.status === 200) {
      const token = (JSON.parse(r.body) as { token?: string }).token
      if (token) {
        await persistPassword(username, password)
        return token
      }
    }
    // Fall through to login (e.g. a race created the user first).
  }
  const password = existing
  if (!password) {
    throw new Error(
      `CloudCLI already has a user but no stored password for "${username}". Delete ${path.join(PATHS.CLOUDCLI_HOME, "auth.db")} and retry.`,
    )
  }
  const r = await req(port, "POST", "/api/auth/login", { username, password })
  if (r.status === 200) {
    const token = (JSON.parse(r.body) as { token?: string }).token
    if (token) return token
  }
  throw new Error(
    `Could not obtain a CloudCLI session token (status ${r.status}). If a stale isolated DB exists, delete ${path.join(PATHS.CLOUDCLI_HOME, "auth.db")} and retry.`,
  )
}
