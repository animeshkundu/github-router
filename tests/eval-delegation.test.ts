import { afterEach, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import {
  isolatedArmConfig,
  reportableArm,
} from "../scripts/eval-delegation"

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("isolatedArmConfig gives each arm separate scrubbed state", () => {
  const source = fs.mkdtempSync(path.join(os.tmpdir(), "delegation-source-"))
  tempDirs.push(source)
  fs.writeFileSync(path.join(source, "settings.json"), JSON.stringify({
    env: {
      CLAUDE_CODE_COORDINATOR_MODE: "1",
      CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1",
      KEEP_ME: "yes",
    },
    permissions: { allow: ["Read"] },
  }))
  fs.writeFileSync(path.join(source, ".credentials.json"), "sensitive")
  fs.mkdirSync(path.join(source, "sessions"))
  fs.writeFileSync(path.join(source, "sessions", "state.json"), "mutable")
  fs.mkdirSync(path.join(source, "agents"))
  fs.writeFileSync(path.join(source, "agents", "custom.md"), "kept")

  const armA = isolatedArmConfig(source, true)
  const armB = isolatedArmConfig(source, true)
  tempDirs.push(armA.cleanupDir!, armB.cleanupDir!)

  expect(armA.homeDir).not.toBe(armB.homeDir)
  expect(armA.configDir).not.toBe(armB.configDir)
  expect(armA.configDir).toBe(path.join(armA.homeDir!, ".claude"))
  const settings = JSON.parse(
    fs.readFileSync(path.join(armA.configDir!, "settings.json"), "utf8"),
  )
  expect(settings.env).toEqual({ KEEP_ME: "yes" })
  expect(settings.permissions).toEqual({ allow: ["Read"] })
  expect(fs.existsSync(path.join(armA.configDir!, ".credentials.json"))).toBe(false)
  expect(fs.existsSync(path.join(armA.configDir!, "sessions"))).toBe(false)
  expect(fs.readFileSync(path.join(armA.configDir!, "agents", "custom.md"), "utf8")).toBe("kept")
})

test("isolatedArmConfig rejects a missing explicit source", () => {
  const missing = path.join(os.tmpdir(), `missing-delegation-config-${Date.now()}`)
  expect(() => isolatedArmConfig(missing, false)).toThrow(
    `arm CLAUDE_CONFIG_DIR does not exist: ${missing}`,
  )
})

test("reportableArm omits credentials and unrelated environment", () => {
  const base = {
    name: "A" as const,
    revision: "baseline",
    env: {
      ANTHROPIC_BASE_URL: "http://127.0.0.1:8787",
      CLAUDE_CONFIG_DIR: "C:/tmp/arm-a/.claude",
      GH_TOKEN: "secret-token",
      ANTHROPIC_AUTH_TOKEN: "delegation-eval",
    },
  }
  const report = reportableArm({
    ...base,
    command: ["github-router", "claude", "--github-token=inline-secret", "-g", "split-secret", "--model", "max", "--"],
  })
  expect(report).toEqual({
    name: "A",
    command: ["github-router", "claude", "--github-token=[REDACTED]", "-g", "[REDACTED]", "--model", "max", "--"],
    revision: "baseline",
    baseUrl: "http://127.0.0.1:8787",
    configDir: "C:/tmp/arm-a/.claude",
  })
  expect(JSON.stringify(report)).not.toContain("inline-secret")
  expect(JSON.stringify(report)).not.toContain("split-secret")
  expect(JSON.stringify(report)).not.toContain("secret-token")
})
