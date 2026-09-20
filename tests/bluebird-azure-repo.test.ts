import { describe, expect, test } from "bun:test"

import { parseAzureRepo } from "../src/lib/azure-repo"

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
