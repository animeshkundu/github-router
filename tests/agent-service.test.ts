import { test, expect, mock, beforeEach, afterEach } from "bun:test"

import { ghGraphQL } from "~/lib/agent/graphql"
import { ghRest } from "~/lib/agent/rest"
import {
  assignAgent,
  findAgentPRs,
  getPullRequestDiffSummary,
  mergePullRequest,
  resolveAgentRoster,
  __resetAgentServiceCachesForTests,
} from "~/lib/agent/service"
import { getTask } from "~/lib/agent/tasks"
import { AgentError, type AgentErrorCode, type RepoRef } from "~/lib/agent/types"
import { state } from "~/lib/state"

const originalFetch = globalThis.fetch
const repo: RepoRef = { owner: "octo", repo: "hello" }

interface TestResponseInit {
  status?: number
  headers?: Record<string, string>
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

async function expectAgentCode(
  promise: Promise<unknown>,
  code: AgentErrorCode,
): Promise<AgentError> {
  try {
    await promise
  } catch (err) {
    expect(err).toBeInstanceOf(AgentError)
    const agentErr = err as AgentError
    expect(agentErr.code).toBe(code)
    return agentErr
  }
  throw new Error(`Expected AgentError ${code}`)
}

beforeEach(() => {
  state.githubAgentToken = "test-token"
  __resetAgentServiceCachesForTests()
  globalThis.fetch = originalFetch
})

afterEach(() => {
  __resetAgentServiceCachesForTests()
  globalThis.fetch = originalFetch
})

test("ghRest maps GitHub auth, access, rate-limit, and not-found errors", async () => {
  const cases: Array<{
    status: number
    headers?: Record<string, string>
    code: AgentErrorCode
  }> = [
    { status: 401, code: "AUTH_REVOKED" },
    { status: 403, code: "NO_WRITE_ACCESS" },
    {
      status: 403,
      headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "12345" },
      code: "RATE_LIMITED",
    },
    { status: 404, code: "NOT_FOUND" },
  ]

  for (const item of cases) {
    const fetchMock = mock(() => new Response("fail", {
      status: item.status,
      headers: item.headers,
    }))
    setFetch(fetchMock)

    const err = await expectAgentCode(ghRest("GET", "/rate-test"), item.code)
    if (item.code === "RATE_LIMITED") expect(err.message).toContain("12345")
    expect(fetchMock).toHaveBeenCalledTimes(1)
  }
})

test("ghGraphQL maps preview feature and missing-field errors to GRAPHQL_FEATURE", async () => {
  const fetchMock = mock(() =>
    jsonResponse({
      errors: [
        {
          message:
            "Field 'replaceActorsForAssignable' does not exist on type 'Mutation'",
          type: "FORBIDDEN",
        },
      ],
    }),
  )
  setFetch(fetchMock)

  await expectAgentCode(ghGraphQL("query { viewer { login } }", {}), "GRAPHQL_FEATURE")
})

test("resolveAgentRoster parses agent bots and copilot login drift", async () => {
  const copilotVariants = ["copilot", "copilot-swe-agent", "Copilot"]

  for (const [index, copilotLogin] of copilotVariants.entries()) {
    const fetchMock = mock(() =>
      jsonResponse({
        data: {
          repository: {
            suggestedActors: {
              nodes: [
                { login: copilotLogin, __typename: "Bot", id: `BOT_COPILOT_${index}` },
                { login: "anthropic-code-agent", __typename: "Bot", id: "BOT_ANTHROPIC" },
                { login: "openai-code-agent", __typename: "Bot", id: "BOT_OPENAI" },
                { login: "human-user", __typename: "User", id: "USER" },
              ],
            },
          },
        },
      }),
    )
    setFetch(fetchMock)

    const roster = await resolveAgentRoster({
      owner: "octo",
      repo: `roster-${index}`,
    })

    expect(roster.get("copilot")?.login).toBe(copilotLogin)
    expect(roster.get("copilot")?.botId).toBe(`BOT_COPILOT_${index}`)
    expect(roster.get("anthropic")?.login).toBe("anthropic-code-agent")
    expect(roster.get("openai")?.login).toBe("openai-code-agent")
    expect(roster.size).toBe(3)
  }
})

test("assignAgent uses GraphQL assignment path and falls back to REST on GRAPHQL_FEATURE", async () => {
  const graphqlFetch = mock((_url: string, _init?: RequestInit) =>
    jsonResponse({
      data: {
        replaceActorsForAssignable: {
          assignable: { id: "ISSUE_NODE" },
        },
      },
    }),
  )
  setFetch(graphqlFetch)

  const graphqlResult = await assignAgent(repo, {
    issueNodeId: "ISSUE_NODE",
    issueNumber: 7,
    botId: "BOT_ID",
    botLogin: "copilot",
  })

  expect(graphqlResult).toEqual({ assigned: true, via: "graphql" })
  const graphqlInit = graphqlFetch.mock.calls[0][1] as RequestInit
  const graphqlBody = JSON.parse(String(graphqlInit.body)) as {
    variables: { issueNodeId: string; botId: string }
  }
  expect(graphqlBody.variables.issueNodeId).toBe("ISSUE_NODE")
  expect(graphqlBody.variables.botId).toBe("BOT_ID")
  expect((graphqlInit.headers as Record<string, string>)["GraphQL-Features"]).toBe(
    "issues_copilot_assignment_api_support",
  )

  let fallbackCall = 0
  const fallbackFetch = mock((_url: string, _init?: RequestInit) => {
    fallbackCall += 1
    if (fallbackCall === 1) {
      return jsonResponse({
        errors: [
          {
            message:
              "Field 'replaceActorsForAssignable' does not exist on type 'Mutation'",
          },
        ],
      })
    }
    return jsonResponse({}, { status: 201 })
  })
  setFetch(fallbackFetch)

  const fallbackResult = await assignAgent(repo, {
    issueNodeId: "ISSUE_NODE",
    issueNumber: 9,
    botId: "BOT_ID",
    botLogin: "copilot",
  })

  expect(fallbackResult).toEqual({ assigned: true, via: "rest" })
  expect(String(fallbackFetch.mock.calls[1][0])).toContain(
    "/repos/octo/hello/issues/9/assignees",
  )
  expect(JSON.parse(String((fallbackFetch.mock.calls[1][1] as RequestInit).body))).toEqual({
    assignees: ["copilot[bot]"],
  })
})

test("findAgentPRs returns 0, 1, or many PRs filtered only by author login", async () => {
  const fetchMock = mock((url: string) => {
    if (url.includes("zero")) {
      return jsonResponse([
        { number: 1, user: { login: "someone" }, head: { sha: "x", ref: "x" } },
      ])
    }
    if (url.includes("one")) {
      return jsonResponse([
        { number: 2, user: { login: "copilot" }, head: { sha: "a", ref: "agent/a" } },
        { number: 3, user: { login: "human" }, head: { sha: "b", ref: "agent/b" } },
      ])
    }
    return jsonResponse([
      { number: 4, user: { login: "copilot" }, head: { sha: "c", ref: "agent/c" } },
      { number: 5, user: { login: "copilot[bot]" }, head: { sha: "d", ref: "agent/d" }, draft: true },
      { number: 6, user: { login: "human" }, head: { sha: "e", ref: "copilot-looking-branch" } },
    ])
  })
  setFetch(fetchMock)

  expect(await findAgentPRs({ owner: "octo", repo: "zero" }, {
    issueNumber: 1,
    botLogin: "copilot",
  })).toEqual([])

  expect(await findAgentPRs({ owner: "octo", repo: "one" }, {
    issueNumber: 1,
    botLogin: "copilot",
  })).toEqual([
    { number: 2, headSha: "a", headRef: "agent/a", isDraft: false },
  ])

  expect(await findAgentPRs({ owner: "octo", repo: "many" }, {
    issueNumber: 1,
    botLogin: "copilot",
  })).toEqual([
    { number: 4, headSha: "c", headRef: "agent/c", isDraft: false },
    { number: 5, headSha: "d", headRef: "agent/d", isDraft: true },
  ])
})

test("findAgentPRs is branch-authoritative when a branch is given (author-agnostic)", async () => {
  // The cloud API authors every PR as "Copilot" regardless of model, so branch
  // is the only reliable per-task correlator. When given, it wins over author.
  const fetchMock = mock(() =>
    jsonResponse([
      { number: 2, user: { login: "Copilot" }, head: { sha: "a", ref: "copilot/modernize" } },
      { number: 3, user: { login: "Copilot" }, head: { sha: "b", ref: "copilot/add-ci" } },
    ]),
  )
  setFetch(fetchMock)

  // An anthropic unit whose PR is (per the API) authored by "Copilot" is still
  // found by its branch.
  expect(await findAgentPRs({ owner: "octo", repo: "r" }, {
    issueNumber: 0,
    botLogin: "anthropic-code-agent",
    branch: "copilot/add-ci",
  })).toEqual([{ number: 3, headSha: "b", headRef: "copilot/add-ci", isDraft: false }])
})

test("findAgentPRs matches a Copilot-authored PR to a copilot-swe-agent unit by login alias", async () => {
  // Branch-unknown fallback: author "Copilot" must map to the copilot unit
  // whose assignee login is "copilot-swe-agent".
  const fetchMock = mock(() =>
    jsonResponse([
      { number: 8, user: { login: "Copilot" }, head: { sha: "h8", ref: "copilot/x" } },
      { number: 9, user: { login: "human" }, head: { sha: "h9", ref: "feature/y" } },
    ]),
  )
  setFetch(fetchMock)

  expect(await findAgentPRs({ owner: "octo", repo: "r" }, {
    issueNumber: 0,
    botLogin: "copilot-swe-agent",
  })).toEqual([{ number: 8, headSha: "h8", headRef: "copilot/x", isDraft: false }])
})

test("getPullRequestDiffSummary is compact, omits patches, and caps files", async () => {
  const files = Array.from({ length: 60 }, (_, index) => ({
    filename: `file-${index}.ts`,
    additions: index + 1,
    deletions: 1,
    status: "modified",
    patch: "secret diff text that must not be returned",
  }))
  const fetchMock = mock(() => jsonResponse(files))
  setFetch(fetchMock)

  const summary = await getPullRequestDiffSummary(repo, 12)

  expect(summary.files).toHaveLength(50)
  expect(summary.fileCount).toBe(60)
  expect(summary.truncated).toBe(true)
  expect(summary.totalAdditions).toBe(1830)
  expect(summary.totalDeletions).toBe(60)
  expect(JSON.stringify(summary)).not.toContain("patch")
  expect(JSON.stringify(summary)).not.toContain("secret diff")
})

test("getTask hard-truncates logExcerpt and never returns the full session log", async () => {
  const log = `${"a".repeat(2500)}TAIL${"z".repeat(2500)}`
  const fetchMock = mock(() =>
    jsonResponse({
      id: "task-1",
      state: "running",
      session_log: log,
    }),
  )
  setFetch(fetchMock)

  const task = await getTask(repo, "task-1")

  expect(task.taskId).toBe("task-1")
  expect(task.state).toBe("running")
  expect(task.logExcerpt.length).toBeLessThanOrEqual(4000)
  expect(task.logExcerpt.startsWith("…[truncated]…")).toBe(true)
  expect(task.logExcerpt).not.toBe(log)
  expect(task.logExcerpt).not.toContain("a".repeat(2000))
})

test("mergePullRequest sends expected head sha and maps head-moved status to HEAD_MOVED", async () => {
  const mergeFetch = mock((_url: string, _init?: RequestInit) =>
    jsonResponse({ merged: true, sha: "merge-sha" }),
  )
  setFetch(mergeFetch)

  const result = await mergePullRequest(repo, {
    pr: 31,
    expectedHeadSha: "head-sha",
  })

  expect(result).toEqual({ merged: true, sha: "merge-sha" })
  const body = JSON.parse(String((mergeFetch.mock.calls[0][1] as RequestInit).body))
  expect(body).toEqual({ merge_method: "squash", sha: "head-sha" })

  const movedFetch = mock(() => new Response("head moved", { status: 409 }))
  setFetch(movedFetch)

  await expectAgentCode(
    mergePullRequest(repo, { pr: 31, expectedHeadSha: "old-head-sha" }),
    "HEAD_MOVED",
  )
})
