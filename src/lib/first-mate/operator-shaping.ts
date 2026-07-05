/**
 * Capability shaping for github-router operator/`--agents` mode.
 *
 * When first-mate/operator mode is active the spawned Claude is the cloud-agent
 * OPERATOR, not an implementer: it must delegate ALL implementation to GitHub
 * cloud agents (and may use subagents/first-mate to orchestrate), but it must
 * not hand-code. Because the launcher spawns `claude --dangerously-skip-permissions`
 * (which ignores settings `permissions.deny`), enforcement is a PreToolUse hook
 * that fires regardless and BLOCKS the file-authoring + local-worker vectors.
 *
 * Kept available: Agent (subagents/forks), the first-mate MCP, read-only `gh`
 * via Bash, and read/search tools. Dropped: Edit/Write/NotebookEdit and
 * mcp__workers__* (local implementation agents). Gated: only in operator mode;
 * a normal session is untouched.
 *
 * ONE exemption to the file-authoring block: the operator may Write/Edit/
 * NotebookEdit its OWN plans/memory scratch files (planning notes, durable
 * memory). Those are the operator's own working state, NOT product code, so
 * authoring them is not "hand-coding". The exemption is scoped to the EXACT
 * shapes `CLAUDE_CONFIG_DIR/plans/**`, `CLAUDE_CONFIG_DIR/projects/<slug>/plans/**`
 * and `CLAUDE_CONFIG_DIR/projects/<slug>/memory/**` (the real per-project memory
 * lives at `projects/<slug>/memory`, NOT a top-level `memory/`), matched against
 * symlink-resolved absolute paths, and FAIL-CLOSED: anything we cannot prove
 * lands strictly inside one of those shapes stays blocked (see
 * `operatorWritePathAllowed`).
 */

import fs from "node:fs"
import path from "node:path"

/** Tools denied to the operator (exact names + the workers/orchestrate MCP prefixes). */
export const OPERATOR_DENIED_TOOLS = ["Edit", "Write", "NotebookEdit"] as const
export const OPERATOR_DENIED_MCP_PREFIXES = ["mcp__workers__", "mcp__orchestrate__"] as const

/** Tools explicitly preserved (documented; used by assertion tests). */
export const OPERATOR_KEPT_TOOLS = [
  "Agent",
  "Task",
  "Bash", // read-only gh + read-only shell
  "Read",
  "Grep",
  "Glob",
  "mcp__first-mate__",
] as const

export const OPERATOR_MODE_BANNER =
  "MODE: cloud-agent operator. You DELEGATE all implementation to GitHub cloud " +
  "agents via the first-mate MCP (and may use subagents to orchestrate/protect " +
  "context). You do NOT hand-code: Edit/Write/NotebookEdit and mcp__workers__* " +
  "are disabled. Read-only gh, Agent, first-mate, and read/search remain."

/**
 * Least-privilege note for what the cloud agents themselves may touch — the
 * operator scopes missions to specific repos and forbids irreversible actions
 * without human approval (see first-mate house rules). This constant documents
 * the intent for the launcher/README; enforcement of the cloud-agent scope is
 * the GitHub agent-token scope (repo/workflow) + the mission house_rules.
 */
export const CLOUD_AGENT_SCOPE_NOTE =
  "Cloud agents operate only within mission-listed repos; merges, releases, " +
  "Pages, and deletes require explicit human approval (first-mate merge gate)."

/**
 * The tool-input fields the operator guard inspects. `command` is the Bash
 * command; `file_path` is the Write/Edit target; `notebook_path` is the
 * NotebookEdit target. All `unknown` — the hook payload is untrusted JSON.
 */
export interface OperatorToolInput {
  command?: unknown
  file_path?: unknown
  notebook_path?: unknown
}

/**
 * Resolve `p` to an absolute path with symlinks resolved on the portion that
 * EXISTS on disk. The write target itself usually does NOT exist yet (we are
 * about to create it), so we walk up to the deepest existing ancestor, realpath
 * THAT, then re-append the non-existent tail. This prevents a symlinked
 * `plans`/`memory`/`projects` dir (or any symlinked ancestor) from escaping the
 * CLAUDE_CONFIG_DIR containment check. When nothing on the chain exists, falls
 * back to a pure `path.resolve` (so an in-memory unit test whose config dir is
 * not on disk still resolves deterministically).
 */
function resolveWithExistingSymlinks(p: string): string {
  const resolved = path.resolve(p)
  const tail: string[] = []
  let cursor = resolved
  for (;;) {
    try {
      const real = fs.realpathSync(cursor)
      return tail.length === 0 ? real : path.join(real, ...[...tail].reverse())
    } catch {
      const parent = path.dirname(cursor)
      if (parent === cursor) return resolved // reached the filesystem root — nothing existed.
      tail.push(path.basename(cursor))
      cursor = parent
    }
  }
}

/**
 * Path-scoped exemption for the file-authoring tools. The operator MAY author a
 * file whose symlink-resolved path lands strictly inside one of the operator's
 * own scratch shapes:
 *   - `<CLAUDE_CONFIG_DIR>/plans/**`
 *   - `<CLAUDE_CONFIG_DIR>/projects/<slug>/plans/**`
 *   - `<CLAUDE_CONFIG_DIR>/projects/<slug>/memory/**`
 * where `<slug>` is a SINGLE path segment (the per-project dir). This matches the
 * EXACT shapes, NOT "any path containing a plans/memory segment" (which would be
 * overbroad — a product file at `src/plans/x.ts` must stay blocked).
 *
 * FAIL-CLOSED — returns `false` (not exempt → the caller keeps blocking) on any
 * of: `CLAUDE_CONFIG_DIR` unset / empty / NOT absolute; a missing / non-string /
 * empty target path; a `../` escape out of CLAUDE_CONFIG_DIR (caught by the
 * `path.relative` sep-boundary containment, so a normalized target that climbs
 * out is simply not "inside"); a symlink that escapes (realpath resolves it
 * before the shape match); or any resolution error. Windows-safe via
 * `path.resolve`/`path.relative`/`path.sep` (case-insensitive drive handling is
 * `path.relative`'s job on win32).
 */
function operatorWritePathAllowed(rawPath: unknown): boolean {
  if (typeof rawPath !== "string" || rawPath.length === 0) return false
  const configDir = process.env.CLAUDE_CONFIG_DIR
  if (typeof configDir !== "string" || configDir.length === 0 || !path.isAbsolute(configDir)) {
    return false
  }
  try {
    const root = resolveWithExistingSymlinks(configDir)
    const target = resolveWithExistingSymlinks(rawPath)
    const rel = path.relative(root, target)
    // Outside CLAUDE_CONFIG_DIR (a `../` climb-out, or a different Windows drive
    // where `path.relative` returns an absolute path) → not exempt.
    if (rel.length === 0 || rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
      return false
    }
    const segs = rel.split(path.sep).filter((s) => s.length > 0)
    // Each shape requires content BENEATH the leaf dir — the dir itself is never a
    // writable target (so `<CFG>/plans` alone, or `<CFG>/projects/<slug>/memory`
    // alone, stays blocked).
    if (segs[0] === "plans" && segs.length >= 2) return true
    if (segs[0] === "projects" && segs.length >= 4 && (segs[2] === "plans" || segs[2] === "memory")) {
      return true
    }
    return false
  } catch {
    return false // any resolution error → fail closed.
  }
}

/** The file-authoring target for a tool, if it exposes one. */
function operatorWriteTarget(toolName: string, input?: OperatorToolInput): unknown {
  if (toolName === "Write" || toolName === "Edit") return input?.file_path
  if (toolName === "NotebookEdit") return input?.notebook_path
  return undefined
}

/**
 * Decide whether a tool call must be BLOCKED for the operator. Pure — used both
 * by the PreToolUse hook handler and by config-assertion tests. When operator
 * mode is off, nothing is blocked (normal sessions unaffected).
 *
 * The file-authoring tools (Edit/Write/NotebookEdit) are denied EXCEPT when the
 * tool input names a target inside one of the operator's own scratch shapes
 * (`<CLAUDE_CONFIG_DIR>/plans/**`, `<CLAUDE_CONFIG_DIR>/projects/<slug>/plans/**`,
 * `<CLAUDE_CONFIG_DIR>/projects/<slug>/memory/**` — see `operatorWritePathAllowed`).
 * Without an inspectable input the exemption cannot be proven, so the tool stays
 * blocked (fail-closed).
 */
export function shouldDenyOperatorTool(
  toolName: string,
  operatorMode: boolean,
  input?: OperatorToolInput,
): boolean {
  if (!operatorMode) return false
  if ((OPERATOR_DENIED_TOOLS as readonly string[]).includes(toolName)) {
    if (operatorWritePathAllowed(operatorWriteTarget(toolName, input))) return false
    return true
  }
  return OPERATOR_DENIED_MCP_PREFIXES.some((p) => toolName.startsWith(p))
}

export interface PreToolUseDecision {
  block: boolean
  reason?: string
  /**
   * #11 — set on an ALLOW that should ALSO inject steering context to the model
   * (a control-flow Bash construct we allowed but could not fully vet). The guard
   * hook surfaces this as a PreToolUse `additionalContext` system reminder.
   */
  additionalContext?: string
}

/**
 * B1 — decide whether a Bash command is READ-ONLY enough for the operator.
 *
 * THREAT MODEL: this is a guardrail against a COOPERATING operator accidentally
 * hand-coding via the shell (the same vector the Edit/Write deny-list closes),
 * NOT a security sandbox against a determined adversary. A denylist is trivially
 * bypassable (python -c/node -e writes, cp/mv/install/tee-by-path, `git -c …
 * commit`, …), so this is an ALLOWLIST: only provably read-only commands pass;
 * everything else is denied. True isolation against a hostile process requires
 * OS-level sandboxing (a restricted user, container, seccomp) — out of scope for
 * an in-process hook and documented as such.
 *
 * FAIL-CLOSED: anything we cannot confidently prove read-only is denied —
 * command/process substitution, file-writing redirection, an unknown binary, or
 * an unknown/mutating subcommand of an allowlisted multiplexer (git/gh).
 *
 * KNOWN LIMITATION (documented, accepted for a guardrail): this uses a
 * hand-rolled tokenizer (quote- and backslash-aware), NOT a full shell parser,
 * so validate can still DESYNC from execute on adversarial input (exotic
 * quoting/expansion/heredocs). It is defense-in-depth against a COOPERATING
 * operator, NOT a boundary against a hostile one — a determined operator with a
 * shell can still get code to run. The robust future step is a real shell
 * tokenizer (e.g. the `shell-quote` parser) so validate == execute, or simply
 * not exposing arbitrary Bash; true isolation needs OS-level sandboxing.
 *
 * Returns a human reason when the command is DENIED, else undefined (allowed).
 */

/** Bare binaries that are read-only in any invocation (basename-matched). */
const READ_ONLY_BINARIES = new Set<string>([
  // trivial / builtins
  "echo", "printf", "true", "false", "test", "[", "pwd",
  "whoami", "hostname", "uname", "date", "which", "type", "id", "uptime", "tty",
  // file inspection
  "ls", "cat", "bat", "head", "tail", "wc", "stat", "file", "du", "df", "tree",
  "readlink", "realpath", "dirname", "basename", "nl", "tac", "od", "hexdump",
  "strings", "less", "more",
  // NB: `xxd` is deliberately excluded — `xxd infile outfile` (and `xxd -r`)
  // write a file with no redirection; od/hexdump/strings cover read-only dumps.
  // search / find
  "grep", "egrep", "fgrep", "rg", "ag", "ack", "fd", "find", "locate", "glob",
  // read-only text processing (a file-write via redirection is caught
  // separately; a write hidden inside a program string over-blocks, which is
  // safe for a guardrail)
  "sort", "uniq", "cut", "tr", "column", "comm", "join", "paste", "fold",
  "expand", "unexpand", "seq", "rev", "cksum", "md5sum", "sha1sum", "sha256sum",
  "jq", "yq", "gron", "diff", "difft", "cmp", "scc", "tokei", "cloc",
])

/** git subcommands that never mutate the repo or working tree. */
const GIT_READONLY_SUBCOMMANDS = new Set<string>([
  "log", "show", "diff", "status", "rev-parse", "describe", "blame",
  "shortlog", "reflog", "ls-files", "ls-tree", "ls-remote", "cat-file",
  "for-each-ref", "rev-list", "whatchanged", "grep", "annotate", "show-ref",
  "var", "count-objects",
])
// NB: `symbolic-ref` is NOT read-only — `git symbolic-ref HEAD <ref>` REWRITES
// HEAD — so it is deliberately excluded. `reflog` is read-only only for
// show/default; its mutating sub-actions (expire/delete) are vetted below.

/** reflog sub-actions that only READ; any other (expire/delete/drop/…) mutates. */
const GIT_REFLOG_READONLY = new Set<string>(["show", "exists"])

/** git global options that CONSUME the following token (so it isn't the subcommand). */
const GIT_GLOBAL_ARG_FLAGS = new Set<string>([
  "-C", "--git-dir", "--work-tree", "--namespace",
])
// `-c` and `--exec-path` are NOT here (and are rejected outright below): they are
// config/exec injection vectors — `git -c core.pager=<cmd>` / `core.sshCommand=` /
// `core.fsmonitor=` and `--exec-path=<dir>` run arbitrary commands.

/**
 * git argument forms that inject command execution or write a file, anywhere in
 * the invocation (before OR after the subcommand). `-c`/`--exec-path` are RCE;
 * `--output`/`-O`/`--open-files-in-pager` write or spawn a pager.
 */
function gitArgIsDangerous(tok: string): string | undefined {
  if (tok === "-c") return "git -c can inject config that executes commands"
  if (tok === "--exec-path" || tok.startsWith("--exec-path=")) {
    return "git --exec-path can run commands from an attacker path"
  }
  if (tok === "--output" || tok.startsWith("--output=")) return "git --output writes a file"
  if (tok === "-O" || tok === "--open-files-in-pager") return "git -O opens files in a pager (executes)"
  return undefined
}

/** gh actions that only read. Structure: `gh <cmd> <action> …`. */
const GH_READONLY_ACTIONS = new Set<string>([
  "view", "list", "diff", "checks", "status",
])

/** gh top-level commands that read with no action word (e.g. `gh status`). */
const GH_READONLY_TOPLEVEL = new Set<string>(["status"])

/** gh global options that consume the following token. */
const GH_GLOBAL_ARG_FLAGS = new Set<string>(["-R", "--repo"])

/** Basename a binary path so `/usr/bin/tee` → `tee`. */
function binaryBasename(token: string): string {
  const slash = token.lastIndexOf("/")
  return slash === -1 ? token : token.slice(slash + 1)
}

/**
 * Split a command into pipeline/list segments, respecting single and double
 * quotes so an operator inside a quoted string is not treated as a separator.
 * Grouping `()`/`{}` are treated as separators. Returns undefined when the input
 * is un-vettable (an unterminated quote) so the caller fails closed.
 */
function splitSegments(command: string): string[] | undefined {
  const segments: string[] = []
  let current = ""
  let quote: '"' | "'" | undefined
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!
    if (quote) {
      current += ch
      if (ch === quote) quote = undefined
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      current += ch
      continue
    }
    // A backslash escapes the next char (e.g. `\;` in `find … -exec … \;`) so it
    // is NOT treated as a separator — keeps validate aligned with execute.
    if (ch === "\\" && i + 1 < command.length) {
      current += ch + command[i + 1]!
      i++
      continue
    }
    // operators: | || & && ; newline, and subshell grouping ( ). NOTE `{` / `}`
    // are intentionally NOT separators so brace expansion (`echo {a,b}`) is one
    // word; a `{ …; }` command group still fails closed because its `{` becomes
    // a non-allowlisted "binary" token.
    if (ch === "|" || ch === "&" || ch === ";" || ch === "\n" || ch === "(" || ch === ")") {
      segments.push(current)
      current = ""
      continue
    }
    current += ch
  }
  if (quote) return undefined // unterminated quote — un-vettable
  segments.push(current)
  return segments.map((s) => s.trim()).filter((s) => s.length > 0)
}

/**
 * Tokenize a single segment on whitespace, respecting quotes, and record whether
 * each token was formed entirely OUTSIDE quotes and WITHOUT a backslash escape
 * (`bare`). A shell reserved word (`for`, `case`, …) is only STRUCTURAL when bare
 * — a QUOTED `'for'` is a normal command word, not a keyword, so treating it as
 * structural would skip allowlist vetting.
 */
function tokenizeDetailed(segment: string): { text: string; bare: boolean }[] {
  const tokens: { text: string; bare: boolean }[] = []
  let current = ""
  let bare = true
  let quote: '"' | "'" | undefined
  const flush = (): void => {
    if (current.length > 0) tokens.push({ text: current, bare })
    current = ""
    bare = true
  }
  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i]!
    if (quote) {
      bare = false
      if (ch === quote) quote = undefined
      else current += ch
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      bare = false
      continue
    }
    if (ch === "\\" && i + 1 < segment.length) {
      current += segment[i + 1]!
      bare = false
      i++
      continue
    }
    if (ch === " " || ch === "\t") {
      flush()
      continue
    }
    current += ch
  }
  flush()
  return tokens
}
function gitDenyReason(args: string[]): string | undefined {
  let subcommand: string | undefined
  const bareAfterSub: string[] = []
  for (let i = 0; i < args.length; i++) {
    const tok = args[i]!
    // Injection/write forms are denied wherever they appear (before OR after the
    // subcommand): `-c` config-injection, `--exec-path`, `--output`, `-O` pager.
    const danger = gitArgIsDangerous(tok)
    if (danger !== undefined) return danger
    if (subcommand === undefined) {
      if (tok.startsWith("--") && tok.includes("=")) continue // --git-dir=… (self-contained)
      if (GIT_GLOBAL_ARG_FLAGS.has(tok)) {
        i++ // skip its argument
        continue
      }
      if (tok.startsWith("-")) continue // lone global flag (-p, --no-pager, …)
      // first bareword is the subcommand
      subcommand = tok
      if (!GIT_READONLY_SUBCOMMANDS.has(tok)) return `git subcommand '${tok}' is not read-only`
      continue
    }
    // After the subcommand: collect barewords so a mutating sub-action is vetted.
    if (!tok.startsWith("-")) bareAfterSub.push(tok)
  }
  if (subcommand === undefined) return "git invocation has no inspectable subcommand (fail-closed)"
  // `reflog` reads only for show/exists (or bare `git reflog`); expire/delete/
  // drop/write/… mutate — allowlist the read-only actions and deny the rest.
  if (
    subcommand === "reflog" &&
    bareAfterSub[0] !== undefined &&
    !GIT_REFLOG_READONLY.has(bareAfterSub[0])
  ) {
    return `git reflog ${bareAfterSub[0]} is not read-only`
  }
  return undefined
}

/** Validate a `gh …` invocation is read-only. Returns a deny reason or undefined. */
function ghDenyReason(args: string[]): string | undefined {
  const bare: string[] = []
  for (let i = 0; i < args.length; i++) {
    const tok = args[i]!
    if (GH_GLOBAL_ARG_FLAGS.has(tok)) {
      i++ // skip its argument
      continue
    }
    if (tok.startsWith("-")) continue
    bare.push(tok)
    if (bare.length === 2) break
  }
  // `gh <cmd> <action>` — the action decides read vs write; `gh api …` has no
  // read-only action word, so it fails closed (it can POST/PATCH/DELETE). A few
  // top-level commands read with no action word (e.g. `gh status`).
  const cmd = bare[0]
  const action = bare[1]
  if (action !== undefined && GH_READONLY_ACTIONS.has(action)) return undefined
  if (action === undefined && cmd !== undefined && GH_READONLY_TOPLEVEL.has(cmd)) return undefined
  return `gh ${bare.join(" ") || "(no subcommand)"} is not an allowlisted read-only action`
}

/**
 * Per-binary argument vetting for otherwise-read-only binaries that grow a
 * write/exec capability under a specific flag (a bare-name allowlist entry alone
 * would wave these through). Returns a deny reason or undefined.
 */
function argDenyReason(binary: string, args: string[]): string | undefined {
  const has = (...flags: string[]): boolean => args.some((a) => flags.includes(a))
  switch (binary) {
    case "find":
      // -exec/-execdir/-ok/-okdir run a command; -delete removes files;
      // -fprint*/-fprint0/-fls write a named file.
      if (
        args.some(
          (a) =>
            a === "-exec" || a === "-execdir" || a === "-ok" || a === "-okdir" ||
            a === "-delete" || a === "-fprint" || a === "-fprint0" ||
            a === "-fprintf" || a === "-fls",
        )
      ) {
        return "find -exec/-delete/-fprint can execute or write (fail-closed)"
      }
      return undefined
    case "fd":
      if (has("-x", "--exec", "-X", "--exec-batch")) {
        return "fd -x/--exec executes a command (fail-closed)"
      }
      return undefined
    case "yq":
      if (has("-i", "--inplace")) return "yq -i writes the file in place"
      return undefined
    case "sort":
      if (
        args.some(
          (a) => a === "-o" || a === "--output" || a.startsWith("--output=") || (a.startsWith("-o") && a.length > 2),
        )
      ) {
        return "sort -o writes an output file"
      }
      return undefined
    case "tree":
      if (
        args.some(
          (a) => a === "-o" || a === "--output" || a.startsWith("--output=") || (a.startsWith("-o") && a.length > 2),
        )
      ) {
        return "tree -o writes an output file"
      }
      return undefined
    case "diff":
      if (args.some((a) => a === "--output" || a.startsWith("--output="))) {
        return "diff --output writes a file"
      }
      return undefined
    default:
      return undefined
  }
}

/**
 * Replace the CONTENT of single/double-quoted spans (and the quotes themselves)
 * with spaces, preserving length. Used only for shell-metacharacter detection so
 * a metacharacter inside a quoted literal (`rg 'a>b'`) is not mistaken for an
 * operator. Returns undefined on an unterminated quote (fail-closed).
 */
function maskQuotes(command: string): string | undefined {
  let out = ""
  let quote: '"' | "'" | undefined
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!
    if (quote) {
      out += " "
      if (ch === quote) quote = undefined
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      out += " "
      continue
    }
    out += ch
  }
  if (quote) return undefined
  return out
}

/**
 * Like `maskQuotes`, but masks ONLY single-quoted spans and backslash-escaped
 * chars (replacing them with spaces), leaving DOUBLE-quoted content intact. Used
 * for command/process-substitution detection: `$(…)` and backticks are INERT
 * inside single quotes / after a backslash but ACTIVE inside double quotes, so
 * `grep '>(x)'` (a single-quoted regex) must pass the proc-sub check while
 * `echo "$(rm f)"` (active inside double quotes) must still be caught. Returns
 * undefined on an unterminated single quote (un-vettable → fail-closed).
 */
function maskSingleQuotesAndEscapes(command: string): string | undefined {
  let out = ""
  let inSingle = false
  let inDouble = false
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!
    if (inSingle) {
      out += " "
      if (ch === "'") inSingle = false
      continue
    }
    // A backslash-newline is a LINE CONTINUATION (bash joins the lines before
    // parsing, outside single quotes) — DROP both chars so a split `$\<nl>(`
    // rejoins to an active `$(` and is still detected (not masked into `$  (`).
    if (ch === "\\" && (command[i + 1] === "\n" || command[i + 1] === "\r")) {
      i++
      if (command[i] === "\r" && command[i + 1] === "\n") i++
      continue
    }
    // Any other backslash escapes the next char (outside single quotes, incl.
    // inside double quotes): the escaped metachar (`\$`, `` \` ``, `\<`) is inert,
    // so mask BOTH the backslash and the char it neutralizes.
    if (ch === "\\" && i + 1 < command.length) {
      out += "  "
      i++
      continue
    }
    if (ch === "'" && !inDouble) {
      inSingle = true
      out += " "
      continue
    }
    if (ch === '"') {
      inDouble = !inDouble
      out += ch // keep the quote; double-quoted CONTENT is preserved for the check.
      continue
    }
    out += ch
  }
  if (inSingle) return undefined // unterminated single quote — un-vettable.
  return out
}

/**
 * Env-var names whose VALUE is executed as a command by a subsequent read-only
 * tool (git/less/…). A leading `NAME=… cmd` assignment to one of these turns an
 * allowlisted read into arbitrary execution, so it fails closed.
 */
const COMMAND_HOOK_ENV = new Set<string>([
  "GIT_PAGER", "PAGER", "GIT_EXTERNAL_DIFF", "GIT_DIFF_OPTS", "GIT_SEQUENCE_EDITOR",
  "VISUAL", "BASH_ENV", "ENV", "IFS", "PROMPT_COMMAND",
])
function isCommandHookEnv(name: string): boolean {
  if (COMMAND_HOOK_ENV.has(name)) return true
  if (name.endsWith("EDITOR")) return true // EDITOR, GIT_EDITOR, HGEDITOR, …
  if (name.endsWith("_COMMAND")) return true // GIT_SSH_COMMAND, GIT_PROXY_COMMAND, …
  if (name.startsWith("LESS")) return true // LESSOPEN, LESSCLOSE, LESS, LESSSECURE, …
  if (name.startsWith("GIT_SSH")) return true // GIT_SSH, GIT_SSH_COMMAND/VARIANT
  return false
}

/**
 * #11 — shell control-flow keywords treated as STRUCTURAL (not commands): a
 * segment that is only these, or these followed by a vettable inner command, is
 * decomposed rather than blunt-blocked. `for`/`select`/`case` additionally
 * consume their header (loop-variable + value list / match word) as DATA — those
 * are never a command word. The remaining keywords (`while`/`until`/`if`/`elif`)
 * are followed by a condition COMMAND, which is still vetted.
 */
const CONTROL_FLOW_KEYWORDS = new Set<string>([
  "for", "while", "until", "if", "do", "done", "then", "elif", "else", "fi",
  "case", "esac", "in", "select", "{", "}",
])
const CONTROL_FLOW_HEADER_KEYWORDS = new Set<string>(["for", "select", "case"])

/**
 * #11 — the steering reminder surfaced (as PreToolUse `additionalContext`) when a
 * control-flow construct is ALLOWED. A hand-rolled tokenizer cannot fully vet a
 * shell control-flow construct, so we allow the read-only-looking case but nudge
 * the operator back toward delegation rather than shell-scripting.
 */
export const CONTROL_FLOW_REMINDER =
  "Note: shell control-flow (loops/conditionals) is hard to fully vet from a "
  + "guard hook. This ran because its inner commands look read-only, but prefer "
  + "delegating multi-step work to a GitHub cloud agent via the first-mate MCP "
  + "over scripting control-flow in the operator shell."

/** Does this single segment contain a heredoc redirection (`<<` / `<<-`)? Checked
 *  over a quote-masked copy so a literal `<<` inside a quoted arg doesn't count. */
function hasHeredoc(segment: string): boolean {
  const masked = maskQuotes(segment)
  if (masked === undefined) return true // unterminated quote → be conservative.
  return masked.includes("<<")
}

/** Bare interpreter names whose heredoc form runs arbitrary code. */
const HEREDOC_INTERPRETERS = new Set<string>(["python", "python3", "node", "nodejs", "perl", "ruby"])
/** Shells whose `-c` form runs an arbitrary command string. */
const DASH_C_SHELLS = new Set<string>(["sh", "bash", "zsh", "dash", "ksh"])
/** Package managers whose install/add subcommand mutates the environment. */
const PACKAGE_MANAGERS = new Set<string>(["npm", "pnpm", "yarn", "pip", "pip3", "apt", "apt-get", "brew"])

/**
 * #11 layer 1 — ALWAYS-ON escape-hatch detection. These definite write/exec
 * vectors are hard-blocked regardless of the surrounding (control-flow) syntax,
 * so the leniency of the control-flow path can NEVER wave one of them through.
 * `idx` is the resolved command-word position (after env assignments + stripped
 * control-flow keywords). Returns a deny reason or undefined.
 */
function escapeHatchReason(tokens: string[], idx: number, segment: string): string | undefined {
  const word = tokens[idx]!
  // Indirect execution: the command word is itself a variable expansion
  // (`$VAR foo`, `${VAR}`) — its value is un-vettable.
  if (word.startsWith("$")) return "indirect command execution via a variable is un-vettable (fail-closed)"
  const binary = binaryBasename(word)
  const rest = tokens.slice(idx + 1)
  if (binary === "eval") return "eval executes an arbitrary command (fail-closed)"
  if (DASH_C_SHELLS.has(binary) && rest.includes("-c")) {
    return `${binary} -c executes an arbitrary command (fail-closed)`
  }
  if (HEREDOC_INTERPRETERS.has(binary) && hasHeredoc(segment)) {
    return `${binary} with a heredoc executes arbitrary code (fail-closed)`
  }
  if (
    binary === "find" &&
    rest.some((a) => a === "-exec" || a === "-execdir" || a === "-ok" || a === "-okdir" || a === "-delete")
  ) {
    return "find -exec/-execdir/-delete executes or deletes files (fail-closed)"
  }
  if (binary === "xargs") {
    // xargs runs a command per input line; the target is the first non-flag arg.
    const target = rest.find((a) => !a.startsWith("-"))
    if (target === undefined || !READ_ONLY_BINARIES.has(binaryBasename(target))) {
      return "xargs runs a non-read-only command (fail-closed)"
    }
  }
  // In-place editors write the file back (`sed -i`, `perl -pi`). `-i`/`--in-place`
  // or a bundled short-flag cluster containing `i`.
  if (
    binary === "sed" &&
    rest.some((a) => a === "-i" || a === "--in-place" || (a.startsWith("-i") && !a.startsWith("--")) || (a.startsWith("-") && !a.startsWith("--") && a.includes("i")))
  ) {
    return "sed -i edits a file in place (fail-closed)"
  }
  if (
    binary === "perl" &&
    rest.some((a) => a.startsWith("-") && !a.startsWith("--") && a.includes("i"))
  ) {
    return "perl -i/-pi edits a file in place (fail-closed)"
  }
  if (PACKAGE_MANAGERS.has(binary) && rest.some((a) => a === "install" || a === "i" || a === "add")) {
    return `${binary} install mutates the environment (fail-closed)`
  }
  return undefined
}

/**
 * The read-only vet verdict for a Bash command:
 *   - `block: true`  → a definite write/exec (with a `reason`) — deny.
 *   - `block: false` + `reminder` → allowed, but a control-flow construct we
 *     could not fully vet; the caller surfaces the reminder as steering context.
 *   - `block: false` (no reminder) → provably read-only, allow silently.
 */
export interface BashVetResult {
  block: boolean
  reason?: string
  reminder?: string
}

/**
 * B1 — vet whether a Bash command is READ-ONLY enough for the operator. See the
 * threat-model / known-limitation notes above: this is a guardrail against a
 * COOPERATING operator hand-coding via the shell, an ALLOWLIST (only provably
 * read-only commands pass), NOT a sandbox against a hostile process.
 */
export function vetBashCommand(command: string): BashVetResult {
  // #7: command / process substitution can hide an arbitrary mutating command.
  // Detect it over a copy with single-quoted spans + backslash escapes masked
  // (so a `>(`/`$(` inside a single-quoted regex arg is inert) while DOUBLE-quoted
  // content is preserved (`$(…)`/backticks are active there and MUST be caught).
  const forProcSub = maskSingleQuotesAndEscapes(command)
  if (forProcSub === undefined) return { block: true, reason: "unterminated quote (fail-closed)" }
  if (/\$\(|`|<\(|>\(/.test(forProcSub)) {
    return { block: true, reason: "command/process substitution cannot be vetted (fail-closed)" }
  }
  // Strip redirections that do NOT write a real file (fd duplication 2>&1/>&2/
  // >&-, discard to /dev/null), then any remaining `>` writes a file. The
  // /dev/null strip requires a boundary after `null` so a longer path like
  // `>/dev/null.log` is NOT mistaken for the discard sink (that `>` survives and
  // is caught). The `>` check runs over a QUOTE-MASKED copy so a `>` inside a
  // quoted literal (`rg 'a>b'`) is not mistaken for a redirection; the un-masked
  // `benign` is what we tokenize (quotes carry real arg content).
  const benign = command
    .replace(/\d*>&\s*[\d-]+/g, " ")
    .replace(/&?\d*>{1,2}\s*\/dev\/null(?=$|[\s;|&)])/g, " ")
  const maskedBenign = maskQuotes(benign)
  if (maskedBenign === undefined) return { block: true, reason: "unterminated quote (fail-closed)" }
  if (/>/.test(maskedBenign)) return { block: true, reason: "shell output redirection writes a file" }

  // Segment/tokenize the redirection-stripped form so an fd-dup like `2>&1`
  // (which contains `&`) is not mistaken for a background-job separator.
  const segments = splitSegments(benign)
  if (segments === undefined) return { block: true, reason: "unparseable shell command (fail-closed)" }
  if (segments.length === 0) return { block: true, reason: "empty shell command (fail-closed)" }

  let sawControlFlow = false
  for (const segment of segments) {
    const detailed = tokenizeDetailed(segment)
    const tokens = detailed.map((d) => d.text)
    // Skip leading VAR=value environment assignments; the next token is the cmd.
    // BUT reject assignments to env vars that HOOK command execution (a pager /
    // editor / diff-helper / ssh-command the subsequent git/less/… then runs).
    let idx = 0
    while (idx < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[idx]!)) {
      const name = tokens[idx]!.slice(0, tokens[idx]!.indexOf("="))
      if (isCommandHookEnv(name)) {
        return { block: true, reason: `environment assignment ${name}= can hook command execution (fail-closed)` }
      }
      idx++
    }
    // #11 layer 2: strip leading control-flow keywords (STRUCTURAL, not commands).
    // Only a BARE (unquoted, unescaped) keyword is structural — a quoted `'for'`
    // is a command word and must fall through to allowlist vetting, not be treated
    // as a header that skips the segment. A `for VAR in …` / `select VAR in …` /
    // `case WORD in` header's remaining tokens are the loop variable + value list
    // (DATA), consumed to the end of this segment — the loop BODY commands live in
    // the `do …` segment(s) and are vetted there. `while`/`until`/`if`/`elif` are
    // followed by a condition COMMAND, which the vet below still checks.
    while (idx < tokens.length && detailed[idx]!.bare && CONTROL_FLOW_KEYWORDS.has(tokens[idx]!)) {
      sawControlFlow = true
      const kw = tokens[idx]!
      idx++
      if (CONTROL_FLOW_HEADER_KEYWORDS.has(kw)) {
        idx = tokens.length // consume the header's variable + value list as data.
      }
    }
    if (idx >= tokens.length) {
      // A pure-assignment segment (`FOO=bar`) or a pure control-flow keyword /
      // header segment (`done`, `fi`, `for f in a b`) — no command to vet.
      continue
    }
    // #11 layer 1: ALWAYS-ON escape-hatch hard-blocks (fire regardless of the
    // control-flow context we're inside).
    const escapeReason = escapeHatchReason(tokens, idx, segment)
    if (escapeReason !== undefined) return { block: true, reason: escapeReason }

    const binary = binaryBasename(tokens[idx]!)
    const rest = tokens.slice(idx + 1)
    if (binary === "git") {
      const reason = gitDenyReason(rest)
      if (reason !== undefined) return { block: true, reason }
      continue
    }
    if (binary === "gh") {
      const reason = ghDenyReason(rest)
      if (reason !== undefined) return { block: true, reason }
      continue
    }
    if (!READ_ONLY_BINARIES.has(binary)) {
      return { block: true, reason: `'${binary}' is not on the read-only allowlist` }
    }
    // An allowlisted binary can still grow a write/exec capability under a
    // specific flag (find -exec, yq -i, sort -o, …) — vet its args.
    const argReason = argDenyReason(binary, rest)
    if (argReason !== undefined) return { block: true, reason: argReason }
  }
  // #11: a control-flow construct passed the read-only vet, but the hand-rolled
  // tokenizer can't fully guarantee a shell construct is inert — allow, and steer.
  if (sawControlFlow) return { block: false, reminder: CONTROL_FLOW_REMINDER }
  return { block: false }
}

/**
 * Back-compat thin wrapper over `vetBashCommand`: returns the deny reason when the
 * command is BLOCKED, else undefined (allowed — the control-flow steering
 * reminder, if any, is surfaced by `operatorPreToolUse`, not here).
 */
export function bashDenyReason(command: string): string | undefined {
  const verdict = vetBashCommand(command)
  return verdict.block ? verdict.reason : undefined
}

/**
 * M4 — fail-CLOSED. If operator/`--agents` mode is active but the capability
 * -shaping guard could NOT be installed (e.g. settings.json unwritable), the
 * operator session must NOT start unshaded. The launcher calls this after
 * attempting injection; it throws to abort the launch. Non-agents sessions are
 * never affected.
 */
export function assertShapingInstalled(agentsMode: boolean, injectionSucceeded: boolean): void {
  if (agentsMode && !injectionSucceeded) {
    throw new Error(
      "cloud-agent operator mode requires the capability-shaping PreToolUse hook, " +
        "but it could not be installed — refusing to start an unshaded operator session.",
    )
  }
}

/**
 * The PreToolUse hook decision for a given tool name in operator mode.
 *
 * For Bash the command is inspected: a file-mutating command is blocked, a
 * read-only one is allowed. FAIL-CLOSED — if operator mode is on and a Bash
 * call arrives with no inspectable command string, block it (a malformed /
 * unparseable Bash payload must not slip an unchecked shell through).
 *
 * Task propagation: this guard is a PreToolUse hook in the spawned session's
 * settings.json, which also governs subagents spawned via Task/Agent — their
 * Bash calls hit the same hook. Agent/Task themselves stay allowed (the
 * operator orchestrates), but a subagent cannot use Bash to hand-code around
 * the block. (A subagent launched with an isolated settings dir would be the
 * only residual; the launcher does not do that in operator mode.)
 */
export function operatorPreToolUse(
  toolName: string,
  operatorMode: boolean,
  input?: OperatorToolInput,
): PreToolUseDecision {
  if (!operatorMode) return { block: false }
  if (shouldDenyOperatorTool(toolName, operatorMode, input)) {
    return {
      block: true,
      reason: `${toolName} is disabled in cloud-agent operator mode — delegate implementation to a GitHub cloud agent via the first-mate MCP instead of hand-coding (only writes into CLAUDE_CONFIG_DIR/plans/ or projects/<slug>/{plans,memory}/ are exempt).`,
    }
  }
  if (toolName === "Bash") {
    const command = input?.command
    if (typeof command !== "string" || command.length === 0) {
      // Fail-closed: a Bash call we cannot inspect is treated as unsafe.
      return {
        block: true,
        reason:
          "Bash call blocked in cloud-agent operator mode — its command could not be inspected (fail-closed).",
      }
    }
    const verdict = vetBashCommand(command)
    if (verdict.block) {
      return {
        block: true,
        reason: `Bash blocked in cloud-agent operator mode (${verdict.reason}) — only read-only shell is allowed; delegate implementation to a GitHub cloud agent instead of hand-coding via the shell.`,
      }
    }
    if (verdict.reminder !== undefined) {
      // #11: allowed control-flow — surface the steering reminder to the model.
      return { block: false, additionalContext: verdict.reminder }
    }
  }
  return { block: false }
}
