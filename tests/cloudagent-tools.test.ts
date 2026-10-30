import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { CloudAgentClient } from "../src/lib/cloudagent-client"
import {
  CLOUDAGENT_TOOLS,
  resetCloudAgentClientForTesting,
  setCloudAgentClientForTesting,
} from "../src/lib/cloudagent-tools"
import { firstText, type McpToolResult } from "../src/lib/attachments"
import type { McpToolCallContext, NonPersonaMcpTool } from "../src/lib/peer-mcp-personas"
import { state } from "../src/lib/state"

// Hermetic by construction: the client is injected (scripted `fetchImpl`, a
// literal token provider, an empty retry ladder), so nothing here reaches an
// Cloud Agent origin, `az`, or the network. The only real subprocess is `git`, used
// against a throwaway repository under the OS temp dir — the same code path the
// launcher takes, rather than a mock of the lookup.
//
// The bearer literal is synthetic, asserted present on the wire (so the leak
// assertion is not vacuous) and absent from every rendered result.

const SYNTHETIC_TOKEN = "synthetic-cloudagent-bearer-not-a-credential"
const JOB_ID = "7f3a6c1e-0000-4000-8000-000000000001"

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
}

/**
 * A client whose `fetch` walks a scripted queue, consumed in order. An
 * exhausted queue is a test bug: it means the code under test made a call
 * nobody expected.
 */
function harness(script: Array<() => Response>): Harness {
  const calls: Array<Captured> = []
  const queue = [...script]
  const client = new CloudAgentClient({
    environment: "prod",
    tokenProvider: async () => SYNTHETIC_TOKEN,
    // Empty ladder: a retriable verdict is final on the first attempt, so a
    // suite asserts the VERDICT without paying for a backoff.
    retryDelaysMs: [],
    fetchImpl: (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      calls.push({
        url: String(input),
        method: init?.method ?? "GET",
        headers: { ...(init?.headers as Record<string, string>) },
        body: typeof init?.body === "string" ? init.body : undefined,
      })
      const next = queue.shift()
      if (!next) throw new Error(`unexpected fetch call #${calls.length}: ${String(input)}`)
      return next()
    }) as unknown as typeof fetch,
  })
  return { client, calls }
}

/**
 * The body `create_job` put on the wire, typed only as far as the assertions
 * reach. A `Record<string, any>` here would be a lint error and, worse, would
 * let a renamed field assert against `undefined` and pass.
 */
interface CreateJobBody {
  context: { repository: Record<string, unknown> }
  customAgent?: Record<string, unknown>
  plugins?: Array<unknown>
  additionalOptions?: Record<string, unknown>
  modelConfiguration?: Record<string, unknown>
  metadata?: Record<string, unknown>
}

function createJobBody(h: Harness): CreateJobBody {
  return JSON.parse(h.calls[0]!.body!) as CreateJobBody
}

/** Install a scripted client for the current environment and return it. */
function use(script: Array<() => Response> = []): Harness {
  const h = harness(script)
  setCloudAgentClientForTesting(h.client)
  return h
}

beforeEach(() => {
  state.cloudAgentEnvironment = "prod"
  resetCloudAgentClientForTesting()
  // A default install, so a handler that unexpectedly reaches the client fails
  // on an exhausted queue instead of constructing a real one that would try to
  // mint an Entra token through `az`.
  use()
})

function toolNamed(name: string): NonPersonaMcpTool {
  const tool = CLOUDAGENT_TOOLS.find((entry) => entry.toolNameHttp === name)
  if (!tool) throw new Error(`no cloudagent tool named ${name}`)
  return tool
}

async function call(
  name: string,
  args: Record<string, unknown> = {},
  ctx?: McpToolCallContext,
): Promise<McpToolResult> {
  return toolNamed(name).handler(args, undefined, ctx)
}

function textOf(result: McpToolResult): string {
  return firstText(result)
}

function propertiesOf(tool: NonPersonaMcpTool): Record<string, unknown> {
  return (tool.inputSchema.properties ?? {}) as Record<string, unknown>
}

// --- Fixtures --------------------------------------------------------------

const REPOSITORY = {
  organization: "contoso",
  project: "platform",
  repository: "web",
} as const

/** A created job, in the shape the live service returns from `POST /v2/jobs`. */
const CREATED_JOB = {
  operationId: "op-1",
  jobId: JOB_ID,
  state: "Queued",
  createdAt: "2026-10-29T10:00:00Z",
  prompt: "Fix the flaky login test",
  context: {
    repository: { $type: "ado", ...REPOSITORY, branch: "main" },
  },
  pipelineRun: { definitionId: 0, runId: 4123 },
}

const SUCCEEDED_JOB = {
  jobId: JOB_ID,
  state: "Completed",
  outcome: { code: "Succeeded", description: "The agent completed the task." },
  jobOutcomeType: "Succeeded",
  createdAt: "2026-10-29T10:00:00Z",
  updatedAt: "2026-10-29T13:41:00Z",
  prompt: "Fix the flaky login test",
  context: { repository: { $type: "ado", ...REPOSITORY, branch: "main" } },
  azDoContext: {
    pullRequestId: 4123,
    sourceBranchName: "refs/heads/cloudagent/fix-login",
    targetBranchName: "refs/heads/main",
  },
  metadata: { chain: "research", step: "1" },
}

const FAILED_JOB = {
  jobId: JOB_ID,
  state: "Failed",
  outcome: { code: "Failed", description: "The agent reported an error while running." },
  jobOutcomeType: "UserError",
  createdAt: "2026-10-29T10:00:00Z",
  prompt: "Fix the flaky login test",
  context: { repository: { $type: "ado", ...REPOSITORY } },
}

const SUCCEEDED_TRACE = {
  id: JOB_ID,
  createdAt: "2026-10-29T10:00:00Z",
  updatedAt: "2026-10-29T13:41:00Z",
  chatHistory: [
    { role: { label: "user" }, items: [{ $type: "TextContent", text: "Fix the flaky login test" }] },
    {
      role: { label: "assistant" },
      items: [
        { $type: "TextContent", text: "Let me look at the test." },
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
        {
          $type: "FunctionCallContent",
          id: "call-2",
          functionName: "edit",
          arguments: { path: "F:\\1\\s\\source\\src\\login.test.ts", content: "…" },
        },
        {
          $type: "FunctionCallContent",
          id: "call-3",
          functionName: "task_complete",
          arguments: { summary: "Fixed the race by awaiting the condition.\n\n**Files:** src/login.test.ts" },
        },
      ],
    },
  ],
}

/** A failed run: no `task_complete`, and a failing final tool result. */
const FAILED_TRACE = {
  id: JOB_ID,
  chatHistory: [
    { role: { label: "user" }, items: [{ $type: "TextContent", text: "Fix the flaky login test" }] },
    {
      role: { label: "assistant" },
      items: [{
        $type: "FunctionCallContent",
        id: "call-1",
        functionName: "powershell",
        arguments: { command: "npm test" },
      }],
    },
    {
      role: { label: "tool" },
      items: [{
        $type: "FunctionResultContent",
        callId: "call-1",
        result: { content: "npm ERR! Missing script: \"test\"" },
      }],
    },
  ],
}

// --- A real checkout, so the repository lookup is exercised, not mocked ----

let repoDir = ""
let plainDir = ""

async function git(cwd: string, args: Array<string>): Promise<void> {
  const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" })
  const exitCode = await proc.exited
  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text()
    throw new Error(`git ${args.join(" ")} failed with ${exitCode}: ${stderr}`)
  }
}

beforeAll(async () => {
  repoDir = await mkdtemp(path.join(tmpdir(), "cloudagent-tools-repo-"))
  plainDir = await mkdtemp(path.join(tmpdir(), "cloudagent-tools-plain-"))
  await git(repoDir, ["init"])
  await git(repoDir, ["remote", "add", "origin", "https://dev.azure.com/contoso/platform/_git/web"])
})

afterAll(async () => {
  await rm(repoDir, { recursive: true, force: true })
  await rm(plainDir, { recursive: true, force: true })
})

// --- Schemas ---------------------------------------------------------------

describe("the tool surface", () => {
  test("is the eight tools the plan specifies, in the cloudagent group", () => {
    expect(CLOUDAGENT_TOOLS.map((tool) => tool.toolNameHttp).sort()).toEqual([
      "cancel_job",
      "create_job",
      "get_job",
      "get_job_logs",
      "list_agents",
      "list_jobs",
      "list_plugins",
      "wait_for_job",
    ])
    for (const tool of CLOUDAGENT_TOOLS) expect(tool.group).toBe("cloudagent")
  })

  test("splits read from write, so discovery can never spend compute", () => {
    const capabilities = Object.fromEntries(
      CLOUDAGENT_TOOLS.map((tool) => [tool.toolNameHttp, tool.capability]),
    )
    expect(capabilities).toEqual({
      create_job: "cloudagent_write",
      cancel_job: "cloudagent_write",
      get_job: "cloudagent",
      list_jobs: "cloudagent",
      wait_for_job: "cloudagent",
      get_job_logs: "cloudagent",
      list_plugins: "cloudagent",
      list_agents: "cloudagent",
    })
  })

  test("every schema is closed, so an unknown argument is rejected instead of ignored", () => {
    for (const tool of CLOUDAGENT_TOOLS) {
      expect(tool.inputSchema.additionalProperties).toBe(false)
      expect(tool.inputSchema.type).toBe("object")
    }
  })

  test("only `jobId` is ever required, so every other argument works when omitted", () => {
    // A schema of optional properties reads to a model as a form to fill in,
    // and a live session did exactly that: `list_jobs` with an empty
    // organization/project/repository triple and a `pageSize` of 0, every one
    // of which the service rejected. Marking an argument required makes it a
    // hard call failure, so the required list has to stay at the one value a
    // call cannot be expressed without.
    for (const tool of CLOUDAGENT_TOOLS) {
      const required = (tool.inputSchema.required ?? []) as string[]
      const expected = "jobId" in propertiesOf(tool) ? ["jobId"] : []
      expect({ tool: tool.toolNameHttp, required: [...required].sort() }).toEqual({
        tool: tool.toolNameHttp,
        required: expected,
      })
    }
  })

  test("every optional argument states its default in its description", () => {
    // `prompt` and `agent` are the deliberate either-or pair: each is needed
    // only when the other is absent, so neither carries a "Default". Every
    // other optional argument has a real default the handler applies or the
    // service supplies, and must say so — a model cannot see the handler and
    // will otherwise fill the field with a guess.
    const eitherOr = new Set(["prompt", "agent"])
    for (const tool of CLOUDAGENT_TOOLS) {
      const properties = propertiesOf(tool)
      const required = new Set((tool.inputSchema.required ?? []) as string[])
      for (const [name, spec] of Object.entries(properties)) {
        if (required.has(name) || eitherOr.has(name)) continue
        const description = String((spec as { description?: string }).description ?? "")
        expect(`${tool.toolNameHttp}.${name}: ${description}`).toMatch(/default/i)
      }
    }
  })

  test("list_jobs exposes no filter the service silently ignores", () => {
    // Measured against prod: `state`, `status` and `top` are accepted and
    // ignored on GET /jobs. A schema field for any of them would be a filter
    // that looks like it works, which is worse than no filter.
    const properties = propertiesOf(toolNamed("list_jobs"))
    expect(Object.keys(properties).sort()).toEqual([
      "continuationToken",
      "organization",
      "pageSize",
      "project",
      "pullRequestId",
      "repository",
      "workspace",
    ])
  })

  test("create_job's context tier is an enum, and its description says hours and one-shot", () => {
    const tool = toolNamed("create_job")
    const context = propertiesOf(tool).context as { enum?: Array<string> }
    expect(context.enum).toEqual(["default", "long_context"])
    // The two properties the surface cannot function without: a model that
    // thinks a job can be messaged, or that it finishes quickly, misuses it.
    expect(tool.description).toContain("ONE-SHOT")
    expect(tool.description).toContain("median 221 minutes")
    expect(tool.description).toContain("Confirm with the user")
  })

  test("get_job says a failure is a result, not an error", () => {
    expect(toolNamed("get_job").description).toContain("not as an error")
  })
})

// --- create_job ------------------------------------------------------------

describe("create_job", () => {
  test("reads the repository from the workspace checkout and says that it inferred it", async () => {
    const h = use([() => jsonResponse(CREATED_JOB, { status: 201 })])
    // The MCP boundary merges a per-connection `X-GH-Workspace` into
    // `args.workspace` and records where it came from; this reproduces that
    // pair exactly.
    const result = await call(
      "create_job",
      { prompt: "Fix the flaky login test", workspace: repoDir },
      { workspaceSource: "argument" },
    )
    const text = textOf(result)

    const body = createJobBody(h)
    expect(body.context.repository).toEqual({
      $type: "ado",
      organization: "contoso",
      project: "platform",
      repository: "web",
    })

    // The provenance line sits directly under the job id, before every other
    // field, because "I guessed your repository" must not be a footnote.
    const lines = text.split("\n")
    expect(lines[0]).toBe(`Job ${JOB_ID}`)
    expect(lines[1]).toBe(
      "[repository: contoso/platform/web (inferred from the workspace you passed)]",
    )
    expect(text).toContain("state: Queued")
    expect(text).toContain("effective request (the normalized body the service received):")
    expect(text).toContain("  repository: contoso/platform/web")
    // The create call tells the caller to go away rather than wait.
    expect(text).toContain(`get_job jobId=${JOB_ID} in about 10 minutes`)
  })

  test("a session-supplied workspace is attributed to the session, not to the caller", async () => {
    use([() => jsonResponse(CREATED_JOB, { status: 201 })])
    const result = await call(
      "create_job",
      { prompt: "Fix the flaky login test", workspace: repoDir },
      { workspaceSource: "session" },
    )
    expect(textOf(result)).toContain(
      "[repository: contoso/platform/web (inferred from this session's workspace)]",
    )
  })

  test("an explicit triple is used verbatim and carries no provenance line", async () => {
    const h = use([() => jsonResponse(CREATED_JOB, { status: 201 })])
    const result = await call("create_job", { prompt: "Fix it", ...REPOSITORY })
    const lines = textOf(result).split("\n")
    expect(lines[0]).toBe(`Job ${JOB_ID}`)
    expect(lines[1]).toBe("state: Queued")
    expect(textOf(result)).not.toContain("[repository:")
    const body = createJobBody(h)
    expect(body.context.repository.branch).toBeUndefined()
  })

  test("a partial repository triple fails before any request is made", async () => {
    const h = use()
    await expect(call("create_job", { prompt: "x", organization: "contoso" }))
      .rejects.toThrow(/Pass all of `organization`, `project` and `repository`/)
    // The wrong thing to do here is guess the remaining two components.
    expect(h.calls).toHaveLength(0)
  })

  test("no repository and no workspace fails with both ways forward", async () => {
    const h = use()
    await expect(call("create_job", { prompt: "x" }))
      .rejects.toThrow(/No repository: pass `organization`, `project` and `repository`, or `workspace`/)
    expect(h.calls).toHaveLength(0)
  })

  test("a relative workspace is refused rather than resolved against the proxy's cwd", async () => {
    const h = use()
    await expect(call("create_job", { prompt: "x", workspace: "some/repo" }))
      .rejects.toThrow(/must be an absolute path/)
    expect(h.calls).toHaveLength(0)
  })

  test("every selector round-trips into the wire body and is echoed back", async () => {
    const h = use([() => jsonResponse(CREATED_JOB, { status: 201 })])
    const text = textOf(
      await call("create_job", {
        prompt: "Fix the flaky login test",
        ...REPOSITORY,
        branch: "main",
        agent: "echo",
        agentType: "Repo",
        agentInputs: { spec: "do it", depth: 2, dry: false },
        plugins: ["repo-search", "docs"],
        includeDefaultPlugins: true,
        model: "gpt-5.6-sol",
        reasoningEffort: "high",
        context: "long_context",
        metadata: { chain: "research", step: "1" },
      }),
    )

    const body = createJobBody(h)
    expect(body.context.repository.branch).toBe("main")
    expect(body.customAgent).toEqual({
      name: "echo",
      type: "Repo",
      inputs: { spec: "do it", depth: 2, dry: false },
    })
    expect(body.plugins).toEqual([{ name: "repo-search" }, { name: "docs" }])
    expect(body.additionalOptions).toEqual({ pluginOptions: { includeDefaults: true } })
    expect(body.modelConfiguration).toEqual({
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
      context: "long_context",
    })
    expect(body.metadata).toEqual({ chain: "research", step: "1" })

    // The echo is what makes a follow-up job a follow-up: GET /jobs/{id} never
    // returns modelConfiguration, so these lines are the only durable record of
    // what the first job actually used.
    expect(text).toContain("effective request (the normalized body the service received):")
    expect(text).toContain("  repository: contoso/platform/web branch main")
    expect(text).toContain("  agent: echo (Repo) inputs: spec=do it, depth=2, dry=false")
    expect(text).toContain("  plugins: repo-search, docs")
    expect(text).toContain("  default plugins: included")
    expect(text).toContain("  model gpt-5.6-sol, effort high, context long_context")
    expect(text).toContain("  metadata: chain=research step=1")
  })

  test("an agent-only job needs no prompt", async () => {
    const h = use([() => jsonResponse(CREATED_JOB, { status: 201 })])
    await call("create_job", { ...REPOSITORY, agent: "echo" })
    const body = createJobBody(h)
    expect("prompt" in body).toBe(false)
    expect(body.customAgent).toEqual({ name: "echo" })
  })

  test("an unknown agentType is rejected before the request", async () => {
    const h = use()
    await expect(call("create_job", { prompt: "x", ...REPOSITORY, agent: "echo", agentType: "Planet" }))
      .rejects.toThrow(/`agentType` must be one of Repo, Organization, Company, Spec/)
    expect(h.calls).toHaveLength(0)
  })

  test("a context tier outside the enum is rejected before the request", async () => {
    const h = use()
    await expect(call("create_job", { prompt: "x", ...REPOSITORY, context: "huge" }))
      .rejects.toThrow(/`context` must be "default" or "long_context"/)
    expect(h.calls).toHaveLength(0)
  })
})

// --- get_job ---------------------------------------------------------------

describe("get_job", () => {
  test("a finished job leads with its deliverable, and a failure is not an isError", async () => {
    use([() => jsonResponse(SUCCEEDED_JOB), () => jsonResponse(SUCCEEDED_TRACE)])
    const result = await call("get_job", { jobId: JOB_ID })
    const text = textOf(result)

    expect(result.isError).toBeUndefined()
    // The ordering IS the feature: a model quotes the top of a tool result, so
    // a summary below the metadata is a summary the caller never uses.
    const summaryAt = text.indexOf("summary (the job's deliverable):")
    const stateAt = text.indexOf("state: Completed")
    expect(summaryAt).toBeGreaterThan(-1)
    expect(stateAt).toBeGreaterThan(summaryAt)
    expect(text).toContain("Fixed the race by awaiting the condition.")

    expect(text).toContain("outcome: Succeeded — The agent completed the task.")
    expect(text).toContain("jobOutcomeType (who is responsible): Succeeded")
    expect(text).toContain("repository: contoso/platform/web")
    expect(text).toContain("metadata: chain=research step=1")
    expect(text).toContain("pull request: #4123 (refs/heads/cloudagent/fix-login -> refs/heads/main)")
    expect(text).toContain(`next: the job is finished. get_job_logs jobId=${JOB_ID}`)
    expect(text).not.toContain("summary: none")
  })

  test("a FAILED job is a normal result that says whose fault it is", async () => {
    use([() => jsonResponse(FAILED_JOB), () => jsonResponse(FAILED_TRACE)])
    const result = await call("get_job", { jobId: JOB_ID })
    const text = textOf(result)

    // isError stays reserved for input-shape failures. A job that ended Failed
    // is an answer; marking it an error teaches the caller to retry the same
    // call, which would create nothing and cost another job.
    expect(result.isError).toBeUndefined()
    expect(text).toContain("state: Failed")
    expect(text).toContain("failure".length > 0 ? "outcome: Failed — The agent reported an error while running." : "")
    expect(text).toContain("jobOutcomeType (who is responsible): UserError")
    expect(text).toContain("summary: none — the job never called task_complete")
    expect(text).toContain(`get_job_logs jobId=${JOB_ID}`)
  })

  test("a running job gets a poll cadence, never a false 'no summary' claim", async () => {
    const createdAt = new Date(Date.now() - 45 * 60_000).toISOString()
    const h = use([() => jsonResponse({ ...FAILED_JOB, state: "InProgress", createdAt, outcome: undefined })])
    const text = textOf(await call("get_job", { jobId: JOB_ID }))

    expect(text).toContain("state: InProgress")
    expect(text).toMatch(/next: check again in ~10 min; job created 4[45] min ago\./)
    // A running job also has no summary yet; telling its caller it never called
    // task_complete would be a false negative on every single poll.
    expect(text).not.toContain("never called task_complete")
    // ...and a live poll never pays for a multi-megabyte trace.
    expect(h.calls).toHaveLength(1)
  })

  test("a queued job is told the queue is the thing to watch", async () => {
    use([() => jsonResponse(CREATED_JOB)])
    const text = textOf(await call("get_job", { jobId: JOB_ID }))
    expect(text).toMatch(/next: check again in ~2 min; job created \d+ min ago\./)
    expect(text).toContain("no compute has been allocated yet")
  })

  test("a failed trace read still returns the state and outcome", async () => {
    // The trace is the summary's only source, but the state/outcome half of the
    // answer is more useful than an exception. A transient 503 must degrade.
    use([() => jsonResponse(FAILED_JOB), () => jsonResponse({ message: "unavailable" }, { status: 503 })])
    const result = await call("get_job", { jobId: JOB_ID })
    const text = textOf(result)
    expect(result.isError).toBeUndefined()
    expect(text).toContain("state: Failed")
    expect(text).toContain("summary: none")
  })

  test("a bad job id is refused before any request", async () => {
    const h = use()
    await expect(call("get_job", { jobId: "../../v2/jobs" })).rejects.toThrow(/not a valid Cloud Agent job id/)
    expect(h.calls).toHaveLength(0)
  })
})

// --- wait_for_job ----------------------------------------------------------

describe("wait_for_job", () => {
  test("returns as soon as the job leaves the queue", async () => {
    use([() => jsonResponse(CREATED_JOB), () => jsonResponse({ ...CREATED_JOB, state: "InProgress" })])
    const text = textOf(await call("wait_for_job", { jobId: JOB_ID, max_wait_s: 1 }))
    expect(text).toMatch(/the handoff took: the job left the queue within \d+ s \(\d+ poll\(s\)\)\./)
    expect(text).toContain("next: the job is running. Check with get_job in about 10 minutes")
  })

  test("a job still queued at the deadline is a normal answer, bounded in time", async () => {
    use([() => jsonResponse(CREATED_JOB), () => jsonResponse(CREATED_JOB)])
    const startedAt = Date.now()
    const text = textOf(await call("wait_for_job", { jobId: JOB_ID, max_wait_s: 1 }))
    const elapsedMs = Date.now() - startedAt

    expect(text).toMatch(/still Queued after \d+ s \(\d+ poll\(s\)\) — the service has not allocated compute yet\./)
    expect(text).toContain("next: nothing is wrong yet — a job can sit in the queue.")
    // The bound is the contract: this call can never be what holds an in-flight
    // MCP slot for ten minutes.
    expect(elapsedMs).toBeLessThan(5_000)
  })

  test("a terminal job returns its deliverable instead of waiting", async () => {
    use([() => jsonResponse(SUCCEEDED_JOB), () => jsonResponse(SUCCEEDED_TRACE)])
    const text = textOf(await call("wait_for_job", { jobId: JOB_ID }))
    expect(text).toContain("summary (the job's deliverable):")
    expect(text).toContain("Fixed the race by awaiting the condition.")
    expect(text).toMatch(/next: the job finished within \d+ s\./)
  })

  test("the wait is capped, so a caller cannot hold the slot indefinitely", async () => {
    const h = use()
    await expect(call("wait_for_job", { jobId: JOB_ID, max_wait_s: 51 }))
      .rejects.toThrow(/`max_wait_s` must be an integer from 1 to 50/)
    expect(h.calls).toHaveLength(0)
  })
})

// --- list_jobs -------------------------------------------------------------

describe("list_jobs", () => {
  const PAGE = {
    data: [
      { ...SUCCEEDED_JOB },
      { ...CREATED_JOB, metadata: { chain: "implement" } },
    ],
    hasMore: false,
  }

  test("filters by the explicit repository and renders one line per job", async () => {
    const h = use([() => jsonResponse(PAGE)])
    const text = textOf(await call("list_jobs", REPOSITORY))
    const url = new URL(h.calls[0]!.url)

    expect(url.pathname).toBe("/api/agency/jobs")
    expect(url.searchParams.get("organization")).toBe("contoso")
    expect(url.searchParams.get("project")).toBe("platform")
    expect(url.searchParams.get("repository")).toBe("web")
    // pageSize is only sent when asked, so the service default is never
    // narrowed behind the caller's back.
    expect(url.searchParams.has("pageSize")).toBe(false)

    expect(text).toContain("2 job(s):")
    expect(text).toContain(
      `${JOB_ID}  Completed  Succeeded  2026-10-29T10:00:00Z  contoso/platform/web  PR#4123  [chain=research step=1]  Fix the flaky login test`,
    )
    expect(text).toContain("  [chain=implement]  ")
  })

  test("with no repository at all, says it is unfiltered instead of pretending", async () => {
    const h = use([() => jsonResponse(PAGE)])
    const text = textOf(await call("list_jobs"))
    const url = new URL(h.calls[0]!.url)
    expect(url.searchParams.has("organization")).toBe(false)
    expect(url.searchParams.has("repository")).toBe(false)
    expect(text).toContain("[repository: not filtered")
    expect(text).toContain("this lists every job the account can see]")
  })

  test("a workspace that is not an Azure DevOps checkout degrades to unfiltered", async () => {
    // A session workspace that happens to be a plain directory (or a checkout
    // with no ADO remote) must not fail the ledger read; it just cannot narrow.
    const h = use([() => jsonResponse(PAGE)])
    const text = textOf(
      await call("list_jobs", { workspace: plainDir }, { workspaceSource: "session" }),
    )
    expect(text).toContain("[repository: not filtered")
    expect(new URL(h.calls[0]!.url).searchParams.has("organization")).toBe(false)
  })

  test("a caller-named workspace that cannot be read drops the filter instead of failing", async () => {
    // Reproduced from a live session. Claude Code fills every optional property
    // rather than omitting it, so "list the whole ledger" arrived as
    // { organization: "", project: "", repository: "", workspace: <a GitHub
    // checkout>, pullRequestId: 0, pageSize: 100, continuationToken: "" }.
    // The repository here is a FILTER, so an unreadable checkout means "do not
    // narrow" — failing the call for it hid the ledger behind a field the
    // caller never needed.
    const h = use([() => jsonResponse(PAGE)])
    const text = textOf(
      await call(
        "list_jobs",
        {
          organization: "",
          project: "",
          repository: "",
          workspace: plainDir,
          pullRequestId: 0,
          pageSize: 100,
          continuationToken: "",
        },
        { workspaceSource: "argument" },
      ),
    )
    const url = new URL(h.calls[0]!.url)
    expect(url.searchParams.has("organization")).toBe(false)
    expect(url.searchParams.has("pullRequestId")).toBe(false)
    expect(url.searchParams.has("continuationToken")).toBe(false)
    // pageSize was a real choice, not a placeholder, and survives.
    expect(url.searchParams.get("pageSize")).toBe("100")
    expect(text).toContain("2 job(s):")
    expect(text).toContain(
      "[repository: not filtered — Could not read an Azure DevOps repository from",
    )
  })

  test("a partial repository triple is still a typo, not a filter", async () => {
    const h = use()
    await expect(call("list_jobs", { organization: "contoso" }))
      .rejects.toThrow(/Pass all of `organization`, `project` and `repository`, or none/)
    expect(h.calls).toHaveLength(0)
  })

  test("a page that has more says how to continue", async () => {
    use([() => jsonResponse({ ...PAGE, hasMore: true, continuationToken: "next-page" })])
    const text = textOf(await call("list_jobs", REPOSITORY))
    expect(text).toContain('Pass continuationToken "next-page" to continue.')
  })

  test("continuationToken and pullRequestId round-trip into the query", async () => {
    const h = use([() => jsonResponse({ data: [] })])
    const text = textOf(
      await call("list_jobs", { ...REPOSITORY, pullRequestId: 4123, continuationToken: "abc" }),
    )
    const url = new URL(h.calls[0]!.url)
    expect(url.searchParams.get("pullRequestId")).toBe("4123")
    expect(url.searchParams.get("continuationToken")).toBe("abc")
    expect(text).toContain("No jobs matched.")
  })
})

// --- get_job_logs ----------------------------------------------------------

describe("get_job_logs", () => {
  test("the digest leads with the summary and names what changed", async () => {
    use([() => jsonResponse(SUCCEEDED_TRACE)])
    const text = textOf(await call("get_job_logs", { jobId: JOB_ID }))
    expect(text).toContain(`trace for job ${JOB_ID}: 4 message(s), 3 tool call(s)`)
    const summaryAt = text.indexOf("summary (the job's deliverable):")
    expect(summaryAt).toBeGreaterThan(-1)
    expect(text.indexOf("tool use:")).toBeGreaterThan(summaryAt)
    expect(text).toContain("tool use: edit=1 task_complete=1 view=1")
    expect(text).toContain("changed files (1):")
    expect(text).toContain("  src/login.test.ts")
    expect(text).toContain("final tool result (the last thing the agent saw):")
    expect(text).toContain("describe('login', …)")
  })

  test("a failed job's digest explains itself instead of claiming a summary", async () => {
    use([() => jsonResponse(FAILED_TRACE)])
    const text = textOf(await call("get_job_logs", { jobId: JOB_ID }))
    expect(text).toContain("summary: none — the job never called task_complete")
    expect(text).toContain('npm ERR! Missing script: "test"')
  })

  test("the tail bounds how much of a long run is listed", async () => {
    use([() => jsonResponse(SUCCEEDED_TRACE)])
    const text = textOf(await call("get_job_logs", { jobId: JOB_ID, tail: 1 }))
    expect(text).toContain("recent tool calls (last 1):")
    expect(text).not.toContain("view {")
  })

  test("an unknown mode is refused before any request", async () => {
    const h = use()
    await expect(call("get_job_logs", { jobId: JOB_ID, mode: "raw" }))
      .rejects.toThrow(/`mode` must be "digest" or "full"/)
    expect(h.calls).toHaveLength(0)
  })

  test("mode full returns the service's own bytes", async () => {
    const raw = JSON.stringify(SUCCEEDED_TRACE)
    use([() => jsonResponse(SUCCEEDED_TRACE)])
    const text = textOf(await call("get_job_logs", { jobId: JOB_ID, mode: "full" }))
    expect(text).toBe(raw)
  })

  test("reading the digest warms the summary cache, so the next poll costs one request", async () => {
    const h = use([() => jsonResponse(SUCCEEDED_TRACE), () => jsonResponse(SUCCEEDED_JOB)])
    await call("get_job_logs", { jobId: JOB_ID })
    const text = textOf(await call("get_job", { jobId: JOB_ID }))

    expect(h.calls).toHaveLength(2)
    expect(new URL(h.calls[1]!.url).pathname).toBe(`/api/agency/jobs/${JOB_ID}`)
    expect(text).toContain("summary (the job's deliverable):")
    expect(text).toContain("Fixed the race by awaiting the condition.")
  })

  test("the digest warms only a POSITIVE summary, never a negative one", async () => {
    // The digest handler cannot tell a terminal job from a running one, so
    // caching "no summary" here would let a later terminal poll assert that a
    // summary never came — a false claim about a job that did call
    // task_complete. The negative verdict is cached in `summaryFor`, which only
    // reads a trace once it knows the job is terminal.
    const h = use([
      () => jsonResponse(FAILED_TRACE), // get_job_logs: parsed, not cached
      () => jsonResponse(FAILED_JOB), // get_job: state
      () => jsonResponse(FAILED_TRACE), // get_job: trace, negative verdict cached here
      () => jsonResponse(FAILED_JOB), // get_job again: state only
    ])
    await call("get_job_logs", { jobId: JOB_ID })
    const first = textOf(await call("get_job", { jobId: JOB_ID }))
    const second = textOf(await call("get_job", { jobId: JOB_ID }))

    expect(h.calls).toHaveLength(4)
    expect(first).toContain("summary: none")
    // The property that matters: a repeated poll of a finished, summary-less
    // job never re-fetches a multi-megabyte trace.
    expect(second).toContain("summary: none")
  })
})

// --- cancel_job ------------------------------------------------------------

describe("cancel_job", () => {
  test("posts the v1-shaped cancel route and reports the request", async () => {
    const h = use([() => new Response(null, { status: 202 })])
    const text = textOf(await call("cancel_job", { jobId: JOB_ID }))

    expect(h.calls[0]!.method).toBe("POST")
    // The docs are explicit that there is no `/v2/.../cancel`; getting this
    // wrong is a 404 the caller would read as "the job is gone".
    expect(new URL(h.calls[0]!.url).pathname).toBe(`/api/agency/jobs/${JOB_ID}/cancel`)
    expect(h.calls[0]!.url).not.toContain("/v2/")
    expect(text).toContain(`Cancellation requested for job ${JOB_ID}.`)
    expect(text).toContain("stops the job asynchronously")
  })

  test("a 200 means it was already cancelled, and reports the final job", async () => {
    use([() => jsonResponse({ ...SUCCEEDED_JOB, state: "Cancelled" })])
    const text = textOf(await call("cancel_job", { jobId: JOB_ID }))
    expect(text).toContain("the job was already cancelled; nothing further will happen to it.")
    expect(text).toContain("state: Cancelled")
  })

  test("a bad job id is refused before any request", async () => {
    const h = use()
    await expect(call("cancel_job", { jobId: " " })).rejects.toThrow(/`jobId` is required/)
    expect(h.calls).toHaveLength(0)
  })
})

// --- list_plugins / list_agents -------------------------------------------

describe("list_plugins", () => {
  const PLUGINS = {
    totalCount: 233,
    value: [
      { name: "repo-search", type: "Repo", description: "Search the repository" },
      { name: "ado-sync", type: "Organization", enabledByDefault: true },
      { name: "docs" },
    ],
  }

  test("sends no page size unless asked, so the service default is not narrowed", async () => {
    const h = use([() => jsonResponse(PLUGINS)])
    textOf(await call("list_plugins"))
    const url = new URL(h.calls[0]!.url)
    expect(url.pathname).toBe("/api/agency/plugins")
    // Measured: the default page is 50 of 233, and `top > 100` is a 400 unless
    // `marketplace` is set. A silent default here would either shrink the page
    // or provoke that 400.
    expect(url.searchParams.has("top")).toBe(false)
    expect(url.searchParams.has("skip")).toBe(false)
  })

  test("name_contains searches the catalog and says how much of it was read", async () => {
    use([() => jsonResponse(PLUGINS)])
    const text = textOf(await call("list_plugins", { name_contains: "REPO" }))
    expect(text).toContain('[name_contains "repo": 1 match(es) in all 233 plugin(s)]')
    expect(text).toContain("1 plugin(s):")
    expect(text).toContain("  repo-search [Repo] — Search the repository")
    expect(text).not.toContain("ado-sync")
  })

  test("a name search pages through the whole catalog, not just the first page", async () => {
    // The measured catalog is 233 entries at 100 per page, so a filter applied
    // to one page would have missed most plugins while looking like an answer.
    const first = {
      totalCount: 102,
      value: Array.from({ length: 100 }, (_, i) => ({ name: `plugin-${i}`, type: "Company" })),
    }
    const second = { totalCount: 102, value: [{ name: "repo-tool" }, { name: "other" }] }
    const h = use([() => jsonResponse(first), () => jsonResponse(second)])
    const text = textOf(await call("list_plugins", { name_contains: "repo" }))
    expect(h.calls).toHaveLength(2)
    // Each request asks for the service maximum and advances by the entries read.
    expect(new URL(h.calls[0]!.url).searchParams.get("top")).toBe("100")
    expect(new URL(h.calls[1]!.url).searchParams.get("skip")).toBe("100")
    expect(text).toContain('[name_contains "repo": 1 match(es) in all 102 plugin(s)]')
    expect(text).toContain("  repo-tool")
  })

  test("with name_contains, top/skip window the matches rather than the catalog", async () => {
    const page = { totalCount: 3, value: [{ name: "repo-a" }, { name: "repo-b" }, { name: "repo-c" }] }
    const h = use([() => jsonResponse(page)])
    const text = textOf(await call("list_plugins", { name_contains: "repo", top: 1, skip: 1 }))
    expect(text).toContain('[name_contains "repo": 3 match(es) in all 3 plugin(s), showing 2-2]')
    expect(text).toContain("  repo-b")
    expect(text).not.toContain("repo-a")
    // The caller's cap windows matches; it must not shrink the scan page.
    expect(new URL(h.calls[0]!.url).searchParams.get("top")).toBe("100")
  })

  test("a search that matches nothing says the whole catalog was read", async () => {
    use([() => jsonResponse(PLUGINS)])
    const text = textOf(await call("list_plugins", { name_contains: "zzz" }))
    expect(text).toContain('[name_contains "zzz": no plugin name contains it, searched all 233 plugin(s)]')
  })

  test("the page renders type, default-enabled and the total", async () => {
    use([() => jsonResponse(PLUGINS)])
    const text = textOf(await call("list_plugins"))
    expect(text).toContain("3 of 233 plugin(s):")
    expect(text).toContain("  ado-sync [Organization] (enabled by default)")
  })

  test("top above the service limit is refused here rather than forwarded as a 400", async () => {
    const h = use()
    await expect(call("list_plugins", { top: 101 }))
      .rejects.toThrow(/`top` must be an integer from 1 to 100/)
    expect(h.calls).toHaveLength(0)
  })

  test("type and skip round-trip into the query", async () => {
    const h = use([() => jsonResponse({ value: [] })])
    textOf(await call("list_plugins", { type: "Company", skip: 50, top: 25 }))
    const url = new URL(h.calls[0]!.url)
    expect(url.searchParams.get("type")).toBe("Company")
    expect(url.searchParams.get("skip")).toBe("50")
    expect(url.searchParams.get("top")).toBe("25")
  })
})

describe("list_agents", () => {
  const AGENTS = {
    value: [{
      name: "echo",
      type: "Repo",
      engine: "copilot",
      description: "Echoes its input",
      inputs: {
        spec: { type: "string", required: true, description: "The specification" },
        dry: { type: "boolean" },
      },
    }],
  }

  test("renders each agent with the input names create_job must supply", async () => {
    const h = use([() => jsonResponse(AGENTS)])
    const text = textOf(await call("list_agents"))
    expect(new URL(h.calls[0]!.url).pathname).toBe("/api/agency/agents")
    expect(text).toContain("echo [Repo] (engine: copilot)")
    expect(text).toContain("    Echoes its input")
    // The only place these names appear: the service rejects a job whose agent
    // is missing a required input, so the digest has to carry them.
    expect(text).toContain("    inputs: spec (string, required) — The specification; dry (boolean, optional)")
  })

  test("an empty catalog says so instead of rendering a header alone", async () => {
    use([() => jsonResponse({ value: [], totalCount: 0 })])
    expect(textOf(await call("list_agents"))).toContain("No agents matched.")
  })
})

// --- Token handling --------------------------------------------------------

describe("the bearer", () => {
  test("is sent upstream and never appears in a result", async () => {
    const h = use([
      () => jsonResponse(CREATED_JOB, { status: 201 }),
      () => jsonResponse(FAILED_JOB),
      () => jsonResponse(FAILED_TRACE),
    ])
    const results = [
      await call("create_job", { prompt: "Fix the flaky login test", ...REPOSITORY }),
      await call("get_job", { jobId: JOB_ID }),
    ]

    // Asserting the header first is what keeps the leak assertion honest: if
    // the token were never on the wire, "not in the output" would prove nothing.
    for (const request of h.calls) {
      expect(request.headers.Authorization).toBe(`Bearer ${SYNTHETIC_TOKEN}`)
    }
    for (const result of results) {
      const text = textOf(result)
      expect(text).not.toContain(SYNTHETIC_TOKEN)
      expect(text).not.toContain("Bearer")
    }
  })

  test("a 401 says to sign in again, and a 403 says the token was fine", async () => {
    use([() => jsonResponse({ message: "nope" }, { status: 401 }), () => jsonResponse({ message: "nope" }, { status: 401 })])
    await expect(call("get_job", { jobId: JOB_ID })).rejects.toThrow(/az login/)

    use([() => jsonResponse({ message: "no access to this repository" }, { status: 403 })])
    await expect(call("get_job", { jobId: JOB_ID }))
      .rejects.toThrow(/The token was accepted; this is an authorization verdict/)
  })
})
