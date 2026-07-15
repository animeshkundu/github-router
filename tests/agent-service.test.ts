import { test, expect, mock, beforeEach, afterEach } from "bun:test"

import { ghGraphQL } from "~/lib/agent/graphql"
import { ghRest } from "~/lib/agent/rest"
import {
  assignAgent,
  configureBranchProtection,
  createRelease,
  createRepo,
  ensureEnvironment,
  fetchLiveText,
  findAgentPRs,
  getBranchRuleset,
  getCodeScanningAlertCount,
  getCommunityProfile,
  getDependabotAlertCount,
  getLatestDeploymentStatus,
  getLatestRelease,
  getPagesStatus,
  getPullRequestDiffContent,
  getPullRequestDiffSummary,
  getRequiredChecksForSha,
  getReviewComments,
  getWorkflowRunFailedLogs,
  listInboundIssues,
  listInboundPRs,
  markReadyForReview,
  mergePullRequest,
  repoHasWorkflows,
  resolveAgentRoster,
  setPagesSource,
  updateBranch,
  updateRepoSettings,
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

test("updateBranch binds the expected head and treats 422 as non-fatal", async () => {
  const successFetch = mock((_url: string, _init?: RequestInit) =>
    jsonResponse({ message: "Updating pull request branch." }, { status: 202 }),
  )
  setFetch(successFetch)
  expect(await updateBranch(repo, 12, "head-12")).toEqual({
    updated: true,
    message: "Updating pull request branch.",
  })
  expect(String(successFetch.mock.calls[0][0])).toEndWith("/repos/octo/hello/pulls/12/update-branch")
  expect((successFetch.mock.calls[0][1] as RequestInit).method).toBe("PUT")
  expect(JSON.parse(String((successFetch.mock.calls[0][1] as RequestInit).body))).toEqual({
    expected_head_sha: "head-12",
  })

  const movedFetch = mock(() => jsonResponse({ message: "Head branch was modified" }, { status: 422 }))
  setFetch(movedFetch)
  expect(await updateBranch(repo, 12, "old-head")).toEqual({
    updated: false,
    message: "Head branch was modified",
  })
})

test("listInboundIssues paginates, excludes PR-shaped issues, and fails closed", async () => {
  const fetchMock = mock((url: string) => {
    if (pageOf(url) === 1) {
      return jsonResponse([
        ...Array.from({ length: 99 }, (_, number) => ({
          number,
          title: `Issue ${number}`,
          user: { login: "octocat", type: "User" },
          labels: [{ name: "bug" }],
          created_at: "2026-01-01",
          updated_at: "2026-01-02",
        })),
        { number: 100, title: "PR", pull_request: {}, user: { login: "bot[bot]", type: "Bot" } },
      ])
    }
    return jsonResponse([{
      number: 101,
      title: "Second page",
      user: { login: "dependabot[bot]", type: "Bot" },
      labels: ["dependencies"],
      created_at: "2026-01-03",
      updated_at: "2026-01-04",
    }])
  })
  setFetch(fetchMock)
  const result = await listInboundIssues(repo)
  expect(result).toHaveLength(100)
  expect(result.at(-1)).toEqual({
    number: 101,
    title: "Second page",
    authorLogin: "dependabot[bot]",
    isBot: true,
    labels: ["dependencies"],
    createdAt: "2026-01-03",
    updatedAt: "2026-01-04",
  })
  expect(String(fetchMock.mock.calls[1][0])).toContain("issues?state=open&per_page=100&page=2")

  setFetch(mock(() => jsonResponse({ message: "boom" }, { status: 500 })))
  await expectAgentCode(listInboundIssues(repo), "UPSTREAM")
})

test("listInboundPRs maps draft, bot, labels, and head sha and propagates errors", async () => {
  const fetchMock = mock((_url: string, _init?: RequestInit) => jsonResponse([{
    number: 7,
    title: "Bump dependency",
    user: { login: "dependabot[bot]", type: "Bot" },
    labels: [{ name: "dependencies" }],
    draft: true,
    head: { sha: "pr-sha" },
    created_at: "2026-02-01",
    updated_at: "2026-02-02",
  }]))
  setFetch(fetchMock)
  expect(await listInboundPRs(repo)).toEqual([{
    number: 7,
    title: "Bump dependency",
    authorLogin: "dependabot[bot]",
    isBot: true,
    labels: ["dependencies"],
    isDraft: true,
    createdAt: "2026-02-01",
    updatedAt: "2026-02-02",
    headSha: "pr-sha",
  }])
  expect((fetchMock.mock.calls[0][1] as RequestInit).method).toBe("GET")
  expect(String(fetchMock.mock.calls[0][0])).toContain("pulls?state=open&per_page=100&page=1")

  setFetch(mock(() => jsonResponse({ message: "forbidden" }, { status: 403 })))
  await expectAgentCode(listInboundPRs(repo), "NO_WRITE_ACCESS")
})

test("configureBranchProtection creates or updates a named repository ruleset", async () => {
  let call = 0
  const createFetch = mock((_url: string, _init?: RequestInit) => {
    call += 1
    return call === 1 ? jsonResponse([]) : jsonResponse({ id: 44 })
  })
  setFetch(createFetch)
  expect(await configureBranchProtection(repo, "main", {
    requiredStatusCheckContexts: ["ci/windows", "ci/linux"],
    strict: true,
    requiredApprovingReviewCount: 2,
    requireLinearHistory: true,
    requireConversationResolution: true,
  })).toEqual({ rulesetId: 44, action: "created" })
  expect((createFetch.mock.calls[1][1] as RequestInit).method).toBe("POST")
  const createBody = JSON.parse(String((createFetch.mock.calls[1][1] as RequestInit).body))
  expect(createBody).toMatchObject({
    name: "first-mate:main",
    target: "branch",
    conditions: { ref_name: { include: ["refs/heads/main"], exclude: [] } },
  })
  expect(createBody.rules[0].parameters).toEqual({
    required_status_checks: [{ context: "ci/windows" }, { context: "ci/linux" }],
    strict_required_status_checks_policy: true,
  })

  call = 0
  const updateFetch = mock((_url: string, _init?: RequestInit) => {
    call += 1
    return call === 1
      ? jsonResponse([{ id: 45, name: "first-mate:main", target: "branch" }])
      : jsonResponse({ id: 45 })
  })
  setFetch(updateFetch)
  expect((await configureBranchProtection(repo, "main", {
    requiredStatusCheckContexts: [],
    strict: false,
    requiredApprovingReviewCount: 0,
    requireLinearHistory: false,
    requireConversationResolution: false,
  })).action).toBe("updated")
  expect((updateFetch.mock.calls[1][1] as RequestInit).method).toBe("PUT")
  expect(String(updateFetch.mock.calls[1][0])).toEndWith("/rulesets/45")

  setFetch(mock(() => jsonResponse({ message: "denied" }, { status: 403 })))
  await expectAgentCode(configureBranchProtection(repo, "main", {
    requiredStatusCheckContexts: [],
    strict: false,
    requiredApprovingReviewCount: 0,
    requireLinearHistory: false,
    requireConversationResolution: false,
  }), "NO_WRITE_ACCESS")
})

test("ensureEnvironment PUTs optional protection fields and propagates errors", async () => {
  const fetchMock = mock((_url: string, _init?: RequestInit) =>
    jsonResponse({ name: "production" }, { status: 201 }),
  )
  setFetch(fetchMock)
  expect(await ensureEnvironment(repo, "production", {
    waitTimer: 10,
    reviewers: [{ type: "Team", id: 17 }],
    preventSelfReview: true,
  })).toEqual({ name: "production", created: true })
  expect(String(fetchMock.mock.calls[0][0])).toEndWith("/environments/production")
  expect((fetchMock.mock.calls[0][1] as RequestInit).method).toBe("PUT")
  expect(JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body))).toEqual({
    wait_timer: 10,
    reviewers: [{ type: "Team", id: 17 }],
    prevent_self_review: true,
  })

  setFetch(mock(() => jsonResponse({ message: "invalid" }, { status: 422 })))
  await expectAgentCode(ensureEnvironment(repo, "production"), "UPSTREAM")
})

test("createRelease maps input fields and getLatestRelease returns null on 404", async () => {
  const createFetch = mock((_url: string, _init?: RequestInit) => jsonResponse({
    id: 8,
    tag_name: "v1.2.3",
    html_url: "https://github.test/release/8",
  }, { status: 201 }))
  setFetch(createFetch)
  expect(await createRelease(repo, {
    tagName: "v1.2.3",
    targetCommitish: "main",
    name: "Release 1.2.3",
    body: "Notes",
    draft: false,
    prerelease: true,
    generateReleaseNotes: true,
  })).toEqual({ id: 8, tagName: "v1.2.3", url: "https://github.test/release/8" })
  expect((createFetch.mock.calls[0][1] as RequestInit).method).toBe("POST")
  expect(JSON.parse(String((createFetch.mock.calls[0][1] as RequestInit).body))).toEqual({
    tag_name: "v1.2.3",
    target_commitish: "main",
    name: "Release 1.2.3",
    body: "Notes",
    draft: false,
    prerelease: true,
    generate_release_notes: true,
  })

  setFetch(mock(() => jsonResponse({ message: "invalid tag" }, { status: 422 })))
  await expectAgentCode(createRelease(repo, { tagName: "invalid" }), "UPSTREAM")

  setFetch(mock(() => jsonResponse({ message: "not found" }, { status: 404 })))
  expect(await getLatestRelease(repo)).toBeNull()
})

test("getLatestRelease maps the latest release and propagates non-404 errors", async () => {
  const fetchMock = mock((_url: string, _init?: RequestInit) => jsonResponse({
    id: 9,
    tag_name: "v2",
    html_url: "https://github.test/release/9",
  }))
  setFetch(fetchMock)
  expect(await getLatestRelease(repo)).toEqual({
    id: 9,
    tagName: "v2",
    url: "https://github.test/release/9",
    isLatest: true,
  })
  expect((fetchMock.mock.calls[0][1] as RequestInit).method).toBe("GET")
  expect(String(fetchMock.mock.calls[0][0])).toEndWith("/releases/latest")

  setFetch(mock(() => jsonResponse({ message: "boom" }, { status: 500 })))
  await expectAgentCode(getLatestRelease(repo), "UPSTREAM")
})

test("updateRepoSettings PATCHes provided fields and enables private reporting", async () => {
  const fetchMock = mock((_url: string, _init?: RequestInit) => new Response(null, { status: 204 }))
  setFetch(fetchMock)
  expect(await updateRepoSettings(repo, {
    description: "Description",
    hasIssues: false,
    securityAndAnalysis: {
      secretScanning: "enabled",
      secretScanningPushProtection: "enabled",
    },
    enablePrivateVulnerabilityReporting: true,
  })).toEqual({
    appliedFields: [
      "description",
      "has_issues",
      "security_and_analysis.secret_scanning",
      "security_and_analysis.secret_scanning_push_protection",
      "private_vulnerability_reporting",
    ],
  })
  expect((fetchMock.mock.calls[0][1] as RequestInit).method).toBe("PATCH")
  expect(JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body))).toEqual({
    description: "Description",
    has_issues: false,
    security_and_analysis: {
      secret_scanning: { status: "enabled" },
      secret_scanning_push_protection: { status: "enabled" },
    },
  })
  expect((fetchMock.mock.calls[1][1] as RequestInit).method).toBe("PUT")
  expect(String(fetchMock.mock.calls[1][0])).toEndWith("/private-vulnerability-reporting")

  setFetch(mock(() => jsonResponse({ message: "denied" }, { status: 403 })))
  await expectAgentCode(updateRepoSettings(repo, { homepage: "https://example.test" }), "NO_WRITE_ACCESS")
})

test("setPagesSource posts workflow or legacy source and propagates errors", async () => {
  const workflowFetch = mock((_url: string, _init?: RequestInit) =>
    jsonResponse({ html_url: "https://octo.test/hello" }, { status: 201 }),
  )
  setFetch(workflowFetch)
  expect(await setPagesSource(repo, { buildType: "workflow" })).toEqual({
    configured: true,
    url: "https://octo.test/hello",
  })
  expect((workflowFetch.mock.calls[0][1] as RequestInit).method).toBe("POST")
  expect(JSON.parse(String((workflowFetch.mock.calls[0][1] as RequestInit).body))).toEqual({
    build_type: "workflow",
  })

  const legacyFetch = mock((_url: string, _init?: RequestInit) => jsonResponse({}))
  setFetch(legacyFetch)
  await setPagesSource(repo, { buildType: "legacy", branch: "main", path: "/docs" })
  expect(JSON.parse(String((legacyFetch.mock.calls[0][1] as RequestInit).body))).toEqual({
    build_type: "legacy",
    source: { branch: "main", path: "/docs" },
  })

  setFetch(mock(() => jsonResponse({ message: "exists" }, { status: 409 })))
  await expectAgentCode(setPagesSource(repo, { buildType: "workflow" }), "UPSTREAM")
})

test("createRepo selects personal or org endpoint, maps fields, and types 422", async () => {
  const fetchMock = mock((_url: string, _init?: RequestInit) => jsonResponse({
    owner: { login: "acme" }, name: "new-repo", html_url: "https://github.test/acme/new-repo",
    default_branch: "main",
  }, { status: 201 }))
  setFetch(fetchMock)
  expect(await createRepo({
    org: "acme", name: "new-repo", private: true, description: "D", autoInit: true,
    gitignoreTemplate: "Node", licenseTemplate: "mit",
  })).toEqual({
    owner: "acme", name: "new-repo", url: "https://github.test/acme/new-repo", defaultBranch: "main",
  })
  expect(String(fetchMock.mock.calls[0][0])).toEndWith("/orgs/acme/repos")
  expect((fetchMock.mock.calls[0][1] as RequestInit).method).toBe("POST")
  expect(JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body))).toEqual({
    name: "new-repo", private: true, description: "D", auto_init: true,
    gitignore_template: "Node", license_template: "mit",
  })
  setFetch(mock(() => jsonResponse({ message: "exists" }, { status: 422 })))
  await expect(createRepo({ name: "new-repo" })).rejects.toMatchObject({ code: "already-exists" })
})

test("getWorkflowRunFailedLogs maps failed steps and annotations and truncates", async () => {
  setFetch(routedFetch((url) => {
    if (url.includes("/jobs")) return jsonResponse({ jobs: [
      { id: 10, check_run_id: 88, name: "windows", html_url: "https://ci/job", conclusion: "failure",
        steps: [{ name: "Checkout", conclusion: "success" }, { name: "Test", conclusion: "failure" }] },
      { id: 11, name: "linux", conclusion: "success" },
    ] })
    if (url.includes("/check-runs/88/annotations")) return jsonResponse([
      { path: "src/a.ts", start_line: 7, annotation_level: "failure", message: "x".repeat(400) },
      { path: "src/b.ts", start_line: 8, annotation_level: "warning", message: "second" },
    ])
    throw new Error(`unexpected fetch ${url}`)
  }))
  const detail = await getWorkflowRunFailedLogs(repo, 9, { maxBytes: 1100, maxAnnotations: 1 })
  expect(detail.failingJobs).toEqual([{ name: "windows", url: "https://ci/job", failedSteps: ["Test"] }])
  expect(detail.annotations).toHaveLength(1)
  expect(detail.annotations[0]).toMatchObject({ path: "src/a.ts", line: 7, level: "failure" })
  expect(detail.truncated).toBe(true)
})

test("getPullRequestDiffContent includes patches, paginates defensively, and truncates", async () => {
  const fetchMock = mock((_url: string, _init?: RequestInit) => jsonResponse([
    { filename: "src/a.ts", status: "modified", additions: 2, deletions: 1, patch: "+".repeat(2000) },
    { filename: "src/b.ts", status: "added", additions: 1, deletions: 0, patch: "+b" },
  ]))
  setFetch(fetchMock)
  const result = await getPullRequestDiffContent(repo, 5, { maxBytes: 1500, maxPatchBytes: 700 })
  expect(result.files[0]).toMatchObject({ filename: "src/a.ts", status: "modified", additions: 2, deletions: 1 })
  expect(result.files[0]?.patch).toBeDefined()
  expect(Buffer.byteLength(result.files[0]?.patch ?? "")).toBeLessThanOrEqual(700)
  expect(result.truncated).toBe(true)
  expect(String(fetchMock.mock.calls[0][0])).toContain("pulls/5/files?per_page=100&page=1")
})

test("getReviewComments maps inline location, author, and bounded body", async () => {
  const fetchMock = mock((_url: string, _init?: RequestInit) => jsonResponse([{ path: "src/a.ts", line: null, original_line: 4,
    user: { login: "reviewer" }, body: "x".repeat(5000) }]))
  setFetch(fetchMock)
  const comments = await getReviewComments(repo, 3)
  expect(comments).toHaveLength(1)
  expect(comments[0]).toMatchObject({ path: "src/a.ts", line: 4, author: "reviewer" })
  expect(comments[0]?.bodyExcerpt).toHaveLength(4000)
  expect(String(fetchMock.mock.calls[0][0])).toContain("/pulls/3/comments?per_page=100")
})

test("getBranchRuleset summarizes rule types, checks, strictness, and reviews", async () => {
  const fetchMock = mock((_url: string, _init?: RequestInit) => jsonResponse([
    { type: "required_status_checks", parameters: { required_status_checks: [{ context: "ci/windows" }], strict_required_status_checks_policy: true } },
    { type: "pull_request", parameters: { required_approving_review_count: 2 } },
  ]))
  setFetch(fetchMock)
  expect(await getBranchRuleset(repo, "main")).toEqual({
    ruleTypes: ["required_status_checks", "pull_request"], requiredChecks: ["ci/windows"],
    strict: true, requiredApprovingReviewCount: 2,
  })
  expect(String(fetchMock.mock.calls[0][0])).toEndWith("/rules/branches/main")
})

test("security alert counts read Link totals and degrade disabled APIs non-fatally", async () => {
  const fetchMock = mock((url: string) => url.includes("code-scanning")
    ? jsonResponse([{}], { headers: { link: '<https://api.github.test/x?page=42>; rel="last"' } })
    : jsonResponse({ message: "disabled" }, { status: 403 }))
  setFetch(fetchMock)
  expect(await getCodeScanningAlertCount(repo)).toEqual({ enabled: true, count: 42 })
  expect(await getDependabotAlertCount(repo)).toEqual({ enabled: false })
  expect(String(fetchMock.mock.calls[0][0])).toContain("code-scanning/alerts?state=open&per_page=1")
})

test("getCommunityProfile maps health and file presence", async () => {
  const fetchMock = mock((_url: string, _init?: RequestInit) => jsonResponse({ health_percentage: 80, files: { readme: { url: "x" }, code_of_conduct: null } }))
  setFetch(fetchMock)
  expect(await getCommunityProfile(repo)).toEqual({
    healthPercentage: 80, files: { readme: true, code_of_conduct: false },
  })
  expect(String(fetchMock.mock.calls[0][0])).toEndWith("/community/profile")
})

test("getPagesStatus maps enabled status and treats 404 as disabled", async () => {
  const fetchMock = mock(() => jsonResponse({ status: "built", cname: "docs.test", html_url: "https://docs.test", build_type: "workflow" }))
  setFetch(fetchMock)
  expect(await getPagesStatus(repo)).toEqual({ enabled: true, status: "built", cname: "docs.test", htmlUrl: "https://docs.test", buildType: "workflow" })
  setFetch(mock(() => jsonResponse({ message: "none" }, { status: 404 })))
  expect(await getPagesStatus(repo)).toEqual({ enabled: false })
})

test("getLatestDeploymentStatus reads latest deployment then latest status", async () => {
  setFetch(routedFetch((url) => {
    if (url.includes("/deployments?")) return jsonResponse([{ id: 77, environment: "production" }])
    if (url.includes("/deployments/77/statuses")) return jsonResponse([{ state: "success", environment_url: "https://live.test", created_at: "2026-07-14" }])
    throw new Error(`unexpected fetch ${url}`)
  }))
  expect(await getLatestDeploymentStatus(repo, { environment: "production" })).toEqual({
    environment: "production", state: "success", targetUrl: "https://live.test", createdAt: "2026-07-14",
  })
  setFetch(mock(() => jsonResponse([])))
  expect(await getLatestDeploymentStatus(repo)).toBeNull()
})

test("fetchLiveText follows redirects, bounds text, and never throws on network error", async () => {
  const fetchMock = mock((_url: string, init?: RequestInit) => {
    expect(init?.redirect).toBe("follow")
    return new Response("x".repeat(3000), { status: 200 })
  })
  setFetch(fetchMock)
  const result = await fetchLiveText("https://live.test", { maxBytes: 1024 })
  expect(result.ok).toBe(true)
  expect(Buffer.byteLength(result.text)).toBe(1024)
  setFetch(mock(() => Promise.reject(new Error("offline"))))
  expect(await fetchLiveText("https://offline.test", { timeoutMs: 100 })).toEqual({
    ok: false, status: 0, text: "", finalUrl: "https://offline.test",
  })
})
