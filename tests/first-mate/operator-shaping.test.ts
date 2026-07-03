import { describe, expect, test } from "bun:test"

import {
  OPERATOR_DENIED_TOOLS,
  OPERATOR_KEPT_TOOLS,
  OPERATOR_MODE_BANNER,
  assertShapingInstalled,
  bashDenyReason,
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

  test("B1 (allowlist): read-only Bash allowed, everything else blocked", () => {
    const ok = (c: string): boolean => operatorPreToolUse("Bash", true, { command: c }).block
    // Allowed: read-only gh + git + inspection, including the discard idiom.
    expect(ok("gh pr view 42")).toBe(false)
    expect(ok("gh pr list --json number 2>/dev/null")).toBe(false)
    expect(ok("gh -R o/n run list")).toBe(false)
    expect(ok("git log --oneline -5")).toBe(false)
    expect(ok("cat package.json | jq .name 2>&1")).toBe(false)
    expect(ok("rg -n TODO src")).toBe(false)
    expect(ok("ls -la && cat README.md")).toBe(false)
    // Blocked: the denylist-bypass vectors that a mutation-denylist missed.
    expect(ok("python -c \"open('f','w').write('x')\"")).toBe(true)
    expect(ok("node -e \"require('fs').writeFileSync('f','x')\"")).toBe(true)
    expect(ok("cp src/a.ts src/b.ts")).toBe(true)
    expect(ok("mv a b")).toBe(true)
    expect(ok("install -m 0755 a b")).toBe(true)
    expect(ok("touch newfile")).toBe(true)
    expect(ok("ln -s a b")).toBe(true)
    expect(ok("chmod +x script.sh")).toBe(true)
    expect(ok("printf hi | /usr/bin/tee out.txt")).toBe(true) // tee by absolute path
    expect(ok("printf hi | tee out.txt")).toBe(true)
    expect(ok("echo x > f")).toBe(true)
    expect(ok("echo x >> f")).toBe(true)
    expect(ok("sed -i 's/a/b/' file.ts")).toBe(true) // sed not allowlisted at all
    expect(ok("dd if=/dev/zero of=f bs=1 count=1")).toBe(true)
    expect(ok("patch -p1 < change.diff")).toBe(true)
    // Mutating git/gh subcommands.
    expect(ok("git commit -am wip")).toBe(true)
    expect(ok("git -c user.email=x@y.z commit -am wip")).toBe(true) // -c bypass closed
    expect(ok("git checkout -- src/x.ts")).toBe(true)
    expect(ok("git apply change.diff")).toBe(true)
    expect(ok("git push origin main")).toBe(true)
    expect(ok("gh pr merge 42")).toBe(true)
    expect(ok("gh api -X POST repos/o/n/issues")).toBe(true) // gh api fails closed
    // Substitution cannot be vetted → fail closed.
    expect(ok("cat $(echo f)")).toBe(true)
    expect(ok("echo `whoami`")).toBe(true)
  })

  test("B1: a Bash call with no inspectable command fails CLOSED", () => {
    expect(operatorPreToolUse("Bash", true, {}).block).toBe(true)
    expect(operatorPreToolUse("Bash", true).block).toBe(true)
    expect(operatorPreToolUse("Bash", true, { command: "" }).block).toBe(true)
    // Non-operator sessions never block Bash.
    expect(operatorPreToolUse("Bash", false, {}).block).toBe(false)
  })

  test("B1: bashDenyReason pinpoints the vector", () => {
    expect(bashDenyReason("gh pr view 2>/dev/null")).toBeUndefined()
    expect(bashDenyReason("git log")).toBeUndefined()
    expect(bashDenyReason("echo x > f")).toContain("redirection")
    expect(bashDenyReason("git push origin main")).toContain("git subcommand")
    expect(bashDenyReason("python -c 'x'")).toContain("allowlist")
    expect(bashDenyReason("echo `id`")).toContain("substitution")
  })

  test("B2: per-binary arg vetting blocks write/exec forms and legit reads still pass", () => {
    const ok = (c: string): boolean => operatorPreToolUse("Bash", true, { command: c }).block
    // BLOCKED: allowlisted binaries that grow a write/exec capability under a flag.
    expect(ok("yq -i '.a=1' f.yaml")).toBe(true)
    expect(ok("sort -o out.txt f.txt")).toBe(true)
    expect(ok("sort --output=out.txt f.txt")).toBe(true)
    expect(ok("sort -oout.txt f.txt")).toBe(true)
    expect(ok("find . -name '*.ts' -delete")).toBe(true)
    expect(ok("find . -type f -exec rm {} ;")).toBe(true)
    expect(ok("fd -x rm")).toBe(true)
    expect(ok("fd --exec-batch rm")).toBe(true)
    expect(ok("tree -o out.html")).toBe(true)
    expect(ok("xxd -r dump.hex")).toBe(true) // xxd dropped from the allowlist (writes a file)
    expect(ok("xxd f.bin out.bin")).toBe(true) // 2nd positional is an output file
    expect(ok("diff --output=patch a b")).toBe(true)
    // BLOCKED: mutating git that a subcommand/`--output`/reflog-action check catches.
    expect(ok("git symbolic-ref HEAD refs/heads/x")).toBe(true)
    expect(ok("git reflog expire --all --expire=now")).toBe(true)
    expect(ok("git diff --output=/tmp/x HEAD~1")).toBe(true)
    // ALLOWED: the legit read-only forms of the same binaries.
    expect(ok("rg 'a>b' file.txt")).toBe(false) // `>` inside a quoted arg is not a redirect
    expect(ok("echo {a,b}")).toBe(false) // brace expansion is one word
    expect(ok("gh status")).toBe(false) // single-token read-only gh action
    expect(ok("git log --oneline")).toBe(false)
    expect(ok("git reflog")).toBe(false)
    expect(ok("git reflog show")).toBe(false)
    expect(ok("git ls-files -o")).toBe(false) // `-o` (--others) is read-only for ls-files
    expect(ok("sort f.txt")).toBe(false)
    expect(ok("find . -name '*.ts'")).toBe(false)
    expect(ok("yq '.a' f.yaml")).toBe(false)
  })

  test("B2: /dev/null-prefix write, reflog write actions, and find -fprint0 fail closed", () => {
    const ok = (c: string): boolean => operatorPreToolUse("Bash", true, { command: c }).block
    // A path that merely BEGINS with /dev/null still writes a real file.
    expect(ok("cat x >/dev/null.log")).toBe(true)
    expect(ok("cat x >>/dev/null_backup")).toBe(true)
    // reflog is read-only ONLY for show/exists/bare; other actions fail closed.
    expect(ok("git reflog expire --all")).toBe(true)
    expect(ok("git reflog delete HEAD@{0}")).toBe(true)
    expect(ok("git reflog show")).toBe(false)
    expect(ok("git reflog exists refs/heads/main")).toBe(false)
    expect(ok("find . -fprint0 out")).toBe(true)
    // The genuine discard idiom is still allowed.
    expect(ok("gh pr view 42 2>/dev/null")).toBe(false)
    expect(ok("gh pr list 1>/dev/null 2>&1")).toBe(false)
  })

  test("B3: git config/exec injection, env command-hooks, and escaped-separator desync fail closed", () => {
    const ok = (c: string): boolean => operatorPreToolUse("Bash", true, { command: c }).block
    // git -c config-injection RCE (core.pager/sshCommand/fsmonitor run commands).
    expect(ok("git -c core.pager=cat show HEAD")).toBe(true)
    expect(ok("git -c core.sshCommand='touch x' log")).toBe(true)
    expect(ok("git -c core.fsmonitor='touch x' status")).toBe(true)
    // --exec-path / -O (open-files-in-pager) are exec vectors; --output writes.
    expect(ok("git --exec-path=/tmp/evil log")).toBe(true)
    expect(ok("git grep -O foo")).toBe(true)
    expect(ok("git log --output=/tmp/x")).toBe(true)
    // Leading env assignments that hook a command the read-only tool then runs.
    expect(ok("GIT_PAGER='touch x' git log")).toBe(true)
    expect(ok("LESSOPEN='|touch x %s' less f")).toBe(true)
    expect(ok("GIT_EXTERNAL_DIFF='touch x' git diff")).toBe(true)
    expect(ok("EDITOR=vim git log")).toBe(true)
    expect(ok("GIT_SSH_COMMAND='touch x' git log")).toBe(true)
    // Escaped separator must not desync the parser away from the real -exec.
    expect(ok("find . -type f -exec touch x \\;")).toBe(true)
    // A benign leading assignment before a read-only command still passes.
    expect(ok("LC_ALL=C git log")).toBe(false)
    expect(ok("GIT_DIR=.git git status")).toBe(false)
  })

  test("B3: legit reads with shell metacharacters inside quotes/braces are NOT over-blocked", () => {
    const ok = (c: string): boolean => operatorPreToolUse("Bash", true, { command: c }).block
    expect(ok("rg 'a->b' src")).toBe(false)
    expect(ok("grep \"=>\" f")).toBe(false)
    expect(ok("git log --grep='>'")).toBe(false)
    expect(ok("jq '.a>1' f.json")).toBe(false)
    expect(ok("cat src/{a,b}.ts")).toBe(false)
  })

  test("B2: bashDenyReason pinpoints the write/exec vector", () => {
    expect(bashDenyReason("yq -i '.a=1' f.yaml")).toContain("yq -i")
    expect(bashDenyReason("sort -o out f")).toContain("sort -o")
    expect(bashDenyReason("find . -delete")).toContain("find")
    expect(bashDenyReason("git symbolic-ref HEAD x")).toContain("symbolic-ref")
    expect(bashDenyReason("git reflog expire")).toContain("reflog")
    expect(bashDenyReason("git diff --output=/tmp/x")).toContain("--output")
    expect(bashDenyReason("rg 'a>b' file.txt")).toBeUndefined()
    expect(bashDenyReason("gh status")).toBeUndefined()
    expect(bashDenyReason("echo {a,b}")).toBeUndefined()
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
