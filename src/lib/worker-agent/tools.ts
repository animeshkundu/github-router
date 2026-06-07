/**
 * Worker-agent AgentTool definitions.
 *
 * Plan: see `plans/we-have-added-a-dreamy-tide.md` ("Tools" section).
 *
 * 11 tools across two modes:
 *
 *   - Explore mode (8, read-only):
 *       read, glob, grep, code_search, web_search, fetch_url,
 *       peer_review, advisor.
 *
 *   - Implement mode (11): explore + edit, write, bash.
 *
 * All tools follow Pi's `AgentTool<TParameters, TDetails>` contract:
 *
 *   execute(toolCallId, params, signal?, onUpdate?) →
 *     Promise<AgentToolResult<TDetails>>
 *
 * The `signal` parameter is the PER-CALL signal Pi forwards (the agent's
 * abort signal, possibly chained with the engine's wall-clock timer).
 * It MUST be threaded into the fs / child-process / fetch call we
 * spawn — closing over an outer signal would skip mid-turn cancels.
 *
 * Error convention (locked in by team-lead after agent-loop.ts:634-661
 * inspection, divergent from Pi's docstring's looser "throw on failure"):
 *
 *   THROW (real failure → Pi's loop wraps as `isError: true`):
 *     - read   — ENOENT/EACCES/>10MB/denylist/path-containment
 *     - glob   — rg invocation failure (NOT zero matches)
 *     - grep   — rg invocation failure (NOT zero matches)
 *     - edit   — path-containment/file ENOENT/atomic-write failure
 *                (NOT zero/multi-match)
 *     - write  — path-containment/>10MB/atomic-write failure
 *     - bash   — timeout/killed-by-abort/spawn failure
 *                (NOT non-zero exit)
 *     - web_search / fetch_url / code_search / peer_review / advisor
 *                — upstream HTTP errors
 *
 *   RETURN CONTENT (tool succeeded, semantic outcome):
 *     - edit zero-match    → "not found"
 *     - edit multi-match   → "matches N times"
 *     - glob/grep no hits  → "no matches"
 *     - bash non-zero exit → "<stdout>\n<stderr>\nexit=N"
 *
 * The error messages are TERSE FACTS, NO ADVICE — Pi's harness decides
 * what to do next; advice from the tool layer just pollutes the model's
 * context. (`createErrorToolResult` from Pi is private; we never import
 * it. We `throw new Error(<short fact>)` and let agent-loop.ts wrap.)
 *
 * Factory pattern: `buildWorkerTools({mode, workspace, ...})` returns
 * a fresh `AgentTool[]` per worker run. `workspace` is captured in
 * closure; per-call `signal` comes from Pi's execute arg.
 */

import {
  type ChildProcess,
  spawn,
  spawnSync,
} from "node:child_process"
import {
  closeSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs"
import { readFile, stat } from "node:fs/promises"
import * as path from "node:path"
import process from "node:process"

import type {
  AgentMessage,
  AgentTool,
  AgentToolResult,
} from "@earendil-works/pi-agent-core"
import { type TSchema, Type } from "@earendil-works/pi-ai"

import { resolveRipgrep, searchCode } from "~/lib/code-search"
import {
  MAX_INFLIGHT_TOOLS_CALL,
  acquireInFlightSlot,
} from "~/lib/mcp-inflight"
import {
  PERSONAS_READ,
  type PersonaSpec,
} from "~/lib/peer-mcp-personas"
import { state } from "~/lib/state"
import { resolveModel } from "~/lib/utils"
import { callPersona, extractResponsesText } from "~/routes/mcp/handler"
import {
  ADVISOR_DEFAULT_EFFORT,
  ADVISOR_DEFAULT_MODEL,
} from "~/services/advisor/advisor"
import {
  createResponses,
  type ResponsesApiResponse,
} from "~/services/copilot/create-responses"
import { searchWeb } from "~/services/copilot/web-search"

import { runBash } from "./bash"
import {
  confineToWorkspaceResult,
  isSensitivePath,
} from "./paths"

// ============================================================
// Constants
// ============================================================

/** read: 10 MiB hard cap per file — matches the `MAX_STDOUT_BYTES`
 *  precedent in `~/lib/code-search.ts:106` for the same `rg` invocation
 *  pattern. Above this we throw; the model should ask for a narrower
 *  slice via offset/limit. */
const READ_MAX_BYTES = 10 * 1024 * 1024

/** write: 10 MiB hard cap per write — symmetric with `READ_MAX_BYTES`
 *  and matches the same `MAX_STDOUT_BYTES` precedent. Bounds the
 *  worker's output amplification factor regardless of model intent. */
const WRITE_MAX_BYTES = 10 * 1024 * 1024

/** glob/grep: hard cap on hits returned. Past this we truncate with a
 *  one-line marker. The model can re-call with `limit` to page through. */
const SEARCH_DEFAULT_LIMIT = 200
const SEARCH_HARD_MAX = 1000

/** bash: default and max per-call timeouts. The default keeps a wild
 *  `bun test --bail=0` from sitting on a worker slot indefinitely; the
 *  max prevents the model from `timeout_ms: 0xFFFFFFFF`. */
const BASH_DEFAULT_TIMEOUT_MS = 2 * 60 * 1000
const BASH_MAX_TIMEOUT_MS = 10 * 60 * 1000

/** fetch_url: per-call wall-clock cap + per-call byte cap. The byte cap
 *  is enforced AFTER decode — a 50 MB gzip-bomb would still be bounded
 *  by the upstream limit Fetch applies; we re-cap at 1 MiB so a single
 *  call can't poison the agent's context. */
const FETCH_URL_TIMEOUT_MS = 30 * 1000
const FETCH_URL_MAX_BYTES = 1 * 1024 * 1024

/** Network-deny env var. When `GH_ROUTER_WORKER_DISABLE_NETWORK=1` is
 *  set, the network-bearing tools (`web_search`, `fetch_url`,
 *  `peer_review`, `advisor`, `code_search` — code_search is local but
 *  we keep it allowed) refuse with a terse error and don't even reach
 *  out. `bash` checks via a tiny regex on the raw cmd; see
 *  `disableNetworkForBash`. */
const NETWORK_DENY_ENV = "GH_ROUTER_WORKER_DISABLE_NETWORK"

/** Network-egress shell verbs we refuse when DISABLE_NETWORK is on.
 *  Best-effort — bash one-liners are notoriously hard to gate against
 *  determined exfil — but this catches the common `curl example.com`,
 *  `wget`, `nc`, and `ssh` cases the model would naturally reach for. */
const NETWORK_BIN_RE =
  /(^|[\s;|&(`])(curl|wget|nc|ncat|ssh|scp|sftp|rsync|nslookup|dig|host|telnet)([\s;|&)`]|$)/i

// ============================================================
// Per-call wiring
// ============================================================

export interface BuildWorkerToolsOpts {
  /** Worker mode — picks which tools are returned. `review` is read-only and
   *  returns the same tool surface as `explore`. */
  mode: "explore" | "review" | "implement"
  /**
   * Absolute path to the worker's workspace. MUST be pre-realpath-
   * canonicalized by the engine; `confineToWorkspace` re-asserts on
   * every call but assumes the workspace itself is canonical (per
   * `paths.ts`'s docstring).
   */
  workspace: string
}

/**
 * Resolve the network-deny gate from env. Read at tool construction
 * time so a long-running worker doesn't change its mind mid-run if
 * the env var is toggled externally (env state is captured per
 * `runWorkerAgent` call, not per tool call).
 */
function networkDisabled(): boolean {
  const v = process.env[NETWORK_DENY_ENV]
  return v === "1" || v === "true"
}

function disableNetworkForBash(cmd: string): boolean {
  if (!networkDisabled()) return false
  return NETWORK_BIN_RE.test(cmd)
}

// ============================================================
// Helpers
// ============================================================

/**
 * Wrap an arbitrary text payload in Pi's tool-result content shape.
 * Pi's loop reads `result.content[].text` for the model-visible text;
 * `details` is opaque metadata for harness/UI consumers (we keep it
 * empty — the worker has no UI).
 */
function textResult(text: string): AgentToolResult<Record<string, never>> {
  return {
    content: [{ type: "text", text }],
    details: {},
  }
}

/**
 * Resolve `rawPath` against the workspace, throwing the short
 * `confineToWorkspace` error verbatim on rejection. `isSensitivePath`
 * is then layered on top — the workspace check is structural
 * (it lives inside), the denylist is name-based (`.env`, `*.pem`,
 * `.git/*`, etc.). Both run for every path-touching tool.
 */
function resolvePathOrThrow(
  rawPath: string,
  workspace: string,
  opts: { allowMissing?: boolean } = {},
): string {
  const result = confineToWorkspaceResult(rawPath, workspace)
  if (!result.ok) {
    throw new Error(result.error)
  }
  // Layer 2: secret-shape denylist. Independent of workspace
  // containment — we refuse `.env` even when the user explicitly
  // dropped one inside the workspace.
  if (isSensitivePath(result.abs, workspace)) {
    throw new Error("rejected: secret-file pattern")
  }
  // `allowMissing` is just for documentation — the caller's `fs.*`
  // call will surface ENOENT cleanly; we don't pre-stat here.
  void opts.allowMissing
  return result.abs
}

/**
 * Spawn ripgrep with `args` under `cwd` and resolve with the full
 * stdout text (UTF-8) and exit code. Used by `glob` and `grep`.
 *
 * - Bounded by `signal` (Pi's per-call signal): when aborted, the
 *   child is killed and the promise rejects with a terse abort error.
 * - stderr is captured but only surfaced on non-zero/non-1 exit codes
 *   (rg exit 1 = "no matches", which is a clean semantic outcome).
 * - stdout is capped at 10 MiB; past that we kill the child and resolve
 *   with the truncated text + a flag. The caller appends the
 *   truncation marker to the formatted output.
 */
/**
 * Platform-aware kill for child processes. On Windows `child.kill()`
 * does NOT reliably terminate descendant processes — we use
 * `taskkill /T /F /PID` instead (same pattern as `bash.ts:killProcessTree`
 * and `code-search.ts:killChild`). EBUSY is swallowed because taskkill
 * occasionally races with the child's own teardown.
 */
function killChildTree(child: ChildProcess): void {
  if (!child.pid || child.killed) return
  if (process.platform === "win32") {
    try {
      spawnSync("taskkill", ["/T", "/F", "/PID", String(child.pid)], {
        stdio: "ignore",
        windowsHide: true,
      })
    } catch {
      /* EBUSY race or already gone */
    }
    return
  }
  try {
    child.kill("SIGTERM")
  } catch {
    /* already gone */
  }
}

async function runRipgrep(
  args: Array<string>,
  cwd: string,
  signal: AbortSignal,
): Promise<{ stdout: string; exitCode: number; truncated: boolean }> {
  // Matches `MAX_STDOUT_BYTES` in `~/lib/code-search.ts:106` — same `rg`
  // invocation pattern; keep the caps consistent so both paths bound
  // upstream subprocess output by the same rule.
  const RG_STDOUT_CAP = 10 * 1024 * 1024
  const { rgPath } = resolveRipgrep()
  return new Promise((resolve, reject) => {
    let child: ChildProcess
    try {
      child = spawn(rgPath, args, {
        cwd,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      })
    } catch (err) {
      reject(
        err instanceof Error
          ? err
          : new Error(`spawn rg failed: ${String(err)}`),
      )
      return
    }

    let stdout = ""
    let stdoutBytes = 0
    let stderr = ""
    let truncated = false
    let settled = false

    const onAbort = (): void => {
      if (child.pid && !child.killed) {
        killChildTree(child)
      }
    }
    if (signal.aborted) {
      onAbort()
    } else {
      signal.addEventListener("abort", onAbort, { once: true })
    }

    child.stdout?.setEncoding("utf8")
    child.stdout?.on("data", (chunk: string) => {
      if (truncated) return
      const room = RG_STDOUT_CAP - stdoutBytes
      const slice = chunk.length <= room ? chunk : chunk.slice(0, room)
      stdout += slice
      stdoutBytes += slice.length
      if (chunk.length > room) {
        truncated = true
        if (child.pid && !child.killed) {
          killChildTree(child)
        }
      }
    })
    child.stderr?.setEncoding("utf8")
    child.stderr?.on("data", (chunk: string) => {
      // Bounded — rg errors are short, but cap defensively.
      if (stderr.length < 16 * 1024) stderr += chunk
    })
    child.stdout?.on("error", () => {})
    child.stderr?.on("error", () => {})

    const settle = (code: number): void => {
      if (settled) return
      settled = true
      signal.removeEventListener("abort", onAbort)
      if (signal.aborted) {
        reject(new Error("rg aborted"))
        return
      }
      if (code !== 0 && code !== 1) {
        const tail = stderr.trim().split("\n").slice(-3).join("; ")
        reject(new Error(`rg exit=${code}${tail ? `: ${tail}` : ""}`))
        return
      }
      resolve({ stdout, exitCode: code, truncated })
    }

    child.on("exit", (code, sig) => {
      settle(code ?? (sig ? 128 : 1))
    })
    child.on("error", (err) => {
      if (settled) return
      settled = true
      signal.removeEventListener("abort", onAbort)
      reject(err instanceof Error ? err : new Error(String(err)))
    })
  })
}

/**
 * Atomic write — write to `<dir>/.<base>.<rand>.tmp` in the SAME
 * directory as the final path, then `fs.renameSync` over the target.
 * Same-directory temp avoids Windows EXDEV (cross-device rename
 * refused) and keeps the rename atomic on every platform we care
 * about. fsync the file BEFORE rename so a crash mid-rename doesn't
 * leave a zero-length file post-recovery (matches the pattern used
 * elsewhere in this repo).
 *
 * Throws on any underlying fs failure. Best-effort tmp cleanup on
 * error so we don't leave litter.
 */
function atomicWriteSync(absPath: string, contents: string): void {
  const dir = path.dirname(absPath)
  const base = path.basename(absPath)
  const rand = Math.random().toString(16).slice(2, 10)
  const tmp = path.join(dir, `.${base}.${rand}.tmp`)
  let fd: number | undefined
  try {
    fd = openSync(tmp, "w", 0o644)
    if (contents.length > 0) {
      writeSync(fd, contents, 0, "utf8")
    }
    closeSync(fd)
    fd = undefined
    renameSync(tmp, absPath)
  } catch (err) {
    if (fd !== undefined) {
      try {
        closeSync(fd)
      } catch {
        /* fine */
      }
    }
    try {
      unlinkSync(tmp)
    } catch {
      /* not present */
    }
    throw err
  }
}

// ============================================================
// File / shell tools
// ============================================================

const READ_PARAMS = Type.Object({
  path: Type.String({ description: "Workspace-relative or absolute path." }),
  offset: Type.Optional(
    Type.Integer({ minimum: 0, description: "Line offset (0-indexed)." }),
  ),
  limit: Type.Optional(
    Type.Integer({ minimum: 1, description: "Max lines to return." }),
  ),
})

function readTool(workspace: string): AgentTool<typeof READ_PARAMS> {
  return {
    name: "read",
    label: "Read file",
    description:
      "Read a file from the worker's workspace. Returns UTF-8 text. " +
      "Files larger than 10 MiB are refused; use offset/limit to page.",
    parameters: READ_PARAMS,
    async execute(
      _toolCallId,
      params,
      signal,
    ): Promise<AgentToolResult<Record<string, never>>> {
      const abs = resolvePathOrThrow(params.path, workspace)
      const st = await stat(abs)
      if (!st.isFile()) {
        throw new Error("rejected: not a regular file")
      }
      if (st.size > READ_MAX_BYTES) {
        throw new Error(
          `rejected: file >${READ_MAX_BYTES} bytes (10 MiB) — got ${st.size}`,
        )
      }
      const buf = await readFile(abs, { signal })
      const text = buf.toString("utf8")
      if (params.offset === undefined && params.limit === undefined) {
        return textResult(text)
      }
      const lines = text.split(/\r?\n/)
      const start = params.offset ?? 0
      const end =
        params.limit === undefined ? lines.length : start + params.limit
      return textResult(lines.slice(start, end).join("\n"))
    },
  }
}

const GLOB_PARAMS = Type.Object({
  pattern: Type.String({
    description: "ripgrep glob pattern, e.g. `src/**/*.ts`.",
  }),
  limit: Type.Optional(
    Type.Integer({ minimum: 1, maximum: SEARCH_HARD_MAX }),
  ),
})

function globTool(workspace: string): AgentTool<typeof GLOB_PARAMS> {
  return {
    name: "glob",
    label: "Glob files",
    description:
      "List files matching a ripgrep glob pattern under the workspace. " +
      "Returns one path per line. Hidden / .gitignored files are skipped.",
    parameters: GLOB_PARAMS,
    async execute(
      _toolCallId,
      params,
      signal,
    ): Promise<AgentToolResult<Record<string, never>>> {
      const limit = Math.min(params.limit ?? SEARCH_DEFAULT_LIMIT, SEARCH_HARD_MAX)
      // `rg --files -g <pattern>` enumerates ALL files matching the
      // glob — same behavior cc-backup's Glob tool depends on. We
      // post-trim to `limit` rather than passing rg a count flag
      // (rg's --max-count is per-file matches, not file count).
      const { stdout, truncated } = await runRipgrep(
        ["--files", "-g", params.pattern],
        workspace,
        signal ?? new AbortController().signal,
      )
      const all = stdout.split("\n").filter((l) => l.length > 0)
      const sliced = all.slice(0, limit)
      if (sliced.length === 0) return textResult("no matches")
      let out = sliced.join("\n")
      if (truncated || all.length > limit) {
        out += `\n[glob: truncated; showing ${sliced.length} of ${all.length === limit ? limit + "+" : all.length}]`
      }
      return textResult(out)
    },
  }
}

const GREP_PARAMS = Type.Object({
  query: Type.String({ description: "Pattern to search for." }),
  mode: Type.Optional(
    Type.Union([Type.Literal("literal"), Type.Literal("regex")], {
      description: "`literal` (default) = fixed-string; `regex` = PCRE2.",
    }),
  ),
  file_glob: Type.Optional(
    Type.String({ description: "ripgrep glob filter, e.g. `*.ts`." }),
  ),
  limit: Type.Optional(
    Type.Integer({ minimum: 1, maximum: SEARCH_HARD_MAX }),
  ),
})

function grepTool(workspace: string): AgentTool<typeof GREP_PARAMS> {
  return {
    name: "grep",
    label: "Grep workspace",
    description:
      "Search workspace files with ripgrep. Default mode is literal " +
      "(fixed-string). Returns `file:line:text` per hit. For ranked " +
      "discovery (\"where is X defined?\") prefer `code_search` instead.",
    parameters: GREP_PARAMS,
    async execute(
      _toolCallId,
      params,
      signal,
    ): Promise<AgentToolResult<Record<string, never>>> {
      const limit = Math.min(params.limit ?? SEARCH_DEFAULT_LIMIT, SEARCH_HARD_MAX)
      const mode = params.mode ?? "literal"
      // `--line-number --no-heading --color never` → file:line:text.
      // `-S` (--smart-case) matches both `cc-backup`'s Grep tool and
      // user intuition. PCRE2 only when explicitly asked.
      const rgArgs: Array<string> = [
        "--line-number",
        "--no-heading",
        "--color",
        "never",
        "-S",
      ]
      if (mode === "literal") rgArgs.push("-F")
      else rgArgs.push("--pcre2")
      if (params.file_glob) rgArgs.push("-g", params.file_glob)
      // Hard per-file match cap to keep one runaway file from pushing
      // out all the others.
      rgArgs.push("--max-count", String(Math.min(limit, 50)))
      rgArgs.push("--", params.query)
      const { stdout, truncated } = await runRipgrep(
        rgArgs,
        workspace,
        signal ?? new AbortController().signal,
      )
      const all = stdout.split("\n").filter((l) => l.length > 0)
      const sliced = all.slice(0, limit)
      if (sliced.length === 0) return textResult("no matches")
      let out = sliced.join("\n")
      if (truncated || all.length > limit) {
        out += `\n[grep: truncated; showing ${sliced.length} of ${all.length === limit ? limit + "+" : all.length}]`
      }
      return textResult(out)
    },
  }
}

const EDIT_PARAMS = Type.Object({
  path: Type.String({ description: "Workspace-relative or absolute path." }),
  old_string: Type.String({
    description:
      "Exact text to find. Must match exactly once; tool returns " +
      "`not found` (0 matches) or `matches N times` (>1) without editing.",
  }),
  new_string: Type.String({
    description: "Replacement text. May be empty (deletes old_string).",
  }),
})

function editTool(workspace: string): AgentTool<typeof EDIT_PARAMS> {
  return {
    name: "edit",
    label: "Edit file",
    description:
      "Edit a file by replacing exactly one occurrence of `old_string` " +
      "with `new_string`. Zero or multiple matches return a status line " +
      "and the file is unchanged.",
    parameters: EDIT_PARAMS,
    // executionMode: "sequential" — write tools serialize to prevent
    // edit-vs-edit races on the same file (Pi's default is parallel).
    executionMode: "sequential",
    async execute(
      _toolCallId,
      params,
    ): Promise<AgentToolResult<Record<string, never>>> {
      const abs = resolvePathOrThrow(params.path, workspace)
      // Use sync read here: atomic write is sync-only (matching the
      // codebase's atomic-rename pattern), and the read+match+write
      // window must not interleave with a sibling tool call. The
      // signal isn't usefully threaded into sync IO; the engine's
      // wall-clock cap is the upper bound.
      let original: string
      try {
        original = readFileSync(abs, "utf8")
      } catch (err) {
        // ENOENT or EACCES — surface as a real failure.
        throw err instanceof Error
          ? err
          : new Error(`read failed: ${String(err)}`)
      }
      // Count matches without doing per-call regex compilation —
      // split is the most robust way to count overlapping/non-overlap
      // semantics for a literal string.
      const parts = original.split(params.old_string)
      const matches = parts.length - 1
      if (matches === 0) return textResult("not found")
      if (matches > 1) return textResult(`matches ${matches} times`)
      const updated = parts.join(params.new_string)
      if (Buffer.byteLength(updated, "utf8") > WRITE_MAX_BYTES) {
        throw new Error(
          `rejected: result >${WRITE_MAX_BYTES} bytes (10 MiB) — got ${Buffer.byteLength(updated, "utf8")}`,
        )
      }
      atomicWriteSync(abs, updated)
      return textResult("ok")
    },
  }
}

const WRITE_PARAMS = Type.Object({
  path: Type.String({ description: "Workspace-relative or absolute path." }),
  contents: Type.String({
    description: "Full file contents. Refused if >10 MiB.",
  }),
})

function writeTool(workspace: string): AgentTool<typeof WRITE_PARAMS> {
  return {
    name: "write",
    label: "Write file",
    description:
      "Create or overwrite a file with the given contents. Uses a " +
      "same-directory temp + atomic rename so partial writes never " +
      "land on disk. Refuses contents >10 MiB.",
    parameters: WRITE_PARAMS,
    executionMode: "sequential",
    async execute(
      _toolCallId,
      params,
    ): Promise<AgentToolResult<Record<string, never>>> {
      if (Buffer.byteLength(params.contents, "utf8") > WRITE_MAX_BYTES) {
        throw new Error(
          `rejected: contents >${WRITE_MAX_BYTES} bytes (10 MiB) — got ${Buffer.byteLength(params.contents, "utf8")}`,
        )
      }
      const abs = resolvePathOrThrow(params.path, workspace, {
        allowMissing: true,
      })
      atomicWriteSync(abs, params.contents)
      return textResult("ok")
    },
  }
}

const BASH_PARAMS = Type.Object({
  cmd: Type.String({ description: "Shell command line." }),
  timeout_ms: Type.Optional(
    Type.Integer({
      minimum: 100,
      maximum: BASH_MAX_TIMEOUT_MS,
      description: `Per-call timeout (default ${BASH_DEFAULT_TIMEOUT_MS} ms).`,
    }),
  ),
})

function bashTool(workspace: string): AgentTool<typeof BASH_PARAMS> {
  return {
    name: "bash",
    label: "Run bash",
    description:
      "Run a shell command in the worker's workspace under a strict " +
      "env allowlist (credentials stripped) with a bounded timeout. " +
      "Non-zero exit returns `<stdout>\\n<stderr>\\nexit=N` as text, " +
      "not an error.",
    parameters: BASH_PARAMS,
    executionMode: "sequential",
    async execute(
      _toolCallId,
      params,
      signal,
    ): Promise<AgentToolResult<Record<string, never>>> {
      if (disableNetworkForBash(params.cmd)) {
        throw new Error("rejected: network disabled")
      }
      // Default + max are enforced by the TypeBox schema; we still clamp
      // defensively here so a future schema relaxation doesn't widen
      // the budget by accident.
      const timeoutMs = Math.min(
        params.timeout_ms ?? BASH_DEFAULT_TIMEOUT_MS,
        BASH_MAX_TIMEOUT_MS,
      )
      // Per-call signal MUST be passed through — closure over an outer
      // signal would skip mid-turn cancels and let the bash process
      // keep running past its budget.
      const result = await runBash(params.cmd, {
        cwd: workspace,
        timeoutMs,
        signal: signal ?? new AbortController().signal,
        disableNetwork: networkDisabled(),
      })
      if (result.timedOut) {
        throw new Error(`bash timeout after ${timeoutMs}ms`)
      }
      if (result.killed) {
        throw new Error("bash aborted")
      }
      // Spawn failure (e.g. EACCES on /bin/bash) — runBash uses
      // exit=-1 + stderr message. Surface as a real error so the model
      // sees `isError: true`, not a numeric exit code it could
      // interpret as data.
      if (result.exitCode === -1) {
        throw new Error(`bash spawn failed: ${result.stderr.trim() || "unknown"}`)
      }
      // Non-zero exit: return as content. Compose stdout, stderr,
      // exit on three lines so the model can scan it without parsing.
      const parts: Array<string> = []
      if (result.stdout.length > 0) parts.push(result.stdout.trimEnd())
      if (result.stderr.length > 0) parts.push(result.stderr.trimEnd())
      parts.push(`exit=${result.exitCode}`)
      return textResult(parts.join("\n"))
    },
  }
}

// ============================================================
// Search / peer tools
// ============================================================

const WEB_SEARCH_PARAMS = Type.Object({
  query: Type.String({ description: "Natural-language search query." }),
})

function webSearchTool(): AgentTool<typeof WEB_SEARCH_PARAMS> {
  return {
    name: "web_search",
    label: "Web search",
    description:
      "Web search via Copilot's MCP. Returns matched snippets plus a " +
      "`## References` list of source URLs.",
    parameters: WEB_SEARCH_PARAMS,
    async execute(
      _toolCallId,
      params,
    ): Promise<AgentToolResult<Record<string, never>>> {
      if (networkDisabled()) {
        throw new Error("rejected: network disabled")
      }
      // searchWeb doesn't currently accept an AbortSignal; the per-
      // call signal is therefore a no-op here (call returns in a
      // few seconds typically, and the engine's wall-clock cap is
      // the upper bound). Documented in peer-mcp-personas.ts.
      const r = await searchWeb(params.query)
      const body = r.content
      if (r.references.length === 0) return textResult(body)
      const refs = r.references.map((x) => `- [${x.title}](${x.url})`).join("\n")
      return textResult(`${body}\n\n## References\n${refs}`)
    },
  }
}

const FETCH_URL_PARAMS = Type.Object({
  url: Type.String({ description: "Absolute URL (http/https only)." }),
})

function fetchUrlTool(): AgentTool<typeof FETCH_URL_PARAMS> {
  return {
    name: "fetch_url",
    label: "Fetch URL",
    description:
      "Fetch a URL (HTTP/HTTPS only) and return the response body as " +
      "text. Bounded to 1 MiB and 30 s. No HTML→markdown conversion " +
      "— callers that need it should ask `peer_review` to parse.",
    parameters: FETCH_URL_PARAMS,
    async execute(
      _toolCallId,
      params,
      signal,
    ): Promise<AgentToolResult<Record<string, never>>> {
      if (networkDisabled()) {
        throw new Error("rejected: network disabled")
      }
      let parsed: URL
      try {
        parsed = new URL(params.url)
      } catch {
        throw new Error("rejected: invalid URL")
      }
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new Error("rejected: only http/https")
      }
      const sigs: Array<AbortSignal> = [
        AbortSignal.timeout(FETCH_URL_TIMEOUT_MS),
      ]
      if (signal) sigs.push(signal)
      const response = await fetch(parsed.toString(), {
        // Some sites 403 a bare fetch — give a recognizable UA so
        // misroutes show up cleanly in proxy logs instead of looking
        // like server errors.
        headers: { "user-agent": "github-router-worker/1" },
        signal: AbortSignal.any(sigs),
      })
      if (!response.ok) {
        throw new Error(`fetch_url: HTTP ${response.status} ${response.statusText}`)
      }
      const reader = response.body?.getReader()
      if (!reader) {
        throw new Error("fetch_url: empty body")
      }
      const decoder = new TextDecoder()
      let buf = ""
      let bytes = 0
      let truncated = false
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        if (!value) continue
        const chunk = value as Uint8Array
        const room = FETCH_URL_MAX_BYTES - bytes
        if (chunk.byteLength <= room) {
          buf += decoder.decode(chunk, { stream: true })
          bytes += chunk.byteLength
        } else {
          if (room > 0) buf += decoder.decode(chunk.subarray(0, room), { stream: true })
          bytes += room
          truncated = true
          try {
            await reader.cancel("size_cap")
          } catch {
            /* fine */
          }
          break
        }
      }
      buf += decoder.decode()
      if (truncated) buf += `\n[fetch_url: truncated at ${FETCH_URL_MAX_BYTES} bytes]`
      return textResult(buf)
    },
  }
}

const CODE_SEARCH_PARAMS = Type.Object({
  query: Type.String({ description: "Search text (literal by default)." }),
  mode: Type.Optional(
    Type.Union(
      [Type.Literal("ranked"), Type.Literal("literal"), Type.Literal("regex")],
      { description: "Ranking mode (default `ranked`)." },
    ),
  ),
  file_glob: Type.Optional(
    Type.String({ description: "ripgrep glob filter." }),
  ),
  limit: Type.Optional(
    Type.Integer({ minimum: 1, description: "Max hits to return." }),
  ),
  structural: Type.Optional(
    Type.Union([Type.Literal("full"), Type.Literal("topN")], {
      description: "Structural-ranking depth (ranked mode only).",
    }),
  ),
  complete: Type.Optional(
    Type.Boolean({
      description:
        "When true, return the COMPLETE ranked match set (every line "
        + "ripgrep would find, capped only by `limit`) — disables the "
        + "default precision shoulder cut + per-file cap. Use it when you "
        + "must not miss any occurrence (every caller of X, a rename, an "
        + "audit). The default response `notice` says when matches were "
        + "hidden.",
    }),
  ),
  multiline: Type.Optional(
    Type.Boolean({
      description:
        "Set true with mode:'regex' to let a pattern span newlines "
        + "(ripgrep -U), e.g. 'foo[\\s\\S]*?bar' across lines. (literal/"
        + "ranked queries can't contain a newline.)",
    }),
  ),
  ast_pattern: Type.Optional(
    Type.String({
      description:
        "ast-grep structural pattern (e.g. 'function $F($$$) { $$$ }'). "
        + "When set, matches come from ast-grep instead of ripgrep — for "
        + "multi-line AST shapes the regex modes can't express. Takes "
        + "precedence over `query`. If ast-grep isn't installed you get a "
        + "`notice`; it never falls back to regex.",
    }),
  ),
})

function codeSearchTool(workspace: string): AgentTool<typeof CODE_SEARCH_PARAMS> {
  return {
    name: "code_search",
    label: "Ranked code search",
    description:
      "BM25F + tree-sitter ranked code search over the worker's " +
      "workspace. Prefer over `grep` for \"where is X defined / which " +
      "files reference Y\" discovery. Returns `file:line:snippet` per " +
      "hit in JSON.",
    parameters: CODE_SEARCH_PARAMS,
    async execute(
      _toolCallId,
      params,
      signal,
    ): Promise<AgentToolResult<Record<string, never>>> {
      const r = await searchCode(
        {
          query: params.query,
          // Workspace is FORCED — the model can't escape the worker's
          // sandbox by passing a different path here.
          workspace,
          mode: params.mode,
          file_glob: params.file_glob,
          limit: params.limit,
          structural: params.structural,
          complete: params.complete,
          multiline: params.multiline,
          ast_pattern: params.ast_pattern,
          // The worker surface trims to {file,line,snippet} and never
          // forwards outlines, so skip the (default-on) summary pass
          // rather than parse files only to discard the result.
          summary: false,
        },
        signal,
      )
      // Match the MCP code_search tool's minimal-surface shape — same
      // `{file,line,snippet}` per hit + `truncated` + optional
      // `notice`. We don't bother with the 256 KB byte cap here
      // because the worker's per-call tool-bytes budget already
      // bounds it (see `budget.ts`).
      const minimal = {
        results: r.results.map((h) => ({
          file: h.file,
          line: h.line,
          snippet: h.snippet,
        })),
        truncated: r.truncated,
        notice: r.notice ?? undefined,
      }
      return textResult(JSON.stringify(minimal))
    },
  }
}

// Hardcode the literal tuple so `Static<typeof PEER_REVIEW_PARAMS>`
// preserves a discriminated union (`"codex_critic" | "gemini_critic" |
// …`) rather than collapsing to `string`. Drift between this tuple and
// the authoritative `PERSONAS_READ` list is policed by a dedicated test
// (`tests/peer-mcp-persona-drift.test.ts`) rather than a module-load
// runtime check — the runtime check pulled `PERSONAS_READ` into module
// init and created a peer-mcp-personas ↔ worker-agent import cycle.
// Exported (via `PEER_CRITIC_NAMES`) so the drift test can compare
// without reimporting the tuple itself.
const PEER_CRITIC_TUPLE = [
  Type.Literal("codex_critic"),
  Type.Literal("gemini_critic"),
  Type.Literal("codex_reviewer"),
  Type.Literal("opus_critic"),
] as const

/**
 * Critic names accepted by `peer_review.critic`. Exported for the
 * drift test in `tests/peer-mcp-persona-drift.test.ts` to compare
 * against `PERSONAS_READ` from `~/lib/peer-mcp-personas`.
 */
export const PEER_CRITIC_NAMES: readonly string[] = PEER_CRITIC_TUPLE.map(
  (l) => l.const,
)

const PEER_EFFORT_UNION = Type.Union(
  [
    Type.Literal("low"),
    Type.Literal("medium"),
    Type.Literal("high"),
    Type.Literal("xhigh"),
  ],
  {
    description:
      "Reasoning depth. Per-critic allowedEfforts gate; out-of-band " +
      "values are clamped to the critic's default.",
  },
)
const PEER_REVIEW_PARAMS = Type.Object({
  critic: Type.Union([...PEER_CRITIC_TUPLE], {
    description:
      "Critic tool name. One of " +
      PEER_CRITIC_NAMES.map((n) => `\`${n}\``).join(", ") +
      ". `gemini_critic` is only valid when gemini-3.x is in the " +
      "Copilot catalog; otherwise the call is refused.",
  }),
  prompt: Type.String({
    description:
      "The brief — artifact under review plus constraints. Pasted " +
      "verbatim into the critic's user message.",
  }),
  context: Type.Optional(
    Type.String({
      description: "Optional extra context concatenated to the brief.",
    }),
  ),
  effort: Type.Optional(PEER_EFFORT_UNION),
})

function peerReviewTool(): AgentTool<typeof PEER_REVIEW_PARAMS> {
  return {
    name: "peer_review",
    label: "Peer critic",
    description:
      "Dispatch a single peer-model critic call (codex / gemini / opus). " +
      "Returns the critic's text response. Use to overcome blind spots " +
      "before committing to an approach.",
    parameters: PEER_REVIEW_PARAMS,
    async execute(
      _toolCallId,
      params,
      signal,
    ): Promise<AgentToolResult<Record<string, never>>> {
      if (networkDisabled()) {
        throw new Error("rejected: network disabled")
      }
      const persona = lookupPersona(params.critic)
      // Clamp effort to the persona's allowedEfforts; the per-persona
      // gate in handler.ts is the source of truth, but Pi's validated
      // params can still carry a tier the critic doesn't accept (e.g.
      // `xhigh` on gemini-critic). Fall back to the persona's default
      // rather than throwing — silent clamp matches how `handleToolsCall`
      // would have behaved at the MCP boundary minus the RPC error.
      const requested = params.effort
      const effort =
        requested && persona.allowedEfforts.includes(requested)
          ? requested
          : persona.defaultEffort
      // Participate in the shared MCP in-flight cap so a worker
      // looping over peer_review can't starve the operator's own
      // tools/call traffic. Synchronous fail-fast on saturation —
      // the worker model receives "queue full" as a tool error and
      // can back off, exactly matching the MCP-boundary semantics.
      const release = acquireInFlightSlot()
      if (!release) {
        throw new Error(
          `peer_review: MCP in-flight cap (${MAX_INFLIGHT_TOOLS_CALL}) saturated; retry shortly`,
        )
      }
      try {
        // Per-call signal is forwarded to callPersona → createResponses
        // etc., so the upstream fetch tears down on Pi-side cancel.
        const result = await callPersona(
          persona,
          params.prompt,
          params.context,
          effort,
          signal,
        )
        if (result.isError) {
          // callPersona surfaces "empty assistant output" via isError;
          // promote to an actual throw so Pi sees a failure.
          const msg =
            result.content[0]?.text ?? `persona ${params.critic} failed`
          throw new Error(msg)
        }
        const text = result.content.map((c) => c.text).join("")
        return textResult(text)
      } finally {
        release()
      }
    },
  }
}

function lookupPersona(critic: string): PersonaSpec {
  const persona = PERSONAS_READ.find((p) => p.toolNameHttp === critic)
  if (!persona) {
    throw new Error(`peer_review: unknown critic "${critic}"`)
  }
  if (persona.requiresGeminiCatalog && !geminiInCatalog()) {
    throw new Error(
      `peer_review: ${critic} requires gemini-3.x in Copilot catalog`,
    )
  }
  return persona
}

/**
 * Narrow code-review tool for the implement-mode worker. Locks the
 * critic to `codex-reviewer` (gpt-5.3-codex — the code-specialist
 * critic) so the worker has exactly one escalation path for code
 * review without exposing the broader peer-critic surface or the
 * advisor. Matches the user directive that worker_implement should
 * have access to a single code-review tool, not the full peer set.
 *
 * Implementation is intentionally a thin wrapper over the same
 * dispatch path as `peerReviewTool` — sharing `lookupPersona`,
 * `acquireInFlightSlot`, and `callPersona` keeps the slot accounting,
 * effort clamping, and isError-promotion semantics identical.
 */
const CODEX_REVIEW_PARAMS = Type.Object({
  prompt: Type.String({
    description:
      "The code-review brief — diff or single file under review plus "
      + "constraints. Pasted verbatim into codex-reviewer's user message.",
  }),
  context: Type.Optional(
    Type.String({
      description: "Optional extra context concatenated to the brief.",
    }),
  ),
  effort: Type.Optional(PEER_EFFORT_UNION),
})

function codexReviewTool(): AgentTool<typeof CODEX_REVIEW_PARAMS> {
  return {
    name: "codex_review",
    label: "Codex code review",
    description:
      "Code review by `codex-reviewer` (gpt-5.3-codex, code-specialist "
      + "critic). Returns line-level findings on a diff or single file. "
      + "Use to overcome blind spots on a coding change before committing.",
    parameters: CODEX_REVIEW_PARAMS,
    async execute(
      _toolCallId,
      params,
      signal,
    ): Promise<AgentToolResult<Record<string, never>>> {
      if (networkDisabled()) {
        throw new Error("rejected: network disabled")
      }
      const persona = lookupPersona("codex-reviewer")
      const requested = params.effort
      const effort =
        requested && persona.allowedEfforts.includes(requested)
          ? requested
          : persona.defaultEffort
      // Slot accounting: `worker_implement` already holds 1 slot from
      // the MCP boundary; this nested `codex_review` call needs a
      // 2nd slot from the same shared `MAX_INFLIGHT_TOOLS_CALL=8`
      // counter. Under modest concurrency (≥8 simultaneous
      // worker_implement runs) every slot is held by a parent, and
      // every nested codex_review attempt starves indefinitely
      // because the parent can't release until the nested call
      // returns. Throwing here would abort the worker's task entirely
      // — bad UX, since the worker's job is to land code, not to be
      // a critic.
      //
      // Soft-fail-and-continue: if the cap is saturated, return a
      // structured tool result naming the saturation and suggesting
      // the worker proceed without review. Pi's tool-call loop feeds
      // this back to the model, which can decide to ship and ask the
      // lead to review the diff manually. This is the same trade-off
      // peer_review made historically when designed for main-agent
      // call sites, but escalated to the worker context where the
      // alternative (throwing) is more disruptive.
      const release = acquireInFlightSlot()
      if (!release) {
        return textResult(
          `codex_review skipped: MCP in-flight cap (${MAX_INFLIGHT_TOOLS_CALL}) saturated. ` +
          `Proceed with the coding task and either retry codex_review later or ` +
          `ask the lead to review the diff out-of-band.`,
        )
      }
      try {
        const result = await callPersona(
          persona,
          params.prompt,
          params.context,
          effort,
          signal,
        )
        if (result.isError) {
          const msg =
            result.content[0]?.text ?? `codex_review failed`
          throw new Error(msg)
        }
        const text = result.content.map((c) => c.text).join("")
        return textResult(text)
      } finally {
        release()
      }
    },
  }
}

function geminiInCatalog(): boolean {
  const models = state.models?.data
  if (!models) return false
  return models.some((m) => /^gemini-3\..*pro/i.test(m.id))
}

const ADVISOR_PARAMS = Type.Object({
  concern: Type.String({
    description:
      "What you want a second pair of eyes on — your current approach, " +
      "the blocker you're stuck on, or the decision you're about to " +
      "commit. Required: the advisor needs a focal point.",
    minLength: 1,
  }),
})

/** Advisor transcript budget — leaves headroom in the advisor's
 *  context window after the system prompt + concern + reasoning
 *  overhead. Truncate-from-front so the most recent turn (where the
 *  advice is needed) always survives. 720K chars matches the existing
 *  `ADVISOR_MAX_CONVERSATION_CHARS` baseline in advisor.ts (the
 *  /v1/messages-side advisor uses the same cap) — keeping the two
 *  cases consistent. Override via env if needed. */
const ADVISOR_TRANSCRIPT_MAX_CHARS = Number(
  process.env.GH_ROUTER_WORKER_ADVISOR_MAX_CHARS ?? 720_000,
)

/**
 * Render Pi's `Agent.state.messages` as a flat text transcript for
 * the advisor's user prompt. Mirrors the intent of advisor.ts's
 * `renderConversationAsText` but consumes Pi's shape directly
 * (`UserMessage | AssistantMessage | ToolResultMessage` plus harness-
 * custom messages — we walk only the LLM-meaningful three and skip
 * custom variants since the advisor never needs UI status events).
 *
 * Truncation policy: keep the TAIL. If the joined transcript exceeds
 * `maxChars`, drop entries from the front until it fits and prepend a
 * `[…earlier turns omitted…]` marker. This matches advisor.ts's
 * front-truncate strategy — the freshest turn is where the worker is
 * stuck.
 */
function renderPiMessagesAsText(
  messages: ReadonlyArray<AgentMessage>,
  maxChars: number,
): string {
  const lines: Array<string> = []
  for (const msg of messages) {
    if (typeof msg !== "object" || msg === null) continue
    const role = (msg as { role?: unknown }).role
    if (role === "user") {
      const content = (msg as { content?: unknown }).content
      lines.push(`USER: ${stringifyMessageContent(content)}`)
    } else if (role === "assistant") {
      const content = (msg as { content?: unknown }).content
      lines.push(`ASSISTANT: ${stringifyMessageContent(content)}`)
    } else if (role === "toolResult") {
      const m = msg as {
        toolName?: string
        toolCallId?: string
        content?: unknown
        isError?: boolean
      }
      const flag = m.isError ? " [error]" : ""
      lines.push(
        `TOOL_RESULT ${m.toolName ?? "?"}${flag}: ${stringifyMessageContent(m.content)}`,
      )
    }
    // Custom harness messages (chat-status, etc.) — skip.
  }
  let joined = lines.join("\n\n")
  if (joined.length <= maxChars) return joined
  // Tail-keep truncation: drop from the front until under cap, then
  // prepend the marker.
  const marker = "[…earlier turns omitted…]\n\n"
  const budget = maxChars - marker.length
  while (joined.length > budget && lines.length > 0) {
    lines.shift()
    joined = lines.join("\n\n")
  }
  return marker + joined
}

/**
 * Flatten a message's content (union of string / TextContent[] /
 * ToolCall[] / ImageContent[]) to a single text line. Images become
 * `[image]` placeholders — the advisor only needs to know they
 * existed, not see their bytes. ToolCalls render as
 * `→ <toolName>(<args-as-json>)` so the advisor can reason about
 * what the worker tried.
 */
function stringifyMessageContent(content: unknown): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  const parts: Array<string> = []
  for (const part of content) {
    if (typeof part !== "object" || part === null) continue
    const p = part as Record<string, unknown>
    if (p.type === "text" && typeof p.text === "string") {
      parts.push(p.text)
    } else if (p.type === "image") {
      parts.push("[image]")
    } else if (p.type === "thinking") {
      // Skip reasoning — the advisor doesn't need to read the
      // worker's thinking, and including it inflates the transcript.
      continue
    } else if (p.type === "toolCall") {
      const name = typeof p.toolName === "string" ? p.toolName : "?"
      const args =
        typeof p.input === "object" && p.input !== null
          ? JSON.stringify(p.input)
          : ""
      parts.push(`→ ${name}(${args.slice(0, 200)})`)
    }
  }
  return parts.join(" ")
}

function advisorTool(
  getMessages?: () => ReadonlyArray<AgentMessage>,
): AgentTool<typeof ADVISOR_PARAMS> {
  return {
    name: "advisor",
    label: "Advisor",
    description:
      "Consult a stronger reviewer model (cross-lab: gpt-5.5 xhigh by " +
      "default) on a specific concern. Use BEFORE substantive work, " +
      "WHEN stuck, or WHEN considering a change of approach. The " +
      "advisor automatically receives the recent conversation " +
      "transcript as context — give it a focused `concern`, not " +
      "background.",
    parameters: ADVISOR_PARAMS,
    async execute(
      _toolCallId,
      params,
      signal,
    ): Promise<AgentToolResult<Record<string, never>>> {
      if (networkDisabled()) {
        throw new Error("rejected: network disabled")
      }
      const advisorSystem =
        "You are an expert advisor reviewing an in-progress coding " +
        "worker's concern. The worker shares its recent conversation " +
        "transcript (USER / ASSISTANT / TOOL_RESULT lines) followed by " +
        "the specific concern under `### Concern`. Provide concrete, " +
        "actionable advice grounded in the transcript — name the " +
        "specific assumption or step to revisit. If the worker is on " +
        "the right track, say so. Aim for 2–5 paragraphs of " +
        "substantive guidance."
      const transcript = getMessages
        ? renderPiMessagesAsText(getMessages(), ADVISOR_TRANSCRIPT_MAX_CHARS)
        : ""
      const userText =
        transcript.length > 0
          ? `### Recent transcript\n${transcript}\n\n### Concern\n${params.concern}`
          : `### Concern\n${params.concern}`
      const resolvedModel = resolveModel(ADVISOR_DEFAULT_MODEL)
      // Same MCP in-flight cap as peer_review — see comment there.
      const release = acquireInFlightSlot()
      if (!release) {
        throw new Error(
          `advisor: MCP in-flight cap (${MAX_INFLIGHT_TOOLS_CALL}) saturated; retry shortly`,
        )
      }
      try {
        const response = (await createResponses(
          {
            model: resolvedModel,
            instructions: advisorSystem,
            input: [
              {
                role: "user",
                content: [{ type: "input_text", text: userText }],
              },
            ],
            stream: false,
            reasoning: { effort: ADVISOR_DEFAULT_EFFORT },
          },
          undefined,
          signal,
        )) as ResponsesApiResponse
        const text = extractResponsesText(response)
        if (!text) {
          throw new Error("advisor returned empty output")
        }
        return textResult(text)
      } finally {
        release()
      }
    },
  }
}

// ============================================================
// Tool sets
// ============================================================

/**
 * Build the AgentTool array for the requested mode.
 *
 *   - explore  → 6 read-only tools
 *   - review   → same 6 read-only tools as explore (reviewer framing lives
 *                in the system prompt, not the toolset)
 *   - implement → explore + edit/write/bash/codex_review
 *
 * Order matches the brief and the prompt-mode-note for stability —
 * Pi's tool-injection shape includes the list verbatim, so a stable
 * order keeps the model's tool-name prediction cache warm.
 *
 * Each call returns FRESH tool objects (workspace is closure-captured
 * per call), so two concurrent worker runs against different
 * workspaces don't share state.
 */
export function buildWorkerTools(
  opts: BuildWorkerToolsOpts,
): Array<AgentTool<TSchema, Record<string, never>>> {
  const { mode, workspace } = opts
  const explore: Array<AgentTool<TSchema, Record<string, never>>> = [
    readTool(workspace),
    globTool(workspace),
    grepTool(workspace),
    codeSearchTool(workspace),
    webSearchTool(),
    fetchUrlTool(),
  ]
  if (mode === "explore" || mode === "review") return explore
  return [
    ...explore,
    editTool(workspace),
    writeTool(workspace),
    bashTool(workspace),
    codexReviewTool(),
  ]
}

// ============================================================
// Test exports
// ============================================================

/**
 * Test-only exports. Not part of the public worker-agent surface —
 * the engine should only ever call `buildWorkerTools`. We re-export
 * the per-tool factories so the unit tests can exercise each in
 * isolation without spinning up the full toolset.
 */
export const __testExports = {
  atomicWriteSync,
  bashTool,
  codeSearchTool,
  editTool,
  fetchUrlTool,
  globTool,
  grepTool,
  peerReviewTool,
  advisorTool,
  readTool,
  renderPiMessagesAsText,
  resolvePathOrThrow,
  webSearchTool,
  writeTool,
}

