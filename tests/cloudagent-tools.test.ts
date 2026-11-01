import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { CloudAgentClient } from "../src/lib/cloudagent-client"
import {
  CLOUDAGENT_TOOLS,
  resetCloudAgentClientForTesting,
  setCloudAgentClientForTesting,
  setCloudAgentRepoIdResolverForTesting,
} from "../src/lib/cloudagent-tools"
import type { AzureRepoIdQuery, AzureRepoIds } from "../src/lib/azure-repo"
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
  prompt?: string
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

/**
 * The Azure DevOps GUIDs `list_jobs` sends for the human names above.
 *
 * The service matches `project` and `repository` by ID only: a name narrows to
 * zero rows and reports no error, which is measured against prod. So the
 * handler resolves names through Azure DevOps REST first, and this is what a
 * test gets instead of a real lookup (which would spawn `az` and hit the
 * network).
 */
const PROJECT_ID = "11ac29bc-5a99-400b-b225-01839ab0c9df"
const REPO_ID = "1b255d6e-1545-42ab-9e75-1fb3f0202dfa"

function fakeRepoIds(query: AzureRepoIdQuery): Promise<AzureRepoIds> {
  return Promise.resolve({
    projectId: PROJECT_ID,
    ...(query.repository ? { repositoryId: REPO_ID } : {}),
  })
}

beforeEach(() => {
  state.cloudAgentEnvironment = "prod"
  resetCloudAgentClientForTesting()
  // A default install, so a handler that unexpectedly reaches the client fails
  // on an exhausted queue instead of constructing a real one that would try to
  // mint an Entra token through `az`.
  use()
  setCloudAgentRepoIdResolverForTesting(fakeRepoIds)
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
  test("is the ten tools the plan specifies, in the cloudagent group", () => {
    expect(CLOUDAGENT_TOOLS.map((tool) => tool.toolNameHttp).sort()).toEqual([
      "cancel_job",
      "create_job",
      "create_pr_job",
      "get_job",
      "get_job_logs",
      "list_agents",
      "list_jobs",
      "list_models",
      "list_plugins",
      "wait_for_job",
    ])
    for (const tool of CLOUDAGENT_TOOLS) expect(tool.group).toBe("cloudagent")
  })

  test("labels the compute-spending tools, even though the group is one switch", () => {
    const capabilities = Object.fromEntries(
      CLOUDAGENT_TOOLS.map((tool) => [tool.toolNameHttp, tool.capability]),
    )
    expect(capabilities).toEqual({
      create_job: "cloudagent_write",
      create_pr_job: "cloudagent_write",
      cancel_job: "cloudagent_write",
      get_job: "cloudagent",
      list_jobs: "cloudagent",
      wait_for_job: "cloudagent",
      get_job_logs: "cloudagent",
      list_plugins: "cloudagent",
      list_agents: "cloudagent",
      list_models: "cloudagent",
    })
  })

  test("every schema is closed, so an unknown argument is rejected instead of ignored", () => {
    for (const tool of CLOUDAGENT_TOOLS) {
      expect(tool.inputSchema.additionalProperties).toBe(false)
      expect(tool.inputSchema.type).toBe("object")
    }
  })

  test("only the argument a call cannot be expressed without is required", () => {
    // A schema of optional properties reads to a model as a form to fill in,
    // and a live session did exactly that: `list_jobs` with an empty
    // organization/project/repository triple and a `pageSize` of 0, every one
    // of which the service rejected. Marking an argument required makes it a
    // hard call failure, so the required list stays at the one value a call
    // cannot be expressed without: `jobId` for the job readers, and `prompt`
    // for `create_pr_job`, whose whole purpose is to carry a task.
    for (const tool of CLOUDAGENT_TOOLS) {
      const required = (tool.inputSchema.required ?? []) as string[]
      const expected = tool.toolNameHttp === "create_pr_job"
        ? ["prompt"]
        : "jobId" in propertiesOf(tool) ? ["jobId"] : []
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
    expect(tool.description).toContain("can run for many hours")
    expect(tool.description).toContain("Confirm with the user")
  })

  test("create_pr_job's description carries its cost, plugin and follow-up contract", () => {
    const tool = toolNamed("create_pr_job")
    // The same two properties create_job's surface cannot function without,
    // plus the two decisions this tool makes on the caller's behalf.
    expect(tool.description).toContain("ONE-SHOT")
    expect(tool.description).toContain("can run for many hours")
    expect(tool.description).toContain("Confirm with the user")
    expect(tool.description).toContain("agency-coding")
    expect(tool.description).toContain("claude-opus-5.5 at max reasoning effort")
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

  test("defaults to the normal tier, so no job runs on an unstated model choice", async () => {
    const h = use([() => jsonResponse(CREATED_JOB, { status: 201 })])
    const text = textOf(await call("create_job", { prompt: "Fix it", ...REPOSITORY }))
    expect(createJobBody(h).modelConfiguration).toEqual({
      model: "gpt-6-astra",
      reasoningEffort: "max",
    })
    // The echo has to say the tier supplied them: GET /jobs/{id} never returns
    // modelConfiguration, so "effort: max" alone would read as a caller choice.
    expect(text).toContain("tier: normal, the default — supplied model gpt-6-astra and effort max.")
  })

  test("each tier maps to its measured model at max effort", async () => {
    const expected = {
      easy: "claude-opus-4.8-fast",
      normal: "gpt-6-astra",
      complex: "claude-opus-5.5",
    } as const
    for (const [tier, model] of Object.entries(expected)) {
      const h = use([() => jsonResponse(CREATED_JOB, { status: 201 })])
      await call("create_job", { prompt: "Fix it", ...REPOSITORY, tier })
      expect({ tier, modelConfiguration: createJobBody(h).modelConfiguration }).toEqual({
        tier,
        modelConfiguration: { model, reasoningEffort: "max" },
      })
    }
  })

  test("an explicit model replaces the preset and drops its effort", async () => {
    // Not a partial override: measured live, 8 of 25 models reject `max`, so
    // carrying the preset's effort onto a caller-named model would send a value
    // nobody asked for that the service may reject.
    const h = use([() => jsonResponse(CREATED_JOB, { status: 201 })])
    const text = textOf(
      await call("create_job", { prompt: "Fix it", ...REPOSITORY, model: "gpt-5.6-sol" }),
    )
    expect(createJobBody(h).modelConfiguration).toEqual({ model: "gpt-5.6-sol" })
    expect(text).toContain(
      "tier: normal, the default — replaced by model gpt-5.6-sol, so its max effort was dropped",
    )
  })

  test("an explicit effort keeps the tier's model", async () => {
    const h = use([() => jsonResponse(CREATED_JOB, { status: 201 })])
    await call("create_job", { prompt: "Fix it", ...REPOSITORY, tier: "easy", reasoningEffort: "high" })
    expect(createJobBody(h).modelConfiguration).toEqual({
      model: "claude-opus-4.8-fast",
      reasoningEffort: "high",
    })
  })

  test("an unknown tier is rejected before the request, naming the presets", async () => {
    const h = use()
    await expect(call("create_job", { prompt: "x", ...REPOSITORY, tier: "extreme" }))
      .rejects.toThrow(/`tier` must be easy, normal or complex \(got "extreme"\).*gpt-6-astra/)
    expect(h.calls).toHaveLength(0)
  })
})

// --- create_pr_job ---------------------------------------------------------

describe("create_pr_job", () => {
  const TASK = "Add a /healthz endpoint that returns the build id, with a test."

  test("composes the fixed workflow ahead of the task and sends no systemPrompt", async () => {
    const h = use([() => jsonResponse(CREATED_JOB, { status: 201 })])
    await call("create_pr_job", { prompt: TASK, ...REPOSITORY })

    const body = createJobBody(h)
    const prompt = body.prompt ?? ""
    // The API has no system-prompt field, so the workflow and the caller's
    // task share one string. The delimiter is what keeps them distinguishable:
    // process first, the actual request last.
    expect(prompt.startsWith("[github-router PR workflow v3]")).toBe(true)
    expect(prompt).toContain(`<user_task>\n${TASK}\n</user_task>`)
    expect(prompt.indexOf("[github-router PR workflow v3]")).toBeLessThan(prompt.indexOf("<user_task>"))
    expect(prompt.endsWith("</user_task>")).toBe(true)
    expect("systemPrompt" in body).toBe(false)

    // Structure, not prose: pinning these keeps a rewrite from silently
    // dropping the request-fidelity guard, the unattended-run rules, the
    // delegation rules, or the exit criteria.
    for (const section of [
      "# The request",
      "# Staying in motion",
      "# Working style",
      "# Definition of done",
      "# Reporting",
    ]) {
      expect(prompt).toContain(section)
    }
    expect(prompt).toContain("## 3. Review the plan")
    expect(prompt).toContain("## 6. Review the implementation")
    expect(prompt).toContain("MSTeams")
  })

  test("loads agency-coding and defaults to opus-5.5 at max", async () => {
    const h = use([() => jsonResponse(CREATED_JOB, { status: 201 })])
    const text = textOf(await call("create_pr_job", { prompt: TASK, ...REPOSITORY }))
    const body = createJobBody(h)
    expect(body.plugins).toEqual([{ name: "agency-coding" }])
    expect(body.modelConfiguration).toEqual({
      model: "claude-opus-5.5",
      reasoningEffort: "max",
    })
    // The echo is the only durable record: GET /jobs/{id} never returns
    // modelConfiguration.
    expect(text).toContain("plugins: agency-coding")
    expect(text).toContain("model claude-opus-5.5, effort max")
    expect(text).toContain("tier: complex, the default — supplied model claude-opus-5.5 and effort max.")
  })

  test("honors tier and model overrides", async () => {
    const easy = use([() => jsonResponse(CREATED_JOB, { status: 201 })])
    await call("create_pr_job", { prompt: TASK, ...REPOSITORY, tier: "easy" })
    expect(createJobBody(easy).modelConfiguration).toEqual({
      model: "claude-opus-4.8-fast",
      reasoningEffort: "max",
    })

    const model = use([() => jsonResponse(CREATED_JOB, { status: 201 })])
    const text = textOf(
      await call("create_pr_job", { prompt: TASK, ...REPOSITORY, model: "gpt-5.6-sol" }),
    )
    expect(createJobBody(model).modelConfiguration).toEqual({ model: "gpt-5.6-sol" })
    expect(text).toContain(
      "tier: complex, the default — replaced by model gpt-5.6-sol, so its max effort was dropped",
    )

    const effort = use([() => jsonResponse(CREATED_JOB, { status: 201 })])
    await call("create_pr_job", {
      prompt: TASK,
      ...REPOSITORY,
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
    })
    expect(createJobBody(effort).modelConfiguration).toEqual({
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
    })
  })

  test("infers the repository from the workspace and reports provenance", async () => {
    use([() => jsonResponse(CREATED_JOB, { status: 201 })])
    const text = textOf(
      await call(
        "create_pr_job",
        { prompt: TASK, workspace: repoDir },
        { workspaceSource: "argument" },
      ),
    )
    expect(text).toContain(
      "[repository: contoso/platform/web (inferred from the workspace you passed)]",
    )
    expect(text).toContain("  repository: contoso/platform/web")
  })

  test("a missing prompt fails before any request", async () => {
    const h = use()
    await expect(call("create_pr_job", { ...REPOSITORY }))
      .rejects.toThrow(/`prompt` is required/)
    expect(h.calls).toHaveLength(0)
  })

  test("the effective request shows the plugin and the truncated composed prompt", async () => {
    use([() => jsonResponse(CREATED_JOB, { status: 201 })])
    const text = textOf(await call("create_pr_job", { prompt: TASK, ...REPOSITORY }))
    expect(text).toContain("effective request (the normalized body the service received):")
    // renderEffectiveRequest clips at 300 chars, so the fixed directive can
    // never flood the tool result.
    expect(text).toContain("prompt: [github-router PR workflow v3]")
    expect(text).toContain("plugins: agency-coding")
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
    const seen: Array<AzureRepoIdQuery> = []
    setCloudAgentRepoIdResolverForTesting((query) => {
      seen.push(query)
      return fakeRepoIds(query)
    })
    const h = use([() => jsonResponse(PAGE)])
    const text = textOf(await call("list_jobs", REPOSITORY))
    const url = new URL(h.calls[0]!.url)

    expect(url.pathname).toBe("/api/agency/jobs")
    expect(url.searchParams.get("organization")).toBe("contoso")
    // Names go to Azure DevOps; the service only understands ids. Measured
    // against prod: project=platform narrowed to zero rows, silently.
    expect(url.searchParams.get("project")).toBe(PROJECT_ID)
    expect(url.searchParams.get("repository")).toBe(REPO_ID)
    expect(seen).toEqual([
      { organization: "contoso", project: "platform", repository: "web" },
    ])
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

  test("an organization alone is a valid narrowing, and costs no lookup", async () => {
    // Unlike a job's repository (one exact triple or nothing), a FILTER is a
    // prefix: the organization is matched by name, so it needs no resolution
    // and is useful on its own.
    let lookups = 0
    setCloudAgentRepoIdResolverForTesting((query) => {
      lookups += 1
      return fakeRepoIds(query)
    })
    const h = use([() => jsonResponse(PAGE)])
    textOf(await call("list_jobs", { organization: "contoso" }))
    const url = new URL(h.calls[0]!.url)
    expect(url.searchParams.get("organization")).toBe("contoso")
    expect(url.searchParams.has("project")).toBe(false)
    expect(url.searchParams.has("repository")).toBe(false)
    expect(lookups).toBe(0)
  })

  test("a project with no organization is a typo, not a filter", async () => {
    const h = use()
    await expect(call("list_jobs", { project: "platform" }))
      .rejects.toThrow(/`project` and `repository` narrow within an `organization`/)
    expect(h.calls).toHaveLength(0)
  })

  test("a repository with no project is a typo, not a filter", async () => {
    const h = use()
    await expect(call("list_jobs", { organization: "contoso", repository: "web" }))
      .rejects.toThrow(/`repository` narrows within a `project`/)
    expect(h.calls).toHaveLength(0)
  })

  test("a caller-named filter that cannot be resolved fails instead of lying", async () => {
    // The whole point of the argument: a ledger that LOOKS filtered and is not
    // is worse than an error. So a name the caller supplied, which Azure DevOps
    // cannot resolve, refuses the call and names both ways out.
    const h = use()
    setCloudAgentRepoIdResolverForTesting(() =>
      Promise.reject(new Error('Azure DevOps has no repository "nope" (HTTP 404).')),
    )
    await expect(call("list_jobs", REPOSITORY))
      .rejects.toThrow(/Pass only `organization` to narrow by organization, or omit all three/)
    expect(h.calls).toHaveLength(0)
  })

  test("an inferred filter resolves the same way and says where it came from", async () => {
    const seen: Array<AzureRepoIdQuery> = []
    setCloudAgentRepoIdResolverForTesting((query) => {
      seen.push(query)
      return fakeRepoIds(query)
    })
    const h = use([() => jsonResponse(PAGE)])
    const text = textOf(
      await call("list_jobs", { workspace: repoDir }, { workspaceSource: "session" }),
    )
    const url = new URL(h.calls[0]!.url)
    expect(url.searchParams.get("organization")).toBe("contoso")
    expect(url.searchParams.get("project")).toBe(PROJECT_ID)
    expect(url.searchParams.get("repository")).toBe(REPO_ID)
    expect(seen).toEqual([
      { organization: "contoso", project: "platform", repository: "web" },
    ])
    expect(text).toContain(
      "[repository: contoso/platform/web (inferred from this session's workspace)]",
    )
  })

  test("a filter read off a checkout that cannot be resolved drops to the organization", async () => {
    // An inferred filter is a convenience, not a request: when the checkout's
    // names cannot be resolved, keep the part that needs no lookup (the
    // organization, matched by name) and say what happened. Failing here would
    // turn "list the ledger from inside this repo" into an error.
    setCloudAgentRepoIdResolverForTesting(() =>
      Promise.reject(new Error("Azure DevOps lookup for project \"web\" was refused with HTTP 403.")),
    )
    const h = use([() => jsonResponse(PAGE)])
    const text = textOf(
      await call("list_jobs", { workspace: repoDir }, { workspaceSource: "session" }),
    )
    const url = new URL(h.calls[0]!.url)
    expect(url.searchParams.get("organization")).toBe("contoso")
    expect(url.searchParams.has("project")).toBe(false)
    expect(url.searchParams.has("repository")).toBe(false)
    expect(text).toContain('[filter: organization "contoso" only')
    expect(text).toContain("were dropped.")
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

  test("an empty page still reports the service's reason", async () => {
    // Measured live: a scope whose marketplace does not exist answers 200 with
    // an empty page and the explanation in `errors`. Rendering only "No agents
    // matched." made "nothing exists" and "it looked somewhere else"
    // indistinguishable, and the second one is actionable.
    use([() => jsonResponse({
      value: [],
      totalCount: 0,
      errors: ["No organization plugin marketplace found. Searched: https://dev.azure.com/contoso/AzureDevOps/_git/ado-private"],
    })])
    const text = textOf(await call("list_agents"))
    expect(text).toContain("No agents matched.")
    expect(text).toContain("reason: No organization plugin marketplace found. Searched: https://dev.azure.com/contoso/AzureDevOps/_git/ado-private")
  })

  test("errors alongside rows are labelled as qualifying them", async () => {
    use([() => jsonResponse({ ...AGENTS, errors: ["One marketplace could not be read."] })])
    const text = textOf(await call("list_agents"))
    expect(text).toContain("echo [Repo]")
    expect(text).toContain("partial results: One marketplace could not be read.")
    expect(text).not.toContain("reason:")
  })
})

describe("list_models", () => {
  const MODELS = {
    models: [
      {
        id: "gpt-6-astra",
        name: "GPT-6 Astra",
        vendor: "OpenAI",
        preview: false,
        modelPickerEnabled: true,
        modelPickerCategory: "powerful",
        capabilities: {
          type: "chat",
          supports: { toolCalls: true, vision: true, reasoningEffort: ["low", "medium", "high", "xhigh", "max"] },
          limits: { maxContextWindowTokens: 400_000, maxOutputTokens: 128_000 },
        },
        billing: { isPremium: true, multiplier: 1 },
      },
      {
        id: "claude-opus-4.8-fast",
        name: "Claude Opus 4.8 Fast",
        vendor: "Anthropic",
        preview: true,
        capabilities: {
          type: "chat",
          supports: { toolCalls: true, reasoningEffort: ["low", "high"] },
          limits: { maxContextWindowTokens: 264_000, maxOutputTokens: 64_000 },
        },
        billing: { isPremium: true, multiplier: 1 },
        infoMessages: [{ code: "model_pending_deprecation", message: "Retires on 2027-01-01." }],
      },
    ],
  }

  test("leads with the tier presets, then the live catalog", async () => {
    const h = use([() => jsonResponse(MODELS)])
    const text = textOf(await call("list_models", {}))
    // Measured: GET /models is global, so no organization/project/repository
    // filter is sent even when a session has an Azure DevOps checkout.
    const url = new URL(h.calls[0]!.url)
    expect(url.pathname).toBe("/api/agency/models")
    expect([...url.searchParams.keys()]).toEqual([])
    const lines = text.split("\n")
    expect(lines[0]).toBe(
      "create_job tier presets: easy = claude-opus-4.8-fast at max effort; "
      + "normal = gpt-6-astra at max effort (default); complex = claude-opus-5.5 at max effort.",
    )
    expect(text).toContain("gpt-6-astra [OpenAI] — context 400K; max output 128K; effort low/medium/high/xhigh/max")
    // Preview is stated, and the per-model effort ladder is printed because it
    // is not uniform: a caller assuming every model takes `max` gets a 400.
    expect(text).toContain("claude-opus-4.8-fast [Anthropic, preview] — context 264K; max output 64K; effort low/high")
    expect(text).toContain("    note: Retires on 2027-01-01.")
  })

  test("an empty catalog says so", async () => {
    use([() => jsonResponse({ models: [] })])
    expect(textOf(await call("list_models", {}))).toContain("No models were returned.")
  })
})

/**
 * The measured catalog scope behavior, 2026-10-30, prod.
 *
 * The two scopes do not want the same context. `Repo` rejects the query with
 * "Azure DevOps context is required" until the full organization/project/
 * repository triple rides on it, and a partial set earns a component-specific
 * 400 ("ProjectName ... is required", "RepositoryName ... is required",
 * "Project is required when Repository is specified"). `Organization` answers
 * identically with the organization alone or with the full triple, so the tool
 * asks for one name there. Company, Spec and untyped calls read no context at
 * all, so a `Company` call on a machine with no Azure DevOps checkout still
 * works.
 */
describe("catalog scopes and the repository context", () => {
  test("a Repo scope sends the checkout's repository and says it inferred it", async () => {
    const h = use([() => jsonResponse({ value: [] })])
    const text = textOf(await call(
      "list_plugins",
      { type: "Repo", workspace: repoDir },
      { workspaceSource: "argument" },
    ))
    const url = new URL(h.calls[0]!.url)
    expect(url.searchParams.get("type")).toBe("Repo")
    expect(url.searchParams.get("organization")).toBe("contoso")
    expect(url.searchParams.get("project")).toBe("platform")
    expect(url.searchParams.get("repository")).toBe("web")
    expect(text).toContain("[repository: contoso/platform/web (inferred from the workspace you passed)]")
  })

  test("an Organization scope attributes the lookup to the session", async () => {
    const h = use([() => jsonResponse({ value: [] })])
    const text = textOf(await call(
      "list_agents",
      { type: "Organization", workspace: repoDir },
      { workspaceSource: "session" },
    ))
    expect(new URL(h.calls[0]!.url).searchParams.get("repository")).toBe("web")
    expect(text).toContain("[repository: contoso/platform/web (inferred from this session's workspace)]")
  })

  test("a Repo scope with no checkout refuses before any request", async () => {
    const h = use()
    await expect(call("list_plugins", { type: "Repo" }, { workspaceSource: "absent" }))
      .rejects.toThrow(/No repository: pass `organization`, `project` and `repository`, or `workspace`/)
    expect(h.calls).toHaveLength(0)
  })

  test("an untyped or Company call needs no repository and never probes a checkout", async () => {
    // `plainDir` is not a git repository at all. If the handler inferred a
    // context eagerly, naming a plain workspace on a Company call would turn a
    // perfectly good question into a git failure — the `list_jobs` lesson.
    const h = use([() => jsonResponse({ value: [] }), () => jsonResponse({ value: [] })])
    const company = textOf(await call(
      "list_plugins",
      { type: "Company", workspace: plainDir },
      { workspaceSource: "session" },
    ))
    const untyped = textOf(await call("list_plugins", {}, { workspaceSource: "absent" }))
    for (const request of h.calls) {
      expect(new URL(request.url).searchParams.has("organization")).toBe(false)
    }
    expect(company).not.toContain("[repository:")
    expect(untyped).not.toContain("[repository:")
  })

  test("an explicit triple is forwarded without a provenance line", async () => {
    const h = use([() => jsonResponse({ value: [] })])
    const text = textOf(await call("list_plugins", { type: "Repo", ...REPOSITORY }))
    const url = new URL(h.calls[0]!.url)
    expect(url.searchParams.get("organization")).toBe("contoso")
    expect(url.searchParams.get("project")).toBe("platform")
    expect(url.searchParams.get("repository")).toBe("web")
    expect(text).not.toContain("[repository:")
  })

  test("a partial triple is refused rather than guessed", async () => {
    const h = use()
    await expect(call("list_plugins", { type: "Repo", organization: "contoso" }))
      .rejects.toThrow(/so it reads all of `organization`, `project` and `repository`/)
    expect(h.calls).toHaveLength(0)
  })

  test("an Organization scope needs only the organization", async () => {
    // Measured: org-only, org+project, org+repository and the full triple all
    // answer an Organization query identically, so demanding the other two
    // names would make a caller with no checkout invent what is never read.
    const h = use([() => jsonResponse({ value: [] })])
    textOf(await call("list_plugins", { type: "Organization", organization: "contoso" }, { workspaceSource: "absent" }))
    const url = new URL(h.calls[0]!.url)
    expect(url.searchParams.get("type")).toBe("Organization")
    expect(url.searchParams.get("organization")).toBe("contoso")
    expect(url.searchParams.has("project")).toBe(false)
    expect(url.searchParams.has("repository")).toBe(false)
  })

  test("an Organization scope forwards the names it was given alongside the organization", async () => {
    const h = use([() => jsonResponse({ value: [] })])
    const text = textOf(await call("list_agents", { type: "Organization", ...REPOSITORY }))
    const url = new URL(h.calls[0]!.url)
    expect(url.searchParams.get("organization")).toBe("contoso")
    expect(url.searchParams.get("project")).toBe("platform")
    expect(url.searchParams.get("repository")).toBe("web")
    expect(text).not.toContain("[repository:")
  })

  test("an Organization scope without an organization refuses rather than guessing one", async () => {
    const h = use()
    await expect(call("list_plugins", { type: "Organization", project: "platform" }, { workspaceSource: "absent" }))
      .rejects.toThrow(/needs `organization`/)
    expect(h.calls).toHaveLength(0)
  })

  test("an Organization scope with no context at all names the one name it needs", async () => {
    const h = use()
    await expect(call("list_agents", { type: "Organization" }, { workspaceSource: "absent" }))
      .rejects.toThrow(/No repository: pass `organization`, or `workspace`/)
    expect(h.calls).toHaveLength(0)
  })

  test("a Company call ignores context it cannot read instead of refusing one", async () => {
    // The service ignores the triple on a Company query (measured: same 233
    // plugins as an untyped call), so forwarding it would claim a filter that
    // does nothing. Dropping it is not an error either: the caller supplied
    // context the scope does not consume, and the answer is complete without it.
    const h = use([() => jsonResponse({ value: [] })])
    textOf(await call("list_plugins", { type: "Company", ...REPOSITORY }, { workspaceSource: "absent" }))
    for (const request of h.calls) {
      expect(new URL(request.url).searchParams.has("organization")).toBe(false)
    }
  })

  test("type is canonicalized, and an unknown scope is refused locally", async () => {
    const h = use([() => jsonResponse({ value: [] })])
    await call("list_plugins", { type: "company" })
    expect(new URL(h.calls[0]!.url).searchParams.get("type")).toBe("Company")

    const before = h.calls.length
    await expect(call("list_agents", { type: "Nonsense" }))
      .rejects.toThrow(/`type` must be one of Repo, Organization, Company, Spec/)
    // Measured: the service answers an unknown scope with a generic ASP.NET
    // validation 400 that names nothing actionable, so the tool has to say it.
    expect(h.calls).toHaveLength(before)
  })

  test("a name search carries the context onto every page it reads", async () => {
    const first = {
      totalCount: 102,
      value: Array.from({ length: 100 }, (_, index) => ({ name: `plugin-${index}` })),
    }
    const second = { totalCount: 102, value: [{ name: "repo-tool" }] }
    const h = use([() => jsonResponse(first), () => jsonResponse(second)])
    textOf(await call(
      "list_plugins",
      { type: "Repo", name_contains: "repo", workspace: repoDir },
      { workspaceSource: "argument" },
    ))
    expect(h.calls).toHaveLength(2)
    for (const request of h.calls) {
      const url = new URL(request.url)
      expect(url.searchParams.get("organization")).toBe("contoso")
      expect(url.searchParams.get("project")).toBe("platform")
      expect(url.searchParams.get("repository")).toBe("web")
    }
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
