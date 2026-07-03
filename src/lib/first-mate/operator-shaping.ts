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
 */

/** Tools denied to the operator (exact names + the workers MCP prefix). */
export const OPERATOR_DENIED_TOOLS = ["Edit", "Write", "NotebookEdit"] as const
export const OPERATOR_DENIED_MCP_PREFIXES = ["mcp__workers__"] as const

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
 * Decide whether a tool call must be BLOCKED for the operator. Pure — used both
 * by the PreToolUse hook handler and by config-assertion tests. When operator
 * mode is off, nothing is blocked (normal sessions unaffected).
 */
export function shouldDenyOperatorTool(toolName: string, operatorMode: boolean): boolean {
  if (!operatorMode) return false
  if ((OPERATOR_DENIED_TOOLS as readonly string[]).includes(toolName)) return true
  return OPERATOR_DENIED_MCP_PREFIXES.some((p) => toolName.startsWith(p))
}

export interface PreToolUseDecision {
  block: boolean
  reason?: string
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
  "xxd", "strings", "less", "more",
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
  "symbolic-ref", "var", "count-objects",
])

/** git global options that CONSUME the following token (so it isn't the subcommand). */
const GIT_GLOBAL_ARG_FLAGS = new Set<string>([
  "-c", "-C", "--git-dir", "--work-tree", "--namespace", "--exec-path",
])

/** gh actions that only read. Structure: `gh <cmd> <action> …`. */
const GH_READONLY_ACTIONS = new Set<string>([
  "view", "list", "diff", "checks", "status",
])

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
    // operators: | || & && ; newline, and grouping ( ) { }
    if (ch === "|" || ch === "&" || ch === ";" || ch === "\n" || ch === "(" || ch === ")" || ch === "{" || ch === "}") {
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

/** Tokenize a single segment on whitespace, respecting quotes. */
function tokenize(segment: string): string[] {
  const tokens: string[] = []
  let current = ""
  let quote: '"' | "'" | undefined
  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i]!
    if (quote) {
      if (ch === quote) quote = undefined
      else current += ch
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      continue
    }
    if (ch === " " || ch === "\t") {
      if (current.length > 0) {
        tokens.push(current)
        current = ""
      }
      continue
    }
    current += ch
  }
  if (current.length > 0) tokens.push(current)
  return tokens
}

/** Validate a `git …` invocation is read-only. Returns a deny reason or undefined. */
function gitDenyReason(args: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const tok = args[i]!
    if (tok.startsWith("--") && tok.includes("=")) continue // --git-dir=… (self-contained)
    if (GIT_GLOBAL_ARG_FLAGS.has(tok)) {
      i++ // skip its argument
      continue
    }
    if (tok.startsWith("-")) continue // lone global flag (-p, --no-pager, …)
    // first bareword is the subcommand
    return GIT_READONLY_SUBCOMMANDS.has(tok)
      ? undefined
      : `git subcommand '${tok}' is not read-only`
  }
  return "git invocation has no inspectable subcommand (fail-closed)"
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
  // `gh <cmd> <action>` — the action decides read vs write. `gh api …` has no
  // read-only action word, so it fails closed (it can POST/PATCH/DELETE).
  const action = bare[1]
  if (action !== undefined && GH_READONLY_ACTIONS.has(action)) return undefined
  return `gh ${bare.join(" ") || "(no subcommand)"} is not an allowlisted read-only action`
}

export function bashDenyReason(command: string): string | undefined {
  // Command / process substitution can hide an arbitrary mutating command; we
  // cannot vet it, so fail closed.
  if (/\$\(|`|<\(|>\(/.test(command)) {
    return "command/process substitution cannot be vetted (fail-closed)"
  }
  // Strip redirections that do NOT write a real file, then any remaining `>`
  // writes a file. (fd duplication 2>&1/>&2/>&-, discard to /dev/null.)
  const benign = command
    .replace(/\d*>&\s*[\d-]+/g, " ")
    .replace(/&?\d*>{1,2}\s*\/dev\/null/g, " ")
  if (/>/.test(benign)) return "shell output redirection writes a file"

  // Segment/tokenize the redirection-stripped form so an fd-dup like `2>&1`
  // (which contains `&`) is not mistaken for a background-job separator.
  const segments = splitSegments(benign)
  if (segments === undefined) return "unparseable shell command (fail-closed)"
  if (segments.length === 0) return "empty shell command (fail-closed)"

  for (const segment of segments) {
    const tokens = tokenize(segment)
    // Skip leading VAR=value environment assignments; the next token is the cmd.
    let idx = 0
    while (idx < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[idx]!)) idx++
    if (idx >= tokens.length) {
      // A segment that is only assignments (`FOO=bar`) mutates only the shell
      // env — harmless read-only-wise. But a lone `<` input redirect token, etc.
      // Allow a pure-assignment segment.
      continue
    }
    const binary = binaryBasename(tokens[idx]!)
    const rest = tokens.slice(idx + 1)
    if (binary === "git") {
      const reason = gitDenyReason(rest)
      if (reason !== undefined) return reason
      continue
    }
    if (binary === "gh") {
      const reason = ghDenyReason(rest)
      if (reason !== undefined) return reason
      continue
    }
    if (!READ_ONLY_BINARIES.has(binary)) {
      return `'${binary}' is not on the read-only allowlist`
    }
  }
  return undefined
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
  input?: { command?: unknown },
): PreToolUseDecision {
  if (!operatorMode) return { block: false }
  if (shouldDenyOperatorTool(toolName, operatorMode)) {
    return {
      block: true,
      reason: `${toolName} is disabled in cloud-agent operator mode — delegate implementation to a GitHub cloud agent via the first-mate MCP instead of hand-coding.`,
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
    const reason = bashDenyReason(command)
    if (reason !== undefined) {
      return {
        block: true,
        reason: `Bash blocked in cloud-agent operator mode (${reason}) — only read-only shell is allowed; delegate implementation to a GitHub cloud agent instead of hand-coding via the shell.`,
      }
    }
  }
  return { block: false }
}
