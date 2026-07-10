import { afterEach, describe, expect, it } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import {
  facadeInterceptKind,
  rewriteProviderResponse,
  type ProviderFacadeContext,
} from "~/lib/serve/provider-facade"
import type { ModelsResponse } from "~/services/copilot/get-models"

const tempDirs: string[] = []

afterEach(async () => {
  while (tempDirs.length) {
    await fs.rm(tempDirs.pop()!, { recursive: true, force: true })
  }
})

async function tempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gh-router-facade-"))
  tempDirs.push(dir)
  return dir
}

function ctx(overrides: Partial<ProviderFacadeContext> = {}): ProviderFacadeContext {
  return {
    getModels: () => undefined,
    defaultModel: "claude-opus-4.8",
    claudeConfigDir: "unused",
    ...overrides,
  }
}

const query = (s = "") => new URLSearchParams(s)

describe("facadeInterceptKind", () => {
  it("matches only the expected CloudCLI routes and methods", () => {
    expect(facadeInterceptKind("GET", "/api/providers/claude/models")).toBe("models")
    expect(facadeInterceptKind("GET", "/api/providers/claude/mcp/servers")).toBe("mcp")
    expect(facadeInterceptKind("GET", "/api/providers/claude/skills")).toBe("skills")
    expect(facadeInterceptKind("GET", "/api/providers/claude/auth/status")).toBe("auth")
    expect(facadeInterceptKind("POST", "/api/commands/list")).toBe("commands")

    expect(facadeInterceptKind("GET", "/api/commands/list")).toBeNull()
    expect(facadeInterceptKind("POST", "/api/providers/claude/models")).toBeNull()
    expect(facadeInterceptKind("GET", "/api/providers/openai/models")).toBeNull()
    expect(facadeInterceptKind("GET", "/api/providers/claude/models/extra")).toBeNull()
  })
})

describe("provider façade models rewriter", () => {
  const models: ModelsResponse = {
    object: "list",
    data: [
      {
        id: "gpt-5.5",
        name: "GPT 5.5",
        vendor: "openai",
        object: "model",
        version: "2026-01-01",
        preview: false,
        model_picker_enabled: true,
        capabilities: { family: "gpt", object: "capabilities", tokenizer: "o200k", type: "chat" },
      },
      {
        id: "hidden-model",
        name: "Hidden",
        vendor: "test",
        object: "model",
        version: "1",
        preview: false,
        model_picker_enabled: false,
        capabilities: { family: "hidden", object: "capabilities", tokenizer: "x", type: "chat" },
      },
      {
        id: "claude-opus-4.8",
        name: "Claude Opus 4.8",
        vendor: "anthropic",
        object: "model",
        version: "2026-01-01",
        preview: false,
        model_picker_enabled: true,
        capabilities: { family: "claude", object: "capabilities", tokenizer: "claude", type: "chat" },
      },
    ],
  }

  it("replaces OPTIONS from picker-enabled catalog models and preserves cache", async () => {
    const upstream = {
      success: true,
      data: {
        models: { OPTIONS: [{ value: "old", label: "Old" }], DEFAULT: "old" },
        cache: { ttl: 123 },
      },
    }

    const rewritten = await rewriteProviderResponse(
      "models",
      upstream,
      ctx({ getModels: () => models, defaultModel: "claude-opus-4.8" }),
      query(),
    ) as { data: { cache: unknown; models: { DEFAULT: string; OPTIONS: Array<Record<string, unknown>> } } }

    expect(rewritten?.data.cache).toEqual({ ttl: 123 })
    expect(rewritten?.data.models.DEFAULT).toBe("claude-opus-4.8")
    expect(rewritten?.data.models.OPTIONS).toEqual([
      { value: "gpt-5.5", label: "GPT 5.5", description: "openai · gpt" },
      { value: "claude-opus-4.8", label: "Claude Opus 4.8", description: "anthropic · claude" },
    ])
  })

  it("falls back to the first option when the default is absent", async () => {
    const rewritten = await rewriteProviderResponse(
      "models",
      {
        success: true,
        data: { models: { OPTIONS: [], DEFAULT: "cloudcli-default" }, cache: {} },
      },
      ctx({ getModels: () => models, defaultModel: "missing" }),
      query(),
    ) as { data: { models: { DEFAULT: string } } }

    expect(rewritten?.data.models.DEFAULT).toBe("gpt-5.5")
  })

  it("returns null for an empty catalog or missing required upstream shape", async () => {
    expect(await rewriteProviderResponse(
      "models",
      { success: true, data: { models: { OPTIONS: [], DEFAULT: "old" }, cache: {} } },
      ctx({ getModels: () => ({ object: "list", data: [] }) }),
      query(),
    )).toBeNull()
    expect(await rewriteProviderResponse(
      "models",
      { success: true, data: { models: { OPTIONS: [], DEFAULT: "old" } } },
      ctx({ getModels: () => models }),
      query(),
    )).toBeNull()
  })
})

describe("provider façade mcp rewriter", () => {
  it("appends sanitized user-scope MCP servers and dedups by name", async () => {
    const dir = await tempDir()
    await fs.writeFile(
      path.join(dir, ".claude.json"),
      JSON.stringify({
        mcpServers: {
          peers: {
            type: "http",
            url: "http://127.0.0.1:8787/mcp/peers",
            headers: { Authorization: "Bearer secret" },
            env: { TOKEN: "secret" },
            headersHelper: "helper",
          },
          existing: {
            type: "stdio",
            command: "node",
            args: ["server.js"],
            env: { API_KEY: "secret" },
          },
        },
      }),
      "utf8",
    )

    const rewritten = await rewriteProviderResponse(
      "mcp",
      {
        success: true,
        data: {
          provider: "claude",
          scope: "user",
          servers: [{ provider: "claude", name: "existing", scope: "user", transport: "stdio" }],
        },
      },
      ctx({ claudeConfigDir: dir }),
      query("scope=user"),
    ) as { data: { servers: Array<Record<string, unknown>> } }

    expect(rewritten.data.servers).toHaveLength(2)
    const added = rewritten.data.servers.find((s) => s.name === "peers")!
    expect(added).toEqual({
      provider: "claude",
      name: "peers",
      scope: "user",
      transport: "http",
      url: "http://127.0.0.1:8787/mcp/peers",
    })
    const serialized = JSON.stringify(added)
    expect(serialized).not.toContain("Authorization")
    expect(serialized).not.toContain("Bearer")
    expect(serialized).not.toContain("headers")
    expect(serialized).not.toContain("headersHelper")
    expect(serialized).not.toContain("env")
    expect(serialized).not.toContain("TOKEN")
  })

  it("passes through non-user scopes and missing mirror files", async () => {
    const dir = await tempDir()
    const upstream = { success: true, data: { servers: [] } }
    expect(await rewriteProviderResponse("mcp", upstream, ctx({ claudeConfigDir: dir }), query("scope=local"))).toBeNull()
    expect(await rewriteProviderResponse("mcp", upstream, ctx({ claudeConfigDir: dir }), query("scope=user"))).toBeNull()
  })
})

describe("provider façade skills and commands rewriters", () => {
  it("appends gh-* skills from the mirror and dedups by command", async () => {
    const dir = await tempDir()
    await fs.mkdir(path.join(dir, "skills", "gh-research"), { recursive: true })
    await fs.writeFile(
      path.join(dir, "skills", "gh-research", "SKILL.md"),
      "---\nname: gh-research\ndescription: Research deeply\n---\n# body\n",
      "utf8",
    )

    const rewritten = await rewriteProviderResponse(
      "skills",
      { success: true, data: { provider: "claude", skills: [{ command: "existing" }] } },
      ctx({ claudeConfigDir: dir }),
      query(),
    ) as { data: { skills: Array<Record<string, unknown>> } }

    expect(rewritten.data.skills).toContainEqual({
      provider: "claude",
      name: "gh-research",
      description: "Research deeply",
      command: "gh-research",
      scope: "user",
    })
  })

  it("appends command markdown files and bumps count", async () => {
    const dir = await tempDir()
    await fs.mkdir(path.join(dir, "commands", "gh"), { recursive: true })
    await fs.writeFile(
      path.join(dir, "commands", "gh", "triage.md"),
      "---\ndescription: Triage issues\n---\n# body\n",
      "utf8",
    )

    const rewritten = await rewriteProviderResponse(
      "commands",
      {
        builtIn: [{ name: "help", namespace: "builtin", metadata: { type: "builtin" } }],
        custom: [{ name: "old", namespace: "user", metadata: { type: "custom" } }],
        count: 2,
      },
      ctx({ claudeConfigDir: dir }),
      query(),
    ) as { custom: Array<Record<string, unknown>>; count: number }

    expect(rewritten.count).toBe(3)
    expect(rewritten.custom).toContainEqual({
      name: "gh/triage",
      path: "gh/triage.md",
      relativePath: "gh/triage.md",
      description: "Triage issues",
      namespace: "user",
      metadata: { type: "custom" },
    })
  })
})

describe("provider façade auth rewriter", () => {
  it("forces the provider authenticated and installed flags", async () => {
    const rewritten = await rewriteProviderResponse(
      "auth",
      { success: true, data: { authenticated: false, installed: false, foo: "bar" } },
      ctx(),
      query(),
    ) as { data: Record<string, unknown> }

    expect(rewritten.data).toEqual({ authenticated: true, installed: true, foo: "bar" })
  })
})
