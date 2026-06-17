/**
 * Pure + thin-IO policy helpers for the consent-gated, top-level-only structural
 * Stop-gate. Split out of `stop-gate-hook.ts` so the security-critical decisions
 * (is this a subagent? is this repo trusted? which checks regressed?) are small,
 * named, and unit-testable.
 *
 * Verified against the official Claude Code hooks reference
 * (https://code.claude.com/docs/en/hooks), 2026-06:
 *   - `Stop` fires for the MAIN agent; subagents fire `SubagentStop`, and a
 *     `Stop`-registered hook is converted to `SubagentStop` in a subagent
 *     context — so the hook command CAN run for a subagent. The payload carries
 *     `agent_id` / `agent_type` ONLY inside a subagent/teammate context, so that
 *     is the reliable top-level-vs-sub discriminator (NOT an env var, which the
 *     proxy cannot set on Claude-spawned subagents).
 *   - `UserPromptSubmit` fires only for human prompts to the main agent.
 *   - `stop_hook_active` is NOT in the current documented payload, so the
 *     per-prompt block budget — not that flag — must be the termination guard.
 */

import { createHash } from "node:crypto"
import { promises as fs } from "node:fs"
import nodePath from "node:path"

import { parseBoolEnv, resolveExecutable, runCommandCapture } from "~/lib/exec"
import { PATHS } from "~/lib/paths"

/** Minimal shape of the hook payload fields these helpers read. */
export interface HookPayloadCommon {
  cwd?: unknown
  session_id?: unknown
  agent_id?: unknown
  agent_type?: unknown
}

/**
 * True when the hook is firing inside a subagent / teammate context (NOT the
 * top-level user session). Claude Code adds `agent_id` + `agent_type` to the
 * payload only there, so their presence is the discriminator. The Stop-gate and
 * the prompt-steer hook both stand down when this is true, scoping them to the
 * top-level session.
 */
export function isSubagentContext(payload: HookPayloadCommon | null | undefined): boolean {
  // Fail CLOSED: ANY present, non-null agent marker means "not the top-level
  // session" -> stand down. Main-agent payloads omit these keys entirely
  // (undefined), so this never disables the gate for the top-level session; but
  // a numeric / empty-string / null marker (malformed or future shape) still
  // scopes us OUT, which is the safe direction for the top-level-only invariant.
  const present = (v: unknown): boolean => v !== undefined && v !== null
  return present(payload?.agent_type) || present(payload?.agent_id)
}

// ─── Per-repo trust (consent once) ───────────────────────────────────────────
// The gate executes the repo's own `bun run typecheck` / `bun test` / `bun run
// lint` scripts, which are arbitrary shell. It must NEVER run them in a repo the
// user has not explicitly trusted. Trust is recorded once per repo in a STABLE
// dir (survives across launches), keyed by the resolved git repo root.

/** Stable trust dir (NOT the per-launch mirror — trust must persist). */
function trustDir(): string {
  return nodePath.join(PATHS.APP_DIR, "stop-gate", "trust")
}

/** Resolve the git repo root for `cwd`, falling back to `cwd` when not a repo. */
export async function repoRoot(cwd: string): Promise<string> {
  const r = await runCommandCapture(["git", "rev-parse", "--show-toplevel"], {
    cwd,
    timeoutMs: 5_000,
  }).catch(() => undefined)
  const top = r?.stdout?.trim()
  return top && top.length > 0 ? top : cwd
}

function trustFileFor(root: string): string {
  const key = createHash("sha256").update(nodePath.resolve(root)).digest("hex").slice(0, 32)
  return nodePath.join(trustDir(), key)
}

/**
 * A stable identity for the repo at `root`: the first (root) commit SHA. It
 * survives normal history growth but differs across distinct repositories, so a
 * DIFFERENT repo later appearing at the same filesystem path is not silently
 * trusted (codex review #2). Empty string when unavailable (no git / no commits)
 * — trust then falls back to path-only, the best we can do.
 */
async function repoFingerprint(root: string): Promise<string> {
  const r = await runCommandCapture(["git", "rev-list", "--max-parents=0", "HEAD"], {
    cwd: root,
    timeoutMs: 5_000,
  }).catch(() => undefined)
  return (
    r?.stdout
      ?.split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean)[0] ?? ""
  )
}

/**
 * True iff the user has consented to run the gate in this repo AND the repo's
 * identity still matches what was trusted. The trust file stores `root\nfp\n`;
 * a present fingerprint is verified against the live one (deny on mismatch, and
 * deny if we pinned one but can't recompute it — fail closed). A legacy file
 * with no fingerprint is path-only trust.
 */
export async function isRepoTrusted(cwd: string): Promise<boolean> {
  const root = await repoRoot(cwd)
  let stored: string
  try {
    stored = await fs.readFile(trustFileFor(root), "utf8")
  } catch {
    return false
  }
  const storedFp = (stored.split(/\r?\n/)[1] ?? "").trim()
  if (storedFp.length === 0) return true // legacy / no-fingerprint -> path-only.
  const currentFp = await repoFingerprint(root)
  if (currentFp.length === 0) return false // pinned a fp but can't verify -> deny.
  return currentFp === storedFp
}

/** Record consent for this repo (consent once → automatic thereafter), pinning
 *  the repo's root-commit fingerprint so a later repo swap at the same path is
 *  not auto-trusted. */
export async function trustRepo(cwd: string): Promise<string> {
  const root = await repoRoot(cwd)
  const fp = await repoFingerprint(root)
  await fs.mkdir(trustDir(), { recursive: true })
  await fs.writeFile(trustFileFor(root), `${root}\n${fp}\n`, { mode: 0o600 })
  return root
}

/**
 * Repo-aware gate enable: `GH_ROUTER_DISABLE_STOP_GATE` force-off wins;
 * `GH_ROUTER_ENABLE_STOP_GATE` force-on next; otherwise default to OFF unless the
 * repo is trusted. This is the load-bearing security gate — the default is OFF,
 * so an untrusted repo's scripts are never auto-run.
 */
export async function stopGateEnabledForRepo(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  if (parseBoolEnv(env.GH_ROUTER_DISABLE_STOP_GATE) === true) return false
  if (parseBoolEnv(env.GH_ROUTER_ENABLE_STOP_GATE) === true) return true
  return isRepoTrusted(cwd)
}

// ─── Harness detection ───────────────────────────────────────────────────────
// Pick a sealed gate whose commands are actually runnable: `bun` present AND the
// package.json scripts the gate invokes exist. Every sealed gate runs `bun run
// typecheck`, so a `typecheck` script is the floor; `bun test` is the bun
// built-in (always runnable); `bun run lint` needs a `lint` script. Returns null
// when nothing safe matches (→ the gate stays off rather than false-red).

async function readScripts(root: string): Promise<Record<string, string>> {
  try {
    const raw = await fs.readFile(nodePath.join(root, "package.json"), "utf8")
    const pkg: unknown = JSON.parse(raw)
    const scripts =
      pkg && typeof pkg === "object" ? (pkg as { scripts?: unknown }).scripts : undefined
    if (scripts && typeof scripts === "object") {
      const out: Record<string, string> = {}
      for (const [k, v] of Object.entries(scripts as Record<string, unknown>)) {
        if (typeof v === "string") out[k] = v
      }
      return out
    }
  } catch {
    /* no package.json / unparseable → no scripts */
  }
  return {}
}

/** Returns the sealed gate id to run for `cwd`, or null when none is safe. */
export async function detectHarnessGateId(cwd: string): Promise<string | null> {
  if (!resolveExecutable("bun", { env: process.env })) return null
  const root = await repoRoot(cwd)
  const scripts = await readScripts(root)
  const has = (k: string): boolean => typeof scripts[k] === "string"
  // Every sealed gate runs `bun run typecheck`; without that script it would
  // false-red, so it is the floor.
  if (!has("typecheck")) return null
  if (has("lint")) return "default-ci" // typecheck + test + lint
  return "typecheck-test" // typecheck + test
}

// ─── Baseline isolation ──────────────────────────────────────────────────────
// Block only on checks the agent's diff REGRESSED, never on failures that
// pre-date the session. v1: the first gate eval of a session records the then-
// failing checks as the baseline and does not block on them (it still blocks on
// gate-weakening); later evals block only on (currentFailed \ baseline).

/** Persistent per-session baseline: the set of check ids failing at first eval. */
export interface BaselineStore {
  /** Recorded baseline for a session, or null if none recorded yet. */
  get: (sessionId: string) => Promise<ReadonlySet<string> | null>
  /** Record the baseline failed-check set for a session (first eval only). */
  set: (sessionId: string, failed: ReadonlyArray<string>) => Promise<void>
}

/**
 * Given the current failed checks and the recorded baseline, return the checks
 * that REGRESSED (failing now, not failing at baseline). A null baseline (first
 * eval) yields an empty regression set — nothing is blamed on the agent yet.
 */
export function regressions(
  currentFailed: ReadonlyArray<string>,
  baseline: ReadonlySet<string> | null,
): string[] {
  if (baseline === null) return []
  return currentFailed.filter((id) => !baseline.has(id))
}

/** File-backed `BaselineStore` under `stateDir`, keyed by sha256(session_id). */
export function fileBaselineStore(stateDir: string): BaselineStore {
  const fileFor = (sid: string): string =>
    nodePath.join(stateDir, `baseline-${createHash("sha256").update(sid).digest("hex").slice(0, 32)}`)
  return {
    async get(sid) {
      try {
        const raw = await fs.readFile(fileFor(sid), "utf8")
        const arr: unknown = JSON.parse(raw)
        if (Array.isArray(arr)) return new Set(arr.filter((x): x is string => typeof x === "string"))
        return new Set<string>()
      } catch {
        return null // no baseline recorded yet
      }
    },
    async set(sid, failed) {
      await fs.mkdir(stateDir, { recursive: true })
      await fs.writeFile(fileFor(sid), JSON.stringify([...failed]), { mode: 0o600 })
    },
  }
}
