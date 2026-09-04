import { randomBytes } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"

const HTTP_EVENT_TIMEOUTS = new Map<string, number>([
  ["PreToolUse", 10],
  ["PostToolUse", 10],
  ["PostToolUseFailure", 10],
  ["PermissionRequest", 1800],
  ["Stop", 10],
  ["Notification", 10],
  ["UserPromptSubmit", 10],
  ["SubagentStart", 10],
  ["SubagentStop", 10],
  ["PreCompact", 10],
  ["TeammateIdle", 10],
  ["TaskCompleted", 10],
  ["SessionEnd", 10],
])

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const URL_IN_COMMAND_RE = /http:\/\/127\.0\.0\.1:\d+\/hook\/[0-9a-f-]+/gi
const RENAME_RETRY_DELAYS_MS = [25, 75, 200] as const
const PARSE_RETRY_DELAYS_MS = [10, 25, 75] as const
const RETRYABLE_RENAME_CODES = new Set(["EACCES", "EBUSY", "EPERM"])

type JsonObject = Record<string, unknown>

interface AgencyEndpoint {
  url: string
  port: number
  nonce: string
  key: string
}

export interface AgencyHookSanitizeResult {
  written: boolean
  removed: number
  endpointCount: number
  invalid?: "malformed-json" | "non-object"
}

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function parseAgencyEndpoint(raw: string): AgencyEndpoint | undefined {
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    return undefined
  }
  if (
    parsed.protocol !== "http:"
    || parsed.hostname !== "127.0.0.1"
    || parsed.username !== ""
    || parsed.password !== ""
    || parsed.search !== ""
    || parsed.hash !== ""
    || parsed.port === ""
  ) {
    return undefined
  }
  const segments = parsed.pathname.split("/").filter(Boolean)
  if (segments.length !== 2 || segments[0] !== "hook" || !UUID_RE.test(segments[1]!)) {
    return undefined
  }
  const port = Number.parseInt(parsed.port, 10)
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) return undefined
  const nonce = segments[1]!.toLowerCase()
  const url = `http://127.0.0.1:${port}/hook/${segments[1]!}`
  return { url, port, nonce, key: `${port}/${nonce}` }
}

function singleHookConfig(value: unknown): JsonObject | undefined {
  if (!isObject(value) || value.matcher !== "*") return undefined
  const hooks = value.hooks
  if (!Array.isArray(hooks) || hooks.length !== 1 || !isObject(hooks[0])) return undefined
  return hooks[0]
}

function httpEndpoint(value: unknown, expectedTimeout?: number): AgencyEndpoint | undefined {
  const config = singleHookConfig(value)
  if (
    !config
    || config.type !== "http"
    || typeof config.url !== "string"
    || (expectedTimeout !== undefined && config.timeout !== expectedTimeout)
  ) {
    return undefined
  }
  return parseAgencyEndpoint(config.url)
}

function commandEndpoint(value: unknown): AgencyEndpoint | undefined {
  const config = singleHookConfig(value)
  if (!config || config.type !== "command" || typeof config.command !== "string") {
    return undefined
  }
  const urls = config.command.match(URL_IN_COMMAND_RE) ?? []
  if (urls.length !== 1) return undefined
  const endpoint = parseAgencyEndpoint(urls[0]!)
  if (!endpoint) return undefined
  const windows = `curl.exe -q -sS --noproxy "*" --connect-timeout 2 --max-time 5 -H "Content-Type: application/json" --data-binary @- "${endpoint.url}" 1>NUL 2>NUL`
  const posix = `curl -q -sS --noproxy '*' --connect-timeout 2 --max-time 5 -H 'Content-Type: application/json' --data-binary @- '${endpoint.url}' >/dev/null 2>&1 || true`
  return config.command === windows || config.command === posix ? endpoint : undefined
}

function agencyPorts(hooks: JsonObject): Set<number> {
  const ports = new Set<number>()

  const starts = hooks.SessionStart
  if (Array.isArray(starts)) {
    for (const entry of starts) {
      const endpoint = commandEndpoint(entry)
      if (endpoint) ports.add(endpoint.port)
    }
  }

  const cohort = new Map<string, { endpoint: AgencyEndpoint; events: Set<string> }>()
  for (const [event, timeout] of HTTP_EVENT_TIMEOUTS) {
    const entries = hooks[event]
    if (!Array.isArray(entries)) continue
    for (const entry of entries) {
      const endpoint = httpEndpoint(entry, timeout)
      if (!endpoint) continue
      const seen = cohort.get(endpoint.key) ?? { endpoint, events: new Set<string>() }
      seen.events.add(event)
      cohort.set(endpoint.key, seen)
    }
  }
  for (const { endpoint, events } of cohort.values()) {
    if (events.size === HTTP_EVENT_TIMEOUTS.size) ports.add(endpoint.port)
  }
  return ports
}

function removeAgencyEntries(hooks: JsonObject, ports: ReadonlySet<number>): {
  hooks: JsonObject
  removed: number
  endpoints: Set<string>
} {
  const nextHooks: JsonObject = { ...hooks }
  const endpoints = new Set<string>()
  let removed = 0
  for (const [event, rawEntries] of Object.entries(hooks)) {
    if (!Array.isArray(rawEntries)) continue
    const kept = rawEntries.filter((entry) => {
      const endpoint = httpEndpoint(entry) ?? commandEndpoint(entry)
      if (!endpoint || !ports.has(endpoint.port)) return true
      endpoints.add(endpoint.key)
      removed += 1
      return false
    })
    if (kept.length !== rawEntries.length) nextHooks[event] = kept
  }
  return { hooks: nextHooks, removed, endpoints }
}

async function renameWithRetry(
  temp: string,
  target: string,
  desiredContent: string,
): Promise<void> {
  let lastError: unknown
  for (let attempt = 0; attempt <= RENAME_RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      await fs.rename(temp, target)
      return
    } catch (error) {
      lastError = error
      const retryable = RETRYABLE_RENAME_CODES.has(
        (error as NodeJS.ErrnoException).code ?? "",
      )
      if (!retryable || attempt === RENAME_RETRY_DELAYS_MS.length) break
      await new Promise<void>((resolve) =>
        setTimeout(resolve, RENAME_RETRY_DELAYS_MS[attempt]),
      )
    }
  }

  // A concurrent mirror provision may have won the rename race. Its transform
  // is deterministic, so identical destination bytes mean the requested state
  // already landed and this operation succeeded despite Windows reporting the
  // losing rename as EPERM/EBUSY.
  try {
    if (await fs.readFile(target, "utf8") === desiredContent) {
      await fs.rm(temp, { force: true }).catch(() => {})
      return
    }
  } catch {
    // Fall through and preserve the original rename error.
  }
  throw lastError
}

/**
 * Remove Microsoft Agency Hub's rotating localhost hooks from one router-owned
 * settings mirror. Agency replaces its per-daemon UUID on restart; retaining
 * those URLs in a one-way launch snapshot makes every later hook call return
 * 404. The operator's canonical settings file is never touched.
 */
export async function sanitizeAgencyHooksInSettingsFile(
  settingsPath: string,
): Promise<AgencyHookSanitizeResult> {
  let parsed: unknown
  for (let attempt = 0; ; attempt += 1) {
    let raw: string
    try {
      raw = await fs.readFile(settingsPath, "utf8")
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? ""
      if (code === "ENOENT") {
        return { written: false, removed: 0, endpointCount: 0 }
      }
      if (
        RETRYABLE_RENAME_CODES.has(code)
        && attempt < PARSE_RETRY_DELAYS_MS.length
      ) {
        await new Promise<void>((resolve) =>
          setTimeout(resolve, PARSE_RETRY_DELAYS_MS[attempt]),
        )
        continue
      }
      throw error
    }
    try {
      const json = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw
      parsed = JSON.parse(json)
      break
    } catch {
      // Concurrent mirror provisions can copy and sanitize the same destination.
      // Retry a torn read briefly; a persistently malformed file cannot contain
      // loadable hooks, so preserve it unchanged and let Claude Code apply its
      // existing invalid-settings behavior.
      if (attempt >= PARSE_RETRY_DELAYS_MS.length) {
        return {
          written: false,
          removed: 0,
          endpointCount: 0,
          invalid: "malformed-json",
        }
      }
      await new Promise<void>((resolve) =>
        setTimeout(resolve, PARSE_RETRY_DELAYS_MS[attempt]),
      )
    }
  }

  if (!isObject(parsed)) {
    return {
      written: false,
      removed: 0,
      endpointCount: 0,
      invalid: "non-object",
    }
  }
  if (!isObject(parsed.hooks)) {
    return { written: false, removed: 0, endpointCount: 0 }
  }

  const ports = agencyPorts(parsed.hooks)
  if (ports.size === 0) {
    return { written: false, removed: 0, endpointCount: 0 }
  }
  const sanitized = removeAgencyEntries(parsed.hooks, ports)
  if (sanitized.removed === 0) {
    return { written: false, removed: 0, endpointCount: 0 }
  }

  const next = { ...parsed, hooks: sanitized.hooks }
  const content = `${JSON.stringify(next, null, 2)}\n`
  const temp = `${settingsPath}.${process.pid}.${randomBytes(4).toString("hex")}.agency.tmp`
  await fs.mkdir(path.dirname(settingsPath), { recursive: true })
  try {
    await fs.writeFile(temp, content, { mode: 0o600, flag: "wx" })
    await renameWithRetry(temp, settingsPath, content)
  } catch (error) {
    await fs.rm(temp, { force: true }).catch(() => {})
    throw error
  }
  return {
    written: true,
    removed: sanitized.removed,
    endpointCount: sanitized.endpoints.size,
  }
}
