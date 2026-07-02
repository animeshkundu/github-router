import { describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import path from "node:path"

import { FleetClient } from "~/lib/fleet/client"
import { applyMeshEgressProxy, MeshEgressUnsupportedRuntimeError } from "~/lib/fleet/mesh-egress-agent"
import { createFleetTools } from "~/lib/fleet/tools"
import type { FleetInstanceInfo, FleetMeshProxy, FleetResolvedInstance } from "~/lib/fleet/registry"

const EGRESS_TOKEN = "supersecret-egress-token-abc123"
const AUTH_HEADER = `Bearer ${EGRESS_TOKEN}`

// Real prod-runtime CONNECT proof. Bun's fetch ignores undici's `dispatcher`, so the
// ProxyAgent egress path only runs under Node (the production runtime). We spawn a
// `node` child that stands up a local CONNECT proxy, drives a request through a REAL
// undici ProxyAgent built exactly like applyMeshEgressProxy's Node branch, and reports
// the Proxy-Authorization header the proxy saw on the CONNECT. This keeps the proof
// EXECUTABLE in the Bun-only CI while testing the actual production code path.
describe("mesh egress: real undici ProxyAgent CONNECT (prod Node runtime)", () => {
  test("sends Proxy-Authorization: Bearer <token> on the CONNECT", () => {
    const script = path.join(import.meta.dir, "fixtures", "mesh-egress-node-proof.cjs")
    const proc = spawnSync("node", [script, AUTH_HEADER], { encoding: "utf8", timeout: 20_000 })
    // If node isn't on PATH in this environment, don't fail the suite — the Node
    // branch is also asserted by the unit test below. But when node IS present, the
    // proof must be positive.
    if (proc.error && (proc.error as NodeJS.ErrnoException).code === "ENOENT") {
      console.warn("[mesh-egress test] node not found on PATH; skipping the live CONNECT proof")
      return
    }
    expect(proc.status).toBe(0)
    const out = JSON.parse(proc.stdout.trim()) as { seenProxyAuth: Array<string | undefined> }
    expect(out.seenProxyAuth).toContain(AUTH_HEADER)
  })
})

describe("applyMeshEgressProxy runtime branches", () => {
  test("Node branch sets a dispatcher and does not copy the token into request init headers", async () => {
    const init: Record<string, unknown> = { headers: { Authorization: "should-not-exist-for-mesh" } }
    const meshProxy: FleetMeshProxy = { url: "http://127.0.0.1:1", authHeader: AUTH_HEADER }
    const agent = applyMeshEgressProxy(init, meshProxy, false)
    expect(init.dispatcher).toBeDefined()
    // The credential must NOT be copied into the request-level init (it belongs on
    // the ProxyAgent CONNECT, not the target request).
    expect(JSON.stringify(init.headers)).not.toContain(EGRESS_TOKEN)
    // Real undici (prod/Node) exposes close(); Bun's undici shim may not — best-effort.
    await (agent as { close?: () => Promise<void> }).close?.()
  })

  test("Bun branch fails closed (throws MeshEgressUnsupportedRuntimeError)", () => {
    const init: Record<string, unknown> = {}
    const meshProxy: FleetMeshProxy = { url: "http://127.0.0.1:1", authHeader: AUTH_HEADER }
    expect(() => applyMeshEgressProxy(init, meshProxy, true)).toThrow(MeshEgressUnsupportedRuntimeError)
    // Nothing was attached to init on the fail-closed path.
    expect(init.dispatcher).toBeUndefined()
    expect(init.proxy).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// NO-LEAK regression: run a mesh instance carrying a meshProxy through both the
// list_instances shaping AND an induced request error, and assert the egress token
// never appears in the tool output or the error surfaced to the model.
// ---------------------------------------------------------------------------
// NOTE: tools.ts keeps a MODULE-LEVEL probe cache keyed on `${id}\0${url}`, so each
// test that exercises the list_instances probe must use a UNIQUE instance id to
// avoid a cross-test cached-result bleed.
function meshRegistry(
  meshProxy: FleetMeshProxy | undefined,
  id = "peer.tail.ts.net",
): {
  resolveInstance(arg?: string): Promise<FleetResolvedInstance>
  listInstances(): Promise<Array<FleetInstanceInfo>>
} {
  const instance: FleetResolvedInstance = {
    id,
    label: "peer",
    url: `https://${id}`,
    token: "",
    auth: { type: "mesh" },
    meshProxy,
  }
  return {
    async resolveInstance() {
      return instance
    },
    async listInstances() {
      return [{ id: instance.id, label: instance.label, url: instance.url }]
    },
  }
}

describe("mesh egress NO-LEAK", () => {
  const meshProxy: FleetMeshProxy = { url: "http://127.0.0.1:54321", authHeader: AUTH_HEADER }

  test("list_instances shaping never contains the egress token", async () => {
    // A createClient whose listSessions THROWS an error whose message embeds the
    // token — simulating a worst-case leak source. The probe must swallow it into a
    // credential-free failed-probe result.
    const tools = new Map(
      createFleetTools({
        registry: meshRegistry(meshProxy, "leak.tail.ts.net"),
        createClient: () => ({
          capabilities: () => Promise.reject(new Error(`boom ${EGRESS_TOKEN}`)),
          listSessions: () => Promise.reject(new Error(`connect failed with header ${AUTH_HEADER}`)),
          readSession: () => Promise.reject(new Error("nope")),
          status: () => Promise.reject(new Error("nope")),
          createSession: () => Promise.reject(new Error("nope")),
          stopSession: () => Promise.reject(new Error("nope")),
          sendMessage: () => Promise.reject(new Error("nope")),
          sendKeys: () => Promise.reject(new Error("nope")),
          respond: () => Promise.reject(new Error("nope")),
          waitEvents: () => Promise.reject(new Error("nope")),
          readFile: () => Promise.reject(new Error("nope")),
          listDir: () => Promise.reject(new Error("nope")),
          search: () => Promise.reject(new Error("nope")),
          gitShow: () => Promise.reject(new Error("nope")),
        }),
      }).map((tool) => [tool.toolNameHttp, tool]),
    )

    const result = await tools.get("list_instances")!.handler({})
    const text = result.content[0]!.text
    expect(text).not.toContain(EGRESS_TOKEN)
    expect(text).not.toContain(AUTH_HEADER)
    expect(text).not.toContain("Proxy-Authorization")
  })

  test("an induced mesh request error (real FleetClient) never echoes the token", async () => {
    // Real FleetClient + real mapMeshUnreachable. The injected applicator sets a
    // dispatcher but the fetch throws an error whose message embeds the token; the
    // sanitized mapMeshUnreachable must drop it.
    const tools = new Map(
      createFleetTools({
        registry: meshRegistry(meshProxy, "induced.tail.ts.net"),
        createClient: (instance) =>
          new FleetClient({
            url: instance.url,
            auth: instance.auth,
            meshProxy: instance.meshProxy,
            applyMeshEgress: () => ({ close: async () => {} }),
            fetchFn: (async () => {
              throw Object.assign(new Error(`socket hang up while sending ${AUTH_HEADER}`), {
                code: "UND_ERR_SOCKET",
                name: "SocketError",
              })
            }) as unknown as typeof fetch,
          }),
      }).map((tool) => [tool.toolNameHttp, tool]),
    )

    const result = await tools.get("list_sessions")!.handler({ instance: "induced.tail.ts.net" })
    const text = result.content[0]!.text
    expect(result.isError).toBe(true)
    expect(text).not.toContain(EGRESS_TOKEN)
    expect(text).not.toContain(AUTH_HEADER)
    // But it IS still a legible mesh diagnostic.
    expect(text).toContain("tag:aiordie")
  })

  test("a normal (successful) mesh tool response never contains the egress credential", async () => {
    // Even on the happy path, the resolvedInstance shaping (publicInstance) must not
    // carry meshProxy/authHeader into the model-facing output.
    const tools = new Map(
      createFleetTools({
        registry: meshRegistry(meshProxy, "happy.tail.ts.net"),
        createClient: () => ({
          capabilities: () => Promise.resolve({ capabilities: [] }),
          listSessions: () => Promise.resolve({ sessions: [{ sessionId: "s1", name: "ok" }] }),
          readSession: () => Promise.reject(new Error("nope")),
          status: () => Promise.reject(new Error("nope")),
          createSession: () => Promise.reject(new Error("nope")),
          stopSession: () => Promise.reject(new Error("nope")),
          sendMessage: () => Promise.reject(new Error("nope")),
          sendKeys: () => Promise.reject(new Error("nope")),
          respond: () => Promise.reject(new Error("nope")),
          waitEvents: () => Promise.reject(new Error("nope")),
          readFile: () => Promise.reject(new Error("nope")),
          listDir: () => Promise.reject(new Error("nope")),
          search: () => Promise.reject(new Error("nope")),
          gitShow: () => Promise.reject(new Error("nope")),
        }),
      }).map((tool) => [tool.toolNameHttp, tool]),
    )

    const result = await tools.get("list_sessions")!.handler({ instance: "happy.tail.ts.net" })
    const text = result.content[0]!.text
    expect(result.isError).toBeFalsy()
    expect(text).not.toContain(EGRESS_TOKEN)
    expect(text).not.toContain(AUTH_HEADER)
    expect(text).not.toContain("meshProxy")
    expect(text).not.toContain("Proxy-Authorization")
  })

  test("a mesh instance with NO egress proxy still lists, with an actionable notice", async () => {
    const tools = new Map(
      createFleetTools({
        registry: meshRegistry(undefined, "noegress.tail.ts.net"),
        createClient: (instance) =>
          new FleetClient({
            url: instance.url,
            auth: instance.auth,
            meshProxy: instance.meshProxy,
            fetchFn: (async () => {
              throw new Error("should never be called — fail closed before fetch")
            }) as unknown as typeof fetch,
          }),
      }).map((tool) => [tool.toolNameHttp, tool]),
    )

    const result = await tools.get("list_instances")!.handler({})
    const text = result.content[0]!.text
    const json = JSON.parse(text) as { instances: Array<{ id: string; reachable: boolean; error?: string; hint?: string }> }
    const peer = json.instances.find((i) => i.id === "noegress.tail.ts.net")!
    expect(peer.reachable).toBe(false)
    expect(peer.error).toBe("MESH_UNCONFIGURED")
    expect(peer.hint).toContain("mesh egress unconfigured or stale")
  })
})
