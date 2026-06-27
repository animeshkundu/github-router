import { describe, expect, test } from "bun:test"

import {
  FleetRegistry,
  FleetRegistryError,
  type FleetRegistryErrorCode,
} from "../../src/lib/fleet/registry"

const BASE_INSTANCES = [
  { id: "alpha", label: "Alpha Lab", url: "https://alpha.example", token: "tok-alpha" },
  { id: "beta", label: "Beta Lab", url: "https://beta.example", token: "tok-beta" },
]

async function expectRegistryError(promise: Promise<unknown>, code: FleetRegistryErrorCode): Promise<void> {
  try {
    await promise
    throw new Error("expected FleetRegistryError")
  } catch (err) {
    expect(err).toBeInstanceOf(FleetRegistryError)
    expect((err as FleetRegistryError).code).toBe(code)
  }
}

describe("FleetRegistry", () => {
  test("resolveInstance resolves by id", async () => {
    const registry = new FleetRegistry({ config: { instances: BASE_INSTANCES } })

    const resolved = await registry.resolveInstance("beta")

    expect(resolved).toEqual({
      id: "beta",
      label: "Beta Lab",
      url: "https://beta.example",
      token: "tok-beta",
      allowExec: undefined,
    })
  })

  test("resolveInstance resolves by label case-insensitively", async () => {
    const registry = new FleetRegistry({ config: { instances: BASE_INSTANCES } })

    const resolved = await registry.resolveInstance("alpha lab")

    expect(resolved.id).toBe("alpha")
  })

  test("resolveInstance rejects ambiguous labels", async () => {
    const registry = new FleetRegistry({
      config: {
        instances: [
          { id: "one", label: "Shared", url: "https://one.example", token: "tok-one" },
          { id: "two", label: "shared", url: "https://two.example", token: "tok-two" },
        ],
      },
    })

    await expectRegistryError(registry.resolveInstance("SHARED"), "AMBIGUOUS_LABEL")
  })

  test("resolveInstance uses the default instance when no arg is supplied", async () => {
    const registry = new FleetRegistry({
      config: {
        instances: [
          { id: "alpha", label: "Alpha", url: "https://alpha.example", token: "tok-alpha" },
          { id: "beta", label: "Beta", url: "https://beta.example", token: "tok-beta", default: true },
        ],
      },
    })

    const resolved = await registry.resolveInstance()

    expect(resolved.id).toBe("beta")
  })

  test("resolveInstance auto-selects a single instance", async () => {
    const registry = new FleetRegistry({
      config: {
        instances: [
          { id: "solo", label: "Solo", url: "https://solo.example", token: "tok-solo" },
        ],
      },
    })

    const resolved = await registry.resolveInstance()

    expect(resolved.id).toBe("solo")
  })

  test("resolveInstance requires an instance when none can be selected", async () => {
    const registry = new FleetRegistry({ config: { instances: BASE_INSTANCES } })

    await expectRegistryError(registry.resolveInstance(), "INSTANCE_REQUIRED")
  })

  test("listInstances rejects non-local http urls", async () => {
    const registry = new FleetRegistry({
      config: {
        instances: [
          { id: "evil", label: "Evil", url: "http://evil.example", token: "tok-evil" },
        ],
      },
    })

    await expectRegistryError(registry.listInstances(), "INVALID_CONFIG")
  })

  test("listInstances accepts https urls and localhost http urls", async () => {
    const registry = new FleetRegistry({
      config: {
        instances: [
          { id: "secure", label: "Secure", url: "https://secure.example", token: "tok-secure" },
          { id: "local", label: "Local", url: "http://localhost:8787", token: "tok-local" },
        ],
      },
    })

    const instances = await registry.listInstances()

    expect(instances.map((instance) => instance.url)).toEqual([
      "https://secure.example",
      "http://localhost:8787",
    ])
  })

  describe("F5 Dev Tunnel URL shape", () => {
    test("rejects the wrong <id>.<cluster>.devtunnels.ms:<port> form with a corrective hint", async () => {
      const registry = new FleetRegistry({
        config: {
          instances: [
            { id: "dt", label: "Dev Tunnel", url: "https://abc.uks1.devtunnels.ms:3000", token: "tok-dt" },
          ],
        },
      })

      let caught: unknown
      try {
        await registry.listInstances()
        throw new Error("expected FleetRegistryError")
      } catch (err) {
        caught = err
      }
      expect(caught).toBeInstanceOf(FleetRegistryError)
      expect((caught as FleetRegistryError).code).toBe("INVALID_CONFIG")
      // Echoes back the corrected port-as-subdomain form.
      expect((caught as FleetRegistryError).message).toContain("https://abc-3000.uks1.devtunnels.ms")
    })

    test("accepts the correct <id>-<port>.<cluster>.devtunnels.ms form", async () => {
      const registry = new FleetRegistry({
        config: {
          instances: [
            { id: "dt", label: "Dev Tunnel", url: "https://abc-3000.uks1.devtunnels.ms", token: "tok-dt" },
          ],
        },
      })

      const instances = await registry.listInstances()

      expect(instances[0]?.url).toBe("https://abc-3000.uks1.devtunnels.ms")
    })

    test("accepts the correct form even with an explicit default :443", async () => {
      const registry = new FleetRegistry({
        config: {
          instances: [
            { id: "dt", label: "Dev Tunnel", url: "https://abc-3000.uks1.devtunnels.ms:443", token: "tok-dt" },
          ],
        },
      })

      const instances = await registry.listInstances()

      // URL normalizes away the default https port.
      expect(instances[0]?.url).toBe("https://abc-3000.uks1.devtunnels.ms:443")
    })

    test("does NOT touch non-devtunnels urls with explicit ports", async () => {
      const registry = new FleetRegistry({
        config: {
          instances: [
            { id: "local", label: "Local", url: "http://localhost:8787", token: "tok-local" },
            { id: "ip", label: "Ip", url: "http://127.0.0.1:9000", token: "tok-ip" },
            { id: "other", label: "Other", url: "https://example.com:3000", token: "tok-other" },
          ],
        },
      })

      const instances = await registry.listInstances()

      expect(instances.map((instance) => instance.url)).toEqual([
        "http://localhost:8787",
        "http://127.0.0.1:9000",
        "https://example.com:3000",
      ])
    })

    test("rejects the wrong form on the legacy tunnels.api.visualstudio.com host", async () => {
      const registry = new FleetRegistry({
        config: {
          instances: [
            { id: "dt", label: "Dev Tunnel", url: "https://abc.usw2.tunnels.api.visualstudio.com:8080", token: "tok-dt" },
          ],
        },
      })

      let caught: unknown
      try {
        await registry.listInstances()
        throw new Error("expected FleetRegistryError")
      } catch (err) {
        caught = err
      }
      expect(caught).toBeInstanceOf(FleetRegistryError)
      expect((caught as FleetRegistryError).message).toContain("https://abc-8080.usw2.tunnels.api.visualstudio.com")
    })
  })
})
