import { describe, expect, it } from "bun:test"

import { parseDevtunnelUrl } from "~/lib/serve/devtunnel"

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
