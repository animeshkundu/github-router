import { test, expect, mock, beforeEach, afterEach } from "bun:test"

import { ghGraphQL } from "~/lib/agent/graphql"
import { ghRest } from "~/lib/agent/rest"
import {
  assignAgent,
  findAgentPRs,
  getPullRequestDiffSummary,
  getRequiredChecksForSha,
  markReadyForReview,
  mergePullRequest,
  repoHasWorkflows,
  resolveAgentRoster,
  __resetAgentServiceCachesForTests,
} from "~/lib/agent/service"
import { getTask, startTask } from "~/lib/agent/tasks"
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


test("findAgentPRs extracts a constrained unit-id marker without HTML-comment over-capture", async () => {
  const fetchMock = mock(() =>
    jsonResponse([
      {
        number: 10,
        user: { login: "Copilot" },
        head: { sha: "h10", ref: "copilot/marker" },
        body: "<!-- unit-id:abc-123--></p>",
      },
    ]),
  )
  setFetch(fetchMock)

  expect(await findAgentPRs({ owner: "octo", repo: "r" }, {
    issueNumber: 0,
    botLogin: "copilot-swe-agent",
  })).toEqual([{
    number: 10,
    headSha: "h10",
    headRef: "copilot/marker",
    isDraft: false,
    unitIdMarker: "abc-123",
  }])
})

test("getRequiredChecksForSha excludes the Copilot review-bot check-run from CI rollup", async () => {
  // The copilot-pull-request-reviewer check-run is a review marker, not a test —
  // counting it would report "passing" for a PR whose real CI never ran.
  const onlyReviewer = mock(() =>
    jsonResponse({
      check_runs: [
        { id: 1, name: "copilot-pull-request-reviewer", status: "completed", conclusion: "success" },
      ],
    }),
  )
  setFetch(onlyReviewer)
  expect((await getRequiredChecksForSha(repo, "sha1")).rollup).toBe("none")

  const withRealCi = mock(() =>
    jsonResponse({
      check_runs: [
        { id: 1, name: "copilot-pull-request-reviewer", status: "completed", conclusion: "success" },
        { id: 2, name: "test (3.12)", status: "completed", conclusion: "success" },
      ],
    }),
  )
  setFetch(withRealCi)
  expect((await getRequiredChecksForSha(repo, "sha2")).rollup).toBe("passing")
})

// FIX 1 — legacy Commit Status API (CircleCI/Travis) must be folded into the CI
// rollup so a red/pending REQUIRED status with ZERO check-runs can never merge.
function routedFetch(route: (url: string) => Response): typeof fetch {
  return ((input: Parameters<typeof fetch>[0]) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as Request).url
    return Promise.resolve(route(url))
  }) as unknown as typeof fetch
}

test("getRequiredChecksForSha folds a RED legacy commit status into a failing rollup", async () => {
  setFetch(
    routedFetch((url) => {
      if (url.includes("/check-runs")) return jsonResponse({ check_runs: [] })
      if (url.includes("/status")) {
        return jsonResponse({
          state: "failure",
          total_count: 1,
          statuses: [{ state: "failure", context: "ci/circleci", target_url: "https://ci/x" }],
        })
      }
      throw new Error(`unexpected fetch ${url}`)
    }),
  )
  const summary = await getRequiredChecksForSha(repo, "sha-red")
  expect(summary.rollup).toBe("failing")
  expect(summary.failing.map((f) => f.name)).toContain("ci/circleci")
})

test("getRequiredChecksForSha folds a PENDING legacy commit status into a pending rollup", async () => {
  setFetch(
    routedFetch((url) => {
      if (url.includes("/check-runs")) return jsonResponse({ check_runs: [] })
      if (url.includes("/status")) {
        return jsonResponse({
          state: "pending",
          total_count: 1,
          statuses: [{ state: "pending", context: "ci/travis" }],
        })
      }
      throw new Error(`unexpected fetch ${url}`)
    }),
  )
  expect((await getRequiredChecksForSha(repo, "sha-pending")).rollup).toBe("pending")
})

test("getRequiredChecksForSha ignores an EMPTY combined status (total_count 0) so an Actions-only repo isn't spuriously pending", async () => {
  // GitHub returns state:"pending" with total_count:0 for a commit with no
  // legacy statuses — folding that would block every modern repo.
  setFetch(
    routedFetch((url) => {
      if (url.includes("/check-runs")) return jsonResponse({ check_runs: [] })
      if (url.includes("/status")) return jsonResponse({ state: "pending", total_count: 0, statuses: [] })
      throw new Error(`unexpected fetch ${url}`)
    }),
  )
  expect((await getRequiredChecksForSha(repo, "sha-empty")).rollup).toBe("none")
})

// FIX (pagination bypass) — the check-runs API has no aggregate state, so a
// failing run on page 2+ must not be hidden by an all-green page 1.
function pageOf(url: string): number {
  return Number(new URL(url).searchParams.get("page") ?? "1")
}
function greenRun(i: number) {
  return { id: i, name: `test-${i}`, status: "completed", conclusion: "success" }
}

test("getRequiredChecksForSha enumerates every check-run page — a failing run on page 2 is not hidden by an all-green page 1", async () => {
  setFetch(
    routedFetch((url) => {
      if (url.includes("/check-runs")) {
        const page = pageOf(url)
        if (page === 1) {
          return jsonResponse({
            total_count: 150,
            check_runs: Array.from({ length: 100 }, (_, i) => greenRun(i)),
          })
        }
        // page 2: 49 green + one failing run at the tail
        return jsonResponse({
          total_count: 150,
          check_runs: [
            ...Array.from({ length: 49 }, (_, i) => greenRun(100 + i)),
            { id: 999, name: "e2e (windows-latest)", status: "completed", conclusion: "failure" },
          ],
        })
      }
      if (url.includes("/status")) return jsonResponse({ state: "success", total_count: 0, statuses: [] })
      throw new Error(`unexpected fetch ${url}`)
    }),
  )
  const summary = await getRequiredChecksForSha(repo, "sha-paged")
  expect(summary.rollup).toBe("failing")
  expect(summary.failing.map((f) => f.name)).toContain("e2e (windows-latest)")
})

test("getRequiredChecksForSha FAILS CLOSED (pending) when a repo exceeds the check-run page cap", async () => {
  // Every page is all-green, but total_count exceeds PER_PAGE * MAX_PAGES, so we
  // can never confirm the un-enumerated tail — the rollup must be pending, never
  // passing.
  setFetch(
    routedFetch((url) => {
      if (url.includes("/check-runs")) {
        return jsonResponse({
          total_count: 100_000,
          check_runs: Array.from({ length: 100 }, (_, i) => greenRun(i)),
        })
      }
      if (url.includes("/status")) return jsonResponse({ state: "success", total_count: 0, statuses: [] })
      throw new Error(`unexpected fetch ${url}`)
    }),
  )
  expect((await getRequiredChecksForSha(repo, "sha-huge")).rollup).toBe("pending")
})

test("repoHasWorkflows returns false on 404 but RE-THROWS a non-404 probe error (indeterminate, fail-safe)", async () => {
  setFetch(routedFetch(() => jsonResponse({ message: "not found" }, { status: 404 })))
  expect(await repoHasWorkflows(repo, "main")).toBe(false)

  __resetAgentServiceCachesForTests()
  state.githubAgentToken = "test-token"
  setFetch(routedFetch(() => jsonResponse({ message: "boom" }, { status: 500 })))
  await expectAgentCode(repoHasWorkflows(repo, "other-branch"), "UPSTREAM")
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

test("markReadyForReview calls the GitHub GraphQL ready-for-review mutation", async () => {
  let capturedBody: Record<string, unknown> = {}
  const fetchMock = mock((_url: string, init?: RequestInit) => {
    capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>
    return jsonResponse({
      data: {
        markPullRequestReadyForReview: {
          pullRequest: { id: "PR_node_1" },
        },
      },
    })
  })
  setFetch(fetchMock)

  const result = await markReadyForReview("PR_node_1")

  expect(result).toEqual({ ready: true })
  expect(String(capturedBody.query)).toContain("markPullRequestReadyForReview")
  expect(capturedBody.variables).toEqual({ pullRequestId: "PR_node_1" })
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

test("startTask includes the model in the POST body when provided", async () => {
  let capturedBody: unknown
  const fetchMock = mock((_url: string, init?: RequestInit) => {
    capturedBody = JSON.parse(String(init?.body))
    return jsonResponse({ task_id: "task-42", state: "queued" })
  })
  setFetch(fetchMock)

  const result = await startTask(repo, {
    prompt: "do the work",
    model: "gpt-5.5",
    createPullRequest: true,
  })

  expect(result).toEqual({ taskId: "task-42", state: "queued" })
  expect(capturedBody).toMatchObject({
    prompt: "do the work",
    model: "gpt-5.5",
    create_pull_request: true,
  })
})

test("startTask omits the model field when none is provided", async () => {
  let capturedBody: Record<string, unknown> = {}
  const fetchMock = mock((_url: string, init?: RequestInit) => {
    capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>
    return jsonResponse({ task_id: "task-43", state: "queued" })
  })
  setFetch(fetchMock)

  await startTask(repo, { prompt: "no model here" })

  expect(capturedBody.prompt).toBe("no model here")
  expect("model" in capturedBody).toBe(false)
})
