import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import fs from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

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

  test("in operator mode: local orchestrate is denied (drives worker-implement backend)", () => {
    // decompose/run_workflow route to the LOCAL worker-implement backend, which
    // makes local file writes — they must be denied in operator mode alongside
    // the raw worker tools.
    expect(shouldDenyOperatorTool("mcp__orchestrate__run_workflow", true)).toBe(true)
    expect(shouldDenyOperatorTool("mcp__orchestrate__decompose", true)).toBe(true)
    expect(operatorPreToolUse("mcp__orchestrate__run_workflow", true).block).toBe(true)
    // Non-operator sessions are unaffected.
    expect(shouldDenyOperatorTool("mcp__orchestrate__run_workflow", false)).toBe(false)
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
    // ATTACHED short form: git parses `-ccore.sshCommand=…` as `-c core.…`, so a
    // no-space `-c<key=value>` token is the same config-injection RCE and must NOT
    // slip through as a "lone global flag".
    expect(ok("git -ccore.sshCommand='sh -c \"touch x\"' ls-remote origin")).toBe(true)
    expect(ok("git -ccore.pager=cat show HEAD")).toBe(true)
    // `-C <dir>` (capital, the allowed dir flag) is distinct and stays allowed.
    expect(ok("git -C /tmp/repo log")).toBe(false)
    // --exec-path / -O (open-files-in-pager) are exec vectors; --output writes.
    expect(ok("git --exec-path=/tmp/evil log")).toBe(true)
    expect(ok("git grep -O foo")).toBe(true)
    expect(ok("git log --output=/tmp/x")).toBe(true)
    // FIX 5: --config-env is the same config-injection RCE as -c, sourced from an
    // env var — blocked in BOTH the `=`-attached and space-separated forms, and
    // the `--config-env=` token must NOT be waved through as a self-contained flag.
    expect(ok("git --config-env=core.sshCommand=EVIL ls-remote origin")).toBe(true)
    expect(ok("git --config-env core.sshCommand=EVIL log")).toBe(true)
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

describe("operator plans/memory Write exemption", () => {
  const CONFIG = path.resolve(path.sep === "\\" ? "C:\\gh-cfg" : "/gh-cfg")
  const prior = process.env.CLAUDE_CONFIG_DIR
  beforeEach(() => {
    process.env.CLAUDE_CONFIG_DIR = CONFIG
  })
  afterEach(() => {
    if (prior === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = prior
  })
  const blocked = (tool: string, input: Record<string, unknown>): boolean =>
    operatorPreToolUse(tool, true, input).block

  test("Write/Edit/NotebookEdit INTO the exempt shapes are ALLOWED", () => {
    // <CFG>/plans/**
    expect(blocked("Write", { file_path: path.join(CONFIG, "plans", "todo.md") })).toBe(false)
    expect(blocked("Edit", { file_path: path.join(CONFIG, "plans", "sub", "deep.md") })).toBe(false)
    // The REAL per-project memory + plans dirs: <CFG>/projects/<slug>/{memory,plans}/**
    expect(blocked("Write", { file_path: path.join(CONFIG, "projects", "my-proj", "memory", "notes.md") })).toBe(false)
    expect(blocked("Edit", { file_path: path.join(CONFIG, "projects", "my-proj", "memory", "sub", "deep.md") })).toBe(false)
    expect(blocked("NotebookEdit", { notebook_path: path.join(CONFIG, "projects", "p", "plans", "nb.ipynb") })).toBe(false)
    // shouldDenyOperatorTool agrees when handed the same input.
    expect(shouldDenyOperatorTool("Write", true, { file_path: path.join(CONFIG, "plans", "x.md") })).toBe(false)
  })

  test("Write anywhere ELSE is still BLOCKED", () => {
    expect(blocked("Write", { file_path: path.join(CONFIG, "other", "x.ts") })).toBe(true)
    expect(blocked("Write", { file_path: path.resolve(path.sep === "\\" ? "C:\\repo\\src\\x.ts" : "/repo/src/x.ts") })).toBe(true)
    // A TOP-LEVEL memory/ is NO LONGER exempt — the real memory lives at
    // projects/<slug>/memory (tightened exemption).
    expect(blocked("Write", { file_path: path.join(CONFIG, "memory", "notes.md") })).toBe(true)
    // A sibling dir whose name merely starts with the allowed prefix must NOT match.
    expect(blocked("Write", { file_path: path.join(CONFIG, "plansX", "x.md") })).toBe(true)
    // The dirs themselves are not writable file targets.
    expect(blocked("Write", { file_path: path.join(CONFIG, "plans") })).toBe(true)
    expect(blocked("Write", { file_path: path.join(CONFIG, "projects", "p", "memory") })).toBe(true)
    // projects/<slug>/<other> (a non-plans/memory subdir) is blocked.
    expect(blocked("Write", { file_path: path.join(CONFIG, "projects", "p", "src", "x.ts") })).toBe(true)
    // projects/<slug> requires a deeper plans|memory segment; projects/<slug>/plans
    // needs a slug (single segment) — projects/plans/x is NOT projects/<slug>/plans.
    expect(blocked("Write", { file_path: path.join(CONFIG, "projects", "plans") })).toBe(true)
    // A PRODUCT file whose path merely CONTAINS a plans/ segment but lives OUTSIDE
    // CLAUDE_CONFIG_DIR stays blocked (the exemption is not "any plans/ segment").
    expect(
      blocked("Write", { file_path: path.resolve(path.sep === "\\" ? "C:\\repo\\src\\plans\\x.ts" : "/repo/src/plans/x.ts") }),
    ).toBe(true)
  })

  test("fail-CLOSED: missing/empty path, unset or non-absolute CLAUDE_CONFIG_DIR, and ../ escape", () => {
    // No target path at all.
    expect(blocked("Write", {})).toBe(true)
    expect(blocked("Write", { file_path: "" })).toBe(true)
    expect(blocked("NotebookEdit", { file_path: path.join(CONFIG, "plans", "x.md") })).toBe(true) // wrong key
    // A ../ escape out of the allowed dir resolves outside → blocked.
    expect(blocked("Write", { file_path: path.join(CONFIG, "plans", "..", "..", "escape.ts") })).toBe(true)
    // Unset CLAUDE_CONFIG_DIR → cannot prove containment → blocked.
    delete process.env.CLAUDE_CONFIG_DIR
    expect(blocked("Write", { file_path: path.join(CONFIG, "plans", "x.md") })).toBe(true)
    // Non-absolute CLAUDE_CONFIG_DIR → blocked.
    process.env.CLAUDE_CONFIG_DIR = "relative/cfg"
    expect(blocked("Write", { file_path: "relative/cfg/plans/x.md" })).toBe(true)
  })

  test("workers + Bash behavior is unchanged by the exemption", () => {
    expect(blocked("mcp__workers__implement", {})).toBe(true)
    expect(operatorPreToolUse("Bash", true, { command: "gh pr view 42" }).block).toBe(false)
    expect(operatorPreToolUse("Bash", true, { command: "echo x > f" }).block).toBe(true)
  })
})

describe("#6 operator exemption — symlink escape (real fs)", () => {
  const prior = process.env.CLAUDE_CONFIG_DIR
  afterEach(() => {
    if (prior === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = prior
  })

  test("a plans/ symlink escaping the config dir is BLOCKED (realpath containment)", async () => {
    const base = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), "op-exempt-")))
    try {
      const cfg = path.join(base, "cfg")
      const outside = path.join(base, "outside")
      await fs.mkdir(cfg, { recursive: true })
      await fs.mkdir(outside, { recursive: true })
      // cfg/plans -> outside : the scratch dir is symlinked OUT of the sandbox.
      await fs.symlink(outside, path.join(cfg, "plans"), "dir")
      process.env.CLAUDE_CONFIG_DIR = cfg
      // A write "into" cfg/plans actually lands in outside/ → NOT exempt.
      expect(operatorPreToolUse("Write", true, { file_path: path.join(cfg, "plans", "x.md") }).block).toBe(true)
      // A REAL (non-symlinked) plans dir under the same cfg IS exempt (control).
      await fs.mkdir(path.join(cfg, "realcfg", "plans"), { recursive: true })
      process.env.CLAUDE_CONFIG_DIR = path.join(cfg, "realcfg")
      expect(
        operatorPreToolUse("Write", true, { file_path: path.join(cfg, "realcfg", "plans", "x.md") }).block,
      ).toBe(false)
    } finally {
      await fs.rm(base, { recursive: true, force: true })
    }
  })
})

describe("#7 process-substitution false-positive fix + #11 control-flow guide-not-cripple", () => {
  const ok = (c: string): boolean => operatorPreToolUse("Bash", true, { command: c }).block

  test("#7: single-quoted proc-sub metachars pass; active $()/backticks are still caught", () => {
    // `>(` / `<(` / `$(` inside a SINGLE-quoted regex arg is inert → allowed.
    expect(ok("grep '>(' file")).toBe(false)
    expect(ok("rg 'a>(b)' src")).toBe(false)
    expect(ok("grep '<(x)' file")).toBe(false)
    expect(ok("rg '$(id)' file")).toBe(false)
    // Backslash-escaped metachars are inert too.
    expect(ok("grep '\\$(id)' file")).toBe(false)
    // Active substitution inside DOUBLE quotes / unquoted is still blocked.
    expect(ok('echo "$(rm f)"')).toBe(true)
    expect(ok("cat <(rm f)")).toBe(true)
    expect(ok("echo `id`")).toBe(true)
    expect(bashDenyReason("grep '>(' file")).toBeUndefined()
    expect(bashDenyReason('echo "$(rm f)"')).toContain("substitution")
    expect(bashDenyReason("cat <(rm f)")).toContain("substitution")
  })

  test("#11: read-only control-flow is ALLOWED with a steering reminder", () => {
    const d = operatorPreToolUse("Bash", true, { command: "for f in a b; do gh pr view $f; done" })
    expect(d.block).toBe(false)
    expect(d.additionalContext).toBeDefined()
    expect(d.additionalContext).toContain("control-flow")
    // A read-only if/then that only inspects is allowed (with reminder).
    const d2 = operatorPreToolUse("Bash", true, { command: "if grep -q x f; then cat f; fi" })
    expect(d2.block).toBe(false)
    expect(d2.additionalContext).toBeDefined()
    // A brace group of read-only commands.
    expect(ok("{ gh pr view 1; cat f; }")).toBe(false)
    // A while loop over a read-only body.
    expect(ok("while true; do git status; done")).toBe(false)
  })

  test("#11: control-flow hiding a write/exec is BLOCKED (exec-escape floor)", () => {
    expect(ok('for f in *; do rm "$f"; done')).toBe(true)
    expect(ok("if grep -q x f; then git commit -am y; fi")).toBe(true)
    expect(ok('eval "$x"')).toBe(true)
    expect(ok("find . -exec rm {} \\;")).toBe(true)
    // ALWAYS-ON escape hatches, regardless of control-flow wrapping.
    expect(ok("while true; do sh -c 'rm x'; done")).toBe(true)
    expect(ok("bash -c 'rm x'")).toBe(true)
    expect(ok("$CMD arg")).toBe(true) // indirect exec via a variable command word
    expect(ok("for f in a; do npm install evil; done")).toBe(true)
    expect(ok("sed -i 's/a/b/' f")).toBe(true)
    // A hard-blocked control-flow command carries NO steering reminder.
    expect(
      operatorPreToolUse("Bash", true, { command: 'for f in *; do rm "$f"; done' }).additionalContext,
    ).toBeUndefined()
  })

  test("#7/#11: bypass hardening — line-continuation proc-sub + quoted keywords", () => {
    // A backslash-newline is a bash LINE CONTINUATION removed before parsing, so a
    // split `$\<nl>(` rejoins to an active `$(` and must still be caught.
    expect(ok("echo $\\\n(rm f)")).toBe(true)
    expect(ok('cat "$\\\n(rm x)"')).toBe(true)
    // A QUOTED reserved word is a command word, not a structural keyword — it must
    // NOT skip allowlist vetting (here `'for'`/`'case'` are non-allowlisted → block).
    expect(ok("'for' rm x")).toBe(true)
    expect(ok("'case' rm x")).toBe(true)
    // A bare `for` header is still structural (read-only body allowed w/ reminder).
    expect(ok("for f in a b; do gh pr view $f; done")).toBe(false)
  })
})
