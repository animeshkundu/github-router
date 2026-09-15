/**
 * Rich default status line for `github-router claude` sessions.
 *
 * Replaces the need for users to maintain their own PowerShell/bash status
 * script: `internal-aic-status` renders these segments natively from the
 * Claude Code stdin JSON, then pins the `[AIC x.xx]` ledger fragment ahead
 * of them. Zero dependencies, cross-platform (Windows 11 is the primary
 * target — no `powershell`/`bash`/`jq` required), and fast (no shell
 * startup; one bounded `git rev-parse` at most).
 *
 * Segment order (left = highest priority; narrow terminals drop from the
 * right, `AIC` is never dropped):
 *
 *   `[AIC] | [ctx bar] % | model | dir (branch) | ~$actual | in/out | dur | +a -r`
 *
 * The `$` segment is the DISCOUNTED actual (`~$` = session AIC × $0.01,
 * the same 1-credit-≈-1¢ convention as the exit summary) — NOT Claude's
 * `cost.total_cost_usd`, which prices at Anthropic list rates and reads
 * ~10-100x high against Copilot billing (a 28-day sample: 41.1B tokens
 * for $5,142 ≈ $0.13/1M blended vs $15-75/1M list). Rendering list price
 * next to the real `[AIC]` billing unit would show two contradictory
 * numbers, so list price is deliberately not rendered at all.
 *
 * Width comes from `COLUMNS` (set by Claude Code for status scripts since
 * v2.1.153); fallback is 120 when unset/unparseable so a missing `COLUMNS`
 * never needlessly drops segments.
 */

import { spawnSync } from "node:child_process"

import {
  buildExecInvocation,
  resolveExecutable,
} from "./exec"

const ESC = "\x1b"
const RESET = `${ESC}[0m`
const DIM = `${ESC}[90m`
const GREEN = `${ESC}[32m`
const YELLOW = `${ESC}[33m`
const RED = `${ESC}[31m`
const ORANGE = `${ESC}[38;5;208m`
const CYAN = `${ESC}[36m`
const MAGENTA = `${ESC}[35m`
const BLUE = `${ESC}[34m`
const AIC_COLOR = `${ESC}[1;33m`

const CTX_BAR_LEN = 10
const GIT_TIMEOUT_MS = 300
const WIDTH_FALLBACK = 120
const SEP_PLAIN = " | "
const SEP_TEXT = `${DIM} | ${RESET}`

export interface StatusInput {
  usedPct?: number
  totalInputTokens?: number
  totalOutputTokens?: number
  totalDurationMs?: number
  linesAdded?: number
  linesRemoved?: number
  cwd?: string
  modelName?: string
}

export interface StatusSegment {
  text: string
  plain: string
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined
  }
  return value as Record<string, unknown>
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

/**
 * Parse Claude Code's status-line stdin JSON into the fields we render.
 * Total function: malformed JSON or unexpected shapes yield `{}` (every
 * segment then renders its `--` placeholder or is omitted) — never throws.
 */
export function parseStatusInput(raw: string): StatusInput {
  if (!raw.trim()) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(raw) as unknown
  } catch {
    return {}
  }
  const root = asRecord(parsed)
  if (!root) return {}
  const out: StatusInput = {}

  const ctx = asRecord(root.context_window)
  if (ctx) {
    const pct = finiteNumber(ctx.used_percentage)
    if (pct !== undefined) out.usedPct = pct
    const tIn = finiteNumber(ctx.total_input_tokens)
    if (tIn !== undefined && tIn >= 0) out.totalInputTokens = Math.floor(tIn)
    const tOut = finiteNumber(ctx.total_output_tokens)
    if (tOut !== undefined && tOut >= 0) out.totalOutputTokens = Math.floor(tOut)
  }

  const cost = asRecord(root.cost)
  if (cost) {
    const dur = finiteNumber(cost.total_duration_ms)
    if (dur !== undefined && dur >= 0) out.totalDurationMs = dur
    const la = finiteNumber(cost.total_lines_added)
    if (la !== undefined && la >= 0) out.linesAdded = Math.floor(la)
    const lr = finiteNumber(cost.total_lines_removed)
    if (lr !== undefined && lr >= 0) out.linesRemoved = Math.floor(lr)
  }

  const workspace = asRecord(root.workspace)
  const wsDir = workspace ? nonEmptyString(workspace.current_dir) : undefined
  const cwd = wsDir ?? nonEmptyString(root.cwd)
  if (cwd) out.cwd = cwd

  const model = asRecord(root.model)
  if (model) {
    const name =
      nonEmptyString(model.display_name) ?? nonEmptyString(model.id)
    if (name) out.modelName = name
  }

  return out
}

/** Compact token count: `999` → `999`, `15234` → `15.2k`, `2.1M`. */
export function compactTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return `${n}`
}

/** `45000` → `0m45s`, `198000` → `3m18s`, `3720000` → `1h02m`. */
export function formatDurationMs(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000)
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  if (hours >= 1) {
    return `${hours}h${String(minutes).padStart(2, "0")}m`
  }
  return `${minutes}m${String(seconds).padStart(2, "0")}s`
}

/** Basename of a cwd, tolerant of `/` and `\` separators + trailing slash. */
export function dirLeaf(cwd: string): string {
  const trimmed = cwd.replace(/[/\\]+$/, "")
  const parts = trimmed.split(/[/\\]/)
  return parts[parts.length - 1] ?? trimmed
}

export function buildCtxSegment(usedPct: number | undefined): StatusSegment {
  if (usedPct === undefined || !Number.isFinite(usedPct)) {
    return {
      text: `${DIM}[----------] --%${RESET}`,
      plain: "[----------] --%",
    }
  }
  const u = Math.max(0, Math.min(100, Math.round(usedPct)))
  let filled = Math.round((u / 100) * CTX_BAR_LEN)
  if (filled > CTX_BAR_LEN) filled = CTX_BAR_LEN
  if (filled < 0) filled = 0
  const bar = `#`.repeat(filled) + `-`.repeat(CTX_BAR_LEN - filled)
  const color = u < 50 ? GREEN : u < 75 ? YELLOW : RED
  return {
    text: `${color}[${bar}] ${u}%${RESET}`,
    plain: `[${bar}] ${u}%`,
  }
}

/**
 * AIC credits → discounted USD. 1 credit ≈ $0.01 — the same convention as
 * the session exit summary (`aic-ledger.ts`). The `~` prefix marks the
 * 1¢/credit approximation (GitHub bills in credits, not dollars).
 */
export const USD_PER_AIC_CREDIT = 0.01

export function usdFromAicCredits(credits: number): number {
  return credits * USD_PER_AIC_CREDIT
}

/**
 * Discounted-actual `$` segment from session AIC credits. Placeholder
 * `~$--` until the first priced upstream response lands in the ledger.
 * Thresholds are tuned for ACTUALS scale (a session runs ~$0.10-2.00) —
 * not the old list-price scale.
 */
export function buildUsdSegment(
  aicCredits: number | undefined,
): StatusSegment {
  if (aicCredits === undefined || !Number.isFinite(aicCredits) || aicCredits < 0) {
    return { text: `${DIM}~$--${RESET}`, plain: "~$--" }
  }
  const c = usdFromAicCredits(aicCredits)
  const color = c < 1 ? GREEN : c < 5 ? YELLOW : c < 20 ? ORANGE : RED
  const formatted = c < 10 ? c.toFixed(2) : c.toFixed(1)
  return {
    text: `${color}~$${formatted}${RESET}`,
    plain: `~$${formatted}`,
  }
}

export function buildToksSegment(
  tIn: number | undefined,
  tOut: number | undefined,
): StatusSegment {
  if (tIn === undefined || tOut === undefined) {
    return { text: `${DIM}--/--${RESET}`, plain: "--/--" }
  }
  const cin = compactTokens(tIn)
  const cout = compactTokens(tOut)
  return {
    text: `${CYAN}${cin}${RESET}${DIM}/${RESET}${MAGENTA}${cout}${RESET}`,
    plain: `${cin}/${cout}`,
  }
}

export function buildDurSegment(durMs: number | undefined): StatusSegment {
  if (durMs === undefined || !Number.isFinite(durMs) || durMs < 0) {
    return { text: `${DIM}--${RESET}`, plain: "--" }
  }
  const formatted = formatDurationMs(durMs)
  return { text: `${DIM}${formatted}${RESET}`, plain: formatted }
}

export function buildLinesSegment(
  added: number | undefined,
  removed: number | undefined,
): StatusSegment {
  const a = added ?? 0
  const r = removed ?? 0
  return {
    text: `${GREEN}+${a}${RESET} ${RED}-${r}${RESET}`,
    plain: `+${a} -${r}`,
  }
}

export function buildModelSegment(
  modelName: string | undefined,
): StatusSegment | undefined {
  if (!modelName || modelName === "--") return undefined
  return {
    text: `${MAGENTA}${modelName}${RESET}`,
    plain: modelName,
  }
}

export function buildDirGitSegment(
  cwd: string | undefined,
  branch: string | undefined,
): StatusSegment | undefined {
  const leaf = cwd ? dirLeaf(cwd) : ""
  const br = branch && branch !== "HEAD" ? branch : ""
  if (!leaf && !br) return undefined
  if (leaf && br) {
    return {
      text: `${BLUE}${leaf}${RESET} ${CYAN}(${br})${RESET}`,
      plain: `${leaf} (${br})`,
    }
  }
  if (leaf) {
    return { text: `${BLUE}${leaf}${RESET}`, plain: leaf }
  }
  return { text: `${CYAN}${br}${RESET}`, plain: br }
}

/**
 * Resolve the current git branch for `cwd`. Bounded (`GIT_TIMEOUT_MS`) and
 * total: any failure (no git binary, not a repo, detached `HEAD`, timeout,
 * `%` in a Windows path that cmd.exe cannot safely quote) yields `""`
 * (caller omits the branch) — never throws.
 */
export function resolveGitBranch(cwd: string | undefined): string {
  try {
    if (!cwd) return ""
    const gitPath = resolveExecutable("git")
    if (!gitPath) return ""
    const { command, args, shell } = buildExecInvocation([
      gitPath,
      "-C",
      cwd,
      "rev-parse",
      "--abbrev-ref",
      "HEAD",
    ])
    const result = spawnSync(command, args, {
      shell,
      timeout: GIT_TIMEOUT_MS,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    })
    if (result.error) return ""
    const out =
      typeof result.stdout === "string" ? result.stdout.trim() : ""
    if (!out || out === "HEAD") return ""
    return out.split("\n")[0]?.trim() ?? ""
  } catch {
    return ""
  }
}

/** Terminal width for the drop-right-to-left assembly. */
export function terminalWidth(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.COLUMNS
  if (raw !== undefined) {
    const n = Number(raw)
    if (Number.isInteger(n) && n > 0) return n
  }
  return WIDTH_FALLBACK
}

/**
 * Assemble the full status line. `aicFragment` (e.g. `[AIC 12.42]`) is
 * PINNED — it renders even when nothing else fits. `aicCredits` feeds the
 * `~$` actuals segment (same ledger snapshot the fragment came from).
 * Droppable segments in priority order: ctx, model, dir/git, ~$, toks,
 * dur, lines.
 */
export function assembleStatusLine(
  aicFragment: string,
  input: StatusInput,
  opts: { width?: number; branch?: string; aicCredits?: number } = {},
): string {
  const aic = aicFragment.trim()
  const aicText = aic ? `${AIC_COLOR}${aic}${RESET}` : ""

  const droppable: Array<StatusSegment> = [buildCtxSegment(input.usedPct)]
  const model = buildModelSegment(input.modelName)
  if (model) droppable.push(model)
  // Location context sits right after ctx/model: more useful than the
  // numbers when the bar is wide, still dropped before ctx/model.
  const dirGit = buildDirGitSegment(input.cwd, opts.branch)
  if (dirGit) droppable.push(dirGit)
  droppable.push(
    buildUsdSegment(opts.aicCredits),
    buildToksSegment(input.totalInputTokens, input.totalOutputTokens),
    buildDurSegment(input.totalDurationMs),
    buildLinesSegment(input.linesAdded, input.linesRemoved),
  )

  const width = opts.width ?? terminalWidth()
  const sepLen = SEP_PLAIN.length

  // Drop from the end (lowest priority) until the line fits. AIC is pinned:
  // it is excluded from the dropping loop entirely.
  let count = droppable.length
  while (count > 0) {
    let total = aic ? aic.length : 0
    for (let i = 0; i < count; i++) {
      if (aic || i > 0) total += sepLen
      total += droppable[i].plain.length
    }
    if (total <= width) break
    // Never drop the last segment when there is no AIC: an over-wide line
    // with real data beats an empty status line.
    if (count === 1 && !aic) break
    count--
  }

  const parts: Array<string> = []
  if (aic) parts.push(aicText)
  for (let i = 0; i < count; i++) parts.push(droppable[i].text)
  if (parts.length === 0) return ""
  return parts.join(SEP_TEXT)
}

/**
 * Convenience: parse stdin JSON + assemble with branch resolution.
 * `branchOverride` skips the `git` spawn (used by tests). `aicCredits`
 * comes from the same ledger snapshot as `aicFragment` (read by the
 * caller — this module never touches the ledger file).
 */
export function buildRichStatusLine(
  stdinRaw: string,
  aicFragment: string,
  opts: { width?: number; branchOverride?: string; aicCredits?: number } = {},
): string {
  const input = parseStatusInput(stdinRaw)
  const branch =
    opts.branchOverride !== undefined
      ? opts.branchOverride
      : resolveGitBranch(input.cwd)
  return assembleStatusLine(aicFragment, input, {
    ...(opts.width !== undefined ? { width: opts.width } : {}),
    ...(branch ? { branch } : {}),
    ...(opts.aicCredits !== undefined ? { aicCredits: opts.aicCredits } : {}),
  })
}
