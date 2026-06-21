/**
 * Evidence-pinned model FALLBACK for the structural Stop-gate — the last resort
 * when the deterministic parser (`harness-parse`) finds no runnable checks.
 *
 * A read-only worker reads the repo's own config/docs and proposes the canonical
 * check commands. Two guards keep this safe despite being model-authored:
 *   1. SANITIZE — `sanitizeDiscoveredCheck` rejects shell metacharacters (so a
 *      command can never chain/redirect/expand), destructive/stateful verbs,
 *      interactive/watch shapes, and an executable that isn't on PATH. What
 *      survives is a single plain argv line, safe for `liveExec`'s naive split.
 *   2. EVIDENCE-PIN — a surviving command must appear (whitespace-normalized)
 *      VERBATIM in one of the collected source files. The model cannot invent a
 *      command or be prompt-injected into emitting one that isn't already a real
 *      command in the repo (and a real command in a user-trusted repo is the
 *      same authority the existing gate already runs).
 *
 * Discovery runs ONCE at launch and the result is cached per (repoFingerprint,
 * sourcesHash) in a human-readable record. The runtime Stop hook only READS the
 * cached record (no model call at stop). This is consumed ONLY by the local Stop
 * hook; the sealed-gate kernel never sees a discovered command.
 */

import { createHash } from "node:crypto"
import { existsSync, promises as fs } from "node:fs"
import nodePath from "node:path"

import { resolveExecutable } from "~/lib/exec"
import { PATHS } from "~/lib/paths"
import { runWorkerAgent } from "~/lib/worker-agent/engine"

import { type CheckSpec } from "./gate-runner"
import { isMutatingCommand, isSafeCommand, type CheckId } from "./harness-parse"
import { repoFingerprint, repoRoot } from "./stop-gate-policy"

/** The allowlist of files the discovery worker is steered to read — config +
 *  docs that legitimately describe how to check a project. Secret files are
 *  additionally blocked at the worker IO layer (`.env*`/`*.pem`/`id_*`/…). */
const SIGNAL_FILES: ReadonlyArray<string> = [
  "package.json",
  "Makefile",
  "makefile",
  "justfile",
  ".justfile",
  "Taskfile.yml",
  "Taskfile.yaml",
  "Cargo.toml",
  "go.mod",
  "pyproject.toml",
  "setup.cfg",
  "tox.ini",
  "pytest.ini",
  "CONTRIBUTING.md",
  "CONTRIBUTING",
  "README.md",
  "README",
  "DEVELOPING.md",
  "mix.exs",
  "build.gradle",
  "pom.xml",
  "composer.json",
]
const SIGNAL_DIRS: ReadonlyArray<string> = [".github/workflows"]

/** A discovered check command after sanitization + evidence-pinning. */
export interface DiscoveredRecord {
  root: string
  fingerprint: string
  sourcesHash: string
  discoveredAt: string
  model: string
  ecosystem: string
  checks: CheckSpec[]
  confidence: string
  evidence: string[]
}

const MAX_SIGNAL_BYTES = 64 * 1024
/** Global caps so a repo with many workflow files can't inflate discovery /
 *  hashing cost: at most this many files and this much total text. */
const MAX_SIGNAL_FILES = 40
const MAX_TOTAL_SIGNAL_BYTES = 512 * 1024

/** Words that mark a command as destructive, stateful, or non-terminating — a
 *  "check" must never do any of these. (Shell operators are already rejected by
 *  `isSafeCommand`, so chaining can't smuggle them past this word scan.) */
const DENY_WORD =
  /\b(rm|rmdir|mv|dd|mkfs|sudo|chmod|chown|publish|push|deploy|migrate|kubectl|terraform|docker|curl|wget|ssh|scp|rsync|nc|eval|npm i|npm install|yarn add|pip install|apt|brew|watch|serve|repl|dev|start)\b/i

/**
 * True when `command` is safe to auto-run as a check: a plain argv line (no
 * shell metacharacters), no destructive/stateful verb, no mutating/interactive
 * shape, and its executable resolves on PATH. The deny-word scan runs on a
 * whitespace-NORMALIZED copy so a tab / double-space can't split `npm  install`
 * past the literal-space patterns.
 */
export function sanitizeDiscoveredCheck(command: string): boolean {
  if (!isSafeCommand(command)) return false
  const norm = normalizeWs(command)
  if (DENY_WORD.test(norm)) return false
  if (isMutatingCommand(norm)) return false // --fix/--write/--watch + :fix/:write scripts
  const first = norm.split(" ")[0] ?? ""
  return resolveExecutable(first, { env: process.env }) !== null
}

function normalizeWs(s: string): string {
  return s.replace(/\s+/g, " ").trim()
}

/** Collect the text of the allowlisted signal files (capped), for evidence-pin +
 *  the sources hash. Returns the concatenated text and the relative file list. */
async function collectSignals(root: string): Promise<{ text: string; files: string[] }> {
  const parts: string[] = []
  const files: string[] = []
  let total = 0
  const readCapped = async (abs: string, rel: string): Promise<void> => {
    if (files.length >= MAX_SIGNAL_FILES || total >= MAX_TOTAL_SIGNAL_BYTES) return
    try {
      const raw = await fs.readFile(abs, "utf8")
      const slice = raw.length > MAX_SIGNAL_BYTES ? raw.slice(0, MAX_SIGNAL_BYTES) : raw
      parts.push(slice)
      files.push(rel)
      total += slice.length
    } catch {
      /* unreadable → skip */
    }
  }
  for (const f of SIGNAL_FILES) {
    const abs = nodePath.join(root, f)
    if (existsSync(abs)) await readCapped(abs, f)
  }
  for (const d of SIGNAL_DIRS) {
    const dir = nodePath.join(root, d)
    try {
      for (const name of await fs.readdir(dir)) {
        if (/\.(ya?ml)$/i.test(name)) await readCapped(nodePath.join(dir, name), nodePath.join(d, name))
      }
    } catch {
      /* no dir */
    }
  }
  return { text: parts.join("\n"), files }
}

/** A freshness hash over the signal files' contents + relative paths. A change
 *  to how the project checks itself flips this → re-discovery on next launch. */
export async function sourcesHash(root: string): Promise<string> {
  const { text, files } = await collectSignals(root)
  return createHash("sha256")
    .update(files.sort().join("\n"))
    .update("\0")
    .update(text)
    .digest("hex")
}

function discoveredDir(): string {
  return nodePath.join(PATHS.APP_DIR, "stop-gate", "discovered")
}
function recordPathFor(root: string): string {
  return nodePath.join(discoveredDir(), createHash("sha256").update(nodePath.resolve(root)).digest("hex").slice(0, 32))
}

/** Read the cached discovered record for `root`, verifying it still matches the
 *  live repo identity AND the live sources hash. Any mismatch / unreadable /
 *  empty-checks record → null (re-discover or stay off; never run a stale set). */
export async function readDiscoveredGate(root: string): Promise<DiscoveredRecord | null> {
  let rec: DiscoveredRecord
  try {
    rec = JSON.parse(await fs.readFile(recordPathFor(root), "utf8")) as DiscoveredRecord
  } catch {
    return null
  }
  if (!rec || !Array.isArray(rec.checks) || rec.checks.length === 0) return null
  const fp = await repoFingerprint(root).catch(() => "")
  if (fp.length === 0 || fp !== rec.fingerprint) return null // identity drift → deny.
  const sh = await sourcesHash(root).catch(() => "")
  if (sh.length === 0 || sh !== rec.sourcesHash) return null // config changed → stale.
  // Re-validate id AND re-sanitize the command at read time (defense-in-depth
  // against a tampered/corrupt record).
  const checks = rec.checks.filter(
    (c) => c && typeof c.id === "string" && VALID_IDS.has(c.id) && typeof c.command === "string" && sanitizeDiscoveredCheck(c.command),
  )
  if (checks.length === 0) return null
  return { ...rec, checks }
}

export async function writeDiscoveredGate(rec: DiscoveredRecord): Promise<void> {
  await fs.mkdir(discoveredDir(), { recursive: true })
  const tmp = `${recordPathFor(rec.root)}.${process.pid}.tmp`
  await fs.writeFile(tmp, `${JSON.stringify(rec, null, 2)}\n`, { mode: 0o600 })
  await fs.rename(tmp, recordPathFor(rec.root))
}

const DISCOVERY_PROMPT = (files: string[]): string =>
  `You are configuring an automated pre-finish CHECK gate for this repository. Read ONLY these `
  + `already-present config/doc files to learn how the project checks itself: ${files.join(", ")}. `
  + `Identify the canonical FAST static check command (typecheck and/or lint) and, if obvious, the test `
  + `command. Rules: (1) return a command ONLY if it appears VERBATIM in one of those files — never invent `
  + `one; (2) commands must be non-interactive, self-terminating, read-only verification (NO install / `
  + `publish / push / deploy / migrate / format-in-place / watch / serve / dev-server / delete); (3) at most `
  + `3 commands; (4) if unsure, return an empty list. Respond with ONLY a fenced \`\`\`json block of the shape `
  + `{"ecosystem":"<label>","checks":[{"id":"typecheck|lint|test","command":"<single-line command>"}],`
  + `"confidence":"high|low"} and NOTHING else.`

interface DiscoverResult {
  ecosystem: string
  checks: CheckSpec[]
  confidence: string
  evidence: string[]
}

/** Extract the first fenced/bare JSON object from the worker's text. */
function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)
  const body = fenced ? fenced[1] : text
  const start = body.indexOf("{")
  const end = body.lastIndexOf("}")
  if (start < 0 || end <= start) return undefined
  try {
    return JSON.parse(body.slice(start, end + 1)) as unknown
  } catch {
    return undefined
  }
}

const VALID_IDS: ReadonlySet<string> = new Set<CheckId>(["typecheck", "lint", "test"])

/**
 * Sanitize + EVIDENCE-PIN the model's raw checks against the collected source
 * text. Pure (no IO) so it is unit-testable without the worker. A check survives
 * only if: its id is canonical, it isn't a `test` while tests are off, its id
 * hasn't already been taken, it passes `sanitizeDiscoveredCheck`, AND its command
 * appears (whitespace-normalized) VERBATIM in `evidenceText`. The evidence-pin is
 * the load-bearing guard: the model cannot invent a command or be prompt-injected
 * into one that isn't already a real command in the (user-trusted) repo.
 */
export function filterDiscoveredChecks(
  rawChecks: unknown,
  evidenceText: string,
  includeTests: boolean,
): CheckSpec[] {
  const evidenceNorm = normalizeWs(evidenceText)
  const seen = new Set<string>()
  const checks: CheckSpec[] = []
  for (const c of Array.isArray(rawChecks) ? rawChecks : []) {
    if (!c || typeof c !== "object") continue
    const id = (c as { id?: unknown }).id
    const command = (c as { command?: unknown }).command
    if (typeof id !== "string" || !VALID_IDS.has(id)) continue
    if (typeof command !== "string") continue
    if (id === "test" && !includeTests) continue
    if (seen.has(id)) continue
    if (!sanitizeDiscoveredCheck(command)) continue
    if (!evidenceNorm.includes(normalizeWs(command))) continue
    seen.add(id)
    checks.push({ id, command: command.trim() })
  }
  return checks
}

/**
 * Run the read-only worker to discover check commands for `cwd`. Returns the
 * sanitized + evidence-pinned result, or null (worker unavailable / errored /
 * nothing survived). NEVER throws.
 */
export async function discoverGateCommands(
  cwd: string,
  opts: { signal?: AbortSignal; includeTests: boolean },
): Promise<DiscoverResult | null> {
  const root = await repoRoot(cwd).catch(() => cwd)
  const { text: evidenceText, files } = await collectSignals(root)
  if (files.length === 0) return null

  let result: { text: string; isError?: boolean }
  try {
    result = await runWorkerAgent({
      mode: "explore",
      workspace: root,
      prompt: DISCOVERY_PROMPT(files),
      signal: opts.signal,
    })
  } catch {
    return null
  }
  if (result.isError) return null
  const parsed = extractJson(result.text)
  if (!parsed || typeof parsed !== "object") return null
  const obj = parsed as { ecosystem?: unknown; checks?: unknown; confidence?: unknown }
  const checks = filterDiscoveredChecks(obj.checks, evidenceText, opts.includeTests)
  if (checks.length === 0) return null
  const ecosystem = typeof obj.ecosystem === "string" && obj.ecosystem.length > 0 ? obj.ecosystem : "discovered"
  const confidence = typeof obj.confidence === "string" ? obj.confidence : "low"
  return { ecosystem, checks, confidence, evidence: files }
}
