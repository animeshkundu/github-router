import { afterEach, describe, expect, test } from "bun:test"

import { MergedFleetRegistry, readMeshPeers } from "~/lib/fleet/discovery"
import { FleetRegistry } from "~/lib/fleet/registry"

const ENV_KEYS = ["GH_ROUTER_FLEET_DISCOVERY", "GH_ROUTER_FLEET_PEERS_FILE"] as const
const savedEnv: Record<string, string | undefined> = {}
for (const k of ENV_KEYS) savedEnv[k] = process.env[k]

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
})

function fileReader(content: string): (p: string) => Promise<string> {
  return async () => content
}

const VALID = JSON.stringify({
  version: 1,
  updatedAt: 1,
  self: { hostname: "aiordie-self", dnsName: "aiordie-self.tail123.ts.net" },
  peers: [
    { hostname: "aiordie-bar", dnsName: "aiordie-bar.tail123.ts.net", online: true },
    { hostname: "aiordie-baz", dnsName: "aiordie-baz.tail123.ts.net", online: false },
  ],
})

describe("readMeshPeers", () => {
  test("synthesizes token-less mesh instances from a valid peers file", async () => {
    delete process.env.GH_ROUTER_FLEET_DISCOVERY
    const peers = await readMeshPeers(fileReader(VALID))
    expect(peers).toHaveLength(2)
    expect(peers[0]).toEqual({
      id: "aiordie-bar.tail123.ts.net",
      label: "aiordie-bar",
      url: "https://aiordie-bar.tail123.ts.net",
      token: "",
      auth: { type: "mesh" },
    })
    // Mesh auth is EXPLICIT, never an empty bearer token. The id is the unique
    // dnsName so a peer-reported hostname can't collide with a static id/label.
    expect(peers.every((p) => p.auth.type === "mesh")).toBe(true)
    expect(peers.every((p) => p.id.endsWith(".ts.net"))).toBe(true)
  })

  test("excludes self by dnsName", async () => {
    delete process.env.GH_ROUTER_FLEET_DISCOVERY
    const withSelf = JSON.stringify({
      self: { hostname: "aiordie-self", dnsName: "aiordie-self.tail123.ts.net" },
      peers: [
        { hostname: "aiordie-self", dnsName: "aiordie-self.tail123.ts.net", online: true },
        { hostname: "aiordie-bar", dnsName: "aiordie-bar.tail123.ts.net", online: true },
      ],
    })
    const peers = await readMeshPeers(fileReader(withSelf))
    expect(peers.map((p) => p.label)).toEqual(["aiordie-bar"])
  })

  test("rejects a non-.ts.net dnsName (no spoofed host becomes a URL)", async () => {
    delete process.env.GH_ROUTER_FLEET_DISCOVERY
    const evil = JSON.stringify({
      self: { hostname: "s", dnsName: "s.tail123.ts.net" },
      peers: [
        { hostname: "evil", dnsName: "evil.example.com", online: true },
        { hostname: "evil2", dnsName: "https://evil.ts.net/x", online: true },
        { hostname: "ok", dnsName: "ok.tail123.ts.net", online: true },
      ],
    })
    const peers = await readMeshPeers(fileReader(evil))
    expect(peers.map((p) => p.label)).toEqual(["ok"])
  })

  test("rejects a peer in a DIFFERENT tailnet (same-suffix scoping)", async () => {
    delete process.env.GH_ROUTER_FLEET_DISCOVERY
    const crossTailnet = JSON.stringify({
      self: { hostname: "s", dnsName: "s.tail1.ts.net" },
      peers: [
        { hostname: "foreign", dnsName: "foreign.tail2.ts.net", online: true },
        { hostname: "mine", dnsName: "mine.tail1.ts.net", online: true },
      ],
    })
    const peers = await readMeshPeers(fileReader(crossTailnet))
    expect(peers.map((p) => p.id)).toEqual(["mine.tail1.ts.net"])
  })

  test("fails closed when self.dnsName is missing or invalid", async () => {
    delete process.env.GH_ROUTER_FLEET_DISCOVERY
    const noSelf = JSON.stringify({
      peers: [{ hostname: "bar", dnsName: "bar.tail1.ts.net", online: true }],
    })
    expect(await readMeshPeers(fileReader(noSelf))).toEqual([])
    const badSelf = JSON.stringify({
      self: { hostname: "s", dnsName: "not-a-tailnet-host" },
      peers: [{ hostname: "bar", dnsName: "bar.tail1.ts.net", online: true }],
    })
    expect(await readMeshPeers(fileReader(badSelf))).toEqual([])
  })

  test("dedupes peers by dnsName", async () => {
    delete process.env.GH_ROUTER_FLEET_DISCOVERY
    const dup = JSON.stringify({
      self: { hostname: "s", dnsName: "s.tail123.ts.net" },
      peers: [
        { hostname: "a", dnsName: "a.tail123.ts.net", online: true },
        { hostname: "a-again", dnsName: "a.tail123.ts.net", online: false },
      ],
    })
    const peers = await readMeshPeers(fileReader(dup))
    expect(peers).toHaveLength(1)
  })

  test("a missing/unreadable file yields [] (never throws)", async () => {
    delete process.env.GH_ROUTER_FLEET_DISCOVERY
    const peers = await readMeshPeers(async () => {
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" })
    })
    expect(peers).toEqual([])
  })

  test("malformed JSON yields []", async () => {
    delete process.env.GH_ROUTER_FLEET_DISCOVERY
    expect(await readMeshPeers(fileReader("{not json"))).toEqual([])
    expect(await readMeshPeers(fileReader(JSON.stringify({ peers: "nope" })))).toEqual([])
  })

  test("an oversized file yields []", async () => {
    delete process.env.GH_ROUTER_FLEET_DISCOVERY
    const huge = "x".repeat(256 * 1024 + 1)
    expect(await readMeshPeers(fileReader(huge))).toEqual([])
  })

  test("GH_ROUTER_FLEET_DISCOVERY=0 disables discovery", async () => {
    process.env.GH_ROUTER_FLEET_DISCOVERY = "0"
    expect(await readMeshPeers(fileReader(VALID))).toEqual([])
  })
})

describe("MergedFleetRegistry", () => {
  const staticConfig = {
    instances: [{ id: "alpha", label: "Alpha", url: "https://alpha.example", token: "tok-a" }],
  }

  test("merges static + discovered; static wins on an id collision", async () => {
    const reg = new MergedFleetRegistry({
      staticRegistry: new FleetRegistry({ config: staticConfig }),
      discover: async () => [
        { id: "alpha", label: "alpha", url: "https://alpha.tail.ts.net", token: "", auth: { type: "mesh" } },
        { id: "bravo", label: "bravo", url: "https://bravo.tail.ts.net", token: "", auth: { type: "mesh" } },
      ],
    })

    const infos = await reg.listInstances()
    expect(infos.map((i) => i.id).sort()).toEqual(["alpha", "bravo"])

    // alpha stays the STATIC bearer instance, not the discovered mesh one.
    const alpha = await reg.resolveInstance("alpha")
    expect(alpha.auth).toEqual({ type: "bearer", token: "tok-a" })
    expect(alpha.url).toBe("https://alpha.example")

    const bravo = await reg.resolveInstance("bravo")
    expect(bravo.auth).toEqual({ type: "mesh" })
  })

  test("a no-arg resolve picks the single discovered peer when static is empty", async () => {
    const reg = new MergedFleetRegistry({
      staticRegistry: new FleetRegistry({ config: { instances: [] } }),
      discover: async () => [
        { id: "solo", label: "solo", url: "https://solo.tail.ts.net", token: "", auth: { type: "mesh" } },
      ],
    })
    const resolved = await reg.resolveInstance()
    expect(resolved.id).toBe("solo")
  })

  test("discovery is cached within the TTL (one read per window)", async () => {
    let calls = 0
    let clock = 1000
    const reg = new MergedFleetRegistry({
      staticRegistry: new FleetRegistry({ config: staticConfig }),
      discover: async () => {
        calls++
        return []
      },
      ttlMs: 5000,
      now: () => clock,
    })
    await reg.listInstances()
    await reg.listInstances()
    expect(calls).toBe(1)
    clock += 6000
    await reg.listInstances()
    expect(calls).toBe(2)
  })

  test("a failed discovery read leaves the static set intact", async () => {
    const reg = new MergedFleetRegistry({
      staticRegistry: new FleetRegistry({ config: staticConfig }),
      discover: async () => {
        throw new Error("disk on fire")
      },
    })
    const infos = await reg.listInstances()
    expect(infos.map((i) => i.id)).toEqual(["alpha"])
    const alpha = await reg.resolveInstance("alpha")
    expect(alpha.auth).toEqual({ type: "bearer", token: "tok-a" })
  })
})
