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
})
