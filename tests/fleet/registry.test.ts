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

describe("FleetRegistry tunnel auth fields", () => {
  test("parses and forwards tunnelId and tunnelToken", async () => {
    const registry = new FleetRegistry({
      config: {
        instances: [
          { id: "t", label: "T", url: "https://t.usw2.devtunnels.ms", token: "tok", tunnelId: "aiordie-h.usw2", tunnelToken: "eyJ.a.b" },
        ],
      },
    })

    const resolved = await registry.resolveInstance("t")

    expect(resolved.tunnelId).toBe("aiordie-h.usw2")
    expect(resolved.tunnelToken).toBe("eyJ.a.b")
  })

  test("normalizes a tunnelToken carrying a `tunnel ` scheme prefix", async () => {
    const registry = new FleetRegistry({
      config: {
        instances: [
          { id: "t", label: "T", url: "https://t.usw2.devtunnels.ms", token: "tok", tunnelToken: "tunnel eyJ.a.b" },
        ],
      },
    })

    const resolved = await registry.resolveInstance("t")

    expect(resolved.tunnelToken).toBe("eyJ.a.b")
  })

  test("rejects an empty tunnelToken", async () => {
    const registry = new FleetRegistry({
      config: { instances: [{ id: "t", label: "T", url: "https://t.devtunnels.ms", token: "tok", tunnelToken: "" }] },
    })
    await expectRegistryError(registry.listInstances(), "INVALID_CONFIG")
  })

  test("rejects a tunnelToken with internal whitespace", async () => {
    const registry = new FleetRegistry({
      config: { instances: [{ id: "t", label: "T", url: "https://t.devtunnels.ms", token: "tok", tunnelToken: "ey J" }] },
    })
    await expectRegistryError(registry.listInstances(), "INVALID_CONFIG")
  })

  test("rejects a tunnelId with a leading hyphen (flag-injection guard)", async () => {
    const registry = new FleetRegistry({
      config: { instances: [{ id: "t", label: "T", url: "https://t.devtunnels.ms", token: "tok", tunnelId: "-h" }] },
    })
    await expectRegistryError(registry.listInstances(), "INVALID_CONFIG")
  })

  test("rejects a tunnelId with shell metacharacters or percent", async () => {
    for (const bad of ["a b", "a;rm -rf /", "a%PATH%", "a|b"]) {
      const registry = new FleetRegistry({
        config: { instances: [{ id: "t", label: "T", url: "https://t.devtunnels.ms", token: "tok", tunnelId: bad }] },
      })
      await expectRegistryError(registry.listInstances(), "INVALID_CONFIG")
    }
  })

  test("rejects a url with embedded credentials (userinfo)", async () => {
    const registry = new FleetRegistry({
      config: { instances: [{ id: "t", label: "T", url: "https://user:pass@t.devtunnels.ms", token: "tok" }] },
    })
    await expectRegistryError(registry.listInstances(), "INVALID_CONFIG")
  })

  test("never exposes tunnelId or tunnelToken in listInstances output", async () => {
    const registry = new FleetRegistry({
      config: {
        instances: [
          {
            id: "t",
            label: "T",
            url: "https://t.usw2.devtunnels.ms",
            token: "tok",
            tunnelId: "aiordie-secretid.usw2",
            tunnelToken: "eyJsecrettoken.a.b",
          },
        ],
      },
    })

    const infos = await registry.listInstances()
    const text = JSON.stringify(infos)

    expect(text).not.toContain("eyJsecrettoken")
    expect(text).not.toContain("aiordie-secretid")
    expect(infos[0]).not.toHaveProperty("tunnelToken")
    expect(infos[0]).not.toHaveProperty("tunnelId")
  })
})

describe("FleetRegistry insecureTLS flag", () => {
  test("resolveInstance carries insecureTLS when set true", async () => {
    const registry = new FleetRegistry({
      config: { instances: [{ id: "local", label: "Local", url: "https://localhost:7777", token: "none", insecureTLS: true }] },
    })

    expect((await registry.resolveInstance("local")).insecureTLS).toBe(true)
  })

  test("leaves insecureTLS undefined when absent or explicitly false (fails closed)", async () => {
    const registry = new FleetRegistry({
      config: {
        instances: [
          { id: "a", label: "A", url: "https://a.example", token: "t", insecureTLS: false },
          { id: "b", label: "B", url: "https://b.example", token: "t" },
        ],
      },
    })

    expect((await registry.resolveInstance("a")).insecureTLS).toBeUndefined()
    expect((await registry.resolveInstance("b")).insecureTLS).toBeUndefined()
  })

  test("rejects a non-boolean insecureTLS with INVALID_CONFIG (no silent coercion)", async () => {
    const registry = new FleetRegistry({
      config: {
        instances: [
          { id: "x", label: "X", url: "https://x.example", token: "t", insecureTLS: "true" as unknown as boolean },
        ],
      },
    })

    await expectRegistryError(registry.listInstances(), "INVALID_CONFIG")
  })

  test("never exposes insecureTLS in listInstances output", async () => {
    const registry = new FleetRegistry({
      config: { instances: [{ id: "local", label: "Local", url: "https://localhost:7777", token: "none", insecureTLS: true }] },
    })

    const [info] = await registry.listInstances()

    expect(info).not.toHaveProperty("insecureTLS")
  })

  test("rejects insecureTLS on an http (localhost) url — no TLS to relax", async () => {
    const registry = new FleetRegistry({
      config: { instances: [{ id: "h", label: "H", url: "http://localhost:7777", token: "none", insecureTLS: true }] },
    })

    await expectRegistryError(registry.listInstances(), "INVALID_CONFIG")
  })

  test("rejects insecureTLS on a Dev Tunnel host (valid public cert; foot-gun)", async () => {
    const registry = new FleetRegistry({
      config: { instances: [{ id: "t", label: "T", url: "https://abc-7777.usw2.devtunnels.ms", token: "none", insecureTLS: true }] },
    })

    await expectRegistryError(registry.listInstances(), "INVALID_CONFIG")
  })

  test("rejects insecureTLS when tunnelId is present (a tunnel instance)", async () => {
    const registry = new FleetRegistry({
      config: { instances: [{ id: "t", label: "T", url: "https://host.example", token: "none", tunnelId: "aiordie-x-gh.usw2", insecureTLS: true }] },
    })

    await expectRegistryError(registry.listInstances(), "INVALID_CONFIG")
  })
})
