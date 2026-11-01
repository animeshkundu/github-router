import { describe, expect, test } from "bun:test"

import {
  cloudAgentDiscoveryNeeded,
  cloudAgentSuppressed,
  resolveCloudAgentFlags,
  type CloudAgentInputs,
} from "../src/lib/cloudagent-flags"
import { CloudAgentError } from "../src/lib/cloudagent-client"
import type { AzureRepoInfo } from "../src/lib/azure-repo"

// Hermetic: no git probe, no process.env mutation. Every case passes its env
// explicitly, because the resolver reads `inputs.env ?? process.env` and a
// developer machine that happens to have GH_ROUTER_ENABLE_CLOUDAGENT exported would
// otherwise flip the expected verdict.

const REPO: AzureRepoInfo = {
  organization: "contoso",
  project: "platform",
  repository: "web",
}

const EMPTY_ENV: NodeJS.ProcessEnv = {}

function resolve(inputs: CloudAgentInputs, discovered: AzureRepoInfo | null = null) {
  return resolveCloudAgentFlags({ env: EMPTY_ENV, ...inputs }, discovered)
}

describe("one switch decides the whole group", () => {
  test("an explicit --cloudagent turns the group on", () => {
    const flags = resolve({ cloudAgentFlag: true })
    expect(flags.enabled).toBe(true)
    expect(flags.discovered).toBe(false)
    expect(flags.reasons).toEqual([])
  })

  test("discovery turns the group on, write tools included", () => {
    // Parity with the ADO, Kusto and Bluebird groups: an ADO checkout is proof
    // the operator works in the ecosystem, and a half-enabled group is the worse
    // failure mode. The operator's `--no-cloudagent` is the veto.
    const flags = resolve({}, REPO)
    expect(flags.enabled).toBe(true)
    expect(flags.discovered).toBe(true)
    expect(flags.reasons).toEqual([
      "Azure DevOps remote contoso/platform/web",
    ])
  })

  test("a discovered repository with no flag is what makes discovery worth running", () => {
    expect(cloudAgentDiscoveryNeeded({ env: EMPTY_ENV })).toBe(true)
    expect(cloudAgentDiscoveryNeeded({ cloudAgentFlag: true, env: EMPTY_ENV })).toBe(false)
    expect(cloudAgentDiscoveryNeeded({ cloudAgentFlag: false, env: EMPTY_ENV })).toBe(false)
  })

  test("the env positive enables the group exactly like the flag", () => {
    const flags = resolve({ env: { GH_ROUTER_ENABLE_CLOUDAGENT: "1" } })
    expect(flags.enabled).toBe(true)
  })
})

describe("precedence: explicit negative, then explicit positive, then discovery", () => {
  test("the CLI negative beats the env positive", () => {
    const flags = resolve({ cloudAgentFlag: false, env: { GH_ROUTER_ENABLE_CLOUDAGENT: "1" } }, REPO)
    expect(flags.enabled).toBe(false)
  })

  test("the disable env beats an explicit enable, so a shell profile cannot win", () => {
    const flags = resolve({
      cloudAgentFlag: true,
      env: { GH_ROUTER_ENABLE_CLOUDAGENT: "1", GH_ROUTER_DISABLE_CLOUDAGENT: "1" },
    })
    expect(flags.enabled).toBe(false)
  })

  test("--no-cloudagent vetoes a discovered repository too", () => {
    // The veto is the whole mitigation for discovery enabling the write tools.
    expect(resolve({ cloudAgentFlag: false }, REPO).enabled).toBe(false)
    expect(
      resolve({ env: { GH_ROUTER_DISABLE_CLOUDAGENT: "1" } }, REPO).enabled,
    ).toBe(false)
  })

  test("an env negative is an intent, so discovery does not override it", () => {
    const flags = resolve({ env: { GH_ROUTER_ENABLE_CLOUDAGENT: "0" } }, REPO)
    expect(flags.enabled).toBe(false)
    expect(cloudAgentDiscoveryNeeded({ env: { GH_ROUTER_ENABLE_CLOUDAGENT: "0" } })).toBe(false)
  })

  test("GH_ROUTER_DISABLE_AZURE_MCPS suppresses the discovery path", () => {
    // A user who turned the Azure groups off does not want a new cloud group
    // surfacing off a git remote either.
    const flags = resolve({ env: { GH_ROUTER_AZURE_MCPS: "0" } }, REPO)
    expect(flags.enabled).toBe(false)
    expect(cloudAgentDiscoveryNeeded({ env: { GH_ROUTER_AZURE_MCPS: "0" } })).toBe(false)
    // ...but it does not block an explicit request.
    expect(resolve({ cloudAgentFlag: true, env: { GH_ROUTER_AZURE_MCPS: "0" } }).enabled).toBe(true)
  })

  test("no flag, no env, no discovery is simply off", () => {
    const flags = resolve({}, null)
    expect(flags.enabled).toBe(false)
    expect(flags.reasons).toEqual([])
  })
})

describe("environment", () => {
  test("defaults to prod", () => {
    expect(resolve({}).environment).toBe("prod")
  })

  test("naming an environment does NOT enable the group", () => {
    const flags = resolve({ cloudAgentEnvironment: "ppe" })
    expect(flags.environment).toBe("ppe")
    expect(flags.enabled).toBe(false)
  })

  test("the CLI value beats the env value", () => {
    const flags = resolve({ cloudAgentEnvironment: "prod", env: { GH_ROUTER_CLOUDAGENT_ENV: "ppe" } })
    expect(flags.environment).toBe("prod")
  })

  test("a malformed environment fails even when the group is off", () => {
    // A typo must not be swallowed: it would surface later as a token minted
    // for the wrong audience, or as a silently missing group.
    expect(() => resolve({ cloudAgentEnvironment: "ppee" })).toThrow(CloudAgentError)
    expect(() => resolve({ env: { GH_ROUTER_CLOUDAGENT_ENV: "staging" } })).toThrow(/prod.*ppe|ppe.*prod/)
  })
})

describe("cloudAgentSuppressed", () => {
  test("accepts the usual truthy spellings and nothing else", () => {
    for (const value of ["1", "true", "yes", "on", " TRUE "]) {
      expect(cloudAgentSuppressed({ GH_ROUTER_DISABLE_CLOUDAGENT: value })).toBe(true)
    }
    for (const value of ["0", "false", "off", "", "maybe"]) {
      expect(cloudAgentSuppressed({ GH_ROUTER_DISABLE_CLOUDAGENT: value })).toBe(false)
    }
    expect(cloudAgentSuppressed({})).toBe(false)
  })
})
