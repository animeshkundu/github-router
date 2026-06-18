/**
 * Tests for the ai-or-die session-bind hook glue. The hook is side-effect-only:
 * it must scope to the top-level session (skip subagent/teammate payloads), map
 * the event correctly, and tolerate junk — and AIORDIE_CLAUDE_BIND must be
 * stripped from the spawned child's env so a nested launch can't hijack the tab.
 */

import { describe, expect, test } from "bun:test"

import { decodeSessionBind } from "../src/internal-session-bind"
import { sanitizeParentEnv } from "../src/lib/launch"
import { buildSessionBindHookCommand } from "../src/lib/orchestration/stop-gate-hook"

describe("decodeSessionBind", () => {
  test("SessionStart → event:start record with id + transcript + source", () => {
    const rec = decodeSessionBind(
      JSON.stringify({
        hook_event_name: "SessionStart",
        session_id: "abc-123",
        transcript_path: "/no/such/dir/abc-123.jsonl", // realpath falls back to raw
        cwd: "/work/proj",
        source: "resume",
      }),
    )
    expect(rec).not.toBeNull()
    expect(rec!.schema).toBe(1)
    expect(rec!.claudeSessionId).toBe("abc-123")
    expect(rec!.event).toBe("start")
    expect(rec!.source).toBe("resume")
    expect(rec!.cwd).toBe("/work/proj")
    expect(typeof rec!.transcriptPath).toBe("string")
    expect(typeof rec!.at).toBe("number")
  })

  test("SessionEnd → event:end record with reason, no source", () => {
    const rec = decodeSessionBind(
      JSON.stringify({ hook_event_name: "SessionEnd", session_id: "x", reason: "clear" }),
    )
    expect(rec!.event).toBe("end")
    expect(rec!.reason).toBe("clear")
    expect(rec!.source).toBeUndefined()
  })

  test("subagent/teammate payload (agent_id) is skipped → null", () => {
    expect(
      decodeSessionBind(
        JSON.stringify({ hook_event_name: "SessionStart", session_id: "x", agent_id: "sub-1" }),
      ),
    ).toBeNull()
  })

  test("teammate payload (agent_type) is skipped → null", () => {
    expect(
      decodeSessionBind(
        JSON.stringify({ hook_event_name: "SessionStart", session_id: "x", agent_type: "Explore" }),
      ),
    ).toBeNull()
  })

  test("missing session_id → null", () => {
    expect(decodeSessionBind(JSON.stringify({ hook_event_name: "SessionStart" }))).toBeNull()
  })

  test("non-JSON stdin → null (tolerated)", () => {
    expect(decodeSessionBind("not json at all")).toBeNull()
    expect(decodeSessionBind("")).toBeNull()
  })
})

describe("buildSessionBindHookCommand", () => {
  test("bakes the --out path (quoted) and the subcommand into the command", () => {
    const cmd = buildSessionBindHookCommand("/usr/bin/node", "/app/dist/main.js", "/data/binds/s1.json")
    expect(cmd).toBe('"/usr/bin/node" "/app/dist/main.js" internal-session-bind --out "/data/binds/s1.json"')
  })

  test("collapses to a single token when script === exec (packaged build)", () => {
    const cmd = buildSessionBindHookCommand("/opt/gr", "/opt/gr", "C:\\data\\s.json")
    expect(cmd).toBe('"/opt/gr" internal-session-bind --out "C:\\data\\s.json"')
  })

  test("double-quotes a Windows path with spaces (backslashes stay literal for cmd/pwsh)", () => {
    const cmd = buildSessionBindHookCommand(
      "C:\\Program Files\\nodejs\\node.exe",
      "C:\\Users\\Some User\\app\\dist\\main.js",
      "C:\\Users\\Some User\\.ai-or-die\\claude-bindings\\tab-1.json",
    )
    expect(cmd).toBe(
      '"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\Some User\\app\\dist\\main.js"'
      + ' internal-session-bind --out "C:\\Users\\Some User\\.ai-or-die\\claude-bindings\\tab-1.json"',
    )
  })
})

describe("sanitizeParentEnv strips AIORDIE_CLAUDE_BIND", () => {
  test("the bind handshake var never reaches the spawned child", () => {
    const out = sanitizeParentEnv({
      AIORDIE_CLAUDE_BIND: "/data/binds/s1.json",
      PATH: "/usr/bin",
    } as NodeJS.ProcessEnv)
    expect(out.AIORDIE_CLAUDE_BIND).toBeUndefined()
    expect(out.PATH).toBe("/usr/bin")
  })
})
