import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import consola from "consola"

import {
  __setWorkiqToolSnapshotForTests,
  buildWorkiqToolEntries,
  disposeWorkiqClients,
  provisionWorkiqTools,
  resetWorkiqToolsForTesting,
  workiqMcpToolEntries,
} from "../src/lib/workiq-tools"
import {
  WORKIQ_PROTOCOL_VERSION,
  WORKIQ_READ_TOOLS,
  WORKIQ_TOKEN_ENV,
  WORKIQ_TOKEN_PATH_ENV,
  WORKIQ_WRITE_TOOLS,
} from "../src/lib/workiq/constants"
import { resetWorkiqTokenStateForTesting } from "../src/lib/workiq/token"
import { state } from "../src/lib/state"
import type { WorkiqToolDescriptor } from "../src/lib/workiq/client"

// Mostly pure mapping, plus provisioning calls that must fail BEFORE any
// network traffic because no login exists. The one exception is the alias
// dispatch test, which installs a fake MCP server over global fetch so the
// handler closure can be driven without a live endpoint; nothing here ever
// resolves workiq.svc.cloud.microsoft.

const originalToken = process.env[WORKIQ_TOKEN_ENV]
const originalTokenPath = process.env[WORKIQ_TOKEN_PATH_ENV]
const originalWarn = consola.warn

let tmpDir: string
let warnings: Array<string>

function descriptor(name: string, properties: Record<string, unknown> = {}): WorkiqToolDescriptor {
  return {
    name,
    description: `${name} (recorded fixture)`,
    inputSchema: { type: "object", properties },
  }
}

/** The live twelve, transcribed from `tools/list` (2026-11-02). */
const RECORDED: Array<WorkiqToolDescriptor> = [
  descriptor("ask", { question: { type: "string" } }),
  descriptor("retrieve", { query: { type: "string" } }),
  descriptor("fetch", { entityUrls: { type: "array" } }),
  descriptor("fetch_blob"),
  descriptor("list_agents"),
  descriptor("get_schema"),
  descriptor("search_paths"),
  descriptor("call_function"),
  descriptor("create_entity"),
  descriptor("update_entity"),
  descriptor("delete_entity"),
  descriptor("do_action"),
]

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "workiq-tools-"))
  process.env[WORKIQ_TOKEN_PATH_ENV] = path.join(tmpDir, "workiq-token.json")
  delete process.env[WORKIQ_TOKEN_ENV]
  warnings = []
  consola.warn = ((msg: unknown) => {
    warnings.push(String(msg))
  }) as typeof consola.warn
  resetWorkiqToolsForTesting()
  resetWorkiqTokenStateForTesting()
  state.workiqEnabled = true
  state.workiqWriteEnabled = false
})

afterEach(async () => {
  consola.warn = originalWarn
  await disposeWorkiqClients()
  resetWorkiqToolsForTesting()
  resetWorkiqTokenStateForTesting()
  state.workiqEnabled = false
  state.workiqWriteEnabled = false
  if (originalToken === undefined) delete process.env[WORKIQ_TOKEN_ENV]
  else process.env[WORKIQ_TOKEN_ENV] = originalToken
  if (originalTokenPath === undefined) delete process.env[WORKIQ_TOKEN_PATH_ENV]
  else process.env[WORKIQ_TOKEN_PATH_ENV] = originalTokenPath
  await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
})

describe("buildWorkiqToolEntries", () => {
  test("the default surface is exactly the eight read tools", () => {
    const entries = buildWorkiqToolEntries(RECORDED, { write: false })
    expect(entries.map((t) => t.toolNameHttp)).toEqual([
      "ask",
      "retrieve",
      "fetch",
      "fetch_blob",
      "agents",
      "get_schema",
      "search_paths",
      "call_function",
    ])
    expect(WORKIQ_READ_TOOLS.size).toBe(8)
    expect(WORKIQ_WRITE_TOOLS.size).toBe(4)
  })

  test("the four mutating tools are dropped silently, not warned about", () => {
    // They are the EXPECTED omission. A warning here would fire on every
    // default launch and train the operator to ignore the warning that does
    // matter (an unknown upstream name).
    buildWorkiqToolEntries(RECORDED, { write: false })
    expect(warnings).toEqual([])
  })

  test("--workiq-write exposes the full live surface", () => {
    const entries = buildWorkiqToolEntries(RECORDED, { write: true })
    expect(entries.length).toBe(12)
    const names = entries.map((t) => t.toolNameHttp)
    for (const name of WORKIQ_WRITE_TOOLS) expect(names).toContain(name)
  })

  test("an upstream name outside both sets is dropped WITH a warning", () => {
    // This is the signal that the service shipped something new: the read
    // surface may now be narrower than the live one.
    const entries = buildWorkiqToolEntries(
      [...RECORDED, descriptor("export_tenant_backup")],
      { write: false },
    )
    expect(entries.map((t) => t.toolNameHttp)).not.toContain("export_tenant_backup")
    expect(warnings.length).toBe(1)
    expect(warnings[0]).toContain("export_tenant_backup")
    expect(warnings[0]).toContain("--workiq-write")
  })

  test("a name the proxy already serves is dropped, whatever the mode", () => {
    // `code` and `web` live on the search group; a remote server that started
    // advertising one of them must never shadow the proxy's own tool.
    const entries = buildWorkiqToolEntries(
      [...RECORDED, descriptor("code"), descriptor("web")],
      { write: true },
    )
    const names = entries.map((t) => t.toolNameHttp)
    expect(names).not.toContain("code")
    expect(names).not.toContain("web")
    expect(warnings.filter((w) => w.includes("already serves")).length).toBe(2)
  })

  test("list_agents is exposed as agents, and the handler asks for the wire name", async () => {
    // The cloudagent group already serves `list_agents`, and the proxy-owned
    // name set is ungated by group enablement, so an unrenamed copy would be
    // dropped on every Azure DevOps launch. Only the MCP-facing name moves.
    const originalFetch = globalThis.fetch
    const wireCalls: Array<string> = []
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {}
      const reply = (result: unknown) =>
        new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }), {
          headers: { "content-type": "application/json" },
        })
      if (body.method === "initialize") {
        return reply({ protocolVersion: WORKIQ_PROTOCOL_VERSION, serverInfo: { name: "WorkIQ" } })
      }
      if (body.method === "notifications/initialized") return new Response(null, { status: 204 })
      if (body.method === "tools/list") {
        return reply({
          tools: [
            {
              name: "list_agents",
              description: "list_agents (recorded fixture)",
              inputSchema: { type: "object", properties: {} },
            },
          ],
        })
      }
      if (body.method === "tools/call") {
        wireCalls.push(String((body.params as Record<string, unknown>).name))
        return reply({ content: [{ type: "text", text: "ok" }] })
      }
      throw new Error(`unexpected MCP method: ${String(body.method)}`)
    }) as typeof fetch
    process.env[WORKIQ_TOKEN_ENV] = "synthetic-workiq-token"

    try {
      const entries = buildWorkiqToolEntries(RECORDED, { write: false })
      const names = entries.map((t) => t.toolNameHttp)
      expect(names).toContain("agents")
      expect(names).not.toContain("list_agents")
      expect(warnings).toEqual([])

      const agents = entries.find((entry) => entry.toolNameHttp === "agents")!
      const result = await agents.handler({})
      expect(wireCalls).toEqual(["list_agents"])
      expect(result.content[0]).toEqual({ type: "text", text: "ok" })
    } finally {
      resetWorkiqToolsForTesting()
      globalThis.fetch = originalFetch
    }
  })

  test("a call with no login puts the remedy in the message the model sees", async () => {
    // The MCP boundary forwards only `err.message`, so a WorkiqAuthError whose
    // remedy stayed a separate property would reach the caller as a dead end.
    const entries = buildWorkiqToolEntries([descriptor("ask")], { write: false })

    let caught: unknown
    try {
      await entries[0]!.handler({ question: "what changed this week?" })
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(Error)
    expect((caught as Error).message).toContain("No Work IQ login found")
    expect((caught as Error).message).toContain("github-router workiq auth")
  })

  test("a duplicated upstream name is emitted once", () => {
    const entries = buildWorkiqToolEntries([descriptor("ask"), descriptor("ask")], { write: true })
    expect(entries.map((t) => t.toolNameHttp)).toEqual(["ask"])
  })

  test("every entry belongs to the workiq group and carries a usable schema", () => {
    for (const entry of buildWorkiqToolEntries(RECORDED, { write: false })) {
      expect(entry.group).toBe("workiq")
      expect(entry.capability).toBe("workiq")
      expect(entry.description.length).toBeGreaterThan(0)
      expect(entry.inputSchema).toEqual({ type: "object", properties: expect.any(Object) })
    }
  })
})

describe("provisionWorkiqTools", () => {
  test("no login turns the group OFF with the auth remedy, and never throws", async () => {
    const result = await provisionWorkiqTools()

    expect(result.ok).toBe(false)
    expect(state.workiqEnabled).toBe(false)
    expect(warnings.length).toBe(1)
    expect(warnings[0]).toContain("disabled")
    expect(warnings[0]).toContain("github-router workiq auth")
    // And the group is genuinely gone from the handler's view.
    expect(workiqMcpToolEntries()).toEqual([])
  })

  test("a disabled group is a no-op, not an error", async () => {
    state.workiqEnabled = false
    const result = await provisionWorkiqTools()
    expect(result).toEqual({ ok: false, reason: "workiq group is not enabled" })
    expect(warnings).toEqual([])
  })

  test("the snapshot accessor returns nothing until a provision lands", () => {
    expect(workiqMcpToolEntries()).toEqual([])
    __setWorkiqToolSnapshotForTests(
      buildWorkiqToolEntries([descriptor("ask")], { write: false }),
    )
    expect(workiqMcpToolEntries().map((t) => t.toolNameHttp)).toEqual(["ask"])
    state.workiqEnabled = false
    expect(workiqMcpToolEntries()).toEqual([])
  })
})
