import { describe, expect, test } from "bun:test"

import {
  OPERATOR_DENIED_TOOLS,
  OPERATOR_KEPT_TOOLS,
  OPERATOR_MODE_BANNER,
  assertShapingInstalled,
  bashMutationReason,
  operatorPreToolUse,
  shouldDenyOperatorTool,
} from "~/lib/first-mate/operator-shaping"

describe("capability shaping — config assertions", () => {
  test("the deny list is exactly the file-authoring tools", () => {
    expect([...OPERATOR_DENIED_TOOLS].sort()).toEqual(["Edit", "NotebookEdit", "Write"])
  })

  test("delegation + read-only tools are preserved", () => {
    expect(OPERATOR_KEPT_TOOLS).toContain("Agent")
    expect(OPERATOR_KEPT_TOOLS).toContain("Bash") // read-only gh
    expect(OPERATOR_KEPT_TOOLS.some((t) => t.startsWith("mcp__first-mate__"))).toBe(true)
  })

  test("in operator mode: file-authoring + local workers are denied", () => {
    expect(shouldDenyOperatorTool("Edit", true)).toBe(true)
    expect(shouldDenyOperatorTool("Write", true)).toBe(true)
    expect(shouldDenyOperatorTool("NotebookEdit", true)).toBe(true)
    expect(shouldDenyOperatorTool("mcp__workers__implement", true)).toBe(true)
    expect(shouldDenyOperatorTool("mcp__workers__review", true)).toBe(true)
  })

  test("in operator mode: delegation + read-only remain allowed", () => {
    expect(shouldDenyOperatorTool("Agent", true)).toBe(false)
    expect(shouldDenyOperatorTool("Bash", true)).toBe(false)
    expect(shouldDenyOperatorTool("Read", true)).toBe(false)
    expect(shouldDenyOperatorTool("mcp__first-mate__advance", true)).toBe(false)
  })

  test("NON-operator sessions are entirely unaffected", () => {
    expect(shouldDenyOperatorTool("Edit", false)).toBe(false)
    expect(shouldDenyOperatorTool("mcp__workers__implement", false)).toBe(false)
  })

  test("PreToolUse decision blocks with an actionable reason", () => {
    const d = operatorPreToolUse("Write", true)
    expect(d.block).toBe(true)
    expect(d.reason).toContain("cloud-agent operator mode")
    expect(operatorPreToolUse("Bash", true, { command: "gh pr view 42" }).block).toBe(false)
  })

  test("B1: read-only Bash allowed, file-mutating Bash blocked", () => {
    const ok = (c: string): boolean => operatorPreToolUse("Bash", true, { command: c }).block
    // Allowed: read-only gh + inspection, including the discard idiom.
    expect(ok("gh pr view 42")).toBe(false)
    expect(ok("gh pr list --json number 2>/dev/null")).toBe(false)
    expect(ok("cat package.json | jq .name 2>&1")).toBe(false)
    expect(ok("rg -n TODO src")).toBe(false)
    // Blocked: the file-mutation vectors.
    expect(ok("echo x > f")).toBe(true)
    expect(ok("echo x >> f")).toBe(true)
    expect(ok("printf hi | tee out.txt")).toBe(true)
    expect(ok("sed -i 's/a/b/' file.ts")).toBe(true)
    expect(ok("dd if=/dev/zero of=f bs=1 count=1")).toBe(true)
    expect(ok("patch -p1 < change.diff")).toBe(true)
    expect(ok("git commit -am wip")).toBe(true)
    expect(ok("git checkout -- src/x.ts")).toBe(true)
    expect(ok("git apply change.diff")).toBe(true)
  })

  test("B1: a Bash call with no inspectable command fails CLOSED", () => {
    expect(operatorPreToolUse("Bash", true, {}).block).toBe(true)
    expect(operatorPreToolUse("Bash", true).block).toBe(true)
    expect(operatorPreToolUse("Bash", true, { command: "" }).block).toBe(true)
    // Non-operator sessions never block Bash.
    expect(operatorPreToolUse("Bash", false, {}).block).toBe(false)
  })

  test("B1: bashMutationReason pinpoints the vector", () => {
    expect(bashMutationReason("gh pr view 2>/dev/null")).toBeUndefined()
    expect(bashMutationReason("echo x > f")).toContain("redirection")
    expect(bashMutationReason("git push origin main")).toContain("git")
  })

  test("the mode banner names the boundary", () => {
    expect(OPERATOR_MODE_BANNER).toContain("cloud-agent operator")
    expect(OPERATOR_MODE_BANNER).toContain("do NOT hand-code")
  })

  test("#M4: fail-CLOSED — agents mode with failed injection aborts; other cases pass", () => {
    // Guard could not be installed in operator mode → must throw (abort launch).
    expect(() => assertShapingInstalled(true, false)).toThrow(/unshaded/)
    // Installed, or non-operator session → no throw.
    expect(() => assertShapingInstalled(true, true)).not.toThrow()
    expect(() => assertShapingInstalled(false, false)).not.toThrow()
  })
})
