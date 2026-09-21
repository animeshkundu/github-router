import { afterEach, describe, expect, test } from "bun:test"

import {
  type AzureRepoInfo,
  checkBranchIndexStatus,
  parseAzureRepo,
  parseGitRemoteLine,
  parseGitRemoteOutput,
  resolveAzureRepoFromRemotes,
} from "../src/lib/azure-repo"

describe("parseAzureRepo", () => {
  test("parses dev.azure.com HTTPS", () => {
    expect(parseAzureRepo("https://dev.azure.com/contoso/webApp/_git/portal")).toEqual({
      organization: "contoso",
      project: "webApp",
      repository: "portal",
    })
  })

  test("parses dev.azure.com HTTPS with .git suffix", () => {
    expect(parseAzureRepo("https://dev.azure.com/contoso/webApp/_git/portal.git")).toEqual({
      organization: "contoso",
      project: "webApp",
      repository: "portal",
    })
  })

  test("parses SSH dev.azure.com", () => {
    expect(
      parseAzureRepo("git@ssh.dev.azure.com:v3/contoso/webApp/portal"),
    ).toEqual({
      organization: "contoso",
      project: "webApp",
      repository: "portal",
    })
  })

  test("parses legacy visualstudio.com SSH", () => {
    expect(
      parseAzureRepo("git@contoso.visualstudio.com:v3/contoso/webApp/portal"),
    ).toEqual({
      organization: "contoso",
      project: "webApp",
      repository: "portal",
    })
  })

  test("parses legacy visualstudio.com HTTPS", () => {
    expect(
      parseAzureRepo("https://contoso.visualstudio.com/webApp/_git/portal"),
    ).toEqual({
      organization: "contoso",
      project: "webApp",
      repository: "portal",
    })
  })

  test("parses legacy collection paths with a _full repo infix", () => {
    expect(
      parseAzureRepo(
        "https://contoso.visualstudio.com/DefaultCollection/WebPlatform/_git/_full/component-library",
      ),
    ).toEqual({
      organization: "contoso",
      project: "WebPlatform",
      repository: "component-library",
    })
  })

  test("strips _optimized/_full repo infixes", () => {
    expect(
      parseAzureRepo("https://dev.azure.com/contoso/webApp/_git/_optimized/portal"),
    ).toEqual({
      organization: "contoso",
      project: "webApp",
      repository: "portal",
    })
    expect(
      parseAzureRepo("git@ssh.dev.azure.com:v3/contoso/webApp/_full/portal.git"),
    ).toEqual({
      organization: "contoso",
      project: "webApp",
      repository: "portal",
    })
  })

  test("rejects non-Azure remotes", () => {
    expect(parseAzureRepo("git@github.com:animeshkundu/github-router.git")).toBeNull()
    expect(parseAzureRepo("https://github.com/animeshkundu/github-router.git")).toBeNull()
    expect(
      parseAzureRepo(
        "https://evil.example/visualstudio.com/attacker/project/_git/repo",
      ),
    ).toBeNull()
    expect(
      parseAzureRepo(
        "https://evil.example/dev.azure.com/attacker/project/_git/repo",
      ),
    ).toBeNull()
  })

  test("rejects empty/malformed input", () => {
    expect(parseAzureRepo(undefined)).toBeNull()
    expect(parseAzureRepo(null)).toBeNull()
    expect(parseAzureRepo("")).toBeNull()
    expect(parseAzureRepo("   ")).toBeNull()
    expect(parseAzureRepo("https://dev.azure.com/_git/portal")).toBeNull()
    expect(parseAzureRepo("not a url")).toBeNull()
  })

  test("neutralizes header-injection payloads (no CR/LF/NUL can survive)", () => {
    // WHATWG URL parsing strips CR/LF (same as the reference extension), so
    // the security property is: no parsed component ever contains a
    // header-splitting character.
    const res = parseAzureRepo(
      "https://dev.azure.com/contoso/webApp/_git/portal\r\nX-Injected: 1",
    )
    for (const part of res ? [res.organization, res.project, res.repository] : []) {
      expect(part).not.toMatch(/[\r\n\0]/)
    }
    // NUL is percent-encoded by the URL parser, then rejected on decode.
    expect(parseAzureRepo("https://dev.azure.com/contoso/webApp/_git/por\0tal")).toBeNull()
  })

  test("rejects overlong components", () => {
    const long = "a".repeat(100)
    expect(parseAzureRepo(`https://dev.azure.com/${long}/webApp/portal`)).toBeNull()
  })
})

describe("parseGitRemoteLine and parseGitRemoteOutput", () => {
  test("parses fetch and push lines preserving remote name and direction", () => {
    const fetchLine = "origin\thttps://dev.azure.com/org1/proj1/_git/repo1 (fetch)"
    const pushLine = "origin\thttps://dev.azure.com/org1/proj1/_git/repo1 (push)"

    expect(parseGitRemoteLine(fetchLine)).toEqual({
      name: "origin",
      url: "https://dev.azure.com/org1/proj1/_git/repo1",
      type: "fetch",
    })

    expect(parseGitRemoteLine(pushLine)).toEqual({
      name: "origin",
      url: "https://dev.azure.com/org1/proj1/_git/repo1",
      type: "push",
    })
  })

  test("handles spaces or tabs and ignores malformed lines", () => {
    expect(parseGitRemoteLine("upstream https://dev.azure.com/org1/proj1/_git/repo1 (fetch)")).toEqual({
      name: "upstream",
      url: "https://dev.azure.com/org1/proj1/_git/repo1",
      type: "fetch",
    })
    expect(parseGitRemoteLine("")).toBeNull()
    expect(parseGitRemoteLine("   ")).toBeNull()
    expect(parseGitRemoteLine("invalid remote format")).toBeNull()
  })

  test("parseGitRemoteOutput parses a full git remote -v block", () => {
    const output = [
      "origin\thttps://dev.azure.com/org1/proj1/_git/repo1 (fetch)",
      "origin\thttps://dev.azure.com/org1/proj1/_git/repo1 (push)",
      "backup\tgit@github.com:someone/repo.git (fetch)",
    ].join("\n")

    const parsed = parseGitRemoteOutput(output)
    expect(parsed).toHaveLength(3)
    expect(parsed[0]).toEqual({
      name: "origin",
      url: "https://dev.azure.com/org1/proj1/_git/repo1",
      type: "fetch",
      info: { organization: "org1", project: "proj1", repository: "repo1" },
    })
    expect(parsed[2]).toEqual({
      name: "backup",
      url: "git@github.com:someone/repo.git",
      type: "fetch",
      info: null,
    })
  })
})

describe("resolveAzureRepoFromRemotes", () => {
  test("prefers origin fetch when origin fetch and push match", () => {
    const entries = parseGitRemoteOutput([
      "origin\thttps://dev.azure.com/org1/proj1/_git/repo1 (fetch)",
      "origin\thttps://dev.azure.com/org1/proj1/_git/repo1 (push)",
      "other\thttps://dev.azure.com/org2/proj2/_git/repo2 (fetch)",
    ].join("\n"))

    const result = resolveAzureRepoFromRemotes(entries)
    expect(result).toEqual({
      organization: "org1",
      project: "proj1",
      repository: "repo1",
    })
  })

  test("collapses duplicate fetch lines for the same origin repo", () => {
    const entries = parseGitRemoteOutput([
      "origin\thttps://dev.azure.com/org1/proj1/_git/repo1 (fetch)",
      "origin\thttps://dev.azure.com/org1/proj1/_git/repo1 (fetch)",
      "origin\thttps://dev.azure.com/org1/proj1/_git/repo1 (push)",
    ].join("\n"))

    const result = resolveAzureRepoFromRemotes(entries)
    expect(result).toEqual({
      organization: "org1",
      project: "proj1",
      repository: "repo1",
    })
  })

  test("collapses case-insensitive duplicate Azure targets across remotes", () => {
    const entries = parseGitRemoteOutput([
      "upstream\thttps://dev.azure.com/OrgA/ProjA/_git/RepoA (fetch)",
      "mirror\thttps://dev.azure.com/orga/proja/_git/repoa (fetch)",
    ].join("\n"))

    const result = resolveAzureRepoFromRemotes(entries)
    expect(result).toEqual({
      organization: "OrgA",
      project: "ProjA",
      repository: "RepoA",
    })
  })

  test("throws error on conflicting origin remote (different Azure repos)", () => {
    const entries = parseGitRemoteOutput([
      "origin\thttps://dev.azure.com/org1/proj1/_git/repo1 (fetch)",
      "origin\thttps://dev.azure.com/org1/proj1/_git/repo2 (push)",
    ].join("\n"))

    expect(() => resolveAzureRepoFromRemotes(entries)).toThrow(
      "Conflicting Azure DevOps repositories configured for origin remote.",
    )
  })

  test("accepts origin Azure fetch plus a non-Azure origin push (Azure fetch stays authoritative)", () => {
    const entries = parseGitRemoteOutput([
      "origin\thttps://dev.azure.com/org1/proj1/_git/repo1 (fetch)",
      "origin\tgit@github.com:user/repo.git (push)",
    ].join("\n"))

    const result = resolveAzureRepoFromRemotes(entries)
    expect(result).toEqual({
      organization: "org1",
      project: "proj1",
      repository: "repo1",
    })
  })

  test("accepts a non-Azure origin fetch plus a sole Azure origin push", () => {
    const entries = parseGitRemoteOutput([
      "origin\tgit@github.com:user/repo.git (fetch)",
      "origin\thttps://dev.azure.com/org1/proj1/_git/repo1 (push)",
    ].join("\n"))

    const result = resolveAzureRepoFromRemotes(entries)
    expect(result).toEqual({
      organization: "org1",
      project: "proj1",
      repository: "repo1",
    })
  })

  test("when origin is absent, accepts exactly one distinct Azure repo across other remotes", () => {
    const entries = parseGitRemoteOutput([
      "upstream\thttps://dev.azure.com/orgA/projA/_git/repoA (fetch)",
      "upstream\thttps://dev.azure.com/orgA/projA/_git/repoA (push)",
      "mirror\tgit@ssh.dev.azure.com:v3/orgA/projA/repoA (fetch)",
      "github\tgit@github.com:user/repo.git (fetch)",
    ].join("\n"))

    const result = resolveAzureRepoFromRemotes(entries)
    expect(result).toEqual({
      organization: "orgA",
      project: "projA",
      repository: "repoA",
    })
  })

  test("when origin is non-Azure, accepts exactly one distinct Azure repo across other remotes", () => {
    const entries = parseGitRemoteOutput([
      "origin\tgit@github.com:user/repo.git (fetch)",
      "origin\tgit@github.com:user/repo.git (push)",
      "azure\thttps://dev.azure.com/orgA/projA/_git/repoA (fetch)",
    ].join("\n"))

    const result = resolveAzureRepoFromRemotes(entries)
    expect(result).toEqual({
      organization: "orgA",
      project: "projA",
      repository: "repoA",
    })
  })

  test("throws credential-free ambiguity error naming only remote names when multiple distinct Azure repos exist", () => {
    const entries = parseGitRemoteOutput([
      "upstream\thttps://dev.azure.com/orgA/projA/_git/repoA (fetch)",
      "azure-mirror\thttps://dev.azure.com/orgB/projB/_git/repoB (fetch)",
    ].join("\n"))

    expect(() => resolveAzureRepoFromRemotes(entries)).toThrow(
      "Ambiguous Azure DevOps repositories found across remotes: azure-mirror, upstream.",
    )
  })

  test("throws descriptive error when no Azure remotes are present", () => {
    const entries = parseGitRemoteOutput([
      "origin\tgit@github.com:user/repo.git (fetch)",
      "origin\tgit@github.com:user/repo.git (push)",
    ].join("\n"))

    expect(() => resolveAzureRepoFromRemotes(entries)).toThrow(
      "No supported Azure DevOps repository remote was found for this workspace.",
    )
  })
})

describe("checkBranchIndexStatus probe", () => {
  const originalFetch = globalThis.fetch
  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  const sampleRepo: AzureRepoInfo = {
    organization: "contoso",
    project: "webApp",
    repository: "portal",
  }

  test("returns isIndexed true when branch facet contains requested branch", async () => {
    globalThis.fetch = (async () => {
      return new Response(
        JSON.stringify({
          facets: {
            Branch: [{ name: "refs/heads/main" }, { name: "feature/login" }],
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )
    }) as unknown as typeof fetch

    const status = await checkBranchIndexStatus(sampleRepo, "main", "fake-token")
    expect(status).toEqual({
      isIndexed: true,
      branch: "main",
      indexedBranches: ["main", "feature/login"],
    })
  })

  test("returns isIndexed false when branch facet does not contain requested branch (only this triggers default-branch fallback upstream)", async () => {
    globalThis.fetch = (async () => {
      return new Response(
        JSON.stringify({
          facets: {
            Branch: [{ name: "refs/heads/main" }],
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )
    }) as unknown as typeof fetch

    const status = await checkBranchIndexStatus(sampleRepo, "feature/unindexed", "fake-token")
    expect(status).toEqual({
      isIndexed: false,
      branch: "feature/unindexed",
      indexedBranches: ["main"],
    })
  })

  test("throws error without credential leakage on HTTP 401/403 auth failure", async () => {
    globalThis.fetch = (async () => {
      return new Response("Secret body with sensitive data", { status: 401 })
    }) as unknown as typeof fetch

    await expect(
      checkBranchIndexStatus(sampleRepo, "main", "secret-token-123"),
    ).rejects.toThrow("Branch index status check authentication failed with HTTP 401.")
  })

  test("throws error without response body on non-2xx status", async () => {
    globalThis.fetch = (async () => {
      return new Response("Internal server error: raw dump", { status: 500 })
    }) as unknown as typeof fetch

    await expect(
      checkBranchIndexStatus(sampleRepo, "main", "fake-token"),
    ).rejects.toThrow("Branch index status check failed with HTTP 500.")
  })

  test("throws error on malformed JSON response", async () => {
    globalThis.fetch = (async () => {
      return new Response("not-valid-json", { status: 200 })
    }) as unknown as typeof fetch

    await expect(
      checkBranchIndexStatus(sampleRepo, "main", "fake-token"),
    ).rejects.toThrow("Branch index status check returned malformed JSON.")
  })

  test("throws on missing facets", async () => {
    globalThis.fetch = (async () => {
      return new Response(JSON.stringify({ count: 0 }), { status: 200 })
    }) as unknown as typeof fetch

    await expect(
      checkBranchIndexStatus(sampleRepo, "main", "fake-token"),
    ).rejects.toThrow("Branch index status check returned an invalid response shape.")
  })

  test("throws on wrong-shaped facets", async () => {
    globalThis.fetch = (async () => {
      return new Response(JSON.stringify({ facets: "not-an-object" }), { status: 200 })
    }) as unknown as typeof fetch

    await expect(
      checkBranchIndexStatus(sampleRepo, "main", "fake-token"),
    ).rejects.toThrow("Branch index status check returned an invalid response shape.")
  })

  test("throws on missing facets.Branch", async () => {
    globalThis.fetch = (async () => {
      return new Response(JSON.stringify({ facets: {} }), { status: 200 })
    }) as unknown as typeof fetch

    await expect(
      checkBranchIndexStatus(sampleRepo, "main", "fake-token"),
    ).rejects.toThrow("Branch index status check returned an invalid response shape.")
  })

  test("throws on wrong-shaped facets.Branch (not an array)", async () => {
    globalThis.fetch = (async () => {
      return new Response(
        JSON.stringify({ facets: { Branch: { name: "main" } } }),
        { status: 200 },
      )
    }) as unknown as typeof fetch

    await expect(
      checkBranchIndexStatus(sampleRepo, "main", "fake-token"),
    ).rejects.toThrow("Branch index status check returned an invalid response shape.")
  })

  test("throws on malformed branch rows", async () => {
    globalThis.fetch = (async () => {
      return new Response(
        JSON.stringify({ facets: { Branch: ["not-an-object"] } }),
        { status: 200 },
      )
    }) as unknown as typeof fetch

    await expect(
      checkBranchIndexStatus(sampleRepo, "main", "fake-token"),
    ).rejects.toThrow("Branch index status check returned an invalid response shape.")
  })

  test("throws on empty branch names", async () => {
    globalThis.fetch = (async () => {
      return new Response(
        JSON.stringify({ facets: { Branch: [{ name: "   " }] } }),
        { status: 200 },
      )
    }) as unknown as typeof fetch

    await expect(
      checkBranchIndexStatus(sampleRepo, "main", "fake-token"),
    ).rejects.toThrow("Branch index status check returned an invalid response shape.")
  })

  test("throws on caller cancellation signal", async () => {
    const controller = new AbortController()
    controller.abort(new Error("caller cancelled operation"))

    await expect(
      checkBranchIndexStatus(sampleRepo, "main", "fake-token", controller.signal),
    ).rejects.toThrow("caller cancelled operation")
  })

  test("distinguishes caller cancellation from malformed JSON when the abort fires mid-body-read", async () => {
    const controller = new AbortController()
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      const signal = init?.signal
      return new Response(
        new ReadableStream<Uint8Array>({
          start(streamController) {
            const onAbort = () => {
              streamController.error(
                signal?.reason ?? new Error("aborted"),
              )
            }
            if (signal?.aborted) {
              onAbort()
              return
            }
            signal?.addEventListener("abort", onAbort, { once: true })
          },
        }),
        { status: 200 },
      )
    }) as unknown as typeof fetch

    const pending = checkBranchIndexStatus(sampleRepo, "main", "fake-token", controller.signal)
    controller.abort(new Error("caller cancelled mid-read"))

    await expect(pending).rejects.toThrow("caller cancelled mid-read")
  })
})
