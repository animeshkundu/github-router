import { describe, expect, it } from "bun:test"

import {
  parseDevtunnelUrl,
  selectServeTunnel,
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

describe("selectServeTunnel", () => {
  const M = "ghr-machine-abc123def456"

  it("reuses the first idle tunnel for this machine and deletes the rest", () => {
    const tunnels = [
      { tunnelId: "keep-1.inc1", labels: [M], hostConnections: 0 },
      { tunnelId: "dup-2.inc1", labels: [M], hostConnections: 0 },
      { tunnelId: "dup-3.usw2", labels: [M] }, // undefined hostConnections === idle
    ]
    expect(selectServeTunnel(tunnels, M)).toEqual({
      reuseId: "keep-1.inc1",
      deleteIds: ["dup-2.inc1", "dup-3.usw2"],
    })
  })

  it("ignores tunnels owned by other machines (different machine label)", () => {
    const tunnels = [
      { tunnelId: "other-host.inc1", labels: ["ghr-machine-999"], hostConnections: 0 },
    ]
    expect(selectServeTunnel(tunnels, M)).toEqual({ reuseId: null, deleteIds: [] })
  })

  it("never reuses or deletes a tunnel that is actively hosted (>0 connections)", () => {
    const tunnels = [
      { tunnelId: "live.inc1", labels: [M], hostConnections: 1 },
      { tunnelId: "idle.inc1", labels: [M], hostConnections: 0 },
    ]
    // the live one is skipped for both reuse AND deletion; only the idle one reused
    expect(selectServeTunnel(tunnels, M)).toEqual({
      reuseId: "idle.inc1",
      deleteIds: [],
    })
  })

  it("returns null reuse when there are no idle owned tunnels (host will create one)", () => {
    expect(selectServeTunnel([], M)).toEqual({ reuseId: null, deleteIds: [] })
  })
})
