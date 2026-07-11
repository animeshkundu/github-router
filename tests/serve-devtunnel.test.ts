import { describe, expect, it } from "bun:test"

import {
  parseDevtunnelUrl,
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
})
