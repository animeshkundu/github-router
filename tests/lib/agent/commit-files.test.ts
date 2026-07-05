import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test"

import { commitFiles, CommitFilesError } from "~/lib/agent/service"
import { state } from "~/lib/state"

const originalFetch = globalThis.fetch

interface TestResponseInit {
  status?: number
  headers?: Record<string, string>
}

type FetchCall = [input: string, init?: RequestInit]

interface FetchMockWithCalls {
  mock: {
    calls: FetchCall[]
  }
}

function jsonResponse(body: unknown, init: TestResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status,
    headers: { "content-type": "application/json", ...init.headers },
  })
}

function setFetch(fetchMock: unknown): void {
  globalThis.fetch = fetchMock as typeof fetch
}

function callsFor(fetchMock: unknown): FetchCall[] {
  return (fetchMock as FetchMockWithCalls).mock.calls
}

function pathAndQuery(input: string): string {
  const url = new URL(input)
  return `${url.pathname}${url.search}`
}

async function expectCommitFilesCode(
  promise: Promise<unknown>,
  code: CommitFilesError["code"],
): Promise<CommitFilesError> {
  try {
    await promise
  } catch (err) {
    expect(err).toBeInstanceOf(CommitFilesError)
    const commitErr = err as CommitFilesError
    expect(commitErr.code).toBe(code)
    return commitErr
  }
  throw new Error(`Expected CommitFilesError ${code}`)
}

beforeEach(() => {
  state.githubAgentToken = "test-token"
  globalThis.fetch = originalFetch
})

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe("commitFiles add-missing-only mode", () => {
  it("preserves existing files and does not call blob/tree/commit APIs for them", async () => {
    const fetchMock = mock((input: string, init?: RequestInit) => {
      const method = init?.method ?? "GET"
      const path = pathAndQuery(input)

      if (method === "GET" && path === "/repos/owner/repo/git/ref/heads/branch") {
        return jsonResponse({ object: { sha: "abc123" } })
      }
      if (method === "GET" && path === "/repos/owner/repo/contents/EXISTING.md?ref=branch") {
        return jsonResponse({ type: "file" })
      }
      if (method === "GET" && path === "/repos/owner/repo/contents/NEW.md?ref=branch") {
        return new Response("missing", { status: 404 })
      }
      if (method === "GET" && path === "/repos/owner/repo/git/commits/abc123") {
        return jsonResponse({ tree: { sha: "tree123" } })
      }
      if (method === "POST" && path === "/repos/owner/repo/git/blobs") {
        return jsonResponse({ sha: "blob456" })
      }
      if (method === "POST" && path === "/repos/owner/repo/git/trees") {
        return jsonResponse({ sha: "newtree" })
      }
      if (method === "POST" && path === "/repos/owner/repo/git/commits") {
        return jsonResponse({ sha: "newcommit" })
      }
      if (method === "PATCH" && path === "/repos/owner/repo/git/refs/heads/branch") {
        return jsonResponse({})
      }

      return new Response(`unexpected ${method} ${path}`, { status: 500 })
    })
    setFetch(fetchMock)

    const result = await commitFiles(
      "owner/repo",
      "branch",
      [
        { path: "EXISTING.md", content: "x" },
        { path: "NEW.md", content: "y" },
      ],
      { mode: "add-missing-only" },
    )

    expect(result.preserved).toEqual(["EXISTING.md"])
    expect(result.committed).toEqual(["NEW.md"])

    const calls = callsFor(fetchMock)
    const blobCalls = calls.filter(
      ([input, init]) => init?.method === "POST" && pathAndQuery(input) === "/repos/owner/repo/git/blobs",
    )
    expect(blobCalls).toHaveLength(1)
    const blobBody = JSON.parse(String(blobCalls[0]![1]?.body)) as {
      content?: string
      encoding?: string
    }
    expect(blobBody).toEqual({
      content: Buffer.from("y", "utf8").toString("base64"),
      encoding: "base64",
    })

    const treeCall = calls.find(
      ([input, init]) => init?.method === "POST" && pathAndQuery(input) === "/repos/owner/repo/git/trees",
    )
    expect(treeCall).toBeDefined()
    const treeBody = JSON.parse(String(treeCall![1]?.body)) as {
      base_tree?: string
      tree?: Array<{ path?: string; sha?: string }>
    }
    expect(treeBody.base_tree).toBe("tree123")
    expect(treeBody.tree?.map((entry) => entry.path)).toEqual(["NEW.md"])
  })

  it("throws CommitFilesError when branch does not exist", async () => {
    const fetchMock = mock((input: string, init?: RequestInit) => {
      const method = init?.method ?? "GET"
      const path = pathAndQuery(input)
      if (method === "GET" && path === "/repos/owner/repo/git/ref/heads/missing-branch") {
        return new Response("missing", { status: 404 })
      }
      return new Response(`unexpected ${method} ${path}`, { status: 500 })
    })
    setFetch(fetchMock)

    await expectCommitFilesCode(
      commitFiles("owner/repo", "missing-branch", [{ path: "NEW.md", content: "y" }]),
      "branch-not-found",
    )
  })
})
