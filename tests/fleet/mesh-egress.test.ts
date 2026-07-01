import { afterEach, describe, expect, test } from "bun:test"

import {
  meshEgressFilePath,
  MergedFleetRegistry,
  readMeshEgress,
} from "~/lib/fleet/discovery"
import { FleetRegistry } from "~/lib/fleet/registry"

const ENV_KEYS = ["GH_ROUTER_FLEET_DISCOVERY", "GH_ROUTER_FLEET_EGRESS_FILE"] as const
const savedEnv: Record<string, string | undefined> = {}
for (const k of ENV_KEYS) savedEnv[k] = process.env[k]

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
})

const NOW = 1_000_000_000_000
const aliveNow = () => NOW
const alivePid = () => true

function egressJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    version: 1,
    pid: 4242,
    updatedAt: NOW,
    url: "http://127.0.0.1:54321",
    token: "deadbeefcafe",
    ...overrides,
  })
}

function reader(content: string): (p: string) => Promise<string> {
  return async () => content
}

describe("meshEgressFilePath", () => {
  test("honors GH_ROUTER_FLEET_EGRESS_FILE override", () => {
    process.env.GH_ROUTER_FLEET_EGRESS_FILE = "/tmp/custom-egress.json"
    expect(meshEgressFilePath()).toBe("/tmp/custom-egress.json")
  })

  test("defaults to the ai-or-die mesh dir", () => {
    delete process.env.GH_ROUTER_FLEET_EGRESS_FILE
    expect(meshEgressFilePath().endsWith("egress.json")).toBe(true)
    expect(meshEgressFilePath()).toContain("mesh")
  })
})

describe("readMeshEgress", () => {
  test("returns the proxy for a valid egress.json (token → Bearer authHeader)", async () => {
    delete process.env.GH_ROUTER_FLEET_DISCOVERY
    const proxy = await readMeshEgress({ readFileFn: reader(egressJson()), now: aliveNow, pidAlive: alivePid })
    expect(proxy).toEqual({ url: "http://127.0.0.1:54321", authHeader: "Bearer deadbeefcafe" })
  })

  test("accepts an IPv6 loopback url", async () => {
    delete process.env.GH_ROUTER_FLEET_DISCOVERY
    const proxy = await readMeshEgress({
      readFileFn: reader(egressJson({ url: "http://[::1]:8080" })),
      now: aliveNow,
      pidAlive: alivePid,
    })
    expect(proxy?.url).toBe("http://[::1]:8080")
  })

  test("rejects a non-loopback url", async () => {
    delete process.env.GH_ROUTER_FLEET_DISCOVERY
    for (const url of [
      "http://10.0.0.5:54321",
      "http://192.168.1.9:54321",
      "http://example.com:54321",
      "http://100.64.0.1:54321", // CGNAT / tailscale — NOT loopback
      "http://localhost:54321", // DNS-rebinding: localhost can resolve off-host, reject
      "http://LOCALHOST:54321",
    ]) {
      const proxy = await readMeshEgress({ readFileFn: reader(egressJson({ url })), now: aliveNow, pidAlive: alivePid })
      expect(proxy).toBeUndefined()
    }
  })

  test("rejects a url with a path, query, or fragment (contract is host:port only)", async () => {
    delete process.env.GH_ROUTER_FLEET_DISCOVERY
    for (const url of [
      "http://127.0.0.1:54321/proxy",
      "http://127.0.0.1:54321/?x=1",
      "http://127.0.0.1:54321#frag",
    ]) {
      const proxy = await readMeshEgress({ readFileFn: reader(egressJson({ url })), now: aliveNow, pidAlive: alivePid })
      expect(proxy).toBeUndefined()
    }
  })

  test("rejects a url with no explicit port", async () => {
    delete process.env.GH_ROUTER_FLEET_DISCOVERY
    const proxy = await readMeshEgress({
      readFileFn: reader(egressJson({ url: "http://127.0.0.1" })),
      now: aliveNow,
      pidAlive: alivePid,
    })
    expect(proxy).toBeUndefined()
  })

  test("rejects an https (non-http) proxy url", async () => {
    delete process.env.GH_ROUTER_FLEET_DISCOVERY
    const proxy = await readMeshEgress({
      readFileFn: reader(egressJson({ url: "https://127.0.0.1:54321" })),
      now: aliveNow,
      pidAlive: alivePid,
    })
    expect(proxy).toBeUndefined()
  })

  test("rejects a url with embedded userinfo (credential sink)", async () => {
    delete process.env.GH_ROUTER_FLEET_DISCOVERY
    const proxy = await readMeshEgress({
      readFileFn: reader(egressJson({ url: "http://user:pass@127.0.0.1:54321" })),
      now: aliveNow,
      pidAlive: alivePid,
    })
    expect(proxy).toBeUndefined()
  })

  test("rejects a missing / blank / whitespace / control-char token", async () => {
    delete process.env.GH_ROUTER_FLEET_DISCOVERY
    for (const token of [undefined, "", "   ", "has space", "tab\tin", "nl\nin", "cr\rin", "del\x7f", "ctrl\x01"]) {
      const proxy = await readMeshEgress({
        readFileFn: reader(egressJson({ token })),
        now: aliveNow,
        pidAlive: alivePid,
      })
      expect(proxy).toBeUndefined()
    }
  })

  test("rejects a wrong version", async () => {
    delete process.env.GH_ROUTER_FLEET_DISCOVERY
    for (const version of [0, 2, "1", undefined, null]) {
      const proxy = await readMeshEgress({
        readFileFn: reader(egressJson({ version })),
        now: aliveNow,
        pidAlive: alivePid,
      })
      expect(proxy).toBeUndefined()
    }
  })

  test("returns undefined when the pid is dead (a fresh updatedAt does NOT rescue a dead pid)", async () => {
    delete process.env.GH_ROUTER_FLEET_DISCOVERY
    // egressJson() carries a fresh updatedAt (== NOW) and now:aliveNow, so the TTL
    // gate passes — proving liveness is an INDEPENDENT AND-gate, the defense against
    // a squatted freed port after an ungraceful sidecar death.
    const proxy = await readMeshEgress({
      readFileFn: reader(egressJson()),
      now: aliveNow,
      pidAlive: () => false,
    })
    expect(proxy).toBeUndefined()
  })

  test("rejects a non-positive or non-integer pid", async () => {
    delete process.env.GH_ROUTER_FLEET_DISCOVERY
    for (const pid of [0, -1, 1.5, "4242", undefined, null]) {
      const proxy = await readMeshEgress({
        readFileFn: reader(egressJson({ pid })),
        now: aliveNow,
        pidAlive: alivePid,
      })
      expect(proxy).toBeUndefined()
    }
  })

  test("returns undefined when updatedAt is older than the TTL", async () => {
    delete process.env.GH_ROUTER_FLEET_DISCOVERY
    const stale = egressJson({ updatedAt: NOW - 120_001 })
    const proxy = await readMeshEgress({ readFileFn: reader(stale), now: aliveNow, pidAlive: alivePid })
    expect(proxy).toBeUndefined()

    // Exactly at the TTL edge is still fresh.
    const edge = egressJson({ updatedAt: NOW - 120_000 })
    const fresh = await readMeshEgress({ readFileFn: reader(edge), now: aliveNow, pidAlive: alivePid })
    expect(fresh).toBeDefined()
  })

  test("rejects an updatedAt far in the FUTURE (garbage / bad clock)", async () => {
    delete process.env.GH_ROUTER_FLEET_DISCOVERY
    const future = egressJson({ updatedAt: NOW + 60_000 })
    const proxy = await readMeshEgress({ readFileFn: reader(future), now: aliveNow, pidAlive: alivePid })
    expect(proxy).toBeUndefined()

    // A tiny future skew (clock jitter) is tolerated.
    const jitter = egressJson({ updatedAt: NOW + 1_000 })
    const ok = await readMeshEgress({ readFileFn: reader(jitter), now: aliveNow, pidAlive: alivePid })
    expect(ok).toBeDefined()
  })

  test("never throws even when the injected pidAlive / now throw", async () => {
    delete process.env.GH_ROUTER_FLEET_DISCOVERY
    const fromPid = await readMeshEgress({
      readFileFn: reader(egressJson()),
      now: aliveNow,
      pidAlive: () => {
        throw new Error("pid probe blew up")
      },
    })
    expect(fromPid).toBeUndefined()

    const fromNow = await readMeshEgress({
      readFileFn: reader(egressJson()),
      now: () => {
        throw new Error("clock blew up")
      },
      pidAlive: alivePid,
    })
    expect(fromNow).toBeUndefined()
  })

  test("rejects a non-numeric updatedAt", async () => {
    delete process.env.GH_ROUTER_FLEET_DISCOVERY
    for (const updatedAt of ["now", undefined, null, Number.NaN, Number.POSITIVE_INFINITY]) {
      const proxy = await readMeshEgress({
        readFileFn: reader(egressJson({ updatedAt })),
        now: aliveNow,
        pidAlive: alivePid,
      })
      expect(proxy).toBeUndefined()
    }
  })

  test("returns undefined when now() returns NaN (non-finite age not silently accepted)", async () => {
    delete process.env.GH_ROUTER_FLEET_DISCOVERY
    const proxy = await readMeshEgress({
      readFileFn: reader(egressJson()),
      now: () => Number.NaN,
      pidAlive: alivePid,
    })
    expect(proxy).toBeUndefined()
  })

  test("returns undefined when readFileFn resolves a non-string (never throws)", async () => {
    delete process.env.GH_ROUTER_FLEET_DISCOVERY
    const proxy = await readMeshEgress({
      readFileFn: (async () => Buffer.from(egressJson())) as unknown as (p: string) => Promise<string>,
      now: aliveNow,
      pidAlive: alivePid,
    })
    expect(proxy).toBeUndefined()
  })

  test("a missing / unreadable file yields undefined (never throws)", async () => {
    delete process.env.GH_ROUTER_FLEET_DISCOVERY
    const proxy = await readMeshEgress({
      readFileFn: async () => {
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" })
      },
      now: aliveNow,
      pidAlive: alivePid,
    })
    expect(proxy).toBeUndefined()
  })

  test("malformed JSON / non-object yields undefined", async () => {
    delete process.env.GH_ROUTER_FLEET_DISCOVERY
    for (const content of ["{not json", "[]", "42", '"str"', "null"]) {
      const proxy = await readMeshEgress({ readFileFn: reader(content), now: aliveNow, pidAlive: alivePid })
      expect(proxy).toBeUndefined()
    }
  })

  test("an oversized file yields undefined", async () => {
    delete process.env.GH_ROUTER_FLEET_DISCOVERY
    const huge = "x".repeat(64 * 1024 + 1)
    const proxy = await readMeshEgress({ readFileFn: reader(huge), now: aliveNow, pidAlive: alivePid })
    expect(proxy).toBeUndefined()
  })

  test("GH_ROUTER_FLEET_DISCOVERY=0 disables egress reads", async () => {
    process.env.GH_ROUTER_FLEET_DISCOVERY = "0"
    const proxy = await readMeshEgress({ readFileFn: reader(egressJson()), now: aliveNow, pidAlive: alivePid })
    expect(proxy).toBeUndefined()
  })
})

describe("MergedFleetRegistry mesh egress attachment", () => {
  const staticConfig = {
    instances: [{ id: "alpha", label: "Alpha", url: "https://alpha.example", token: "tok-a" }],
  }

  test("attaches the same meshProxy to every discovered mesh peer, not to static bearer instances", async () => {
    const meshProxy = { url: "http://127.0.0.1:54321", authHeader: "Bearer egress-secret" }
    const reg = new MergedFleetRegistry({
      staticRegistry: new FleetRegistry({ config: staticConfig }),
      discover: async () => [
        { id: "bravo.tail.ts.net", label: "bravo", url: "https://bravo.tail.ts.net", token: "", auth: { type: "mesh" } },
        { id: "charlie.tail.ts.net", label: "charlie", url: "https://charlie.tail.ts.net", token: "", auth: { type: "mesh" } },
      ],
      discoverEgress: async () => meshProxy,
    })

    const bravo = await reg.resolveInstance("bravo.tail.ts.net")
    const charlie = await reg.resolveInstance("charlie.tail.ts.net")
    expect(bravo.meshProxy).toEqual(meshProxy)
    expect(charlie.meshProxy).toEqual(meshProxy)

    // Static bearer instance never carries a meshProxy.
    const alpha = await reg.resolveInstance("alpha")
    expect(alpha.meshProxy).toBeUndefined()
  })

  test("mesh peers carry NO meshProxy when egress is absent (client will fail closed)", async () => {
    const reg = new MergedFleetRegistry({
      staticRegistry: new FleetRegistry({ config: { instances: [] } }),
      discover: async () => [
        { id: "solo.tail.ts.net", label: "solo", url: "https://solo.tail.ts.net", token: "", auth: { type: "mesh" } },
      ],
      discoverEgress: async () => undefined,
    })
    const solo = await reg.resolveInstance()
    expect(solo.meshProxy).toBeUndefined()
  })

  test("an egress-discovery failure does NOT drop the discovered peers", async () => {
    const reg = new MergedFleetRegistry({
      staticRegistry: new FleetRegistry({ config: { instances: [] } }),
      discover: async () => [
        { id: "solo.tail.ts.net", label: "solo", url: "https://solo.tail.ts.net", token: "", auth: { type: "mesh" } },
      ],
      discoverEgress: async () => {
        throw new Error("egress read on fire")
      },
    })
    const infos = await reg.listInstances()
    expect(infos.map((i) => i.id)).toEqual(["solo.tail.ts.net"])
    const solo = await reg.resolveInstance("solo.tail.ts.net")
    expect(solo.meshProxy).toBeUndefined()
  })

  test("a peer-discovery failure does NOT prevent egress read (peers empty, no throw)", async () => {
    const meshProxy = { url: "http://127.0.0.1:54321", authHeader: "Bearer egress-secret" }
    const reg = new MergedFleetRegistry({
      staticRegistry: new FleetRegistry({ config: { instances: [] } }),
      discover: async () => {
        throw new Error("peers read on fire")
      },
      discoverEgress: async () => meshProxy,
    })
    const infos = await reg.listInstances()
    expect(infos).toEqual([])
  })

  test("listInstances never exposes the meshProxy credential", async () => {
    const meshProxy = { url: "http://127.0.0.1:54321", authHeader: "Bearer egress-secret" }
    const reg = new MergedFleetRegistry({
      staticRegistry: new FleetRegistry({ config: { instances: [] } }),
      discover: async () => [
        { id: "solo.tail.ts.net", label: "solo", url: "https://solo.tail.ts.net", token: "", auth: { type: "mesh" } },
      ],
      discoverEgress: async () => meshProxy,
    })
    const infos = await reg.listInstances()
    const serialized = JSON.stringify(infos)
    expect(serialized).not.toContain("egress-secret")
    expect(serialized).not.toContain("Proxy-Authorization")
    expect(infos[0]).toEqual({ id: "solo.tail.ts.net", label: "solo", url: "https://solo.tail.ts.net" })
  })
})
