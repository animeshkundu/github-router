/**
 * The internal `internal-prompt-submit` subcommand: the executable a spawned
 * Claude Code session's `UserPromptSubmit` hook invokes (registered into the
 * mirrored settings.json by the launcher). It serves the front-end of the
 * floor-raising surface on one event:
 *   1. resets the Stop-gate's per-session block budget (making `maxBlocks`
 *      per-prompt);
 *   2. stashes the prompt + surfaces the prior turn's advisory review findings;
 *   3. for a non-trivial prompt, injects a GROUNDED, user-derived scope/goal
 *      note (one gpt-6-luna call at high effort over the prompt + grounding
 *      code search — local ColBERT when --search is on, Bluebird when
 *      --bluebird is on, lexical-only otherwise) — or, when the proxy URL/nonce
 *      isn't wired or anything errors,
 *      falls open to the v1 regex goal.
 *   4. on a cheapest-profile launch only, tries FIRST a Sol (gpt-5.6-sol,
 *      medium) rewrite of the prompt into a short structured EXECUTION BRIEF over
 *      the prompt + AGENTS.md/CLAUDE.md + repo structure + ecosystem's verify
 *      command + grounding search
 *      (adaptive 3 turns, up to 5 on Sol's deep-grounding flag) — additive,
 *      never replacing the user prompt — and falls back to (3) on any miss.
 *      One-shot per session (first non-trivial prompt only, marked on
 *      attempt even if Sol fails open). Opt out with
 *      GH_ROUTER_DISABLE_CHEAPEST_REWRITE=1.
 *
 * ALWAYS exits 0 (never blocks the prompt): the steer is additive context, and a
 * UserPromptSubmit hook that exit-2'd would refuse the user's prompt. The pure
 * v1 path (`decidePromptSubmit`) is the fail-open fallback; V2
 * (`decidePromptSubmitV2`) layers the grounded enrichment on top via injected IO.
 */

import { defineCommand } from "citty"

import { existsSync, readdirSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import {
  CHEAPEST_REWRITE_EFFORT,
  CHEAPEST_REWRITE_GUIDANCE_CAP,
  CHEAPEST_REWRITE_MODEL,
  CHEAPEST_REWRITE_STRUCTURE_CAP,
  CHEAPEST_REWRITE_TEST_CMD_CAP,
  isCheapestRewriteDisabledEnv,
} from "./lib/cheapest-prompt-rewrite"
import { parseBoolEnv } from "./lib/exec"
import { callInference, callMcpTool, hookMcpRuntimeFromEnv } from "./lib/orchestration/hook-mcp-client"
import { fileBlockBudget } from "./lib/orchestration/stop-gate-hook"
import {
  decidePromptSubmit,
  decidePromptSubmitV2,
  type PromptSubmitDecision,
} from "./lib/orchestration/prompt-submit-hook"
import {
  fileFindingsStore,
  fileLastPromptStore,
  fileRewriteFlagStore,
  stopReviewStateDir,
} from "./lib/orchestration/stop-gate-policy"

/**
 * Read the hook payload from stdin SYNCHRONOUSLY (`readFileSync(0)`). An async
 * stdin read leaves an in-flight libuv FS request that, on Windows, races the
 * process teardown and trips a `uv_async_send` assertion; a synchronous read has
 * no such handle. Hooks always receive piped/redirected stdin, so this never
 * blocks (guarded against an interactive TTY, and any error -> "").
 */
function readStdin(): string {
  try {
    if (process.stdin.isTTY) return ""
    return readFileSync(0, "utf8")
  } catch {
    return ""
  }
}

/** Parse the session cwd from the payload — the workspace the grounding search
 *  runs in. Falls back to the process cwd. */
function workspaceFromStdin(stdin: string): string {
  try {
    const p: unknown = JSON.parse(stdin)
    if (p && typeof p === "object") {
      const cwd = (p as { cwd?: unknown }).cwd
      if (typeof cwd === "string" && cwd.length > 0) return cwd
    }
  } catch {
    /* fall through */
  }
  return process.cwd()
}

/** Per-call timeout for the grounding search (short — it must not stall the prompt). */
const SEARCH_TIMEOUT_MS = 8_000
/** Per-call timeout for a single Sol/Luna inference. */
const INFER_TIMEOUT_MS = 25_000
/**
 * Overall budget for the cheapest Sol rewrite (search + Sol, 3 turns default
 * with one adaptive extension to 5). The hook is registered with a 90s host
 * timeout. A rewrite timeout is TERMINAL — the orchestrator falls open to the
 * cheap regex goal and does NOT then run the Luna scope path — so the worst
 * case is one rewrite (≤30s) OR one Luna scope (≤22s), never both.
 */
const REWRITE_TIMEOUT_MS = 30_000

/** Read a text file best-effort, capped; missing/unreadable -> "". */
function readCappedFile(absPath: string, cap: number): string {
  try {
    return readFileSync(absPath, "utf8").slice(0, cap)
  } catch {
    return ""
  }
}

/** The subset of package.json this module reads. */
interface PackageJsonShape {
  scripts?: Record<string, string>
  packageManager?: string
  dependencies?: Record<string, string>
}

/**
 * Markers that identify the top of a project when there is no `.git` above
 * (a plain directory, a tarball, a scratch tree). Ordered only for readability —
 * the walk is first-hit-wins.
 */
const PROJECT_ROOT_MARKERS = [
  "package.json", "go.mod", "Cargo.toml", "pyproject.toml", "setup.py",
  "mix.exs", "Gemfile", "deno.json", "deno.jsonc", "global.json",
  "Makefile", "makefile", "GNUmakefile",
]

/**
 * Resolve the project root for `startDir`: the nearest ancestor (inclusive)
 * holding a `.git` entry — a file in worktrees/submodules, else a directory.
 *
 * A `.git` anywhere in the walk WINS over a nearer project marker, because
 * inside a repository the root's guidance is the one that applies: a workspace
 * package with its own `package.json` must not become the root, or the
 * repo-root `AGENTS.md` would never be read. With no `.git` above (non-repo
 * working tree), the nearest project marker is the best available root, so
 * non-git projects still get hierarchical guidance.
 *
 * Sync `existsSync` only, deliberately: this runs inside the rewrite's 30s
 * budget on every non-trivial prompt, and the async `repoRoot()` helper in
 * `stop-gate-policy` spawns `git rev-parse` — too expensive for a value a
 * directory probe answers. Falls back to `startDir`, and the walk is bounded
 * so a deep or symlinked path can't spin.
 */
function resolveProjectRoot(startDir: string): string {
  const start = path.resolve(startDir)
  const MAX_ROOT_LEVELS = 8
  let current = start
  let nearestMarker: string | undefined
  for (let i = 0; i < MAX_ROOT_LEVELS; i++) {
    if (existsSync(path.join(current, ".git"))) return current
    if (!nearestMarker && PROJECT_ROOT_MARKERS.some((m) => existsSync(path.join(current, m)))) {
      nearestMarker = current
    }
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }
  return nearestMarker ?? start
}

/**
 * Read the nearest AGENTS.md / CLAUDE.md guidance for `startDir`, walking up
 * toward (and including) `root`. Frontier guidance treats AGENTS.md as
 * hierarchical: the closest file to the work wins — so the chain is built and
 * joined CLOSEST-FIRST. That ordering is load-bearing, not cosmetic: the caller
 * truncates the joined text with `slice(0, CAP)`, which keeps the head, so
 * closest-first is what makes the nearest file survive the budget. (Root-first
 * ordering plus a head-truncating slice silently starves the nearest guidance.)
 *
 * The walk is bounded to `MAX_LEVELS` directories from the start dir and always
 * includes the root, so a deep subdirectory still sees repo-root conventions
 * without paying to read every level. AGENTS.md and CLAUDE.md are collected
 * independently; the caller uses CLAUDE.md only when no AGENTS.md was found at
 * any level. Returns empty strings when none exist.
 */
function readHierarchicalGuidance(
  startDir: string,
  root: string,
): { agentsMd: string; claudeMd: string } {
  const start = path.resolve(startDir)
  const rootAbs = path.resolve(root)
  // Closest-first chain: [start, …bounded ancestors…, root].
  const dirs: Array<string> = []
  let current = start
  const MAX_LEVELS = 3
  for (let i = 0; i < MAX_LEVELS; i++) {
    dirs.push(current)
    if (current === rootAbs) break
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }
  if (!dirs.includes(rootAbs)) dirs.push(rootAbs)

  const agentsParts: Array<string> = []
  const claudeParts: Array<string> = []
  for (const dir of dirs) {
    const agents = readCappedFile(path.join(dir, "AGENTS.md"), CHEAPEST_REWRITE_GUIDANCE_CAP)
    if (agents.length > 0) agentsParts.push(agents)
    const claude = readCappedFile(path.join(dir, "CLAUDE.md"), CHEAPEST_REWRITE_GUIDANCE_CAP)
    if (claude.length > 0) claudeParts.push(claude)
  }
  return {
    agentsMd: agentsParts.join("\n").slice(0, CHEAPEST_REWRITE_GUIDANCE_CAP),
    claudeMd: claudeParts.join("\n").slice(0, CHEAPEST_REWRITE_GUIDANCE_CAP),
  }
}

// ---------------------------------------------------------------------------
// VERIFY COMMAND detection — ecosystem generic on purpose.
//
// The line is presented to Luna as *the* exact command to verify the work, so
// a wrong guess is worse than no guess: an `npm`-only implementation (the
// previous behavior) emitted `npm test` for bun/yarn/pnpm repos, `npx npm
// test` whenever vitest happened to be a dependency, and `""` for every
// non-JavaScript repo. Three tiers, first hit wins, and `""` stays the honest
// answer when nothing is derivable:
//
//   Tier 0  first-class toolchains with one canonical command
//           0a  package.json scripts at the session cwd
//           0b  an ancestor workspace manifest (monorepo sub-package), labeled
//               with the directory to run it in
//           0c  .NET (`*.sln` / `*.csproj`)
//   Tier 1  marker ladder: go, rust, python, elixir, ruby, deno, make
//
// Tier 0 outranks the ladder because a repo with a `Makefile` *and* a
// `package.json` normally uses the Makefile as a wrapper, not as the gate.
// ---------------------------------------------------------------------------

type PackageRunner = "npm" | "pnpm" | "yarn" | "bun"

/** `packageManager` is versioned (`"pnpm@9.1.0"`) — take the leading name. */
function runnerFromPackageManager(value: string | undefined): PackageRunner | undefined {
  if (typeof value !== "string") return undefined
  // Manager names are never scoped, so the version is everything after the
  // first `@`; taking the last segment would yield "9.1.0".
  const name = value.trim().split("@")[0]?.trim() ?? ""
  return name === "npm" || name === "pnpm" || name === "yarn" || name === "bun"
    ? name
    : undefined
}

/** Lockfile → runner, searching `dirs` in order (nearest first). */
function runnerFromLockfiles(dirs: Array<string>): PackageRunner | undefined {
  const table: Array<[string, PackageRunner]> = [
    ["bun.lock", "bun"],
    ["bun.lockb", "bun"],
    ["pnpm-lock.yaml", "pnpm"],
    ["yarn.lock", "yarn"],
    ["package-lock.json", "npm"],
  ]
  for (const dir of dirs) {
    for (const [lockfile, runner] of table) {
      if (existsSync(path.join(dir, lockfile))) return runner
    }
  }
  return undefined
}

/** Lockfile-less repos still name their runner in the script bodies. */
function runnerFromScriptBodies(scripts: Record<string, string>): PackageRunner | undefined {
  for (const body of Object.values(scripts)) {
    if (typeof body !== "string") continue
    const head = body.trimStart()
    if (head.startsWith("bun ")) return "bun"
    if (head.startsWith("pnpm ")) return "pnpm"
    if (head.startsWith("yarn ")) return "yarn"
    if (head.startsWith("npm ")) return "npm"
  }
  return undefined
}

/** Resolve the package runner for `dir`'s project. */
function resolvePackageRunner(
  dir: string,
  root: string,
  pkg: PackageJsonShape,
): PackageRunner {
  return runnerFromPackageManager(pkg.packageManager)
    ?? runnerFromLockfiles([dir, root])
    ?? runnerFromScriptBodies(pkg.scripts ?? {})
    ?? "npm"
}

/**
 * `<runner> run <name>` for EVERY script name, including `test`.
 *
 * The obvious shorthand (`npm test`) is NOT safe: `bun test` invokes Bun's
 * built-in test runner and ignores the `test` script entirely, so a repo whose
 * `test` script is `bun run build && bun scripts/run-tests.ts` would be told to
 * skip its own build and orchestrator. `run` is accepted by npm, pnpm, yarn
 * (1 and berry) and bun alike.
 */
function scriptCommand(runner: PackageRunner, name: string): string {
  return `${runner} run ${name}`
}

/** Pick test/build/lint scripts, in preference order. */
function pickVerifyScripts(scripts: Record<string, string>): Array<string> {
  const preferred = ["test", "test:unit", "build", "typecheck", "lint"]
  return preferred.filter((name) => {
    const body = scripts[name]
    return typeof body === "string" && body.trim().length > 0
  })
}

/** Directories never worth descending when looking for project files. */
const SCAN_SKIP_DIRS = new Set([
  ".git", "node_modules", "dist", "build", "out", "target", "bin", "obj",
  "vendor", "venv", ".venv", "__pycache__", "coverage", ".next", ".turbo",
])

/**
 * Bounded search for a project file (`*.sln`, `*.csproj`) at `dir` and up to
 * `maxDepth` levels below it. Entries are capped per directory so a huge tree
 * can't stall the hook, and heavy/known-noise directories are skipped.
 */
function findProjectFile(
  dir: string,
  matches: (name: string) => boolean,
  maxDepth = 2,
): string | undefined {
  if (maxDepth < 0) return undefined
  let entries: Array<{ name: string; isDirectory: () => boolean }>
  try {
    entries = readdirSync(dir, { withFileTypes: true }).slice(0, 200)
  } catch {
    return undefined
  }
  for (const entry of entries) {
    if (matches(entry.name)) return entry.name
  }
  if (maxDepth === 0) return undefined
  for (const entry of entries) {
    if (!entry.isDirectory() || SCAN_SKIP_DIRS.has(entry.name)) continue
    const hit = findProjectFile(path.join(dir, entry.name), matches, maxDepth - 1)
    if (hit) return hit
  }
  return undefined
}

interface Verification {
  /** Short ecosystem label for repoStructure; "" when undetermined. */
  ecosystem: string
  /** The VERIFY COMMAND line, or "" when nothing is derivable. */
  verifyCommand: string
}

const NO_VERIFICATION: Verification = { ecosystem: "", verifyCommand: "" }

/** Tier 0c: .NET. `dotnet test` restores + builds, but a solution-wide build
 *  is still the gate, and `dotnet format` is only proposed when the repo
 *  actually carries an .editorconfig to check against. */
function dotnetVerification(root: string, cwd: string): Verification | undefined {
  for (const dir of root === cwd ? [cwd] : [root, cwd]) {
    const project = findProjectFile(dir, (name) => /\.(sln|csproj)$/i.test(name))
    if (!project) continue
    const commands = ["dotnet build", "dotnet test"]
    if (existsSync(path.join(dir, ".editorconfig"))) {
      commands.push("dotnet format --verify-no-changes")
    }
    return {
      ecosystem: `dotnet (${project})`,
      verifyCommand: `VERIFY COMMAND: ${commands.join(" ; ")}`,
    }
  }
  return undefined
}

/** Parse `name:` target lines out of a Makefile (skipping `%` pattern rules). */
function makeTargets(dir: string): Set<string> {
  const body = readCappedFile(
    ["Makefile", "makefile", "GNUmakefile"]
      .map((name) => path.join(dir, name))
      .find((abs) => existsSync(abs)) ?? path.join(dir, "Makefile"),
    8 * 1024,
  )
  const targets = new Set<string>()
  for (const line of body.split("\n")) {
    const match = /^([A-Za-z0-9][A-Za-z0-9_.-]*)\s*:(?!=)/.exec(line)
    if (match?.[1] && !match[1].includes("%")) targets.add(match[1])
  }
  return targets
}

/** Tier 1 ladder. First marker hit wins; each entry returns "" for a repo it
 *  recognizes but can't derive a command for (which lets the next probe try). */
function markerVerification(cwd: string, root: string): Verification {
  for (const dir of root === cwd ? [cwd] : [cwd, root]) {
    if (existsSync(path.join(dir, "go.mod"))) {
      return {
        ecosystem: "go (go.mod)",
        verifyCommand: "VERIFY COMMAND: go build ./... ; go test ./... ; go vet ./...",
      }
    }
    if (existsSync(path.join(dir, "Cargo.toml"))) {
      return {
        ecosystem: "rust (Cargo.toml)",
        verifyCommand: "VERIFY COMMAND: cargo build ; cargo test",
      }
    }
    if (existsSync(path.join(dir, "mix.exs"))) {
      return { ecosystem: "elixir (mix.exs)", verifyCommand: "VERIFY COMMAND: mix test" }
    }
    if (existsSync(path.join(dir, "Gemfile"))) {
      const spec = findProjectFile(dir, (name) => name === "spec", 0) !== undefined
      return {
        ecosystem: "ruby (Gemfile)",
        verifyCommand: spec
          ? "VERIFY COMMAND: bundle exec rspec"
          : "VERIFY COMMAND: bundle exec rake test",
      }
    }
    const denoConfig = ["deno.json", "deno.jsonc"]
      .map((name) => path.join(dir, name))
      .find((abs) => existsSync(abs))
    if (denoConfig) {
      const tasks = readCappedFile(denoConfig, 32 * 1024)
      if (/"test"\s*:/.test(tasks) || /'test'\s*:/.test(tasks)) {
        return { ecosystem: "deno (deno.json)", verifyCommand: "VERIFY COMMAND: deno task test" }
      }
    }
    // Python: propose a pytest line when a pytest config OR a test directory is
    // present — most projects run pytest with zero config, so requiring a
    // config section would miss them, while a repo with no tests at all still
    // gets no guess.
    const pyproject = path.join(dir, "pyproject.toml")
    const pyprojectBody = readCappedFile(pyproject, 32 * 1024)
    const setupCfg = readCappedFile(path.join(dir, "setup.cfg"), 32 * 1024)
    const hasTests = ["tests", "test"].some(
      (name) => findProjectFile(dir, (entry) => entry === name, 0) !== undefined,
    )
    const hasPytest = hasTests
      || existsSync(path.join(dir, "pytest.ini"))
      || existsSync(path.join(dir, "tox.ini"))
      || /\[tool\.pytest/.test(pyprojectBody)
      || /\[tool:pytest\]/.test(setupCfg)
    if (hasPytest) {
      const test = existsSync(path.join(dir, "uv.lock"))
        ? "uv run pytest"
        : existsSync(path.join(dir, "poetry.lock"))
          ? "poetry run pytest"
          : existsSync(path.join(dir, "Pipfile"))
            ? "pipenv run pytest"
            : "pytest"
      const commands = [test]
      if (existsSync(path.join(dir, "mypy.ini")) || /\[tool\.mypy/.test(pyprojectBody)) {
        commands.push("mypy .")
      }
      if (existsSync(path.join(dir, "ruff.toml")) || /\[tool\.ruff/.test(pyprojectBody)) {
        commands.push("ruff check .")
      }
      return {
        ecosystem: `python (${path.basename(pyproject)})`,
        verifyCommand: `VERIFY COMMAND: ${commands.join(" ; ")}`,
      }
    }
    if (existsSync(path.join(dir, "Makefile")) || existsSync(path.join(dir, "makefile"))
      || existsSync(path.join(dir, "GNUmakefile"))) {
      const targets = makeTargets(dir)
      const picked = ["test", "tests", "check", "ci", "verify", "build", "lint"]
        .filter((name) => targets.has(name))
        .slice(0, 2)
      if (picked.length > 0) {
        return {
          ecosystem: "make (Makefile)",
          verifyCommand: `VERIFY COMMAND: ${picked.map((t) => `make ${t}`).join(" ; ")}`,
        }
      }
    }
  }
  return NO_VERIFICATION
}

/** Full detection: JS/TS first, then .NET, then the marker ladder. */
function detectVerification(cwd: string, root: string): Verification {
  const cwdPkg = readPackageJson(cwd)
  if (cwdPkg) {
    const picks = pickVerifyScripts(cwdPkg.scripts ?? {})
    if (picks.length > 0) {
      const runner = resolvePackageRunner(cwd, root, cwdPkg)
      return {
        ecosystem: `node (${runner})`,
        verifyCommand: `VERIFY COMMAND: ${picks.map((n) => scriptCommand(runner, n)).join(" ; ")}`,
      }
    }
  }
  // Monorepo sub-package: an ancestor workspace manifest is the real gate, and
  // its scripts must be run from that directory — so say so in the line itself.
  // Walked explicitly (rather than only checking the project root) so a
  // workspace root several levels up is still found, and bounded so a deep
  // sub-package can't pay for a long ascent.
  const ancestor = findAncestorScriptRoot(cwd, root)
  if (ancestor) {
    const { dir, pkg } = ancestor
    const runner = resolvePackageRunner(dir, root, pkg)
    return {
      ecosystem: `node (${runner}, workspace root)`,
      verifyCommand:
        `VERIFY COMMAND (run from ${dir}): `
        + pickVerifyScripts(pkg.scripts ?? {}).map((n) => scriptCommand(runner, n)).join(" ; "),
    }
  }
  return dotnetVerification(root, cwd) ?? markerVerification(cwd, root)
}

/**
 * Nearest strict ancestor of `cwd` whose package.json declares at least one
 * recognized verify script — the monorepo case, where the workspace manifest is
 * the real gate. Never ascends above `root` (so a stray `~/package.json` can't
 * be picked up for a session already at the project root), and bounded so a
 * deep sub-package can't pay for a long ascent.
 */
function findAncestorScriptRoot(
  cwd: string,
  root: string,
): { dir: string; pkg: PackageJsonShape } | undefined {
  const start = path.resolve(cwd)
  const rootAbs = path.resolve(root)
  if (rootAbs === start) return undefined
  const MAX_ASCENT = 4
  let current = path.dirname(start)
  for (let i = 0; i <= MAX_ASCENT; i++) {
    const pkg = readPackageJson(current)
    if (pkg && pickVerifyScripts(pkg.scripts ?? {}).length > 0) {
      return { dir: current, pkg }
    }
    if (current === rootAbs) break
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }
  return undefined
}

function readPackageJson(dir: string): PackageJsonShape | undefined {
  const raw = readCappedFile(path.join(dir, "package.json"), 64 * 1024)
  if (raw.length === 0) return undefined
  try {
    const parsed: unknown = JSON.parse(raw)
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as PackageJsonShape
    }
  } catch {
    /* malformed package.json is not fatal — fall through to the other tiers */
  }
  return undefined
}

/**
 * Static repo context for the cheapest rewrite: hierarchical AGENTS.md
 * (preferred) / CLAUDE.md (fallback) + top-level structure + a detected
 * ecosystem + its VERIFY COMMAND line. All synchronous (tiny reads) and
 * capped; missing files yield "".
 */
export function buildStaticPack(workspace: string): {
  agentsMd: string
  claudeMd: string
  repoStructure: string
  verifyCommand: string
} {
  // The hook runs in the session cwd; walk guidance from there up to the repo
  // root, and reuse that root for lockfile/root-manifest detection.
  const root = resolveProjectRoot(workspace)
  const guidance = readHierarchicalGuidance(workspace, root)
  const agentsMd = guidance.agentsMd
  const claudeMd = agentsMd.length > 0 ? "" : guidance.claudeMd
  let listing: string
  try {
    const entries = readdirSync(workspace, { withFileTypes: true })
      .slice(0, 60)
      .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
    listing = entries.join(", ")
  } catch {
    listing = ""
  }
  let pkgSnippet: string
  const pkg = readPackageJson(workspace)
  if (pkg) {
    const scripts = pkg.scripts ? Object.keys(pkg.scripts).slice(0, 20).join(", ") : ""
    const deps = Object.keys(pkg.dependencies ?? {}).slice(0, 20).join(", ")
    pkgSnippet = `scripts: [${scripts}] deps: [${deps}]`
  } else {
    pkgSnippet = ""
  }
  const { ecosystem, verifyCommand: detected } = detectVerification(workspace, root)
  // The ecosystem line gives Sol a type signal even when no command could be
  // derived, which is what makes an empty VERIFY COMMAND interpretable.
  const repoStructure = [
    `top-level: ${listing}`,
    ecosystem ? `ecosystem: ${ecosystem}` : "",
    pkgSnippet,
  ]
    .filter((s) => s.trim().length > 0 && s !== "top-level: ")
    .join("\n")
    .slice(0, CHEAPEST_REWRITE_STRUCTURE_CAP)
  return {
    agentsMd,
    claudeMd,
    repoStructure,
    verifyCommand: detected.slice(0, CHEAPEST_REWRITE_TEST_CMD_CAP),
  }
}

export const internalPromptSubmit = defineCommand({
  meta: {
    name: "internal-prompt-submit",
    description:
      "Internal: the UserPromptSubmit hook. Resets the Stop-gate per-prompt block "
      + "budget, surfaces prior-turn review findings, and injects a grounded advisory goal "
      + "for non-trivial prompts. Always exit 0.",
  },
  async run() {
    try {
      const stdin = readStdin()
      const steerEnabled = parseBoolEnv(process.env.GH_ROUTER_DISABLE_PROMPT_STEER) !== true
      // Search capability for tip/enrichment text. The launcher exports
      // GH_ROUTER_SEARCH_ENABLED ("1"/"0") from its resolved
      // `state.searchEnabled` before spawning the session, so this
      // short-lived hook process inherits the launch's capability even when
      // the opt-in came from the `--search` CLI flag (which otherwise would
      // not survive the process boundary). Falls back to the raw opt-in env
      // for standalone invocations.
      const searchEnabled = process.env.GH_ROUTER_SEARCH_ENABLED !== undefined
        ? process.env.GH_ROUTER_SEARCH_ENABLED === "1"
        : process.env.GH_ROUTER_ENABLE_SEMANTIC_SEARCH === "1"
      const bluebirdEnabled = process.env.GH_ROUTER_BLUEBIRD_ENABLED === "1"
      const runtime = hookMcpRuntimeFromEnv()

      let decision: PromptSubmitDecision
      if (runtime) {
        const workspace = workspaceFromStdin(stdin)
        // Cheapest-only Sol rewrite identity: the launcher exports
        // GH_ROUTER_PROFILE; only the literal "cheapest" alias enables the
        // rewrite branch (checked again inside decidePromptSubmitV2).
        const profile = (process.env.GH_ROUTER_PROFILE ?? "").trim().toLowerCase()
        const rewriteDisabled = isCheapestRewriteDisabledEnv()
        decision = await decidePromptSubmitV2({
          stdin,
          steerEnabled,
          searchEnabled,
          bluebirdEnabled,
          profile,
          rewriteDisabled,
          rewrite: {
            searchCode: async (query, mode, signal) => {
              const r = await callMcpTool({
                runtime,
                group: "search",
                tool: "code",
                args: { query, workspace, mode, limit: 10, summary: false },
                timeoutMs: SEARCH_TIMEOUT_MS,
                signal,
              })
              return r.isError ? "" : r.text
            },
            inferSol: (system, user, signal) =>
              callInference({
                serverUrl: runtime.serverUrl,
                model: CHEAPEST_REWRITE_MODEL,
                instructions: system,
                input: user,
                effort: CHEAPEST_REWRITE_EFFORT,
                timeoutMs: INFER_TIMEOUT_MS,
                signal,
              }),
            // Lazy: fs reads run only when the cheapest branch actually fires.
            staticPack: async () => buildStaticPack(workspace),
            // Session-keyed one-shot flag: first non-trivial prompt per
            // session spends the rewrite; later prompts use the Luna path.
            hasRewriteRun: (sid) => fileRewriteFlagStore(stopReviewStateDir()).hasRun(sid),
            markRewriteRun: (sid) => fileRewriteFlagStore(stopReviewStateDir()).markRun(sid),
            timeoutMs: REWRITE_TIMEOUT_MS,
          },
          io: {
            searchCode: async (query, mode, signal) => {
              const r = await callMcpTool({
                runtime,
                group: "search",
                tool: "code",
                args: { query, workspace, mode, limit: 10, summary: false },
                timeoutMs: SEARCH_TIMEOUT_MS,
                signal,
              })
              return r.isError ? "" : r.text
            },
            infer: (system, user, signal) =>
              callInference({
                serverUrl: runtime.serverUrl,
                model: "gpt-6-luna",
                instructions: system,
                input: user,
                effort: "high",
                timeoutMs: INFER_TIMEOUT_MS,
                signal,
              }),
            readFindings: (sid) => fileFindingsStore(stopReviewStateDir()).read(sid),
            clearFindings: (sid) => fileFindingsStore(stopReviewStateDir()).clear(sid),
            storePrompt: (sid, prompt) => fileLastPromptStore(stopReviewStateDir()).write(sid, prompt),
          },
        })
      } else {
        // Proxy URL/nonce not wired -> the LLM layer is off; use the pure v1 path.
        decision = decidePromptSubmit({ stdin, steerEnabled })
      }

      if (decision.resetSession) {
        // Same budget store the Stop hook uses, so a new prompt clears its count.
        await fileBlockBudget(path.join(tmpdir(), "gh-router-stopgate"))
          .reset(decision.resetSession)
          .catch(() => {})
      }
      if (decision.inject.length > 0) {
        await new Promise<void>((resolve) => process.stdout.write(`${decision.inject}\n`, () => resolve()))
      }
    } catch {
      /* never let the front-end hook disrupt a prompt */
    }
    // Natural exit (exit code 0): a hard process.exit() races libuv stdio teardown
    // on Windows. No handles are kept alive once the (aborted) enrichment settles,
    // so returning lets the process exit cleanly with code 0.
    process.exitCode = 0
  },
})
