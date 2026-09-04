import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { sanitizeAgencyHooksInSettingsFile } from "~/lib/agency-hook-settings"

const HTTP_EVENTS = [
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "PermissionRequest",
  "Stop",
  "Notification",
  "UserPromptSubmit",
  "SubagentStart",
  "SubagentStop",
  "PreCompact",
  "TeammateIdle",
  "TaskCompleted",
  "SessionEnd",
] as const

const NONCE = "a4617907-0b9e-4bcf-b4ef-b10d7c5a31be"
const OTHER_NONCE = "2f8a78b2-36a7-4aba-90f4-69025b6b27bc"

function endpoint(port = 7824, nonce = NONCE): string {
  return `http://127.0.0.1:${port}/hook/${nonce}`
}

function httpEntry(url: string, timeout = 10): Record<string, unknown> {
  return {
    matcher: "*",
    hooks: [{ type: "http", url, timeout }],
  }
}

function windowsCommand(url: string): string {
  return `curl.exe -q -sS --noproxy "*" --connect-timeout 2 --max-time 5 -H "Content-Type: application/json" --data-binary @- "${url}" 1>NUL 2>NUL`
}

function posixCommand(url: string): string {
  return `curl -q -sS --noproxy '*' --connect-timeout 2 --max-time 5 -H 'Content-Type: application/json' --data-binary @- '${url}' >/dev/null 2>&1 || true`
}

function agencySettings(
  url: string,
  command: (value: string) => string = windowsCommand,
): Record<string, unknown> {
  const hooks: Record<string, Array<Record<string, unknown>>> = {}
  for (const event of HTTP_EVENTS) {
    hooks[event] = [httpEntry(url, event === "PermissionRequest" ? 1800 : 10)]
  }
  hooks.SessionStart = [{ matcher: "*", hooks: [{ type: "command", command: command(url) }] }]
  return { hooks }
}

let dir: string
let settingsPath: string

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "gh-router-agency-hooks-"))
  settingsPath = path.join(dir, "settings.json")
})

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

async function write(value: unknown): Promise<void> {
  await fs.writeFile(settingsPath, `${JSON.stringify(value, null, 2)}\n`)
}

async function read(): Promise<Record<string, unknown>> {
  return JSON.parse(await fs.readFile(settingsPath, "utf8")) as Record<string, unknown>
}

describe("sanitizeAgencyHooksInSettingsFile", () => {
  test("removes the Agency cohort and mixed-nonce residue while preserving unrelated settings", async () => {
    const current = endpoint()
    const stale = endpoint(7824, OTHER_NONCE)
    const settings = agencySettings(current)
    const hooks = settings.hooks as Record<string, Array<Record<string, unknown>>>
    hooks.PreToolUse!.push(httpEntry(stale))
    // Once Agency ownership of the singleton port is proven, a hook event added
    // by a newer Agency release must be removed without changing this table.
    hooks.ConfigChange = [httpEntry(stale)]
    hooks.PreToolUse!.push({
      matcher: "Bash",
      hooks: [{ type: "http", url: "http://127.0.0.1:9000/custom", timeout: 7 }],
    })
    settings.theme = "dark"
    settings.permissions = { allow: ["Read"] }
    await write(settings)

    expect(await sanitizeAgencyHooksInSettingsFile(settingsPath)).toEqual({
      written: true,
      removed: HTTP_EVENTS.length + 3,
      endpointCount: 2,
    })

    const sanitized = await read()
    expect(sanitized.theme).toBe("dark")
    expect(sanitized.permissions).toEqual({ allow: ["Read"] })
    const sanitizedHooks = sanitized.hooks as Record<string, Array<Record<string, unknown>>>
    expect(sanitizedHooks.PreToolUse).toEqual([
      {
        matcher: "Bash",
        hooks: [{ type: "http", url: "http://127.0.0.1:9000/custom", timeout: 7 }],
      },
    ])
    for (const event of HTTP_EVENTS) {
      if (event !== "PreToolUse") expect(sanitizedHooks[event]).toEqual([])
    }
    expect(sanitizedHooks.ConfigChange).toEqual([])
    expect(sanitizedHooks.SessionStart).toEqual([])
    expect((await fs.readdir(dir)).sort()).toEqual(["settings.json"])
  })

  test("recognizes the POSIX SessionStart signature on a non-default port and uppercase UUID", async () => {
    const url = endpoint(49152, NONCE.toUpperCase())
    await write(agencySettings(url, posixCommand))

    const result = await sanitizeAgencyHooksInSettingsFile(settingsPath)
    expect(result.written).toBe(true)
    expect(result.removed).toBe(HTTP_EVENTS.length + 1)
    expect(result.endpointCount).toBe(1)
  })

  test("uses the complete HTTP cohort when SessionStart is absent", async () => {
    const settings = agencySettings(endpoint())
    delete (settings.hooks as Record<string, unknown>).SessionStart
    await write(settings)

    expect(await sanitizeAgencyHooksInSettingsFile(settingsPath)).toEqual({
      written: true,
      removed: HTTP_EVENTS.length,
      endpointCount: 1,
    })
  })

  test("preserves partial cohorts and near-miss command hooks", async () => {
    const url = endpoint()
    const settings = {
      theme: "dark",
      hooks: {
        PreToolUse: [httpEntry(url)],
        Stop: [httpEntry(url)],
        SessionStart: [
          {
            matcher: "*",
            hooks: [
              {
                type: "command",
                command: windowsCommand(url).replace("curl.exe -q", "curl.exe"),
              },
            ],
          },
        ],
      },
    }
    await write(settings)
    const before = await fs.readFile(settingsPath, "utf8")
    const beforeStat = await fs.stat(settingsPath)

    expect(await sanitizeAgencyHooksInSettingsFile(settingsPath)).toEqual({
      written: false,
      removed: 0,
      endpointCount: 0,
    })
    expect(await fs.readFile(settingsPath, "utf8")).toBe(before)
    expect((await fs.stat(settingsPath)).mtimeMs).toBe(beforeStat.mtimeMs)
  })

  test("does not treat a custom multi-hook group as Agency", async () => {
    const settings = agencySettings(endpoint())
    const hooks = settings.hooks as Record<string, Array<Record<string, unknown>>>
    hooks.SessionStart = []
    hooks.PreToolUse = [
      {
        matcher: "*",
        hooks: [
          { type: "http", url: endpoint(), timeout: 10 },
          { type: "command", command: "custom-audit" },
        ],
      },
    ]
    await write(settings)

    expect((await sanitizeAgencyHooksInSettingsFile(settingsPath)).written).toBe(false)
    expect((await read()).hooks).toEqual(hooks)
  })

  test("accepts a UTF-8 BOM without weakening Agency provenance checks", async () => {
    const bom = String.fromCharCode(0xfeff)
    await fs.writeFile(
      settingsPath,
      `${bom}${JSON.stringify(agencySettings(endpoint()), null, 2)}\r\n`,
    )

    const result = await sanitizeAgencyHooksInSettingsFile(settingsPath)
    expect(result.written).toBe(true)
    expect(result.removed).toBe(HTTP_EVENTS.length + 1)
    expect((await fs.readFile(settingsPath, "utf8")).startsWith(bom)).toBe(false)
  })

  test("leaves missing, malformed, and non-object settings unchanged", async () => {
    expect(await sanitizeAgencyHooksInSettingsFile(settingsPath)).toEqual({
      written: false,
      removed: 0,
      endpointCount: 0,
    })

    for (const [raw, invalid] of [
      ["{broken", "malformed-json"],
      ["[1,2,3]", "non-object"],
    ] as const) {
      await fs.writeFile(settingsPath, raw)
      expect(await sanitizeAgencyHooksInSettingsFile(settingsPath)).toEqual({
        written: false,
        removed: 0,
        endpointCount: 0,
        invalid,
      })
      expect(await fs.readFile(settingsPath, "utf8")).toBe(raw)
    }
  })
})
