import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(HERE, "..")

/**
 * Every automated suite that exercises the Azure-backed clients. The file name
 * still says Bluebird because that is where this guard started; the rule is
 * now the whole family, and a new client belongs in this list on the same
 * commit that adds its test.
 */
const AZURE_TEST_FILES = [
  "ado-client.test.ts",
  "azure-cli-token.test.ts",
  "azure-mcp-flags.test.ts",
  "bluebird-azure-repo.test.ts",
  "bluebird-client.test.ts",
  "bluebird-provision.test.ts",
  "bluebird-routing.test.ts",
  "kusto-client.test.ts",
  // Listed because it now names a cluster PER CALL, so it is a suite that
  // decides which host a request goes to, not just one that reads a response.
  "kusto-tools.test.ts",
]

/** The suites whose ENTIRE job is protocol traffic against a client. */
const CLIENT_TEST_FILES = ["ado-client.test.ts", "kusto-client.test.ts", "kusto-tools.test.ts"]

/** Names that are not derivable from source: the manually validated workspace. */
const FORBIDDEN_SUBSTRINGS = ["teams-modular-packages", "domoreexp"]

/**
 * Hosts a test may name. IANA-reserved labels only: `example.*` and the
 * `.test` / `.invalid` TLDs can never resolve to a real service, so a fixture
 * that could reach one is unrepresentable rather than merely discouraged.
 */
const ALLOWED_HOST_RE = /(^|\.)example(\.|$)|\.test$|\.invalid$/

function read(...parts: Array<string>): string {
  return readFileSync(path.join(ROOT, ...parts), "utf8")
}

/**
 * The live endpoint of every router-owned Azure client, read OUT of the client
 * source rather than transcribed here. A guard that hardcodes
 * `mcp.dev.azure.com` stops guarding the moment that constant moves; this one
 * follows it.
 */
function liveEndpoints(): Array<{ label: string; value: string }> {
  const found: Array<{ label: string; value: string }> = []
  for (const file of ["src/lib/ado-client.ts", "src/lib/bluebird-client.ts"]) {
    const text = read(file)
    for (const match of text.matchAll(/^(?:export )?const ([A-Z_]*(?:HOST|URL)[A-Z_]*) = "(https:[^"]+)"/gm)) {
      if (match[1] && match[2]) found.push({ label: `${file}:${match[1]}`, value: match[2] })
    }
  }
  return found
}

function hostLiterals(text: string): Array<string> {
  const hosts = new Set<string>()
  // The authority runs to the first `/`, quote, or whitespace. Userinfo is
  // then stripped: `https://user:pass@host` is a fixture about credential
  // rejection, and its host is the part after the `@`, not the part before it.
  for (const match of text.matchAll(/https:\/\/([^\s"'`/<>]+)/g)) {
    const authority = match[1]
    if (!authority) continue
    const host = authority.split("@").pop()?.split(":").shift()
    if (host) hosts.add(host.toLowerCase())
  }
  return [...hosts]
}

/**
 * Keep automated Azure coverage hermetic and sanitized. Protocol tests use
 * injected clients, mocked fetch handlers, and reserved host names; the real
 * services and the manually validated workspace belong only in explicit
 * operator runs. This is the `docs/bluebird-search.md` testing policy applied
 * to every client that mints an Azure token.
 */
describe("Azure automated-test isolation", () => {
  test("fixtures never name a live client endpoint", () => {
    const endpoints = liveEndpoints()
    // A refactor that renamed every constant would otherwise make this vacuous.
    expect(endpoints.length).toBeGreaterThanOrEqual(2)
    const violations: Array<string> = []
    for (const name of AZURE_TEST_FILES) {
      const text = read("tests", name)
      for (const endpoint of endpoints) {
        if (text.includes(endpoint.value)) violations.push(`${name} names ${endpoint.label}`)
      }
    }
    expect(violations).toEqual([])
  })

  test("fixtures never name the manually validated workspace", () => {
    const violations: Array<string> = []
    for (const name of AZURE_TEST_FILES) {
      const text = read("tests", name).toLowerCase()
      for (const forbidden of FORBIDDEN_SUBSTRINGS) {
        if (text.includes(forbidden)) violations.push(`${name}: ${forbidden}`)
      }
    }
    expect(violations).toEqual([])
  })

  test("the client suites address only documentation-reserved hosts", () => {
    // Scoped deliberately: the Azure-repo suite holds git-remote FIXTURE
    // strings (`dev.azure.com`, `github.com`) that no test ever fetches, and a
    // regex over raw text cannot tell those apart from an endpoint. The claim
    // here is the narrower one a regex can actually prove: the suites that
    // build a client and issue requests name only hosts that cannot resolve.
    const violations: Array<string> = []
    for (const name of CLIENT_TEST_FILES) {
      const hosts = hostLiterals(read("tests", name))
      // Not vacuous: a suite that stopped naming any host would pass the loop
      // below while proving nothing.
      expect(`${name} names a host: ${hosts.length > 0}`).toBe(`${name} names a host: true`)
      for (const host of hosts) {
        if (!ALLOWED_HOST_RE.test(host)) violations.push(`${name}: ${host}`)
      }
    }
    expect(violations).toEqual([])
  })
})
