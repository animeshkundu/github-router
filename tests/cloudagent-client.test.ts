import { describe, expect, test } from "bun:test"

import {
  CloudAgentClient,
  CloudAgentError,
  MAX_CATALOG_TOP,
  cloudAgentBaseUrl,
  buildGenericJobRequest,
  isQueuedJob,
  isTerminalJob,
  readJob,
  readJobLogs,
  renderJob,
  renderJobPage,
  renderMetadataBrief,
  renderPluginPage,
  renderPollHint,
  renderTrace,
} from "../src/lib/cloudagent-client"

// Hermetic by construction: an injected `tokenProvider`, an injected
// `fetchImpl`, and a retry ladder of `[0]` so a retry costs no wall-clock.
// Nothing here reaches an Cloud Agent origin, `az`, or the network. The bearer
// literal is synthetic and asserted absent from every message this module can
// produce, so a leak fails loudly instead of shipping.

const SYNTHETIC_TOKEN = "synthetic-cloudagent-bearer-not-a-credential"

interface Captured {
  url: string
  method: string
  headers: Record<string, string>
  body: string | undefined
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  })
}

interface Harness {
  client: CloudAgentClient
  calls: Array<Captured>
  tokenMints: () => number
}

/**
 * A client whose `fetch` walks a scripted queue. Each entry is either a
 * `Response` factory or a thrown transport error; the queue is consumed in
 * order, and an exhausted queue is a test bug (it means the code under test
 * made a call nobody expected).
 */
function harness(
  script: Array<() => Response>,
  opts: { retryDelaysMs?: ReadonlyArray<number> } = {},
): Harness {
  const calls: Array<Captured> = []
  let mints = 0
  const client = new CloudAgentClient({
    environment: "prod",
    tokenProvider: async () => {
      mints++
      return SYNTHETIC_TOKEN
    },
    retryDelaysMs: opts.retryDelaysMs ?? [0],
    fetchImpl: (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      calls.push({
        url: String(input),
        method: init?.method ?? "GET",
        headers: { ...(init?.headers as Record<string, string>) },
        body: typeof init?.body === "string" ? init.body : undefined,
      })
      const next = script.shift()
      if (!next) throw new Error(`unexpected fetch call #${calls.length}: ${String(input)}`)
      return next()
    }) as unknown as typeof fetch,
  })
  return { client, calls, tokenMints: () => mints }
}

const REPOSITORY = {
  organization: "contoso",
  project: "platform",
  repository: "web",
} as const

/** A created-job response, in the shape the live service returns. */
const CREATED_JOB = {
  operationId: "op-1",
  jobId: "7f3a6c1e-0000-4000-8000-000000000001",
  state: "Queued",
  createdAt: "2026-10-29T10:00:00Z",
  prompt: "Fix the flaky login test",
  context: {
    repository: {
      $type: "ado",
      organization: "contoso",
      project: "platform",
      repository: "web",
      branch: "main",
    },
  },
  pipelineRun: { definitionId: 0, runId: 4123 },
}

describe("buildGenericJobRequest", () => {
  test("a prompt-only request carries no agent, plugins or model keys", () => {
    const request = buildGenericJobRequest({ prompt: "  Fix the test  ", repository: REPOSITORY })
    expect(request.prompt).toBe("Fix the test")
    expect(request.context.repository).toEqual({
      $type: "ado",
      organization: "contoso",
      project: "platform",
      repository: "web",
    })
    // Absent rather than empty: the service rejects an empty object, and an
    // omitted key is what a caller can trust.
    expect("customAgent" in request).toBe(false)
    expect("plugins" in request).toBe(false)
    expect("modelConfiguration" in request).toBe(false)
    expect("metadata" in request).toBe(false)
    expect("additionalOptions" in request).toBe(false)
  })

  test("an agent-only request needs no prompt", () => {
    const request = buildGenericJobRequest({
      repository: REPOSITORY,
      customAgent: { name: "echo", type: "Repo", inputs: { spec: "do it" } },
    })
    expect("prompt" in request).toBe(false)
    expect(request.customAgent).toEqual({ name: "echo", type: "Repo", inputs: { spec: "do it" } })
  })

  test("neither prompt nor agent is rejected before any request is made", () => {
    expect(() => buildGenericJobRequest({ prompt: "   ", repository: REPOSITORY }))
      .toThrow(/either `prompt` or `agent`/)
  })

  test("a blank branch is omitted rather than sent empty", () => {
    const request = buildGenericJobRequest({
      prompt: "x",
      repository: { ...REPOSITORY, branch: "   " },
    })
    expect("branch" in request.context.repository).toBe(false)
  })

  test("every selector round-trips into the wire body", () => {
    const request = buildGenericJobRequest({
      prompt: "x",
      repository: { ...REPOSITORY, branch: "main" },
      plugins: [{ name: "repo-search", type: "Repo" }, { name: "docs" }],
      includeDefaultPlugins: true,
      modelConfiguration: { model: "gpt-5.6-sol", reasoningEffort: "high", context: "long_context" },
      metadata: { chain: "research", step: "1" },
    })
    expect(request.context.repository.branch).toBe("main")
    expect(request.plugins).toEqual([{ name: "repo-search", type: "Repo" }, { name: "docs" }])
    expect(request.additionalOptions).toEqual({ pluginOptions: { includeDefaults: true } })
    expect(request.modelConfiguration).toEqual({
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
      context: "long_context",
    })
    expect(request.metadata).toEqual({ chain: "research", step: "1" })
  })

  test("metadata is bounded, because it is echoed on every later read", () => {
    const tooMany = Object.fromEntries(Array.from({ length: 33 }, (_, index) => [`k${index}`, "v"]))
    expect(() => buildGenericJobRequest({ prompt: "x", repository: REPOSITORY, metadata: tooMany }))
      .toThrow(/at most 32/)

    expect(() => buildGenericJobRequest({
      prompt: "x",
      repository: REPOSITORY,
      metadata: { detail: "y".repeat(300) },
    })).toThrow(/too long/)

    expect(() => buildGenericJobRequest({ prompt: "x", repository: REPOSITORY, metadata: { " ": "v" } }))
      .toThrow(/non-empty/)
  })
})

describe("createJob", () => {
  test("POSTs /v2/jobs with the bearer and returns the created job", async () => {
    const h = harness([() => jsonResponse(CREATED_JOB, { status: 201 })])
    const job = await h.client.createJob(
      buildGenericJobRequest({ prompt: "Fix the flaky login test", repository: REPOSITORY }),
    )

    expect(job.jobId).toBe(CREATED_JOB.jobId)
    expect(job.state).toBe("Queued")
    expect(job.repository).toBe("contoso/platform/web")
    expect(job.sourceBranch).toBe("main")
    expect(job.pipelineRun).toEqual({ definitionId: 0, runId: 4123 })

    expect(h.calls).toHaveLength(1)
    expect(h.calls[0]!.method).toBe("POST")
    // Derived, not transcribed: the isolation guard forbids a fixture from
    // naming a live origin, and the destination is the module's own mapping.
    expect(h.calls[0]!.url).toBe(`${cloudAgentBaseUrl("prod")}/v2/jobs`)
    expect(h.calls[0]!.headers.Authorization).toBe(`Bearer ${SYNTHETIC_TOKEN}`)
    expect(JSON.parse(h.calls[0]!.body!)).toMatchObject({ prompt: "Fix the flaky login test" })
  })

  test("is NOT retried on a 500, because the job may already exist", async () => {
    // Replaying a create could launch a second multi-hour job that spends real
    // compute. A 5xx is retriable in the abstract and final here.
    const h = harness([() => jsonResponse({ message: "boom" }, { status: 500 })])
    await expect(h.client.createJob(
      buildGenericJobRequest({ prompt: "x", repository: REPOSITORY }),
    )).rejects.toThrow(/HTTP 500/)
    expect(h.calls).toHaveLength(1)
  })

  test("a 401 IS retried once for a create, because a rejected request had no effect", async () => {
    const h = harness([
      () => jsonResponse({ message: "unauthorized" }, { status: 401 }),
      () => jsonResponse(CREATED_JOB, { status: 201 }),
    ])
    const job = await h.client.createJob(
      buildGenericJobRequest({ prompt: "x", repository: REPOSITORY }),
    )
    expect(job.jobId).toBe(CREATED_JOB.jobId)
    expect(h.calls).toHaveLength(2)
    // A fresh token was minted for the retry: the rejected value is never
    // replayed.
    expect(h.tokenMints()).toBe(2)
  })
})

describe("token recovery", () => {
  test("a 401 mints exactly one new token; a second 401 is final", async () => {
    const h = harness([
      () => jsonResponse({}, { status: 401 }),
      () => jsonResponse({}, { status: 401 }),
    ])
    await expect(h.client.getJob("job-1")).rejects.toThrow(/rejected the access token/)
    expect(h.tokenMints()).toBe(2)
    expect(h.calls).toHaveLength(2)
  })

  test("a 403 does NOT invalidate or retry, and says the token was accepted", async () => {
    // An authorization verdict on a credential that is fine. Telling the user
    // to re-authenticate would send them to fix the wrong thing.
    const h = harness([() => jsonResponse({ message: "caller lacks repo access" }, { status: 403 })])
    await expect(h.client.getJob("job-1")).rejects.toThrow(/token was accepted/)
    expect(h.tokenMints()).toBe(1)
    expect(h.calls).toHaveLength(1)
  })

  test("a 429 honours Retry-After and then succeeds", async () => {
    const h = harness([
      () => jsonResponse({}, { status: 429, headers: { "retry-after": "0" } }),
      () => jsonResponse(CREATED_JOB),
    ])
    const job = await h.client.getJob("job-1").catch((err: unknown) => err)
    // getJob's body is the created-job fixture, which has a jobId, so it parses.
    expect(job).toBeInstanceOf(Object)
    expect(h.calls).toHaveLength(2)
  })

  test("the retry ladder is finite: retriable errors stop when it is exhausted", async () => {
    const h = harness(
      [
        () => jsonResponse({}, { status: 503 }),
        () => jsonResponse({}, { status: 503 }),
      ],
      { retryDelaysMs: [0] },
    )
    await expect(h.client.getJob("job-1")).rejects.toThrow(/HTTP 503/)
    expect(h.calls).toHaveLength(2)
  })

  test("an empty ladder makes a retriable verdict final", async () => {
    const h = harness([() => jsonResponse({}, { status: 503 })], { retryDelaysMs: [] })
    await expect(h.client.getJob("job-1")).rejects.toThrow(/HTTP 503/)
    expect(h.calls).toHaveLength(1)
  })
})

describe("the bearer never reaches a message", () => {
  test("no status path echoes the Authorization header", async () => {
    for (const status of [400, 401, 403, 429, 500]) {
      const h = harness([() => jsonResponse({ message: "nope" }, { status })])
      const err = await h.client.getJob("job-1").catch((caught: unknown) => caught)
      expect(err).toBeInstanceOf(CloudAgentError)
      expect(String((err as Error).message)).not.toContain(SYNTHETIC_TOKEN)
    }
  })
})

describe("listPlugins / listAgents", () => {
  test("sends no `top` unless asked, because the default page is what the UI shows", async () => {
    const h = harness([() => jsonResponse({ value: [], totalCount: 233 })])
    await h.client.listPlugins()
    const url = new URL(h.calls[0]!.url)
    expect(url.pathname.endsWith("/api/agency/plugins")).toBe(true)
    expect(url.searchParams.has("top")).toBe(false)
    expect(url.searchParams.has("skip")).toBe(false)
  })

  test("rejects `top` above the service limit locally instead of forwarding a 400", async () => {
    const h = harness([() => jsonResponse({ value: [] })])
    await expect(h.client.listPlugins({ top: MAX_CATALOG_TOP + 1 }))
      .rejects.toThrow(/1 to 100/)
    expect(h.calls).toHaveLength(0)
  })

  test("a catalog page renders and counts the total", async () => {
    const h = harness([() => jsonResponse({
      value: [
        { name: "repo-search", type: "Repo", description: "Search the repository", enabledByDefault: true },
        { name: "docs", description: "Read the docs" },
      ],
      totalCount: 233,
      top: 2,
    })])
    const page = await h.client.listPlugins({ top: 2 })
    const rendered = renderPluginPage(page)
    expect(rendered).toContain("2 of 233 plugin(s)")
    expect(rendered).toContain("repo-search [Repo] (enabled by default)")
    expect(rendered).toContain("docs")
  })
})

describe("readJob", () => {
  test("reads the v2 context.repository shape", () => {
    const job = readJob(CREATED_JOB)
    expect(job.repository).toBe("contoso/platform/web")
    expect(job.sourceBranch).toBe("main")
  })

  test("reads the legacy azDoContext shape, including its field spellings", () => {
    const job = readJob({
      jobId: "job-legacy",
      state: "Completed",
      azDoContext: {
        organization: "contoso",
        projectName: "platform",
        repositoryName: "web",
        pullRequestId: 42,
        sourceBranchName: "refs/heads/feature/x",
        targetBranchName: "refs/heads/main",
        workItemIds: [7, 8],
        pullRequestTags: ["cloudagent"],
      },
    })
    expect(job.repository).toBe("contoso/platform/web")
    expect(job.pullRequestId).toBe(42)
    expect(job.sourceBranch).toBe("refs/heads/feature/x")
    expect(job.targetBranch).toBe("refs/heads/main")
    expect(job.workItemIds).toEqual([7, 8])
    expect(job.pullRequestTags).toEqual(["cloudagent"])
  })

  test("drops Go's zero time instead of reporting it as a creation time", () => {
    const job = readJob({ jobId: "job-zero", createdAt: "0001-01-01T00:00:00", updatedAt: "0001-01-01T00:00:00Z" })
    expect(job.createdAt).toBeUndefined()
    expect(job.updatedAt).toBeUndefined()
  })

  test("a response without a jobId is an error, not a job named undefined", () => {
    expect(() => readJob({ state: "Queued" })).toThrow(/without a jobId/)
  })

  test("a null modelMetrics entry is kept as null rather than dropped silently", () => {
    const job = readJob({
      jobId: "job-usage",
      sessionMetrics: {
        currentModel: "gpt-5.6-sol",
        modelMetrics: {
          "gpt-5.6-sol": { inputTokens: 10, outputTokens: 2 },
          "gpt-5.5": null,
        },
      },
    })
    expect(job.currentModel).toBe("gpt-5.6-sol")
    expect(job.modelUsage?.["gpt-5.5"]).toBeNull()
    expect(job.modelUsage?.["gpt-5.6-sol"]).toEqual({ inputTokens: 10, outputTokens: 2 })
    expect(renderJob(job)).toContain("gpt-5.5: (recorded as null)")
  })
})

/**
 * A trace transcribed from a live job's `/logs` body: the message envelope
 * (`{role:{label}, items:[…]}`), the `$type` discriminators, the `callId`
 * pairing, an `apply_patch` whose arguments arrive empty, a shell result that
 * carries the only diff in the trace, and an item type this parser does not
 * model. It is deliberately small; the shape is what is being pinned.
 */
const RECORDED_TRACE = {
  id: "7f3a6c1e-0000-4000-8000-000000000001",
  createdAt: "2026-10-29T10:00:00Z",
  updatedAt: "2026-10-29T13:41:00Z",
  chatHistory: [
    {
      role: { label: "user" },
      items: [{ $type: "TextContent", text: "Fix the flaky login test" }],
    },
    {
      role: { label: "assistant" },
      items: [
        { $type: "TextContent", text: "Let me look at the test." },
        { $type: "ThinkingContent", text: "planning" },
        {
          $type: "FunctionCallContent",
          id: "call-1",
          functionName: "view",
          arguments: { path: "/mnt/vss/_work/1/s/src/login.test.ts" },
        },
      ],
    },
    {
      role: { label: "tool" },
      items: [{
        $type: "FunctionResultContent",
        callId: "call-1",
        result: { content: "describe('login', …)" },
      }],
    },
    {
      role: { label: "assistant" },
      items: [
        { $type: "TextContent", text: "The wait is racy; I'll add a condition." },
        {
          $type: "FunctionCallContent",
          id: "call-2",
          functionName: "edit",
          arguments: { path: "F:\\1\\s\\source\\src\\login.test.ts", content: "…" },
        },
      ],
    },
    {
      role: { label: "tool" },
      items: [
        { $type: "FunctionResultContent", callId: "call-2", result: { content: "edited src/login.test.ts" } },
        {
          $type: "FunctionCallContent",
          id: "call-3",
          functionName: "powershell",
          arguments: {},
        },
      ],
    },
    {
      role: { label: "tool" },
      items: [{
        $type: "FunctionResultContent",
        callId: "call-3",
        result: {
          content: [
            "git diff --stat",
            "diff --git a/src/login.ts b/src/login.ts",
            "--- a/src/login.ts",
            "+++ b/src/login.ts",
          ].join("\n"),
        },
      }],
    },
    {
      role: { label: "assistant" },
      items: [
        // Scaffolding the agent writes for itself; never a repository change.
        {
          $type: "FunctionCallContent",
          id: "call-4",
          functionName: "create",
          arguments: { path: "/mnt/vss/_work/1/s/.engram/session-state.md" },
        },
        {
          $type: "FunctionCallContent",
          id: "call-5",
          functionName: "task_complete",
          arguments: { summary: "Fixed the race by awaiting the condition.\n\n**Files:** src/login.ts" },
        },
      ],
    },
  ],
}

describe("readJobLogs", () => {
  const logs = readJobLogs(RECORDED_TRACE)

  test("the deliverable is the task_complete summary, verbatim", () => {
    expect(logs.summary).toBe("Fixed the race by awaiting the condition.\n\n**Files:** src/login.ts")
    expect(logs.messageCount).toBe(7)
  })

  test("the prompt is not counted as the agent's own words", () => {
    expect(logs.assistantTexts).toEqual([
      "Let me look at the test.",
      "The wait is racy; I'll add a condition.",
    ])
  })

  test("the histogram conveys the shape of the run in one line", () => {
    expect(logs.histogram).toEqual([
      { name: "create", count: 1 },
      { name: "edit", count: 1 },
      { name: "powershell", count: 1 },
      { name: "task_complete", count: 1 },
      { name: "view", count: 1 },
    ])
  })

  test("changed files come from both write arguments and a shell diff", () => {
    // `view` takes a path but changed nothing, so it must not appear.
    // `/mnt/vss/_work/1/s/` and `F:\1\s\` are the two agent prefixes measured
    // on real traces, and both are stripped to a repository-relative path.
    // `.engram/` is session scaffolding, not a repository change.
    expect(logs.changedFiles).toEqual(["src/login.test.ts", "src/login.ts"])
  })

  test("the agent's own runtime directories are not repository changes", () => {
    // Measured on a live Windows job (2026-10-29): the review plugin stages
    // bundles under `%LOCALAPPDATA%\agency\` and artifacts under `%TEMP%`, and
    // 15 such scratch files were reported as changed ahead of the one source
    // file the job actually edited. They are absolute paths, so the
    // checkout-prefix strips do not remove them.
    const logs = readJobLogs({
      chatHistory: [{
        role: { label: "assistant" },
        items: [
          {
            $type: "FunctionCallContent",
            id: "c1",
            functionName: "create",
            arguments: {
              path: "C:\\Users\\cloudtest\\AppData\\Local\\agency\\plugins\\sessions\\p1\\root-0\\skill.json",
            },
          },
          {
            $type: "FunctionCallContent",
            id: "c2",
            functionName: "write",
            arguments: {
              path: "C:\\Users\\cloudtest\\AppData\\Local\\Temp\\agency-review\\session_1\\coverage.json",
            },
          },
          {
            $type: "FunctionCallContent",
            id: "c3",
            functionName: "edit",
            arguments: { path: "Configuration/Service/UserProfileService.cs" },
          },
        ],
      }],
    })
    expect(logs.changedFiles).toEqual(["Configuration/Service/UserProfileService.cs"])
  })

  test("an unmodelled item type is reported, never guessed at", () => {
    expect(logs.unrecognizedItems).toBe(1) // the ThinkingContent item
  })

  test("results pair to calls by callId, not by position", () => {
    const byName = new Map(logs.toolCalls.map((call) => [call.name, call]))
    expect(byName.get("view")?.result).toBe("describe('login', …)")
    expect(byName.get("powershell")?.result).toContain("diff --git")
    // `apply_patch`-style stripped arguments are empty, which is why toolDiffs
    // cannot be the source of "what changed".
    expect(byName.get("powershell")?.args).toEqual({})
  })

  test("an arguments payload that arrives as JSON text is parsed", () => {
    const parsed = readJobLogs({
      chatHistory: [{
        role: { label: "assistant" },
        items: [{
          $type: "FunctionCallContent",
          id: "c1",
          functionName: "edit",
          arguments: JSON.stringify({ path: "src/a.ts" }),
        }],
      }],
    })
    expect(parsed.toolCalls[0]!.args).toEqual({ path: "src/a.ts" })
    expect(parsed.changedFiles).toEqual(["src/a.ts"])
  })

  test("a queued job's empty trace is an empty trace, not an error", () => {
    const empty = readJobLogs({ id: "job-q" })
    expect(empty.messageCount).toBe(0)
    expect(empty.summary).toBeUndefined()
    expect(empty.histogram).toEqual([])
  })
})

describe("renderTrace", () => {
  test("leads with the summary, above the diagnostics", () => {
    const rendered = renderTrace(readJobLogs(RECORDED_TRACE))
    const summaryAt = rendered.indexOf("summary (the job's deliverable):")
    const histogramAt = rendered.indexOf("tool use:")
    expect(summaryAt).toBeGreaterThan(-1)
    expect(histogramAt).toBeGreaterThan(summaryAt)
    expect(rendered).toContain("Fixed the race by awaiting the condition.")
    expect(rendered).toContain("changed files (2)")
    expect(rendered).toContain("src/login.ts")
    // Scaffolding is excluded from the changed-file list specifically. It still
    // appears in the raw call tail above, which is the trace being faithful.
    const changedBlock = rendered.slice(
      rendered.indexOf("changed files (2)"),
      rendered.indexOf("last agent message"),
    )
    expect(changedBlock).not.toContain(".engram")
    // The last thing the agent saw, under the call that produced it.
    expect(rendered).toContain("final tool result")
  })

  test("a failed job's trace says plainly that there is no deliverable", () => {
    const failed = readJobLogs({
      chatHistory: [{
        role: { label: "assistant" },
        items: [{ $type: "FunctionCallContent", id: "c1", functionName: "powershell", arguments: {} }],
      }],
    })
    expect(renderTrace(failed)).toContain("the job never called task_complete")
  })

  test("an empty trace renders nothing rather than a false absent-summary claim", () => {
    expect(renderTrace(readJobLogs({ id: "job-q" }))).not.toContain("never called task_complete")
  })
})

describe("renderJob", () => {
  test("a terminal job's summary precedes state and metadata", () => {
    const job = readJob({ ...CREATED_JOB, state: "Completed", metadata: { chain: "research" } })
    const rendered = renderJob(job, { summary: "The answer." })
    expect(rendered.indexOf("The answer.")).toBeLessThan(rendered.indexOf("state: Completed"))
  })

  test("a Completed/Failure outcome keeps BOTH signals distinct", () => {
    // The docs call this out explicitly: the classifier can judge the WORK
    // unsuccessful while the state is Completed. Collapsing them would leave
    // the model inferring one from the other.
    const job = readJob({
      jobId: "job-cf",
      state: "Completed",
      result: "Failure",
      outcome: { code: "Succeeded", description: "PR opened" },
      jobOutcomeType: "Agent",
    })
    const rendered = renderJob(job)
    expect(rendered).toContain("state: Completed")
    expect(rendered).toContain("outcome: Succeeded — PR opened")
    expect(rendered).toContain("jobOutcomeType (who is responsible): Agent")
    expect(rendered).toContain("result (legacy classifier verdict on the work): Failure")
  })

  test("the placeholder reason is not printed as if it were a finding", () => {
    expect(renderJob(readJob({ jobId: "j", state: "Completed", reason: "No reason provided." })))
      .not.toContain("reason")
  })

  test("definition 0 is a sentinel and is not rendered", () => {
    expect(renderJob(readJob(CREATED_JOB))).toContain("pipeline run id: 4123")
    expect(renderJob(readJob(CREATED_JOB))).not.toContain("definition 0")
  })
})

describe("job-state predicates and the poll cadence", () => {
  test("terminal states are matched by name, so an unknown state keeps polling", () => {
    for (const state of ["Completed", "completed", "Failed", "Cancelled", "Canceled", "Succeeded"]) {
      expect(isTerminalJob(readJob({ jobId: "j", state }))).toBe(true)
    }
    for (const state of ["InProgress", "Queued", "SomeNewState"]) {
      expect(isTerminalJob(readJob({ jobId: "j", state }))).toBe(false)
    }
  })

  test("queued is distinguished from every other live state", () => {
    expect(isQueuedJob(readJob({ jobId: "j", state: "Queued" }))).toBe(true)
    expect(isQueuedJob(readJob({ jobId: "j", state: "InProgress" }))).toBe(false)
  })

  test("a live poll ends with a cadence, and queued gets a shorter one", () => {
    const created = "2026-10-29T10:00:00Z"
    const now = Date.parse("2026-10-29T10:07:00Z")
    const queued = renderPollHint(readJob({ jobId: "j", state: "Queued", createdAt: created }), now)
    const running = renderPollHint(readJob({ jobId: "j", state: "InProgress", createdAt: created }), now)
    expect(queued).toContain("check again in ~2 min")
    expect(queued).toContain("created 7 min ago")
    expect(running).toContain("check again in ~10 min")
    expect(running).toContain("created 7 min ago")
  })

  test("an unparseable creation time is not turned into a bogus elapsed figure", () => {
    expect(renderPollHint(readJob({ jobId: "j", state: "InProgress", createdAt: "not-a-time" })))
      .toContain("creation time not reported")
  })
})

describe("renderMetadataBrief", () => {
  test("nothing to show is an empty string, not empty brackets", () => {
    expect(renderMetadataBrief(undefined)).toBe("")
    expect(renderMetadataBrief({})).toBe("")
    expect(renderMetadataBrief({ step: "" })).toBe("")
  })

  test("caps the pairs it prints and counts the rest", () => {
    const brief = renderMetadataBrief({ chain: "research", step: "1", issue: "9", env: "prod", extra: "x" })
    expect(brief).toMatch(/^\[/)
    expect(brief).toContain("+")
    // Five pairs, four slots: one is counted, never printed.
    expect(brief).not.toContain("extra=x")
  })

  test("a page row carries the labels, so a chain is reconstructable from the ledger", () => {
    const rendered = renderJobPage({
      data: [readJob({ ...CREATED_JOB, metadata: { chain: "research", step: "1" } })],
      hasMore: false,
    })
    expect(rendered).toContain("[chain=research step=1]")
    expect(rendered).toContain("contoso/platform/web")
  })

  test("an empty page says so instead of rendering a header alone", () => {
    expect(renderJobPage({ data: [], hasMore: false })).toBe("No jobs matched.")
  })

  test("a continuation is surfaced with the token a caller needs", () => {
    const rendered = renderJobPage({ data: [], hasMore: true, continuationToken: "tok" })
    expect(rendered).toContain("No jobs matched.")
  })
})

describe("job ids are validated before they reach a path", () => {
  test("a traversal-shaped id is refused without a request", async () => {
    const h = harness([() => jsonResponse({})])
    for (const bad of ["../../etc/passwd", "a/b", "", "-leading-dash"]) {
      await expect(h.client.getJob(bad)).rejects.toThrow(/not a valid Cloud Agent job id/)
    }
    expect(h.calls).toHaveLength(0)
  })
})

describe("upstream error bodies", () => {
  const cases: Array<[string, string, RegExp]> = [
    ["a bare JSON string", JSON.stringify("Failed to retrieve repository information."), /Failed to retrieve repository information\./],
    ["a message envelope", JSON.stringify({ message: "bad repo" }), /bad repo/],
    ["a nested error envelope", JSON.stringify({ error: { message: "nested" } }), /nested/],
    ["an errors array", JSON.stringify({ errors: ["one", { message: "two" }] }), /one; two/],
    ["plain text", "upstream said no", /upstream said no/],
  ]

  for (const [label, body, expected] of cases) {
    test(`unwraps ${label} without echoing its quoting`, async () => {
      const h = harness([() => new Response(body, { status: 400 })])
      const err = await h.client.getJob("job-1").catch((caught: unknown) => caught)
      expect(err).toBeInstanceOf(CloudAgentError)
      expect((err as Error).message).toMatch(expected)
      // The bare-string case is the one that used to reach the model with its
      // JSON quotes intact.
      expect((err as Error).message).not.toContain('\\"')
    })
  }

  test("a non-JSON 200 is a retriable parse failure, not a silent empty result", async () => {
    const h = harness([() => new Response("<html>oops</html>", { status: 200 })], { retryDelaysMs: [] })
    await expect(h.client.getJob("job-1")).rejects.toThrow(/not JSON/)
  })
})

describe("log transport", () => {
  test("getJobLogsText returns the service's own bytes", async () => {
    const body = JSON.stringify({ id: "job-1", chatHistory: [] }, null, 2)
    const h = harness([() => new Response(body, { status: 200 })])
    expect(await h.client.getJobLogsText("job-1")).toBe(body)
    expect(new URL(h.calls[0]!.url).pathname.endsWith("/jobs/job-1/logs")).toBe(true)
  })

  test("a declared body over the cap is refused before it is buffered", async () => {
    const h = harness([() => new Response("{}", {
      status: 200,
      headers: { "content-length": String(64 * 1024 * 1024) },
    })])
    await expect(h.client.getJobLogs("job-1")).rejects.toThrow(/declared .* bytes, over the/)
  })
})

describe("cancelJob", () => {
  test("202 with no body means the cancel was requested, not completed", async () => {
    const h = harness([() => new Response(null, { status: 202 })])
    expect(await h.client.cancelJob("job-1")).toEqual({ alreadyCancelled: false })
    expect(new URL(h.calls[0]!.url).pathname.endsWith("/jobs/job-1/cancel")).toBe(true)
    // The v1-shaped route, deliberately: there is no /v2/.../cancel.
    expect(h.calls[0]!.url).not.toContain("/v2/jobs/")
  })

  test("200 with a job means it was already cancelled and the outcome is known", async () => {
    const h = harness([() => jsonResponse({ ...CREATED_JOB, state: "Cancelled" })])
    const result = await h.client.cancelJob("job-1")
    expect(result.alreadyCancelled).toBe(true)
    expect(result.job?.state).toBe("Cancelled")
  })
})
