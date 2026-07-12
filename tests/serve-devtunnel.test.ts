import { describe, expect, it } from "bun:test"

import {
  parseDevtunnelUrl,
  portsToReconcile,
  serveTunnelId,
  serveTunnelIdsToSweep,
  serveTunnelMachineLabel,
} from "~/lib/serve/devtunnel"

describe("parseDevtunnelUrl", () => {
  it("extracts the browser URL from the devtunnel host output line", () => {
    const line = "Hosting port 5454 at https://l3rs99qw-5454.usw2.devtunnels.ms/"
    expect(parseDevtunnelUrl(line)).toBe(
      "https://l3rs99qw-5454.usw2.devtunnels.ms",
    )
  })

  it("finds the URL amid multi-line output and strips trailing slash", () => {
    const out = [
      "Ready to accept connections for tunnel: abc123",
      "Connect via browser:",
      "  https://abc123-5454.euw.devtunnels.ms/",
    ].join("\n")
    expect(parseDevtunnelUrl(out)).toBe("https://abc123-5454.euw.devtunnels.ms")
  })

  it("returns null when there is no devtunnels.ms URL", () => {
    expect(parseDevtunnelUrl("Logging in…")).toBeNull()
    // a lookalike domain is not matched
    expect(parseDevtunnelUrl("https://evil-devtunnels.ms/x")).toBeNull()
    expect(parseDevtunnelUrl("https://example.com/")).toBeNull()
  })
})

describe("serveTunnelMachineLabel", () => {
  it("is deterministic per hostname and label-charset-safe", () => {
    const a = serveTunnelMachineLabel("my-host")
    expect(a).toBe(serveTunnelMachineLabel("my-host"))
    expect(a).toMatch(/^ghr-machine-[0-9a-f]{12}$/)
  })

  it("differs across hostnames", () => {
    expect(serveTunnelMachineLabel("host-a")).not.toBe(serveTunnelMachineLabel("host-b"))
  })
})

describe("serveTunnelIdsToSweep", () => {
  const M = "ghr-machine-abc123def456"

  it("sweeps every idle tunnel for this machine (deleted before a fresh host)", () => {
    const tunnels = [
      { tunnelId: "a-1.inc1", labels: [M], hostConnections: 0 },
      { tunnelId: "a-2.inc1", labels: [M], hostConnections: 0 },
      { tunnelId: "a-3.usw2", labels: [M] }, // undefined hostConnections === idle
    ]
    expect(serveTunnelIdsToSweep(tunnels, M)).toEqual(["a-1.inc1", "a-2.inc1", "a-3.usw2"])
  })

  it("ignores tunnels owned by other machines (different machine label)", () => {
    const tunnels = [
      { tunnelId: "other-host.inc1", labels: ["ghr-machine-999"], hostConnections: 0 },
    ]
    expect(serveTunnelIdsToSweep(tunnels, M)).toEqual([])
  })

  it("never sweeps a tunnel that is actively hosted (>0 connections)", () => {
    const tunnels = [
      { tunnelId: "live.inc1", labels: [M], hostConnections: 1 },
      { tunnelId: "idle.inc1", labels: [M], hostConnections: 0 },
    ]
    expect(serveTunnelIdsToSweep(tunnels, M)).toEqual(["idle.inc1"])
  })

  it("returns nothing when there are no idle owned tunnels", () => {
    expect(serveTunnelIdsToSweep([], M)).toEqual([])
  })

  it("keeps the stable reused tunnel (exceptId) — sweeps only the OTHER idle ones", () => {
    const tunnels = [
      { tunnelId: "ghr-serve-abc.inc1", labels: [M], hostConnections: 0 }, // the stable one
      { tunnelId: "random-old.inc1", labels: [M], hostConnections: 0 },    // a pre-migration leftover
    ]
    expect(serveTunnelIdsToSweep(tunnels, M, "ghr-serve-abc")).toEqual(["random-old.inc1"])
  })
})

describe("serveTunnelId", () => {
  it("is deterministic per hostname and a valid tunnel-id (lowercase alnum + hyphens)", () => {
    const a = serveTunnelId("my-host")
    expect(a).toBe(serveTunnelId("my-host"))
    expect(a).toMatch(/^ghr-serve-[0-9a-f]{12}$/)
    expect(a.length).toBeLessThan(60)
  })

  it("differs across hostnames", () => {
    expect(serveTunnelId("host-a")).not.toBe(serveTunnelId("host-b"))
  })
})

describe("portsToReconcile", () => {
  it("no change when the tunnel already has exactly the desired port", () => {
    expect(portsToReconcile([5454], 5454)).toEqual({ toDelete: [], toCreate: null })
  })

  it("adds the desired port when the tunnel has none", () => {
    expect(portsToReconcile([], 5454)).toEqual({ toDelete: [], toCreate: 5454 })
  })

  it("deletes stale ports and adds the desired one on a --port change", () => {
    expect(portsToReconcile([5454], 8080)).toEqual({ toDelete: [5454], toCreate: 8080 })
  })

  it("deletes extra ports but keeps the desired one (no re-create)", () => {
    expect(portsToReconcile([5454, 8080, 9090], 8080)).toEqual({ toDelete: [5454, 9090], toCreate: null })
  })
})
