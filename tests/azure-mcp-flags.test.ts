import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import os from "node:os"
import path from "node:path"

import {
  azureDiscoveryNeeded,
  azureMcpsSuppressed,
  discoverAzureRepo,
  gitAzureRepoProbe,
  resetAzureDiscoveryForTesting,
  resolveAzureMcpFlags,
  type AzureMcpInputs,
} from "~/lib/azure-mcp-flags"
import type { AzureRepoInfo } from "~/lib/azure-repo"

/**
 * A synthetic Azure DevOps remote. Deliberately not a real organization: the
 * point of these tests is the DECISION, and the decision must be provable
 * without reaching anything.
 */
const DISCOVERED: AzureRepoInfo = {
  organization: "contoso",
  project: "widgets",
  repository: "widget-service",
}

/**
 * Every case passes an explicit env. The resolver falls back to `process.env`
 * when one is not supplied, and a developer machine carrying
 * `GH_ROUTER_ENABLE_ADO=1` would otherwise make these results depend on where
 * the suite is run.
 */
const NO_ENV: NodeJS.ProcessEnv = {}

function resolve(inputs: AzureMcpInputs, discovered: AzureRepoInfo | null = null) {
  return resolveAzureMcpFlags({ env: NO_ENV, ...inputs }, discovered)
}

afterEach(() => {
  resetAzureDiscoveryForTesting()
})

describe("resolveAzureMcpFlags — precedence", () => {
  test("an Azure DevOps remote turns bluebird and ado on, and kusto stays off", () => {
    const flags = resolve({}, DISCOVERED)
    expect(flags.bluebird).toBe(true)
    expect(flags.ado).toBe(true)
    expect(flags.adoOrganization).toBe("contoso")
    expect(flags.kusto).toBe(false)
    expect(flags.kustoCluster).toBeNull()
    expect(flags.warnings).toEqual([])
    // Both flags came from discovery, so both announce the remote that caused
    // them: a session with three more servers has to be explainable.
    expect(flags.reasons).toEqual([
      "bluebird: Azure DevOps remote contoso/widgets/widget-service",
      "ado: Azure DevOps remote contoso/widgets/widget-service",
    ])
  })

  test("no remote and no flags leaves every surface off, with no warnings", () => {
    const flags = resolve({})
    expect([flags.bluebird, flags.ado, flags.kusto]).toEqual([false, false, false])
    expect(flags.reasons).toEqual([])
    expect(flags.warnings).toEqual([])
  })

  test("--no-<capability> wins over discovery", () => {
    expect(resolve({ bluebirdFlag: false }, DISCOVERED).bluebird).toBe(false)
    expect(resolve({ adoFlag: false }, DISCOVERED).ado).toBe(false)
    // The one it was not told to refuse still comes on.
    const onlyAdo = resolve({ bluebirdFlag: false }, DISCOVERED)
    expect(onlyAdo.ado).toBe(true)
  })

  test("--no-<capability> wins over its own env positive", () => {
    const flags = resolveAzureMcpFlags(
      { env: { GH_ROUTER_ENABLE_ADO: "1" }, adoFlag: false },
      DISCOVERED,
    )
    expect(flags.ado).toBe(false)
  })

  test("GH_ROUTER_AZURE_MCPS=off suppresses everything, including explicit positives", () => {
    const flags = resolveAzureMcpFlags(
      {
        env: { GH_ROUTER_AZURE_MCPS: "off" },
        bluebirdFlag: true,
        adoFlag: true,
        adoOrganization: "contoso",
        kustoFlag: true,
        kustoCluster: "https://example.kusto.windows.net",
      },
      DISCOVERED,
    )
    expect([flags.bluebird, flags.ado, flags.kusto]).toEqual([false, false, false])
    expect(flags.adoOrganization).toBeNull()
    expect(flags.kustoCluster).toBeNull()
    // Suppression is silent by design: the banner reports what IS on, and an
    // operator who set the kill switch already knows why nothing is.
    expect(flags.reasons).toEqual([])
  })

  test("the kill switch is parsed, not merely tested for presence", () => {
    expect(azureMcpsSuppressed({ GH_ROUTER_AZURE_MCPS: "off" })).toBe(true)
    expect(azureMcpsSuppressed({ GH_ROUTER_AZURE_MCPS: "OFF" })).toBe(true)
    expect(azureMcpsSuppressed({ GH_ROUTER_AZURE_MCPS: "0" })).toBe(true)
    expect(azureMcpsSuppressed({ GH_ROUTER_AZURE_MCPS: "no" })).toBe(true)
    expect(azureMcpsSuppressed({ GH_ROUTER_AZURE_MCPS: "on" })).toBe(false)
    expect(azureMcpsSuppressed({})).toBe(false)
  })
})

describe("resolveAzureMcpFlags — Kusto is opt-in, never remote-driven", () => {
  test("discovery alone never enables Kusto", () => {
    expect(resolve({}, DISCOVERED).kusto).toBe(false)
  })

  test("--kusto-cluster is its own opt-in", () => {
    const flags = resolve({ kustoCluster: "https://example.kusto.windows.net" })
    expect(flags.kusto).toBe(true)
    expect(flags.kustoCluster).toBe("https://example.kusto.windows.net")
  })

  test("a malformed cluster fails the launch instead of becoming a dead default", () => {
    // A call that names its own cluster still works with a bad default, but the
    // default would be a host nothing can reach, and the operator would learn
    // that from a model's failed call rather than from the launch. The cluster
    // is normalized at the point it enters the process so the operator gets the
    // expectation named, in the style of the ADO toolset typo above.
    expect(() => resolve({ kustoCluster: "http://example.kusto.windows.net" })).toThrow(/https/)
    expect(() => resolve({ kustoCluster: "not a host" })).toThrow(/not a valid/)
    expect(() => resolve({ kustoCluster: "https://user:pw@example.kusto.windows.net" }))
      .toThrow(/credentials/)
  })

  test("--kusto alone is a complete opt-in, with no cluster and no complaint", () => {
    // The group is on and the calls name their own cluster. It must not warn:
    // a warning here would tell an operator their deliberate configuration is
    // broken, and the one line the launch still prints is informational.
    const flags = resolve({ kustoFlag: true }, DISCOVERED)
    expect(flags.kusto).toBe(true)
    expect(flags.kustoCluster).toBeNull()
    expect(flags.warnings).toEqual([])
  })

  test("GH_ROUTER_ENABLE_KUSTO=1 is the env equivalent, and still needs no cluster", () => {
    const flags = resolveAzureMcpFlags(
      { env: { GH_ROUTER_ENABLE_KUSTO: "1" } },
      DISCOVERED,
    )
    expect(flags.kusto).toBe(true)
    expect(flags.kustoCluster).toBeNull()
    expect(flags.warnings).toEqual([])
  })

  test("--no-kusto beats the flag and the env, cluster or not", () => {
    expect(resolve({ kustoFlag: false, kustoCluster: "https://example.kusto.windows.net" }).kusto)
      .toBe(false)
    const envOff = resolveAzureMcpFlags(
      { kustoFlag: false, env: { GH_ROUTER_ENABLE_KUSTO: "1" } },
      null,
    )
    expect(envOff.kusto).toBe(false)
    expect(envOff.kustoCluster).toBeNull()
  })

  test("a discovered remote plus an env cluster enables Kusto, which the remote did not cause", () => {
    const flags = resolveAzureMcpFlags(
      { env: { GH_ROUTER_KUSTO_CLUSTER: "https://example.kusto.windows.net" } },
      DISCOVERED,
    )
    expect(flags.kusto).toBe(true)
    // Kusto is on because a cluster was configured, not because a remote was
    // found. The banner names the CAUSE of each enabled surface, so it must
    // not credit a remote that had no effect on this one.
    expect(flags.reasons).not.toContain(
      "kusto: Azure DevOps remote contoso/widgets/widget-service",
    )
  })

  test("the database rides along only when the group is on", () => {
    const on = resolve({
      kustoCluster: "https://example.kusto.windows.net",
      kustoDatabase: "Telemetry",
    })
    expect(on.kustoDatabase).toBe("Telemetry")
    const off = resolve({ kustoDatabase: "Telemetry" })
    expect(off.kustoDatabase).toBeNull()
  })
})

describe("resolveAzureMcpFlags — Azure DevOps organization", () => {
  test("an explicit organization is its own opt-in, with no remote required", () => {
    const flags = resolve({ adoOrganization: "contoso" })
    expect(flags.ado).toBe(true)
    expect(flags.adoOrganization).toBe("contoso")
    // `ado` came from the flag, so nothing is announced as auto-enabled.
    expect(flags.reasons).toEqual([])
  })

  test("an explicit organization overrides the discovered one", () => {
    expect(resolve({ adoOrganization: "fabrikam" }, DISCOVERED).adoOrganization).toBe("fabrikam")
  })

  test("--ado with neither an organization nor a remote warns", () => {
    const flags = resolve({ adoFlag: true })
    expect(flags.ado).toBe(false)
    expect(flags.warnings).toEqual([
      "ado: requested but no organization (--ado-org) and no Azure DevOps git remote",
    ])
  })

  test("the toolsets resolve only while the group is on", () => {
    expect(resolve({ adoOrganization: "contoso" }).adoToolsets)
      .toEqual(["repos", "wit", "pipelines", "wiki"])
    expect(resolve({}).adoToolsets).toBeNull()
  })

  test("--ado-all-toolsets sends the single 'all' selection", () => {
    expect(resolve({ adoOrganization: "contoso", adoAllToolsets: true }).adoToolsets)
      .toEqual(["all"])
    // The flag is not itself an opt-in for the group.
    expect(resolve({ adoAllToolsets: true }).ado).toBe(false)
  })

  test("--ado-toolsets validates and collapses 'all'", () => {
    expect(resolve({ adoOrganization: "contoso", adoToolsets: "repos, wiki" }).adoToolsets)
      .toEqual(["repos", "wiki"])
    expect(resolve({ adoOrganization: "contoso", adoToolsets: "repos,all" }).adoToolsets)
      .toEqual(["all"])
    // A typo fails the launch rather than silently widening or narrowing the
    // surface, which is the difference between a 400 and a mystery.
    expect(() => resolve({ adoOrganization: "contoso", adoToolsets: "core" }))
      .toThrow(/Unknown Azure DevOps toolset/)
  })
})

describe("azureDiscoveryNeeded", () => {
  test("true while either remote-scoped capability is undecided", () => {
    expect(azureDiscoveryNeeded({ env: NO_ENV })).toBe(true)
    // Bluebird refused, ADO undecided and unscoped: the probe still matters.
    expect(azureDiscoveryNeeded({ env: NO_ENV, bluebirdFlag: false })).toBe(true)
  })

  test("false once the remote could not change anything", () => {
    // Both refused.
    expect(azureDiscoveryNeeded({ env: NO_ENV, bluebirdFlag: false, adoFlag: false })).toBe(false)
    // Both decided positively.
    expect(azureDiscoveryNeeded({
      env: NO_ENV,
      bluebirdFlag: true,
      adoFlag: true,
      adoOrganization: "contoso",
    })).toBe(false)
    // ADO has a scope and Bluebird was refused.
    expect(azureDiscoveryNeeded({
      env: NO_ENV,
      bluebirdFlag: false,
      adoOrganization: "contoso",
    })).toBe(false)
    // Bluebird has no flag, so it is still undecided even with an ADO scope.
    expect(azureDiscoveryNeeded({ env: NO_ENV, adoOrganization: "contoso" })).toBe(true)
  })

  test("false under the wholesale kill switch", () => {
    expect(azureDiscoveryNeeded({ env: { GH_ROUTER_AZURE_MCPS: "off" } })).toBe(false)
  })
})

describe("discoverAzureRepo", () => {
  test("uses a synthetic probe and memoizes it", async () => {
    let calls = 0
    const probe = async (): Promise<AzureRepoInfo | null> => {
      calls += 1
      return DISCOVERED
    }
    const first = await discoverAzureRepo({ probe })
    const second = await discoverAzureRepo({ probe })
    expect(first).toEqual(DISCOVERED)
    expect(second).toEqual(DISCOVERED)
    expect(calls).toBe(1)
  })

  test("a pushing probe resolves to null and never fails the launch", async () => {
    const result = await discoverAzureRepo({
      probe: async () => {
        throw new Error("git is not installed")
      },
    })
    expect(result).toBeNull()
  })

  test("a probe that never settles is bounded by the timeout", async () => {
    const result = await discoverAzureRepo({
      timeoutMs: 30,
      probe: async (_workspace: string, signal?: AbortSignal) => {
        // Honour the signal the way a real caller would, so the test asserts
        // the deadline reaches the probe rather than only that it returns.
        if (!signal) throw new Error("probe received no abort signal")
        await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }))
        throw new Error("aborted")
      },
    })
    // The probe cannot settle on its own, so reaching this line means the
    // deadline fired and reached the probe. No wall-clock bound is asserted:
    // that deadline is a timer on the test runner's own event loop, and
    // synchronous work in lane 1 delays timers (measured at 5.0s late under a
    // deliberate 5s block; see tests/exec.test.ts). A broken deadline shows up
    // here as a bun timeout, which for this test has exactly one meaning.
    expect(result).toBeNull()
  })

  test("gitAzureRepoProbe resolves a non-repository directory to null", async () => {
    // Real git, real filesystem, synthetic directory: the probe's contract is
    // that a THROWING `getAzureRepoFromGit` becomes a null, and this is the
    // cheapest real throw to reach.
    const dir = mkdtempSync(path.join(os.tmpdir(), "gh-router-not-a-repo-"))
    expect(await gitAzureRepoProbe(dir)).toBeNull()
  })
})
