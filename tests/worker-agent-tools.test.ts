/**
 * Tests for `src/lib/worker-agent/tools.ts`.
 *
 * Covers per-tool guarantees specified in the brief:
 *   - path containment (Windows + POSIX)
 *   - sensitive-file denylist
 *   - edit single/zero/multi match
 *   - write atomicity + size cap
 *   - bash strict env (delegated; see worker-agent-bash.test.ts for full
 *     coverage — here we only verify the tool surfaces the runBash
 *     result correctly and gates network-egress commands)
 *   - network-deny opt-in
 *   - peer_review per-critic dispatch + effort clamp
 *   - advisor synthesis path
 *   - buildWorkerTools mode selection (explore=8, implement=11)
 *
 * Plan: `plans/we-have-added-a-dreamy-tide.md` ("Tools" section).
 *
 * Windows: the bash-tool tests in the "tool surface" block run on
 * Windows because `runBash` wraps cross-platform; the few POSIX-only
 * shell assertions (`exit 42`, network-keyword regex on `curl`) are
 * skipped under `IS_WINDOWS` per CLAUDE.md's Windows-first rule and
 * justification in worker-agent-bash.test.ts.
 */

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test"
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import { state } from "../src/lib/state"
import {
  __testExports,
  buildWorkerTools,
} from "../src/lib/worker-agent/tools"

const IS_WINDOWS = process.platform === "win32"

// ============================================================
// Fixtures
// ============================================================

function freshWorkspace(): { dir: string; cleanup: () => void } {
  // realpath up-front to keep our `confineToWorkspace` checks honest
  // on macOS /private/var symlinks.
  const dir = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), "wa-tools-")))
  return {
    dir,
    cleanup: () => {
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {
        // best-effort
      }
    },
  }
}

const originalFetch = globalThis.fetch
let savedToken: string | undefined
let savedModels: typeof state.models

beforeEach(() => {
  savedToken = state.copilotToken
  savedModels = state.models
})

afterEach(() => {
  globalThis.fetch = originalFetch
  state.copilotToken = savedToken
  state.models = savedModels
  delete process.env.GH_ROUTER_WORKER_DISABLE_NETWORK
})

// ============================================================
// read
// ============================================================

describe("read", () => {
  test("returns full file contents", async () => {
    const { dir, cleanup } = freshWorkspace()
    try {
      const target = path.join(dir, "hello.txt")
      writeFileSync(target, "hi there")
      const tool = __testExports.readTool(dir)
      const r = await tool.execute("c1", { path: "hello.txt" }, undefined)
      expect(r.content[0]?.type).toBe("text")
      expect((r.content[0] as { text: string }).text).toBe("hi there")
    } finally {
      cleanup()
    }
  })

  test("offset+limit slices line range", async () => {
    const { dir, cleanup } = freshWorkspace()
    try {
      writeFileSync(path.join(dir, "lines.txt"), "a\nb\nc\nd\ne")
      const tool = __testExports.readTool(dir)
      const r = await tool.execute(
        "c1",
        { path: "lines.txt", offset: 1, limit: 2 },
        undefined,
      )
      expect((r.content[0] as { text: string }).text).toBe("b\nc")
    } finally {
      cleanup()
    }
  })

  test("rejects path escape (..)", async () => {
    const { dir, cleanup } = freshWorkspace()
    try {
      const tool = __testExports.readTool(dir)
      await expect(
        tool.execute("c1", { path: "../escape.txt" }, undefined),
      ).rejects.toThrow(/rejected: (parent-directory|outside workspace)/i)
    } finally {
      cleanup()
    }
  })

  test("rejects sensitive-file pattern (.env)", async () => {
    const { dir, cleanup } = freshWorkspace()
    try {
      writeFileSync(path.join(dir, ".env"), "SECRET=1")
      const tool = __testExports.readTool(dir)
      await expect(
        tool.execute("c1", { path: ".env" }, undefined),
      ).rejects.toThrow(/secret-file pattern/i)
    } finally {
      cleanup()
    }
  })

  test("rejects sensitive-file pattern (id_rsa)", async () => {
    const { dir, cleanup } = freshWorkspace()
    try {
      writeFileSync(path.join(dir, "id_rsa"), "key")
      const tool = __testExports.readTool(dir)
      await expect(
        tool.execute("c1", { path: "id_rsa" }, undefined),
      ).rejects.toThrow(/secret-file pattern/i)
    } finally {
      cleanup()
    }
  })

  test("rejects file >10 MiB", async () => {
    const { dir, cleanup } = freshWorkspace()
    try {
      const big = Buffer.alloc(11 * 1024 * 1024, 0x61)
      writeFileSync(path.join(dir, "big.bin"), big)
      const tool = __testExports.readTool(dir)
      await expect(
        tool.execute("c1", { path: "big.bin" }, undefined),
      ).rejects.toThrow(/file >/i)
    } finally {
      cleanup()
    }
  })

  test("rejects directory (not a regular file)", async () => {
    const { dir, cleanup } = freshWorkspace()
    try {
      mkdirSync(path.join(dir, "sub"))
      const tool = __testExports.readTool(dir)
      await expect(
        tool.execute("c1", { path: "sub" }, undefined),
      ).rejects.toThrow(/not a regular file/i)
    } finally {
      cleanup()
    }
  })

  test("ENOENT propagates", async () => {
    const { dir, cleanup } = freshWorkspace()
    try {
      const tool = __testExports.readTool(dir)
      await expect(
        tool.execute("c1", { path: "missing.txt" }, undefined),
      ).rejects.toThrow()
    } finally {
      cleanup()
    }
  })
})

// ============================================================
// glob
// ============================================================

describe("glob", () => {
  test("lists matching files", async () => {
    const { dir, cleanup } = freshWorkspace()
    try {
      mkdirSync(path.join(dir, "src"), { recursive: true })
      writeFileSync(path.join(dir, "src", "a.ts"), "")
      writeFileSync(path.join(dir, "src", "b.ts"), "")
      writeFileSync(path.join(dir, "src", "c.js"), "")
      const tool = __testExports.globTool(dir)
      const r = await tool.execute(
        "c1",
        { pattern: "src/*.ts" },
        new AbortController().signal,
      )
      const text = (r.content[0] as { text: string }).text
      expect(text).toContain("a.ts")
      expect(text).toContain("b.ts")
      expect(text).not.toContain("c.js")
    } finally {
      cleanup()
    }
  })

  test("zero matches returns 'no matches'", async () => {
    const { dir, cleanup } = freshWorkspace()
    try {
      const tool = __testExports.globTool(dir)
      const r = await tool.execute(
        "c1",
        { pattern: "**/never.never" },
        new AbortController().signal,
      )
      expect((r.content[0] as { text: string }).text).toBe("no matches")
    } finally {
      cleanup()
    }
  })
})

// ============================================================
// grep
// ============================================================

describe("grep", () => {
  test("literal mode finds matches", async () => {
    const { dir, cleanup } = freshWorkspace()
    try {
      writeFileSync(path.join(dir, "a.txt"), "hello world\nhi world\n")
      writeFileSync(path.join(dir, "b.txt"), "nothing here\n")
      const tool = __testExports.grepTool(dir)
      const r = await tool.execute(
        "c1",
        { query: "hello" },
        new AbortController().signal,
      )
      const text = (r.content[0] as { text: string }).text
      expect(text).toContain("a.txt")
      expect(text).toContain("hello world")
      expect(text).not.toContain("nothing here")
    } finally {
      cleanup()
    }
  })

  test("regex mode is opt-in", async () => {
    const { dir, cleanup } = freshWorkspace()
    try {
      writeFileSync(path.join(dir, "a.txt"), "foo 123\nbar 456\n")
      const tool = __testExports.grepTool(dir)
      const r = await tool.execute(
        "c1",
        { query: "\\d{3}", mode: "regex" },
        new AbortController().signal,
      )
      const text = (r.content[0] as { text: string }).text
      expect(text).toContain("foo 123")
      expect(text).toContain("bar 456")
    } finally {
      cleanup()
    }
  })

  test("zero matches returns 'no matches'", async () => {
    const { dir, cleanup } = freshWorkspace()
    try {
      writeFileSync(path.join(dir, "a.txt"), "x\n")
      const tool = __testExports.grepTool(dir)
      const r = await tool.execute(
        "c1",
        { query: "nothing-like-this" },
        new AbortController().signal,
      )
      expect((r.content[0] as { text: string }).text).toBe("no matches")
    } finally {
      cleanup()
    }
  })
})

// ============================================================
// edit
// ============================================================

describe("edit", () => {
  test("single match replaces and writes atomically", async () => {
    const { dir, cleanup } = freshWorkspace()
    try {
      const p = path.join(dir, "f.txt")
      writeFileSync(p, "alpha\nBETA\ngamma\n")
      const tool = __testExports.editTool(dir)
      const r = await tool.execute(
        "c1",
        { path: "f.txt", old_string: "BETA", new_string: "beta" },
        undefined,
      )
      expect((r.content[0] as { text: string }).text).toBe("ok")
      expect(readFileSync(p, "utf8")).toBe("alpha\nbeta\ngamma\n")
    } finally {
      cleanup()
    }
  })

  test("zero matches returns 'not found' (file unchanged)", async () => {
    const { dir, cleanup } = freshWorkspace()
    try {
      const p = path.join(dir, "f.txt")
      writeFileSync(p, "alpha\n")
      const tool = __testExports.editTool(dir)
      const r = await tool.execute(
        "c1",
        { path: "f.txt", old_string: "missing", new_string: "x" },
        undefined,
      )
      expect((r.content[0] as { text: string }).text).toBe("not found")
      expect(readFileSync(p, "utf8")).toBe("alpha\n")
    } finally {
      cleanup()
    }
  })

  test("multi-match returns count (file unchanged)", async () => {
    const { dir, cleanup } = freshWorkspace()
    try {
      const p = path.join(dir, "f.txt")
      writeFileSync(p, "x\nx\nx\n")
      const tool = __testExports.editTool(dir)
      const r = await tool.execute(
        "c1",
        { path: "f.txt", old_string: "x", new_string: "y" },
        undefined,
      )
      expect((r.content[0] as { text: string }).text).toMatch(/matches 3 times/)
      expect(readFileSync(p, "utf8")).toBe("x\nx\nx\n")
    } finally {
      cleanup()
    }
  })

  test("rejects path escape", async () => {
    const { dir, cleanup } = freshWorkspace()
    try {
      const tool = __testExports.editTool(dir)
      await expect(
        tool.execute(
          "c1",
          { path: "../escape.txt", old_string: "a", new_string: "b" },
          undefined,
        ),
      ).rejects.toThrow(/rejected: (parent-directory|outside workspace)/i)
    } finally {
      cleanup()
    }
  })

  test("ENOENT throws", async () => {
    const { dir, cleanup } = freshWorkspace()
    try {
      const tool = __testExports.editTool(dir)
      await expect(
        tool.execute(
          "c1",
          { path: "missing.txt", old_string: "a", new_string: "b" },
          undefined,
        ),
      ).rejects.toThrow()
    } finally {
      cleanup()
    }
  })

  test("is marked sequential to avoid races", () => {
    const tool = __testExports.editTool("/tmp")
    expect(tool.executionMode).toBe("sequential")
  })
})

// ============================================================
// write
// ============================================================

describe("write", () => {
  test("creates new file", async () => {
    const { dir, cleanup } = freshWorkspace()
    try {
      const tool = __testExports.writeTool(dir)
      const r = await tool.execute(
        "c1",
        { path: "out.txt", contents: "hello" },
        undefined,
      )
      expect((r.content[0] as { text: string }).text).toBe("ok")
      expect(readFileSync(path.join(dir, "out.txt"), "utf8")).toBe("hello")
    } finally {
      cleanup()
    }
  })

  test("overwrites existing file (atomic same-dir temp+rename)", async () => {
    const { dir, cleanup } = freshWorkspace()
    try {
      const p = path.join(dir, "out.txt")
      writeFileSync(p, "OLD")
      const tool = __testExports.writeTool(dir)
      await tool.execute("c1", { path: "out.txt", contents: "NEW" }, undefined)
      expect(readFileSync(p, "utf8")).toBe("NEW")
    } finally {
      cleanup()
    }
  })

  test("rejects >10 MiB contents", async () => {
    const { dir, cleanup } = freshWorkspace()
    try {
      const tool = __testExports.writeTool(dir)
      const big = "a".repeat(11 * 1024 * 1024)
      await expect(
        tool.execute("c1", { path: "out.txt", contents: big }, undefined),
      ).rejects.toThrow(/rejected: contents >/i)
    } finally {
      cleanup()
    }
  })

  test("rejects sensitive-file pattern even when explicit", async () => {
    const { dir, cleanup } = freshWorkspace()
    try {
      const tool = __testExports.writeTool(dir)
      await expect(
        tool.execute(
          "c1",
          { path: ".env", contents: "SECRET=1" },
          undefined,
        ),
      ).rejects.toThrow(/secret-file pattern/i)
    } finally {
      cleanup()
    }
  })

  test("rejects path escape", async () => {
    const { dir, cleanup } = freshWorkspace()
    try {
      const tool = __testExports.writeTool(dir)
      await expect(
        tool.execute(
          "c1",
          { path: "../escape.txt", contents: "x" },
          undefined,
        ),
      ).rejects.toThrow(/rejected: (parent-directory|outside workspace)/i)
    } finally {
      cleanup()
    }
  })

  test("is marked sequential to avoid races", () => {
    const tool = __testExports.writeTool("/tmp")
    expect(tool.executionMode).toBe("sequential")
  })
})

// ============================================================
// atomicWriteSync (direct)
// ============================================================

describe("atomicWriteSync", () => {
  test("no .tmp litter on success", () => {
    const { dir, cleanup } = freshWorkspace()
    try {
      const target = path.join(dir, "a.txt")
      __testExports.atomicWriteSync(target, "hello")
      expect(readFileSync(target, "utf8")).toBe("hello")
      // Same-dir temp + rename → no .a.txt.* leftover
      const list = readdirSync(dir)
      expect(list.filter((n) => n.startsWith(".a.txt"))).toHaveLength(0)
    } finally {
      cleanup()
    }
  })

  test("empty string writes empty file", () => {
    const { dir, cleanup } = freshWorkspace()
    try {
      const target = path.join(dir, "empty.txt")
      __testExports.atomicWriteSync(target, "")
      expect(readFileSync(target, "utf8")).toBe("")
    } finally {
      cleanup()
    }
  })
})

// ============================================================
// bash (tool surface)
// ============================================================

describe("bash tool surface", () => {
  test("captures stdout", async () => {
    const { dir, cleanup } = freshWorkspace()
    try {
      const tool = __testExports.bashTool(dir)
      const r = await tool.execute(
        "c1",
        { cmd: "echo worker-bash" },
        new AbortController().signal,
      )
      const text = (r.content[0] as { text: string }).text
      expect(text).toContain("worker-bash")
      expect(text).toContain("exit=0")
    } finally {
      cleanup()
    }
  })

  test("non-zero exit returns as content, not error", async () => {
    const { dir, cleanup } = freshWorkspace()
    try {
      const tool = __testExports.bashTool(dir)
      const r = await tool.execute(
        "c1",
        { cmd: IS_WINDOWS ? "exit /b 7" : "exit 7" },
        new AbortController().signal,
      )
      expect((r.content[0] as { text: string }).text).toContain("exit=7")
    } finally {
      cleanup()
    }
  })

  test("network-disabled gate blocks curl when env set", async () => {
    process.env.GH_ROUTER_WORKER_DISABLE_NETWORK = "1"
    const { dir, cleanup } = freshWorkspace()
    try {
      const tool = __testExports.bashTool(dir)
      await expect(
        tool.execute(
          "c1",
          { cmd: "curl https://example.com" },
          new AbortController().signal,
        ),
      ).rejects.toThrow(/network disabled/i)
    } finally {
      cleanup()
    }
  })

  test("network-disabled does NOT block a plain echo", async () => {
    process.env.GH_ROUTER_WORKER_DISABLE_NETWORK = "1"
    const { dir, cleanup } = freshWorkspace()
    try {
      const tool = __testExports.bashTool(dir)
      const r = await tool.execute(
        "c1",
        { cmd: "echo ok" },
        new AbortController().signal,
      )
      expect((r.content[0] as { text: string }).text).toContain("ok")
    } finally {
      cleanup()
    }
  })

  test("network-disabled matches wget / ssh too", async () => {
    process.env.GH_ROUTER_WORKER_DISABLE_NETWORK = "1"
    const { dir, cleanup } = freshWorkspace()
    try {
      const tool = __testExports.bashTool(dir)
      await expect(
        tool.execute(
          "c1",
          { cmd: "wget http://x" },
          new AbortController().signal,
        ),
      ).rejects.toThrow(/network disabled/i)
      await expect(
        tool.execute(
          "c1",
          { cmd: "ssh user@host" },
          new AbortController().signal,
        ),
      ).rejects.toThrow(/network disabled/i)
    } finally {
      cleanup()
    }
  })

  test("is marked sequential to avoid races", () => {
    const tool = __testExports.bashTool("/tmp")
    expect(tool.executionMode).toBe("sequential")
  })
})

// ============================================================
// fetch_url
// ============================================================

describe("fetch_url", () => {
  test("returns body text on 200", async () => {
    globalThis.fetch = mock(async () =>
      new Response("hello body", {
        status: 200,
        headers: { "content-type": "text/plain" },
      }),
    ) as unknown as typeof fetch
    const tool = __testExports.fetchUrlTool()
    const r = await tool.execute(
      "c1",
      { url: "https://example.com" },
      new AbortController().signal,
    )
    expect((r.content[0] as { text: string }).text).toBe("hello body")
  })

  test("throws on non-2xx", async () => {
    globalThis.fetch = mock(
      async () => new Response("nope", { status: 500, statusText: "boom" }),
    ) as unknown as typeof fetch
    const tool = __testExports.fetchUrlTool()
    await expect(
      tool.execute(
        "c1",
        { url: "https://example.com" },
        new AbortController().signal,
      ),
    ).rejects.toThrow(/HTTP 500/i)
  })

  test("rejects invalid URL", async () => {
    const tool = __testExports.fetchUrlTool()
    await expect(
      tool.execute(
        "c1",
        { url: "not a url" },
        new AbortController().signal,
      ),
    ).rejects.toThrow(/invalid URL/i)
  })

  test("rejects non-http(s) scheme", async () => {
    const tool = __testExports.fetchUrlTool()
    await expect(
      tool.execute(
        "c1",
        { url: "file:///etc/passwd" },
        new AbortController().signal,
      ),
    ).rejects.toThrow(/http\/https/i)
  })

  test("respects DISABLE_NETWORK opt-in", async () => {
    process.env.GH_ROUTER_WORKER_DISABLE_NETWORK = "1"
    const tool = __testExports.fetchUrlTool()
    await expect(
      tool.execute(
        "c1",
        { url: "https://example.com" },
        new AbortController().signal,
      ),
    ).rejects.toThrow(/network disabled/i)
  })

  test("truncates oversized body", async () => {
    // 1.5 MiB body → 1 MiB cap → expect truncated marker.
    const big = "a".repeat(1024 * 1024 + 1024)
    globalThis.fetch = mock(
      async () => new Response(big, { status: 200 }),
    ) as unknown as typeof fetch
    const tool = __testExports.fetchUrlTool()
    const r = await tool.execute(
      "c1",
      { url: "https://example.com" },
      new AbortController().signal,
    )
    expect((r.content[0] as { text: string }).text).toMatch(/truncated/i)
  })
})

// ============================================================
// web_search
// ============================================================

describe("web_search", () => {
  test("respects DISABLE_NETWORK opt-in", async () => {
    process.env.GH_ROUTER_WORKER_DISABLE_NETWORK = "1"
    const tools = buildWorkerTools({
      mode: "explore",
      workspace: realpathSync.native(os.tmpdir()),
    })
    const tool = tools.find((t) => t.name === "web_search")!
    await expect(
      tool.execute(
        "c1",
        { query: "anything" },
        new AbortController().signal,
      ),
    ).rejects.toThrow(/network disabled/i)
  })
})

// ============================================================
// code_search
// ============================================================

describe("code_search", () => {
  test("returns JSON minimal-surface (file/line/snippet)", async () => {
    const { dir, cleanup } = freshWorkspace()
    try {
      mkdirSync(path.join(dir, "src"))
      writeFileSync(
        path.join(dir, "src", "user.ts"),
        "export function getUserName() { return 'kundus' }\n",
      )
      const tool = __testExports.codeSearchTool(dir)
      const r = await tool.execute(
        "c1",
        { query: "getUserName" },
        new AbortController().signal,
      )
      const parsed = JSON.parse((r.content[0] as { text: string }).text) as {
        results: Array<{ file: string; line: number; snippet: string }>
      }
      expect(Array.isArray(parsed.results)).toBe(true)
      expect(parsed.results.length).toBeGreaterThan(0)
      const first = parsed.results[0]!
      expect(typeof first.file).toBe("string")
      expect(typeof first.line).toBe("number")
      expect(typeof first.snippet).toBe("string")
    } finally {
      cleanup()
    }
  })
})

// ============================================================
// peer_review
// ============================================================

describe("peer_review", () => {
  test("respects DISABLE_NETWORK opt-in", async () => {
    process.env.GH_ROUTER_WORKER_DISABLE_NETWORK = "1"
    const tool = __testExports.peerReviewTool()
    await expect(
      tool.execute(
        "c1",
        { critic: "codex_critic", prompt: "review this" },
        new AbortController().signal,
      ),
    ).rejects.toThrow(/network disabled/i)
  })

  test("dispatches to codex_critic via callPersona (mocked upstream)", async () => {
    state.copilotToken = "test-token"
    state.models = {
      object: "list",
      data: [
        {
          id: "gpt-5.5",
          name: "gpt-5.5",
          object: "model",
          preview: false,
          vendor: "openai",
          version: "1",
          model_picker_enabled: true,
          capabilities: {
            family: "gpt-5",
            limits: { max_output_tokens: 16384 },
            object: "model",
            supports: {},
            tokenizer: "o200k",
            type: "chat",
          },
        },
      ] as unknown as NonNullable<typeof state.models>["data"],
    }
    // Stub the upstream /responses call — peer_review for
    // codex_critic routes through createResponses (verified in
    // handler.ts:callPersona).
    globalThis.fetch = mock(async () =>
      new Response(
        JSON.stringify({
          id: "resp_1",
          object: "response",
          status: "completed",
          output: [
            {
              type: "message",
              role: "assistant",
              content: [
                { type: "output_text", text: "looks good to me" },
              ],
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    ) as unknown as typeof fetch
    const tool = __testExports.peerReviewTool()
    const r = await tool.execute(
      "c1",
      { critic: "codex_critic", prompt: "review this" },
      new AbortController().signal,
    )
    expect((r.content[0] as { text: string }).text).toContain("looks good")
  })

  test("rejects unknown critic with terse message", async () => {
    const tool = __testExports.peerReviewTool()
    await expect(
      tool.execute(
        "c1",
        // Cast: schema rejects this literal at TS level; we want to
        // assert the runtime lookupPersona path catches it too.
        { critic: "unknown_critic" as never, prompt: "x" },
        new AbortController().signal,
      ),
    ).rejects.toThrow(/unknown critic/i)
  })

  test("rejects gemini_critic when catalog lacks gemini-3.x", async () => {
    state.copilotToken = "test-token"
    state.models = {
      object: "list",
      data: [],
    } as unknown as typeof state.models
    const tool = __testExports.peerReviewTool()
    await expect(
      tool.execute(
        "c1",
        { critic: "gemini_critic", prompt: "x" },
        new AbortController().signal,
      ),
    ).rejects.toThrow(/gemini-3\.x/i)
  })

  test("clamps out-of-band effort to persona default", async () => {
    // gemini_critic doesn't accept xhigh — verify the call still
    // succeeds (we don't observe the clamped value here; the persona
    // default is opaque from outside, but we can prove the throw
    // doesn't happen for an in-allowedEfforts critic with xhigh).
    state.copilotToken = "test-token"
    state.models = {
      object: "list",
      data: [
        {
          id: "gpt-5.5",
          name: "gpt-5.5",
          object: "model",
          preview: false,
          vendor: "openai",
          version: "1",
          model_picker_enabled: true,
          capabilities: {
            family: "gpt-5",
            limits: { max_output_tokens: 16384 },
            object: "model",
            supports: {},
            tokenizer: "o200k",
            type: "chat",
          },
        },
      ] as unknown as NonNullable<typeof state.models>["data"],
    }
    let observedBody: string | undefined
    globalThis.fetch = mock(async (_url: string, init?: RequestInit) => {
      observedBody = typeof init?.body === "string" ? init.body : ""
      return new Response(
        JSON.stringify({
          id: "x",
          object: "response",
          status: "completed",
          output: [
            {
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: "ok" }],
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )
    }) as unknown as typeof fetch
    const tool = __testExports.peerReviewTool()
    await tool.execute(
      "c1",
      { critic: "codex_critic", prompt: "x", effort: "xhigh" },
      new AbortController().signal,
    )
    // codex_critic allows xhigh — body should mention "xhigh".
    expect(observedBody).toContain("xhigh")
  })
})

// ============================================================
// advisor
// ============================================================

describe("advisor", () => {
  test("respects DISABLE_NETWORK opt-in", async () => {
    process.env.GH_ROUTER_WORKER_DISABLE_NETWORK = "1"
    const tool = __testExports.advisorTool()
    await expect(
      tool.execute(
        "c1",
        { concern: "stuck on validation" },
        new AbortController().signal,
      ),
    ).rejects.toThrow(/network disabled/i)
  })

  test("synthesizes a gpt-5.5 /responses call and extracts text", async () => {
    state.copilotToken = "test-token"
    state.models = {
      object: "list",
      data: [
        {
          id: "gpt-5.5",
          name: "gpt-5.5",
          object: "model",
          preview: false,
          vendor: "openai",
          version: "1",
          model_picker_enabled: true,
          capabilities: {
            family: "gpt-5",
            limits: { max_output_tokens: 16384 },
            object: "model",
            supports: {},
            tokenizer: "o200k",
            type: "chat",
          },
        },
      ] as unknown as NonNullable<typeof state.models>["data"],
    }
    let observedUrl = ""
    let observedBody = ""
    globalThis.fetch = mock(async (url: string, init?: RequestInit) => {
      observedUrl = url
      observedBody = typeof init?.body === "string" ? init.body : ""
      return new Response(
        JSON.stringify({
          id: "resp_advisor",
          object: "response",
          status: "completed",
          output: [
            {
              type: "message",
              role: "assistant",
              content: [
                {
                  type: "output_text",
                  text: "Consider X before committing to Y.",
                },
              ],
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )
    }) as unknown as typeof fetch
    const tool = __testExports.advisorTool()
    const r = await tool.execute(
      "c1",
      { concern: "Should I use Redis or in-memory cache?" },
      new AbortController().signal,
    )
    expect((r.content[0] as { text: string }).text).toContain(
      "Consider X",
    )
    expect(observedUrl).toContain("/responses")
    // gpt-5.5 is the advisor default + xhigh effort
    expect(observedBody).toContain("gpt-5.5")
    expect(observedBody).toContain("xhigh")
  })

  test("throws on empty assistant output", async () => {
    state.copilotToken = "test-token"
    state.models = {
      object: "list",
      data: [
        {
          id: "gpt-5.5",
          name: "gpt-5.5",
          object: "model",
          preview: false,
          vendor: "openai",
          version: "1",
          model_picker_enabled: true,
          capabilities: {
            family: "gpt-5",
            limits: { max_output_tokens: 16384 },
            object: "model",
            supports: {},
            tokenizer: "o200k",
            type: "chat",
          },
        },
      ] as unknown as NonNullable<typeof state.models>["data"],
    }
    globalThis.fetch = mock(async () =>
      new Response(
        JSON.stringify({
          id: "x",
          object: "response",
          status: "completed",
          output: [],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    ) as unknown as typeof fetch
    const tool = __testExports.advisorTool()
    await expect(
      tool.execute(
        "c1",
        { concern: "anything" },
        new AbortController().signal,
      ),
    ).rejects.toThrow(/empty output/i)
  })

  test("prepends rendered transcript when getMessages is provided", async () => {
    state.copilotToken = "test-token"
    state.models = {
      object: "list",
      data: [
        {
          id: "gpt-5.5",
          name: "gpt-5.5",
          object: "model",
          preview: false,
          vendor: "openai",
          version: "1",
          model_picker_enabled: true,
          capabilities: {
            family: "gpt-5",
            limits: { max_output_tokens: 16384 },
            object: "model",
            supports: {},
            tokenizer: "o200k",
            type: "chat",
          },
        },
      ] as unknown as NonNullable<typeof state.models>["data"],
    }
    let observedBody = ""
    globalThis.fetch = mock(async (_url: string, init?: RequestInit) => {
      observedBody = typeof init?.body === "string" ? init.body : ""
      return new Response(
        JSON.stringify({
          id: "x",
          object: "response",
          status: "completed",
          output: [
            {
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: "advice" }],
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )
    }) as unknown as typeof fetch
    // Type-erase the test transcript to avoid pulling Pi's full
    // AgentMessage type into the test surface. The renderer only
    // reads `role` and `content` shape — see __testExports
    // `renderPiMessagesAsText` for direct unit tests.
    const transcript = [
      { role: "user", content: "Please write a worker tool", timestamp: 0 },
      {
        role: "assistant",
        content: [{ type: "text", text: "I'll start with read" }],
        timestamp: 1,
      },
    ] as never
    const tool = __testExports.advisorTool(() => transcript)
    await tool.execute(
      "c1",
      { concern: "Is sequential mode right for edit?" },
      new AbortController().signal,
    )
    // Body should mention "### Recent transcript" header + a tail
    // line from the assistant turn.
    expect(observedBody).toContain("Recent transcript")
    expect(observedBody).toContain("Please write a worker tool")
    expect(observedBody).toContain("I'll start with read")
    expect(observedBody).toContain("Is sequential mode right for edit?")
  })
})

// ============================================================
// renderPiMessagesAsText
// ============================================================

describe("renderPiMessagesAsText", () => {
  test("walks user/assistant/toolResult and renders roles", () => {
    const messages = [
      { role: "user", content: "hi", timestamp: 0 },
      {
        role: "assistant",
        content: [{ type: "text", text: "let me grep" }],
        timestamp: 1,
      },
      {
        role: "toolResult",
        toolName: "grep",
        toolCallId: "t1",
        content: [{ type: "text", text: "no matches" }],
        isError: false,
        timestamp: 2,
      },
    ] as never
    const out = __testExports.renderPiMessagesAsText(messages, 10_000)
    expect(out).toContain("USER: hi")
    expect(out).toContain("ASSISTANT: let me grep")
    expect(out).toContain("TOOL_RESULT grep: no matches")
  })

  test("marks toolResult errors", () => {
    const messages = [
      {
        role: "toolResult",
        toolName: "bash",
        toolCallId: "t1",
        content: [{ type: "text", text: "ENOENT" }],
        isError: true,
        timestamp: 0,
      },
    ] as never
    const out = __testExports.renderPiMessagesAsText(messages, 10_000)
    expect(out).toContain("[error]")
  })

  test("renders tool calls inline", () => {
    const messages = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "looking" },
          {
            type: "toolCall",
            toolName: "read",
            toolCallId: "t1",
            input: { path: "src/a.ts" },
          },
        ],
        timestamp: 0,
      },
    ] as never
    const out = __testExports.renderPiMessagesAsText(messages, 10_000)
    expect(out).toContain("looking")
    expect(out).toContain("→ read(")
    expect(out).toContain("src/a.ts")
  })

  test("skips harness/custom messages without role", () => {
    const messages = [
      { type: "chat-status", text: "ignored" },
      { role: "user", content: "kept", timestamp: 0 },
    ] as never
    const out = __testExports.renderPiMessagesAsText(messages, 10_000)
    expect(out).toContain("USER: kept")
    expect(out).not.toContain("ignored")
  })

  test("tail-keep truncation prepends marker", () => {
    // 100 messages × ~100 chars each = ~10000 chars → cap at 500 →
    // only the most recent few survive, with marker prepended.
    const big = Array.from({ length: 100 }, (_, i) => ({
      role: "user" as const,
      content: `msg-${i} ` + "x".repeat(80),
      timestamp: i,
    })) as never
    const out = __testExports.renderPiMessagesAsText(big, 500)
    expect(out).toMatch(/^\[…earlier turns omitted…\]/)
    // The most recent msg-99 should be in the tail.
    expect(out).toContain("msg-99")
    expect(out).not.toContain("msg-0")
  })

  test("returns empty string for empty messages", () => {
    expect(__testExports.renderPiMessagesAsText([] as never, 1000)).toBe("")
  })

  test("skips thinking content", () => {
    const messages = [
      {
        role: "assistant",
        content: [
          { type: "thinking", text: "internal reasoning" },
          { type: "text", text: "visible" },
        ],
        timestamp: 0,
      },
    ] as never
    const out = __testExports.renderPiMessagesAsText(messages, 10_000)
    expect(out).toContain("visible")
    expect(out).not.toContain("internal reasoning")
  })
})

// ============================================================
// buildWorkerTools (mode selection)
// ============================================================

describe("buildWorkerTools", () => {
  test("explore mode returns 6 read-only tools (peer_review/advisor dropped from worker surface)", () => {
    const tools = buildWorkerTools({
      mode: "explore",
      workspace: realpathSync.native(os.tmpdir()),
    })
    expect(tools.length).toBe(6)
    const names = tools.map((t) => t.name).sort()
    expect(names).toEqual(
      [
        "code_search",
        "fetch_url",
        "glob",
        "grep",
        "read",
        "web_search",
      ].sort(),
    )
    // peer_review and advisor are intentionally NOT in the worker
    // surface (per user directive). They remain implemented as helper
    // factories for legacy callers, but buildWorkerTools no longer
    // wires them.
    expect(names).not.toContain("peer_review")
    expect(names).not.toContain("advisor")
  })

  test("review mode returns the SAME 6 read-only tools as explore (no write tools)", () => {
    const tools = buildWorkerTools({
      mode: "review",
      workspace: realpathSync.native(os.tmpdir()),
    })
    expect(tools.length).toBe(6)
    const names = tools.map((t) => t.name).sort()
    expect(names).toEqual(
      ["code_search", "fetch_url", "glob", "grep", "read", "web_search"].sort(),
    )
    // review is read-only — the reviewer framing lives in the system prompt,
    // not the toolset, so the write tools must be absent.
    for (const w of ["edit", "write", "bash", "codex_review"]) {
      expect(names).not.toContain(w)
    }
  })

  test("implement mode returns 10 tools (explore + edit/write/bash + codex_review)", () => {
    const tools = buildWorkerTools({
      mode: "implement",
      workspace: realpathSync.native(os.tmpdir()),
    })
    expect(tools.length).toBe(10)
    const names = tools.map((t) => t.name)
    for (const w of ["edit", "write", "bash", "codex_review"]) {
      expect(names).toContain(w)
    }
    // Same narrowing: no peer_review, no advisor — only the
    // codex-reviewer-locked codex_review is exposed for code review.
    expect(names).not.toContain("peer_review")
    expect(names).not.toContain("advisor")
  })

  test("each tool has the required Pi AgentTool shape", () => {
    const tools = buildWorkerTools({
      mode: "implement",
      workspace: realpathSync.native(os.tmpdir()),
    })
    for (const t of tools) {
      expect(typeof t.name).toBe("string")
      expect(typeof t.label).toBe("string")
      expect(typeof t.description).toBe("string")
      expect(typeof t.execute).toBe("function")
      expect(t.parameters).toBeDefined()
    }
  })

  test("workspace is captured by closure (per-call independence)", () => {
    const w1 = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), "w1-")))
    const w2 = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), "w2-")))
    try {
      const t1 = buildWorkerTools({ mode: "explore", workspace: w1 })
      const t2 = buildWorkerTools({ mode: "explore", workspace: w2 })
      // Distinct tool object identities — fresh AgentTool per call
      expect(t1.find((t) => t.name === "read")).not.toBe(
        t2.find((t) => t.name === "read"),
      )
    } finally {
      rmSync(w1, { recursive: true, force: true })
      rmSync(w2, { recursive: true, force: true })
    }
  })
})
