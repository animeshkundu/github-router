import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"

import { artifactToolsEnabled } from "../../src/lib/mcp-capabilities"
import { ARTIFACT_TOOLS } from "../../src/lib/artifact/tools"

type ArtifactTool = (typeof ARTIFACT_TOOLS)[number]

const ARTIFACT_ENV_KEYS = [
  "AIORDIE_BASE_URL",
  "AIORDIE_TOKEN",
  "AIORDIE_SESSION_ID",
] as const

let previousEnv: Record<(typeof ARTIFACT_ENV_KEYS)[number], string | undefined>
let originalFetch: typeof fetch

function setArtifactEnv(): void {
  process.env.AIORDIE_BASE_URL = "https://ai.example"
  process.env.AIORDIE_TOKEN = "tok-artifact"
  process.env.AIORDIE_SESSION_ID = "sess-1"
}

function clearArtifactEnv(): void {
  for (const key of ARTIFACT_ENV_KEYS) delete process.env[key]
}

function restoreArtifactEnv(): void {
  for (const key of ARTIFACT_ENV_KEYS) {
    const value = previousEnv[key]
    if (value === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = value
    }
  }
}

function toolByName(name: string): ArtifactTool {
  const tool = ARTIFACT_TOOLS.find((candidate) => candidate.toolNameHttp === name)
  expect(tool).toBeDefined()
  return tool!
}

async function callTool(
  name: string,
  args: Record<string, unknown>,
): Promise<{ result: Awaited<ReturnType<ArtifactTool["handler"]>>; json: unknown }> {
  const result = await toolByName(name).handler(args)
  return { result, json: JSON.parse(result.content[0]!.text) as unknown }
}

beforeEach(() => {
  previousEnv = {
    AIORDIE_BASE_URL: process.env.AIORDIE_BASE_URL,
    AIORDIE_TOKEN: process.env.AIORDIE_TOKEN,
    AIORDIE_SESSION_ID: process.env.AIORDIE_SESSION_ID,
  }
  originalFetch = globalThis.fetch
  clearArtifactEnv()
  globalThis.fetch = originalFetch
})

afterEach(() => {
  restoreArtifactEnv()
  globalThis.fetch = originalFetch
})

describe("artifactToolsEnabled", () => {
  test("reflects the ai-or-die environment trio", () => {
    expect(artifactToolsEnabled()).toBe(false)

    process.env.AIORDIE_BASE_URL = "https://ai.example"
    process.env.AIORDIE_TOKEN = "tok-artifact"
    expect(artifactToolsEnabled()).toBe(false)

    process.env.AIORDIE_SESSION_ID = "sess-1"
    expect(artifactToolsEnabled()).toBe(true)
  })
})

describe("artifact MCP tools", () => {
  test("artifact_open posts the file and returns the review viewUrl", async () => {
    setArtifactEnv()
    const calls: Array<{ url: string; method: string; body?: unknown; auth?: string; redirect?: string }> = []
    globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({
        url: url.toString(),
        method: init?.method ?? "GET",
        body: typeof init?.body === "string" ? JSON.parse(init.body) as unknown : undefined,
        auth: init?.headers instanceof Headers
          ? init.headers.get("authorization") ?? undefined
          : (init?.headers as Record<string, string> | undefined)?.Authorization,
        redirect: init?.redirect,
      })
      return Response.json({
        sessionId: "sess-1",
        key: "artifact-key",
        viewUrl: "https://ai.example/artifact/sess-1/artifact-key",
      })
    }) as unknown as typeof fetch

    const { result, json } = await callTool("artifact_open", { file: "src/App.tsx" })

    expect(result.isError).toBeUndefined()
    expect(json).toEqual({
      viewUrl: "https://ai.example/artifact/sess-1/artifact-key",
      next_step: "Tell the user to review at the Artifact panel, then call artifact_poll.",
    })
    expect(calls).toEqual([
      {
        url: "https://ai.example/api/artifact/sess-1/open",
        method: "POST",
        body: { file: "src/App.tsx" },
        auth: "Bearer tok-artifact",
        redirect: "error",
      },
    ])
  })

  test("artifact_poll returns the human feedback payload", async () => {
    setArtifactEnv()
    const feedback = {
      status: "ready",
      prompts: ["Please tighten the spacing around the CTA."],
      layout_warnings: [{ severity: "warn", message: "CTA overlaps on mobile" }],
      dom_snapshot: { title: "Preview", buttons: ["Buy now"] },
      next_step: "Make the requested UI fix and reply.",
    }
    const calls: Array<{ url: string; method: string; auth?: string; redirect?: string }> = []
    globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({
        url: url.toString(),
        method: init?.method ?? "GET",
        auth: init?.headers instanceof Headers
          ? init.headers.get("authorization") ?? undefined
          : (init?.headers as Record<string, string> | undefined)?.Authorization,
        redirect: init?.redirect,
      })
      return Response.json(feedback)
    }) as unknown as typeof fetch

    const { result, json } = await callTool("artifact_poll", {})

    expect(result.isError).toBeUndefined()
    expect(json).toEqual(feedback)
    expect(calls).toEqual([
      {
        url: "https://ai.example/api/artifact/sess-1/poll",
        method: "GET",
        auth: "Bearer tok-artifact",
        redirect: "error",
      },
    ])
  })

  test("returns isError when the ai-or-die environment trio is missing", async () => {
    clearArtifactEnv()

    for (const name of ["artifact_open", "artifact_poll", "artifact_reply"]) {
      const { result, json } = await callTool(name, { file: "src/App.tsx", text: "done" })

      expect(result.isError).toBe(true)
      expect(json).toEqual({
        error: {
          code: "NOT_IN_AIORDIE_TAB",
          message:
            "artifact tools only work inside an ai-or-die tab-backed Claude session. Missing AIORDIE_BASE_URL, AIORDIE_TOKEN, or AIORDIE_SESSION_ID.",
        },
      })
    }
  })
})
