/**
 * Deterministic, language-agnostic harness PARSER for the structural Stop-gate.
 *
 * The gate runs a repo's own checks (typecheck/lint/test/build) when the agent
 * tries to finish. Historically it only auto-enabled for Bun/TS repos via a
 * hard-coded sealed gate. This module generalizes detection by PARSING the
 * project's own authoritative config — `package.json` scripts, CI `run:` steps,
 * Make/just/task targets, and language manifests — and emitting the canonical
 * check commands it finds.
 *
 * Design properties (a cross-lab panel chose a parser over a model for these):
 *   - EVIDENCE-PINNED BY CONSTRUCTION: every emitted command is either lifted
 *     verbatim from a parsed source file (a package.json script, a CI `run:`
 *     line, a Make target invocation) or is a fixed canonical manifest command
 *     for a detected ecosystem (`cargo check`, `go vet ./...`). The parser never
 *     invents a command, so it has no hallucination / prompt-injection surface.
 *   - PURE + DETERMINISTIC: a function of the repo's files + the live PATH. The
 *     runtime Stop hook re-derives it at each stop (no cache), so it always
 *     reflects the current tree and fails open for free when a tool vanished.
 *   - SHELL-SAFE: `liveExec` runs `command.trim().split(/\s+/)` (naive argv
 *     split, no shell), so every emitted command is validated to be plain
 *     space-separated tokens with no shell operators and no `%` (cmd.exe quoting
 *     throws on `%`). See `isSafeCommand`.
 *
 * This is consumed ONLY by the local Stop hook. The sealed-gate kernel
 * (`run_workflow`) is never fed a parsed command — `GateDescriptor.kind` is
 * `"parsed"`, never a sealed id, and `sealedGateIds()` is unchanged.
 */

import { createHash } from "node:crypto"
import { existsSync, promises as fs } from "node:fs"
import nodePath from "node:path"

import { resolveExecutable } from "~/lib/exec"

import { resolveSealedGate } from "./gate-registry"
import { type CheckSpec } from "./gate-runner"

/** Canonical check ids — stable across ecosystems so baseline isolation and the
 *  selector key on the same names regardless of language. `build` is deliberately
 *  NOT a check: build scripts are too variable in cost to auto-run on every stop
 *  (a full bundle/SEA build is the slow-command / false-red footgun the design
 *  avoids). Compile-checking is covered under `typecheck` (`go vet`, `cargo
 *  check`, `tsc`). */
export type CheckId = "typecheck" | "lint" | "test"

/** The fast static checks that are always-on; `test` is opt-in (it runs project
 *  code and can be slow on every stop). */
const STATIC_IDS: ReadonlySet<CheckId> = new Set(["typecheck", "lint"])

/**
 * The resolved gate source for a repo.
 *   - `sealed`     — the bun/TS fast-path (a sealed gate id, byte-identical to
 *                    the legacy behavior; the runtime hook resolves it via the
 *                    sealed registry).
 *   - `parsed`     — deterministic parser output (this module).
 *   - `discovered` — the evidence-pinned model fallback (see `gate-discovery`).
 * `workdir` is the directory the checks run in (the repo/package root where the
 * evidence was found), NOT the Stop payload's cwd — so a monorepo stop from a
 * nested dir still runs the root's checks.
 */
export type GateDescriptor =
  | { kind: "sealed"; gateId: string; workdir: string }
  | { kind: "parsed"; checks: CheckSpec[]; ecosystem: string; workdir: string; evidence: string[] }
  | { kind: "discovered"; checks: CheckSpec[]; ecosystem: string; workdir: string; evidence: string[] }

interface Candidate {
  id: CheckId
  command: string
  /** The source file the command was lifted from (for evidence + messages). */
  source: string
}

/** Reject anything that is not a plain, shell-free, `%`-free argv line. This is
 *  the load-bearing guard for `liveExec`'s naive whitespace split. */
export function isSafeCommand(command: string): boolean {
  const c = command.trim()
  if (c.length === 0 || c.length > 200) return false
  if (/[\r\n]/.test(c)) return false
  // Each token may contain only these chars: letters/digits and a small set of
  // path/flag punctuation. This rejects shell metacharacters (; & | < > ( ) $
  // backtick " ' * ? ! ^ \ %), env expansion, and quoting in one shot.
  const tokens = c.split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return false
  return tokens.every((t) => /^[A-Za-z0-9._/:@=+-]+$/.test(t))
}

/** First token of a command (the executable), for a PATH-presence probe. */
function firstToken(command: string): string {
  return command.trim().split(/\s+/)[0] ?? ""
}

/** True when a command would MUTATE the tree and so must never be a gate: a
 *  `--fix`/`--write` flag or a `:fix`/`:write` script-name suffix (e.g.
 *  `npm run lint:fix`, `eslint --fix`). Whitespace is normalized first so a
 *  tab/double-space can't slip a flag past the scan. Exported + shared with the
 *  discovered-command sanitizer. */
export function isMutatingCommand(command: string): boolean {
  const c = command.trim().replace(/\s+/g, " ")
  if (/(^| )(--fix|--write|-w|--watch|--serve|--interactive|-i)( |=|$)/i.test(c)) return true
  if (/(^| |:|-)(fix|write)\b/i.test(c)) return true
  return false
}

/** True when the command is safe AND its executable resolves on PATH (a missing
 *  tool → drop the check rather than guarantee a false-red). */
function commandRunnable(command: string): boolean {
  if (!isSafeCommand(command)) return false
  return resolveExecutable(firstToken(command), { env: process.env }) !== null
}

async function readJsonFile(file: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await fs.readFile(file, "utf8")) as unknown
  } catch {
    return undefined
  }
}

async function readTextFile(file: string): Promise<string | undefined> {
  try {
    return await fs.readFile(file, "utf8")
  } catch {
    return undefined
  }
}

/** package.json `scripts` as a plain string→string map (best-effort). */
async function readScripts(root: string): Promise<Record<string, string>> {
  const pkg = await readJsonFile(nodePath.join(root, "package.json"))
  const scripts = pkg && typeof pkg === "object" ? (pkg as { scripts?: unknown }).scripts : undefined
  const out: Record<string, string> = {}
  if (scripts && typeof scripts === "object") {
    for (const [k, v] of Object.entries(scripts as Record<string, unknown>)) {
      if (typeof v === "string") out[k] = v
    }
  }
  return out
}

/** Pick the JS package runner from the lockfile present at the root. */
function nodeRunner(root: string): "bun" | "pnpm" | "yarn" | "npm" {
  if (existsSync(nodePath.join(root, "bun.lockb")) || existsSync(nodePath.join(root, "bun.lock"))) return "bun"
  if (existsSync(nodePath.join(root, "pnpm-lock.yaml"))) return "pnpm"
  if (existsSync(nodePath.join(root, "yarn.lock"))) return "yarn"
  return "npm"
}

/** Map a package.json script NAME to a canonical id (read-only checks only — a
 *  `:fix`/`:write` variant mutates the tree and is never a gate). */
function scriptNameToId(name: string): CheckId | null {
  if (/:(fix|write)$/i.test(name)) return null
  if (/^(typecheck|type-check|check-types|tsc|types)$/i.test(name)) return "typecheck"
  if (/^(lint|lint:check|eslint)$/i.test(name)) return "lint"
  if (/^test$/i.test(name)) return "test"
  return null
}

async function collectNodeChecks(root: string, includeTests: boolean): Promise<Candidate[]> {
  if (!existsSync(nodePath.join(root, "package.json"))) return []
  const runner = nodeRunner(root)
  if (resolveExecutable(runner, { env: process.env }) === null) return []
  const scripts = await readScripts(root)
  const out: Candidate[] = []
  for (const [name] of Object.entries(scripts)) {
    const id = scriptNameToId(name)
    if (!id) continue
    if (id === "test" && !includeTests) continue
    const command = `${runner} run ${name}`
    if (isSafeCommand(command)) out.push({ id, command, source: "package.json" })
  }
  return out
}

/**
 * Best-effort CI gap-filler: scan GitHub Actions / GitLab CI YAML for single-line
 * `run:` static checks (typecheck/lint/build) the project actually runs. We do
 * NOT lift `test` from CI — CI test jobs frequently need services/secrets and
 * would false-red on every stop. Multi-line / scripted `run:` blocks are skipped
 * (they can't be a single argv). Any parse failure yields nothing.
 */
async function collectCiChecks(root: string): Promise<Candidate[]> {
  const files: string[] = []
  const wfDir = nodePath.join(root, ".github", "workflows")
  try {
    for (const name of await fs.readdir(wfDir)) {
      if (/\.ya?ml$/i.test(name)) files.push(nodePath.join(wfDir, name))
    }
  } catch {
    /* no workflows dir */
  }
  const gitlab = nodePath.join(root, ".gitlab-ci.yml")
  if (existsSync(gitlab)) files.push(gitlab)
  if (files.length === 0) return []

  let parseYaml: (s: string) => unknown
  try {
    // Lazy import so the parser module has no hard dep when CI files are absent.
    ;({ parse: parseYaml } = await import("yaml"))
  } catch {
    return []
  }

  const out: Candidate[] = []
  const seen = new Set<CheckId>()
  const classify = (cmd: string): CheckId | null => {
    if (/\b(typecheck|type-check|tsc|mypy|pyright)\b/i.test(cmd)) return "typecheck"
    if (/\b(lint|eslint|ruff|clippy|golangci|vet)\b/i.test(cmd)) return "lint"
    return null
  }
  const consider = (run: unknown, source: string): void => {
    if (typeof run !== "string") return
    const cmd = run.trim()
    if (cmd.includes("\n")) return // multi-line script block — not a single argv.
    if (!isSafeCommand(cmd) || isMutatingCommand(cmd) || !commandRunnable(cmd)) return
    const id = classify(cmd)
    if (!id || seen.has(id)) return
    seen.add(id)
    out.push({ id, command: cmd, source })
  }
  // Walk the parsed YAML for any `run:` string anywhere (GH `steps[].run`, GitLab
  // `<job>.script[]`). A generic deep walk tolerates both schemas + future shapes.
  const walk = (node: unknown, source: string): void => {
    if (!node || typeof node !== "object") return
    if (Array.isArray(node)) {
      for (const v of node) walk(v, source)
      return
    }
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (k === "run" && typeof v === "string") consider(v, source)
      else if (k === "script") {
        // GitLab `script:` is a string or string[].
        if (typeof v === "string") consider(v, source)
        else if (Array.isArray(v)) for (const s of v) consider(s, source)
      } else walk(v, source)
    }
  }
  for (const f of files) {
    const text = await readTextFile(f)
    if (text === undefined) continue
    try {
      walk(parseYaml(text), nodePath.relative(root, f) || nodePath.basename(f))
    } catch {
      /* unparseable workflow → skip */
    }
  }
  return out
}

/** Make / just / Taskfile targets matching canonical ids → `<tool> <target>`. */
async function collectTaskChecks(root: string, includeTests: boolean): Promise<Candidate[]> {
  const out: Candidate[] = []
  const wantId = (target: string): CheckId | null => scriptNameToId(target)
  // Makefile / justfile: a line `target:` (Make) or `target:` (just recipe head).
  for (const [file, tool] of [
    ["Makefile", "make"],
    ["makefile", "make"],
    ["justfile", "just"],
    [".justfile", "just"],
  ] as const) {
    const text = await readTextFile(nodePath.join(root, file))
    if (text === undefined) continue
    if (resolveExecutable(tool, { env: process.env }) === null) continue
    for (const line of text.split(/\r?\n/)) {
      const m = /^([A-Za-z0-9._-]+)\s*:/.exec(line)
      if (!m) continue
      const id = wantId(m[1])
      if (!id || (id === "test" && !includeTests)) continue
      const command = `${tool} ${m[1]}`
      if (isSafeCommand(command)) out.push({ id, command, source: file })
    }
  }
  // Taskfile.yml: top-level `tasks:` keys.
  const taskfile = ["Taskfile.yml", "Taskfile.yaml"].map((n) => nodePath.join(root, n)).find((p) => existsSync(p))
  if (taskfile && resolveExecutable("task", { env: process.env }) !== null) {
    const text = await readTextFile(taskfile)
    if (text !== undefined) {
      try {
        const { parse } = await import("yaml")
        const doc = parse(text) as { tasks?: Record<string, unknown> } | undefined
        for (const name of Object.keys(doc?.tasks ?? {})) {
          const id = wantId(name)
          if (!id || (id === "test" && !includeTests)) continue
          const command = `task ${name}`
          if (isSafeCommand(command)) out.push({ id, command, source: nodePath.basename(taskfile) })
        }
      } catch {
        /* skip */
      }
    }
  }
  return out
}

async function collectRustChecks(root: string, includeTests: boolean): Promise<Candidate[]> {
  if (!existsSync(nodePath.join(root, "Cargo.toml"))) return []
  if (resolveExecutable("cargo", { env: process.env }) === null) return []
  const out: Candidate[] = [{ id: "typecheck", command: "cargo check", source: "Cargo.toml" }]
  // clippy is a separate component; only emit it if `cargo-clippy` resolves.
  if (resolveExecutable("cargo-clippy", { env: process.env }) !== null) {
    out.push({ id: "lint", command: "cargo clippy", source: "Cargo.toml" })
  }
  if (includeTests) out.push({ id: "test", command: "cargo test", source: "Cargo.toml" })
  return out
}

async function collectGoChecks(root: string, includeTests: boolean): Promise<Candidate[]> {
  if (!existsSync(nodePath.join(root, "go.mod"))) return []
  if (resolveExecutable("go", { env: process.env }) === null) return []
  // `go vet` compiles + reports suspect constructs — the typecheck-equivalent.
  const out: Candidate[] = [{ id: "typecheck", command: "go vet ./...", source: "go.mod" }]
  if (includeTests) out.push({ id: "test", command: "go test ./...", source: "go.mod" })
  return out
}

async function collectPythonChecks(root: string, includeTests: boolean): Promise<Candidate[]> {
  const configFiles = ["pyproject.toml", "setup.cfg", "pytest.ini", "tox.ini", "ruff.toml", "mypy.ini"]
  const present = configFiles.filter((f) => existsSync(nodePath.join(root, f)))
  if (present.length === 0) return []
  const evidence = present[0]
  const out: Candidate[] = []
  const configText = (await readTextFile(nodePath.join(root, present[0]))) ?? ""
  const mentions = (tool: string): boolean => present.some((f) => f.startsWith(tool)) || configText.includes(tool)
  // Only emit a Python tool when BOTH config evidence AND the tool resolve.
  if (mentions("mypy") && resolveExecutable("mypy", { env: process.env }) !== null) {
    out.push({ id: "typecheck", command: "mypy .", source: evidence })
  }
  if (mentions("ruff") && resolveExecutable("ruff", { env: process.env }) !== null) {
    out.push({ id: "lint", command: "ruff check .", source: evidence })
  }
  if (includeTests && (mentions("pytest") || existsSync(nodePath.join(root, "pytest.ini")))) {
    if (resolveExecutable("pytest", { env: process.env }) !== null) {
      out.push({ id: "test", command: "pytest -q", source: evidence })
    }
  }
  return out
}

/** Pick the first runnable candidate per id, in source-priority order. */
function pickByPriority(candidates: Candidate[]): { checks: CheckSpec[]; evidence: string[] } {
  const byId = new Map<CheckId, Candidate>()
  for (const c of candidates) {
    if (!byId.has(c.id) && commandRunnable(c.command)) byId.set(c.id, c)
  }
  const order: CheckId[] = ["typecheck", "lint", "test"]
  const checks: CheckSpec[] = []
  const evidence = new Set<string>()
  for (const id of order) {
    const c = byId.get(id)
    if (c) {
      checks.push({ id: c.id, command: c.command })
      evidence.add(c.source)
    }
  }
  return { checks, evidence: [...evidence] }
}

/**
 * Resolve the gate descriptor for an already-resolved repo `root`.
 *   1. bun/TS sealed fast-path — byte-identical to the legacy `detectHarnessGateId`
 *      (bun on PATH + a `typecheck` script → sealed `default-ci`/`typecheck-test`).
 *   2. else the deterministic parser: collect candidates from package.json
 *      scripts (primary, self-contained), Make/just/task, language manifests, and
 *      a CI gap-filler for static checks; pick one per id by priority. A `parsed`
 *      descriptor is returned only when at least one STATIC check survives (a
 *      test-only set would either be off-by-default or risk false-reds).
 *   3. else null (the launcher prints why and the gate stays off).
 */
export async function parseGateDescriptor(
  root: string,
  opts: { includeTests: boolean },
): Promise<GateDescriptor | null> {
  // (1) bun/TS sealed parity.
  if (resolveExecutable("bun", { env: process.env }) !== null) {
    const scripts = await readScripts(root)
    if (typeof scripts.typecheck === "string") {
      const gateId = typeof scripts.lint === "string" ? "default-ci" : "typecheck-test"
      return { kind: "sealed", gateId, workdir: root }
    }
  }

  // (2) deterministic parser. package.json scripts first (self-contained), then
  //     task runners + manifests, then a CI gap-filler for static checks.
  const groups = await Promise.all([
    collectNodeChecks(root, opts.includeTests),
    collectTaskChecks(root, opts.includeTests),
    collectRustChecks(root, opts.includeTests),
    collectGoChecks(root, opts.includeTests),
    collectPythonChecks(root, opts.includeTests),
    collectCiChecks(root),
  ])
  const candidates = groups.flat()
  if (candidates.length === 0) return null

  const ecosystem =
    candidates.find((c) => c.source === "package.json") ? "node"
    : candidates.find((c) => c.source === "Cargo.toml") ? "rust"
    : candidates.find((c) => c.source === "go.mod") ? "go"
    : candidates.find((c) => /^(pyproject|setup|pytest|tox|ruff|mypy)/.test(c.source)) ? "python"
    : candidates.find((c) => /^(Makefile|makefile|justfile|\.justfile|Taskfile)/.test(c.source)) ? "make"
    : "ci"

  const { checks, evidence } = pickByPriority(candidates)
  if (checks.length === 0) return null
  // Require at least one STATIC check (typecheck/lint/build) unless the caller
  // opted into running the full test suite — a test-only set is otherwise either
  // off-by-default or a slow/false-red risk on every stop.
  const hasStatic = checks.some((c) => STATIC_IDS.has(c.id as CheckId))
  if (!hasStatic && !opts.includeTests) return null
  return { kind: "parsed", checks, ecosystem, workdir: root, evidence }
}

/** The checks a descriptor runs: a sealed descriptor resolves its sealed command
 *  set from the registry; parsed/discovered carry their own. Fresh array. */
export function checksForDescriptor(d: GateDescriptor): CheckSpec[] {
  if (d.kind === "sealed") {
    const sealed = resolveSealedGate(d.gateId)
    return sealed ? sealed.checks.map((c) => ({ id: c.id, command: c.command })) : []
  }
  return d.checks.map((c) => ({ id: c.id, command: c.command }))
}

/** A stable key over a descriptor's effective check set, for baseline isolation.
 *  Sealed descriptors key on their gate id (preserving legacy baseline keys);
 *  parsed/discovered key on the canonicalized (id,command) set, so a changed
 *  command set yields a fresh baseline instead of masking/inventing regressions. */
export function descriptorHash(d: GateDescriptor): string {
  if (d.kind === "sealed") return `sealed:${d.gateId}`
  const canon = [...d.checks]
    .map((c) => `${c.id} ${c.command.trim().replace(/\s+/g, " ")}`)
    .sort()
    .join("")
  return `${d.kind}:${createHash("sha256").update(canon).digest("hex").slice(0, 32)}`
}
