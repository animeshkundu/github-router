import fs from "node:fs/promises"
import path from "node:path"

import type { Model, ModelsResponse } from "~/services/copilot/get-models"

export interface ProviderFacadeContext {
  getModels: () => ModelsResponse | undefined
  defaultModel: string
  claudeConfigDir: string
}

export type ProviderFacadeKind = "models" | "mcp" | "skills" | "commands" | "auth"

type JsonObject = Record<string, unknown>

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function envelopedData(value: unknown): JsonObject | null {
  if (!isObject(value) || !isObject(value.data)) return null
  return value.data
}

function cloneObject<T extends JsonObject>(value: T): JsonObject {
  return { ...value }
}

/**
 * Requests serve answers DIRECTLY (never forwarded to CloudCLI) with a canned
 * JSON body. `POST /api/system/update` is CloudCLI's "update available" button,
 * which runs a GLOBAL `npm install -g @cloudcli-ai/cloudcli@latest` in the user's
 * home dir (`server/index.js`) — mutating their global npm and never applying to
 * serve's pinned, router-owned install. Blocking it prevents that surprise
 * mutation and tells the user how updates actually work. HTTP 200 + `success:
 * false` so the UI neither runs the update nor throws an error toast. Returns
 * null for anything not blocked.
 */
export function facadeBlockedRequest(
  method: string,
  pathname: string,
): { status: number; json: JsonObject } | null {
  if (method.toUpperCase() === "POST" && pathname === "/api/system/update") {
    return {
      status: 200,
      json: {
        success: false,
        managed: true,
        message:
          "CloudCLI is managed by github-router (a pinned, router-owned install). "
          + "To update, run `npm i -g github-router@latest`, then restart `github-router serve`.",
      },
    }
  }
  return null
}

export function facadeInterceptKind(
  method: string,
  pathname: string,
): ProviderFacadeKind | null {
  const normalizedMethod = method.toUpperCase()
  if (normalizedMethod === "POST" && pathname === "/api/commands/list") {
    return "commands"
  }
  if (normalizedMethod !== "GET") return null

  switch (pathname) {
    case "/api/providers/claude/models":
      return "models"
    case "/api/providers/claude/mcp/servers":
      return "mcp"
    case "/api/providers/claude/skills":
      return "skills"
    case "/api/providers/claude/auth/status":
      return "auth"
    default:
      return null
  }
}

export async function rewriteProviderResponse(
  kind: ProviderFacadeKind,
  upstreamJson: unknown,
  ctx: ProviderFacadeContext,
  query: URLSearchParams,
): Promise<unknown | null> {
  try {
    switch (kind) {
      case "models":
        return rewriteModels(upstreamJson, ctx)
      case "mcp":
        return rewriteMcp(upstreamJson, ctx, query)
      case "skills":
        return rewriteSkills(upstreamJson, ctx)
      case "commands":
        return rewriteCommands(upstreamJson, ctx)
      case "auth":
        return rewriteAuth(upstreamJson)
    }
  } catch {
    return null
  }
}

function rewriteModels(upstreamJson: unknown, ctx: ProviderFacadeContext): unknown | null {
  if (!isObject(upstreamJson)) return null
  const data = envelopedData(upstreamJson)
  if (!data || !isObject(data.models) || data.cache === undefined) return null

  const catalog = ctx.getModels()
  const models = catalog?.data
  if (!Array.isArray(models) || models.length === 0) return null

  const options = models
    .filter(isPickerModel)
    .map((m) => {
      const option: { value: string; label: string; description: string; effort?: JsonObject } = {
        value: m.id,
        label: m.name || m.id,
        description: `${m.vendor} · ${m.capabilities.family}`,
      }
      // Emit the effort selector the CloudCLI UI + `resolveClaudeEffort` need:
      // `effort.values` is `[{value}]` and the server maps it back with
      // `.map(v => v.value)` to validate a client-picked effort before passing
      // it to the binary. Derived from the Copilot catalog's per-model
      // `reasoning_effort` allowlist; omitted for non-reasoning models (no
      // selector shown). Default to `high` when supported (matches the shim's
      // default), else the model's top tier.
      const efforts = m.capabilities.supports?.reasoning_effort
      if (Array.isArray(efforts) && efforts.length > 0) {
        option.effort = {
          default: efforts.includes("high") ? "high" : efforts[efforts.length - 1],
          values: efforts.map((e) => ({ value: e })),
        }
      }
      return option
    })
  if (options.length === 0) return null

  const values = new Set(options.map((o) => o.value))
  const upstreamDefault = typeof data.models.DEFAULT === "string" ? data.models.DEFAULT : undefined
  const DEFAULT = values.has(ctx.defaultModel)
    ? ctx.defaultModel
    : (options[0]?.value ?? upstreamDefault)

  const nextData = cloneObject(data)
  nextData.models = { OPTIONS: options, DEFAULT }
  return { ...upstreamJson, data: nextData }
}

function isPickerModel(model: unknown): model is Model {
  return isObject(model)
    && typeof model.id === "string"
    && model.model_picker_enabled !== false
    && typeof model.vendor === "string"
    && (model.name === undefined || typeof model.name === "string")
    && isObject(model.capabilities)
    && typeof model.capabilities.family === "string"
}

async function rewriteMcp(
  upstreamJson: unknown,
  ctx: ProviderFacadeContext,
  query: URLSearchParams,
): Promise<unknown | null> {
  if (!isObject(upstreamJson) || query.get("scope") !== "user") return null
  const data = envelopedData(upstreamJson)
  if (!data || !Array.isArray(data.servers)) return null

  const mirror = await readJson(path.join(ctx.claudeConfigDir, ".claude.json"))
  if (!isObject(mirror) || !isObject(mirror.mcpServers)) return null

  const existing = new Set(
    data.servers
      .filter(isObject)
      .map((s) => s.name)
      .filter((name): name is string => typeof name === "string"),
  )
  const additions: JsonObject[] = []
  for (const [name, entry] of Object.entries(mirror.mcpServers)) {
    if (existing.has(name) || !isObject(entry)) continue
    const transport = entry.type === "http" ? "http" : "stdio"
    const server: JsonObject = {
      provider: "claude",
      name,
      scope: "user",
      transport,
    }
    if (typeof entry.url === "string") server.url = entry.url
    additions.push(server)
    existing.add(name)
  }
  if (additions.length === 0) return null

  const nextData = cloneObject(data)
  nextData.servers = [...data.servers, ...additions]
  return { ...upstreamJson, data: nextData }
}

async function rewriteSkills(
  upstreamJson: unknown,
  ctx: ProviderFacadeContext,
): Promise<unknown | null> {
  if (!isObject(upstreamJson)) return null
  const data = envelopedData(upstreamJson)
  if (!data || !Array.isArray(data.skills)) return null

  const skills = await readSkillDirs(path.join(ctx.claudeConfigDir, "skills"))
  if (skills.length === 0) return null

  const existing = new Set(
    data.skills
      .filter(isObject)
      .map((s) => s.command)
      .filter((command): command is string => typeof command === "string"),
  )
  const additions = skills
    .filter((skill) => !existing.has(skill.name))
    .map((skill) => ({
      provider: "claude",
      name: skill.name,
      description: skill.description,
      command: skill.name,
      scope: "user",
      // sourcePath intentionally omitted — the UI dispatches on `command`/`name`,
      // and an absolute mirror path would leak the home dir / username to the browser.
    }))
  if (additions.length === 0) return null

  const nextData = cloneObject(data)
  nextData.skills = [...data.skills, ...additions]
  return { ...upstreamJson, data: nextData }
}

async function rewriteCommands(
  upstreamJson: unknown,
  ctx: ProviderFacadeContext,
): Promise<unknown | null> {
  if (!isObject(upstreamJson) || !Array.isArray(upstreamJson.custom)) return null

  const dirs = [
    path.join(ctx.claudeConfigDir, "commands"),
    path.join(ctx.claudeConfigDir, ".claude", "commands"),
  ]
  const commandFiles = (await Promise.all(dirs.map(readCommandFiles))).flat()
  if (commandFiles.length === 0) return null

  const existing = new Set(
    upstreamJson.custom
      .filter(isObject)
      .map((c) => c.name)
      .filter((name): name is string => typeof name === "string"),
  )
  const additions = commandFiles
    .filter((command) => !existing.has(command.name))
    .map((command) => ({
      name: command.name,
      // Relative path only — an absolute mirror path would leak the home dir /
      // username to the browser. The UI dispatches on `name`.
      path: command.relativePath,
      relativePath: command.relativePath,
      description: command.description,
      namespace: "user",
      metadata: { type: "custom" },
    }))
  if (additions.length === 0) return null

  const custom = [...upstreamJson.custom, ...additions]
  return {
    ...upstreamJson,
    custom,
    count: countCommands(upstreamJson.builtIn) + custom.length,
  }
}

function rewriteAuth(upstreamJson: unknown): unknown | null {
  if (!isObject(upstreamJson)) return null
  const data = envelopedData(upstreamJson)
  if (!data) return null

  return {
    ...upstreamJson,
    data: {
      ...data,
      authenticated: true,
      installed: true,
    },
  }
}

async function readJson(filePath: string): Promise<unknown | null> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"))
  } catch {
    return null
  }
}

async function readSkillDirs(skillsDir: string): Promise<Array<{ name: string; description: string; sourcePath: string }>> {
  try {
    const entries = await fs.readdir(skillsDir, { withFileTypes: true })
    const skills = await Promise.all(
      entries
        .filter((entry) => entry.isDirectory() && entry.name.startsWith("gh-"))
        .map(async (entry) => {
          const sourcePath = path.join(skillsDir, entry.name, "SKILL.md")
          let description = ""
          try {
            const md = await fs.readFile(sourcePath, "utf8")
            description = parseFrontmatterField(md, "description") ?? ""
          } catch {
            // Keep the skill visible even if only the directory is readable.
          }
          const name = entry.name
          return { name, description, sourcePath }
        }),
    )
    return skills
  } catch {
    return []
  }
}

async function readCommandFiles(commandsDir: string): Promise<Array<{ name: string; relativePath: string; filePath: string; description: string }>> {
  try {
    const stat = await fs.stat(commandsDir)
    if (!stat.isDirectory()) return []
  } catch {
    return []
  }
  return readCommandFilesRecursive(commandsDir, commandsDir)
}

async function readCommandFilesRecursive(
  root: string,
  dir: string,
): Promise<Array<{ name: string; relativePath: string; filePath: string; description: string }>> {
  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }

  const out: Array<{ name: string; relativePath: string; filePath: string; description: string }> = []
  for (const entry of entries) {
    const filePath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      out.push(...await readCommandFilesRecursive(root, filePath))
      continue
    }
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue
    const relativePath = normalizeRelative(path.relative(root, filePath))
    const name = relativePath.replace(/\.md$/i, "")
    let description = ""
    try {
      const md = await fs.readFile(filePath, "utf8")
      description = parseFrontmatterField(md, "description") ?? firstMarkdownLine(md)
    } catch {
      // A listed file that disappears mid-read should not break the UI.
    }
    out.push({ name, relativePath, filePath, description })
  }
  return out
}

function parseFrontmatterField(markdown: string, field: string): string | null {
  if (!markdown.startsWith("---")) return null
  const end = markdown.indexOf("\n---", 3)
  if (end < 0) return null
  const frontmatter = markdown.slice(3, end).split(/\r?\n/)
  for (const line of frontmatter) {
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/)
    if (!match || match[1] !== field) continue
    return match[2].replace(/^['"]|['"]$/g, "").trim()
  }
  return null
}

function firstMarkdownLine(markdown: string): string {
  const body = markdown.startsWith("---")
    ? markdown.slice(markdown.indexOf("\n---", 3) + 4)
    : markdown
  for (const line of body.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed) return trimmed.replace(/^#+\s*/, "")
  }
  return ""
}

function normalizeRelative(value: string): string {
  return value.split(path.sep).join("/")
}

function countCommands(builtIn: unknown): number {
  return Array.isArray(builtIn) ? builtIn.length : 0
}
