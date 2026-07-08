import { afterEach, describe, expect, it } from "bun:test"

import { composeCloudCliChildEnv } from "~/lib/serve/cloudcli"

// Security regression: the CloudCLI child env (inherited by its browser
// terminal and every spawned claude) must NEVER carry these secrets. Auth
// rides the synthetic .credentials.json file in CLAUDE_CONFIG_DIR instead.
const SECRETS = [
  "GITHUB_TOKEN",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "COPILOT_TOKEN",
  "GH_ROUTER_HOOK_NONCE",
  "GH_ROUTER_SOMETHING_SECRET",
]

describe("serve child env", () => {
  const saved: Record<string, string | undefined> = {}
  afterEach(() => {
    for (const k of SECRETS) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
  })

  it("strips all router/copilot secrets while keeping the Anthropic vars", () => {
    for (const k of SECRETS) {
      saved[k] = process.env[k]
      process.env[k] = "SUPER-SECRET"
    }

    const env = composeCloudCliChildEnv({
      ANTHROPIC_BASE_URL: "http://127.0.0.1:12345",
      CLAUDE_CONFIG_DIR: "/router/config",
      ANTHROPIC_MODEL: "claude-opus-4-8",
    })

    for (const k of SECRETS) {
      expect(env[k]).toBeUndefined()
    }
    // An arbitrary non-allowlisted key must also be dropped — proves this is a
    // fail-closed ALLOWLIST, not a denylist that only catches known names.
    process.env.BOGUS_TEST_KEY_ZZZ = "leak-me"
    try {
      const env2 = composeCloudCliChildEnv({ ANTHROPIC_BASE_URL: "http://x" })
      expect(env2.BOGUS_TEST_KEY_ZZZ).toBeUndefined()
    } finally {
      delete process.env.BOGUS_TEST_KEY_ZZZ
    }
    // the non-secret wiring the spawned claude needs is present
    expect(env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:12345")
    expect(env.CLAUDE_CONFIG_DIR).toBe("/router/config")
    // and the child still has a usable PATH
    expect(env.PATH ?? env.Path).toBeDefined()
  })
})
