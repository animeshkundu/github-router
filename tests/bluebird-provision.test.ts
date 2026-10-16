import { afterEach, describe, expect, mock, test } from "bun:test"
import { spawnSync } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import {
  provisionBluebird,
  ADO_CODE_SEARCH_TOKEN_RESOURCE,
  BLUEBIRD_MCP_TOKEN_RESOURCE,
} from "../src/lib/bluebird-client"
import {
  __resetAzCliExecDepsForTests,
  __setAzCliExecDepsForTests,
} from "../src/lib/azure-cli-token"
import type { RunResult } from "../src/lib/exec"

/**
 * Provisioning crosses TWO audiences in one flow, and getting them the wrong
 * way round is invisible until the server answers 401: `mcp.bluebird-ai.net`
 * accepts only the Bluebird resource (`f8efec34-…`) and the Azure DevOps
 * search API (`almsearch.dev.azure.com`, reached by the branch-index probe)
 * accepts only the ADO one (`499b84ac-…`). Measured on both endpoints; see
 * `docs/bluebird-search.md`.
 *
 * These tests drive the real provisioning path (`provisionBluebird`) against a
 * synthetic git checkout, with the Azure CLI faked behind `exec` and `fetch`
 * stubbed, so the assertion is about the argv the proxy would run and the
 * bearer it would send, not about a constant.
 */

const originalFetch = globalThis.fetch
const originalBluebirdToken = process.env.BLUEBIRD_TOKEN

function runResult(over: Partial<RunResult> = {}): RunResult {
  return {
    stdout: "",
    stderr: "",
    code: 0,
    timedOut: false,
    truncated: false,
    stderrTruncated: false,
    ...over,
  }
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json", ...init.headers },
    ...init,
  })
}

function git(args: Array<string>, cwd: string): void {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" })
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`)
  }
}

interface Checkout {
  dir: string
  cleanup: () => Promise<void>
}

/** A git checkout whose origin is an Azure DevOps repository, on a branch. */
async function makeAzureCheckout(): Promise<Checkout> {
  const dir = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "bb-provision-"))
  git(["init", "-b", "main"], dir)
  await fs.writeFile(path.join(dir, "readme.md"), "synthetic\n")
  git(["-c", "user.email=test@example.test", "-c", "user.name=Test", "add", "."], dir)
  git(["-c", "user.email=test@example.test", "-c", "user.name=Test", "commit", "-m", "seed"], dir)
  git(
    ["remote", "add", "origin", "https://dev.azure.com/contoso/Platform/_git/service"],
    dir,
  )
  return {
    dir,
    cleanup: () => fs.rm(dir, { recursive: true, force: true }),
  }
}

interface Wire {
  /** Resources the faked `az account get-access-token` was asked for, in order. */
  resources: Array<string>
  /** Bearer sent to almsearch (the branch-index probe). */
  probeBearer: string | null
  /** Bearer sent to the Bluebird MCP endpoint. */
  mcpBearer: string | null
  /** Raw `az` argv, so a scenario can assert on the whole invocation. */
  argv: Array<Array<string>>
}

function installWire(): Wire {
  const wire: Wire = { resources: [], probeBearer: null, mcpBearer: null, argv: [] }
  const capture = mock(async (cmd: Array<string>) => {
    wire.argv.push(cmd)
    const resource = cmd[cmd.indexOf("--resource") + 1] ?? ""
    wire.resources.push(resource)
    const token = `token-for-${resource}`
    // The cache mints with `--output json` (it needs a deadline); honour both
    // shapes so the test asserts the resource rather than the envelope.
    return cmd.includes("json")
      ? runResult({
        stdout: JSON.stringify({
          accessToken: token,
          expires_on: Math.floor(Date.now() / 1000) + 3600,
        }),
      })
      : runResult({ stdout: token })
  })
  __setAzCliExecDepsForTests({
    resolveExecutable: mock((name: string) => (name === "az" ? "/abs/az" : null)) as never,
    runCommandCapture: capture as never,
    runCommandInherit: mock() as never,
  })

  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const target = String(url)
    const headers = new Headers(init?.headers ?? {})
    const bearer = headers.get("authorization")
    // Branches are told apart by PATH, not host: the isolation guard in
    // `bluebird-test-isolation.test.ts` forbids an automated suite from
    // naming a live endpoint, and the path identifies each one just as
    // precisely. Two branches, and the only two requests this flow makes.
    if (target.includes("/_apis/search/")) {
      wire.probeBearer = bearer
      // `main` is indexed, so the default-branch lookup (`az repos show`)
      // never runs and the only `az` calls are the two mints.
      return jsonResponse({ facets: { Branch: [{ name: "main" }] } })
    }
    // Everything else in this flow is the Bluebird MCP endpoint. A stray URL
    // still fails loudly: the body has to be a JSON-RPC request.
    wire.mcpBearer = bearer
    const request = JSON.parse(String(init?.body)) as Record<string, unknown>
    if (request.method === "initialize") {
      return jsonResponse({ jsonrpc: "2.0", id: request.id, result: {} })
    }
    if (request.method === "notifications/initialized") {
      return new Response(null, { status: 202 })
    }
    if (request.method === "tools/list") {
      return jsonResponse({
        jsonrpc: "2.0",
        id: request.id,
        result: { tools: [{ name: "code_search", inputSchema: { type: "object", properties: {} } }] },
      })
    }
    throw new Error(`unexpected MCP method: ${String(request.method)}`)
  }) as typeof fetch

  return wire
}

afterEach(() => {
  globalThis.fetch = originalFetch
  __resetAzCliExecDepsForTests()
  if (originalBluebirdToken === undefined) delete process.env.BLUEBIRD_TOKEN
  else process.env.BLUEBIRD_TOKEN = originalBluebirdToken
})

describe("provisionBluebird audiences", () => {
  test("the MCP client gets the Bluebird resource and the probe the ADO one", async () => {
    delete process.env.BLUEBIRD_TOKEN
    const wire = installWire()
    const checkout = await makeAzureCheckout()
    try {
      const provisioned = await provisionBluebird(checkout.dir)

      expect(provisioned.organization).toBe("contoso")
      expect(provisioned.project).toBe("Platform")
      expect(provisioned.repositories).toEqual(["service"])
      expect(provisioned.branch).toBe("main")

      // The bug this pins: one minted token served both calls, so the MCP
      // endpoint was handed an ADO-audience token and answered 401.
      expect(wire.resources).toEqual([
        BLUEBIRD_MCP_TOKEN_RESOURCE,
        ADO_CODE_SEARCH_TOKEN_RESOURCE,
      ])
      // Literals, not the constants: an assertion written in terms of the same
      // values it is checking would pass just as happily if both constants
      // were collapsed onto one id, which is the regression under test.
      expect(wire.mcpBearer).toBe("Bearer token-for-f8efec34-6ac0-4538-8a18-ee59319d7338")
      expect(wire.probeBearer).toBe("Bearer token-for-499b84ac-1321-427f-aa17-267ca6975798")
      expect(wire.resources[0]).not.toBe(wire.resources[1])
    } finally {
      await checkout.cleanup()
    }
  })

  test("both mints are silent `get-access-token` calls for their own resource", async () => {
    delete process.env.BLUEBIRD_TOKEN
    const wire = installWire()
    const checkout = await makeAzureCheckout()
    try {
      await provisionBluebird(checkout.dir)
      for (const argv of wire.argv) {
        expect(argv[0]).toBe("/abs/az")
        expect(argv.slice(1, 3)).toEqual(["account", "get-access-token"])
      }
    } finally {
      await checkout.cleanup()
    }
  })

  test("BLUEBIRD_TOKEN short-circuits both mints", async () => {
    process.env.BLUEBIRD_TOKEN = "env-token"
    const wire = installWire()
    const checkout = await makeAzureCheckout()
    try {
      await provisionBluebird(checkout.dir)
      expect(wire.resources).toEqual([])
      expect(wire.mcpBearer).toBe("Bearer env-token")
      expect(wire.probeBearer).toBe("Bearer env-token")
    } finally {
      await checkout.cleanup()
    }
  })
})
