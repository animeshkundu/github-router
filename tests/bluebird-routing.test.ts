import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import { BluebirdError, type BluebirdMcpClient } from "../src/lib/bluebird-client"
import {
  buildBluebirdCodeModeDescription,
  buildBluebirdCodeToolDescription,
} from "../src/lib/peer-mcp-personas"
import { parseSharedArgs, resolveSearchFlags } from "../src/lib/server-setup"
import { state } from "../src/lib/state"
import { runUnifiedCodeSearch } from "../src/lib/unified-code-search"

function stubClient(impl: {
  searchFileContent?: (query: string) => Promise<Array<{ file: string; line: number; snippet: string }>>
  doVectorSearch?: (query: string) => Promise<Array<{ file: string; line: number; snippet: string }>>
}): BluebirdMcpClient {
  return {
    searchFileContent: async (query: string) =>
      impl.searchFileContent?.(query) ?? [],
    doVectorSearch: async (query: string) =>
      impl.doVectorSearch?.(query) ?? [],
  } as unknown as BluebirdMcpClient
}

describe("resolveSearchFlags (--bluebird implies --search)", () => {
  const OLD_BLUEBIRD = process.env.GH_ROUTER_ENABLE_BLUEBIRD
  const OLD_SEARCH = process.env.GH_ROUTER_ENABLE_SEMANTIC_SEARCH
  afterEach(() => {
    if (OLD_BLUEBIRD === undefined) delete process.env.GH_ROUTER_ENABLE_BLUEBIRD
    else process.env.GH_ROUTER_ENABLE_BLUEBIRD = OLD_BLUEBIRD
    if (OLD_SEARCH === undefined) delete process.env.GH_ROUTER_ENABLE_SEMANTIC_SEARCH
    else process.env.GH_ROUTER_ENABLE_SEMANTIC_SEARCH = OLD_SEARCH
  })

  test("bluebird on forces search on", () => {
    delete process.env.GH_ROUTER_ENABLE_BLUEBIRD
    delete process.env.GH_ROUTER_ENABLE_SEMANTIC_SEARCH
    expect(resolveSearchFlags({ searchEnabled: false, bluebirdEnabled: true })).toEqual({
      searchEnabled: true,
      bluebirdEnabled: true,
    })
  })

  test("both off stays off", () => {
    delete process.env.GH_ROUTER_ENABLE_BLUEBIRD
    delete process.env.GH_ROUTER_ENABLE_SEMANTIC_SEARCH
    expect(resolveSearchFlags({ searchEnabled: false, bluebirdEnabled: false })).toEqual({
      searchEnabled: false,
      bluebirdEnabled: false,
    })
  })

  test("search alone does not enable bluebird", () => {
    delete process.env.GH_ROUTER_ENABLE_BLUEBIRD
    delete process.env.GH_ROUTER_ENABLE_SEMANTIC_SEARCH
    expect(resolveSearchFlags({ searchEnabled: true, bluebirdEnabled: false })).toEqual({
      searchEnabled: true,
      bluebirdEnabled: false,
    })
  })

  test("GH_ROUTER_ENABLE_BLUEBIRD=1 enables both", () => {
    process.env.GH_ROUTER_ENABLE_BLUEBIRD = "1"
    delete process.env.GH_ROUTER_ENABLE_SEMANTIC_SEARCH
    expect(resolveSearchFlags({ searchEnabled: false, bluebirdEnabled: false })).toEqual({
      searchEnabled: true,
      bluebirdEnabled: true,
    })
  })
})

describe("parseSharedArgs bluebird flag", () => {
  test("parses --bluebird", () => {
    const parsed = parseSharedArgs({ bluebird: true } as Record<string, unknown>)
    expect(parsed.bluebirdEnabled).toBe(true)
  })

  test("defaults to falsy when absent", () => {
    const parsed = parseSharedArgs({} as Record<string, unknown>)
    expect(parsed.bluebirdEnabled).toBeFalsy()
  })
})

describe("runUnifiedCodeSearch bluebird routing", () => {
  const OLD_BLUEBIRD_ENABLED = state.bluebirdEnabled
  const OLD_CLIENT = state.bluebirdClient
  beforeEach(() => {
    state.bluebirdEnabled = true
  })
  afterEach(() => {
    state.bluebirdEnabled = OLD_BLUEBIRD_ENABLED
    state.bluebirdClient = OLD_CLIENT
  })

  test("semantic routes to do_vector_search with source semantic", async () => {
    state.bluebirdClient = stubClient({
      doVectorSearch: async () => [
        { file: "src/auth.ts", line: 42, snippet: "refresh tokens here" },
      ],
    })
    const res = await runUnifiedCodeSearch({
      query: "where are auth tokens refreshed",
      workspace: "/tmp/bluebird-test-ws",
    })
    expect(res.source).toBe("semantic")
    expect(res.results).toHaveLength(1)
    expect(res.results[0].file).toBe("src/auth.ts")
    expect(res.results[0].line).toBe(42)
  })

  test("explicit lexical routes to search_file_content with source lexical", async () => {
    state.bluebirdClient = stubClient({
      searchFileContent: async () => [
        { file: "src/main.ts", line: 7, snippet: "getUserName" },
      ],
    })
    const res = await runUnifiedCodeSearch({
      query: "getUserName",
      workspace: "/tmp/bluebird-test-ws",
      mode: "lexical",
    })
    expect(res.source).toBe("lexical")
    expect(res.results).toHaveLength(1)
    expect(res.results[0].file).toBe("src/main.ts")
  })

  test("bluebird failure surfaces source error with no silent fallback", async () => {
    state.bluebirdClient = stubClient({
      doVectorSearch: async () => {
        throw new BluebirdError("Bluebird responded with HTTP 503.", { retriable: true })
      },
    })
    const res = await runUnifiedCodeSearch({
      query: "anything",
      workspace: "/tmp/bluebird-test-ws",
      mode: "semantic",
    })
    expect(res.source).toBe("error")
    expect(res.results).toEqual([])
    expect(res.notice).toContain("503")
    expect(res.notice).toContain("no local fallback")
  })

  test("exact stays local under --bluebird", async () => {
    state.bluebirdClient = stubClient({
      // If exact ever reached Bluebird, this throw would surface as error.
      searchFileContent: async () => {
        throw new BluebirdError("must not be called for exact", { retriable: false })
      },
      doVectorSearch: async () => {
        throw new BluebirdError("must not be called for exact", { retriable: false })
      },
    })
    const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "gh-router-bb-")))
    try {
      writeFileSync(path.join(root, "needle.ts"), "const uniqueNeedleXyz = 1\n")
      const res = await runUnifiedCodeSearch({
        query: "uniqueNeedleXyz",
        workspace: root,
        mode: "exact",
      })
      expect(res.source).toBe("lexical")
      expect(res.results.length).toBeGreaterThan(0)
      expect(res.results[0].file).toContain("needle.ts")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe("bluebird tool descriptions", () => {
  test("tool description documents bluebird paths and error source", () => {
    const desc = buildBluebirdCodeToolDescription()
    expect(desc).toContain("Bluebird")
    expect(desc).toContain('"error"')
    expect(desc).toContain("exact")
  })

  test("mode description documents local exact/regex/ast", () => {
    const desc = buildBluebirdCodeModeDescription()
    expect(desc).toContain("Bluebird")
    expect(desc).toContain("local")
  })
})
