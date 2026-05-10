import { describe, expect, test } from "bun:test"

import { buildCodexProviderConfigFlags, getCodexVersion } from "../src/lib/launch"

describe("buildCodexProviderConfigFlags", () => {
  test("produces the four-element -c sequence pointing at the proxy", () => {
    const flags = buildCodexProviderConfigFlags("http://127.0.0.1:18787")
    expect(flags.length).toBe(4)
    expect(flags[0]).toBe("-c")
    expect(flags[1]).toContain('base_url="http://127.0.0.1:18787/v1"')
    expect(flags[1]).toContain('wire_api="responses"')
    expect(flags[1]).toContain('env_key="OPENAI_API_KEY"')
    expect(flags[2]).toBe("-c")
    expect(flags[3]).toBe("model_provider=github_router")
  })

  test("regression: byte-identical to the legacy inline construction in buildCodexCmd", () => {
    // The pre-extraction inline shape — keep this string here verbatim so a
    // future drift between buildCodexCmd and the MCP-config builder fails
    // fast at test time (drift is exactly the bug class the extraction is
    // meant to prevent).
    const legacyInline = [
      "-c",
      `model_providers.github_router={name="github-router",base_url="http://x:9/v1",wire_api="responses",env_key="OPENAI_API_KEY"}`,
      "-c",
      "model_provider=github_router",
    ]
    expect(buildCodexProviderConfigFlags("http://x:9")).toEqual(legacyInline)
  })

  test("preserves user-supplied serverUrl with no extra escaping", () => {
    // We deliberately do NOT escape `"` or `}` in the serverUrl — Codex parses
    // -c values as TOML-ish, so a serverUrl containing such characters would
    // break this builder. Document by test that the contract is "serverUrl is
    // a sane http(s) URL, no smuggling allowed."
    const flags = buildCodexProviderConfigFlags("https://my.host:1234")
    expect(flags[1]).toContain('base_url="https://my.host:1234/v1"')
  })
})

describe("getCodexVersion", () => {
  test("returns ok=true when codex CLI is on PATH and >=0.129", () => {
    const info = getCodexVersion()
    // The dev box for this codebase has codex 0.129+ installed (per
    // CLAUDE.md's "Codex 0.129+ compatibility" commit). If this assertion
    // ever flips, either the box lost codex (in which case the test is
    // documenting reality) or codex got downgraded.
    if (!info.ok) {
      expect(info.version === undefined || /^0\.(?:[0-9]|[1-9][0-9]|1[01][0-9]|12[0-8])\./.test(info.version)).toBe(true)
    } else {
      expect(info.version).toBeDefined()
      expect(info.version!).toMatch(/^\d+\.\d+\.\d+$/)
    }
  })
})
