import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const BLUEBIRD_TEST_FILES = [
  "bluebird-azure-repo.test.ts",
  "bluebird-client.test.ts",
  "bluebird-routing.test.ts",
]

/**
 * Keep automated Bluebird coverage hermetic and sanitized. Protocol tests use
 * injected clients or mocked fetch handlers at example.test; the real service
 * and the manually validated workspace belong only in explicit operator runs.
 */
describe("Bluebird automated-test isolation", () => {
  test("fixtures never name the live service or validation workspace", () => {
    for (const name of BLUEBIRD_TEST_FILES) {
      const source = readFileSync(path.join(HERE, name), "utf8").toLowerCase()
      expect(source).not.toContain("mcp.bluebird-ai.net")
      expect(source).not.toContain("teams-modular-packages")
      expect(source).not.toContain("domoreexp")
    }
  })
})
