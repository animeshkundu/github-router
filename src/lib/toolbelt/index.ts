/**
 * Toolbelt gating, gap-fill planning, and the awareness one-liner.
 *
 * "Gap-fill": we only expose a tool the user does NOT already have on
 * PATH, so we never shadow a pinned/wrapper `jq` or an incompatible
 * `yq` (Go vs Python). The provisioner enforces the same rule when
 * materializing binaries; this module computes the *planned* set
 * synchronously (sync PATH probes) so the launcher can tell the model
 * which tools to expect without waiting on background downloads.
 */

import { existsSync } from "node:fs"
import { createRequire } from "node:module"

import { parseBoolEnv, resolveExecutable } from "../exec"
import { assetFor, TOOLBELT_TOOLS } from "./manifest"

/** Default ON; disable with GH_ROUTER_DISABLE_TOOLBELT (truthy). */
export function toolbeltEnabled(): boolean {
  return parseBoolEnv(process.env.GH_ROUTER_DISABLE_TOOLBELT) !== true
}

/** Per-tool opt-out via GH_ROUTER_TOOLBELT_SKIP="jq,yq". */
export function toolbeltSkipSet(): Set<string> {
  const raw = process.env.GH_ROUTER_TOOLBELT_SKIP
  if (!raw) return new Set()
  return new Set(
    raw
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  )
}

/** Absolute path to the bundled `@vscode/ripgrep` binary, or null. */
export function vscodeRipgrepPath(): string | null {
  try {
    const require = createRequire(import.meta.url)
    const mod = require("@vscode/ripgrep") as { rgPath?: string }
    if (mod.rgPath && existsSync(mod.rgPath)) return mod.rgPath
  } catch {
    // optionalDependency absent
  }
  return null
}

/**
 * The commands the toolbelt WILL expose this launch (gap-fill plan):
 * each tool that is supported on this platform, not skipped, and not
 * already on the user's PATH. Used for the awareness one-liner.
 */
export function planExposedCommands(): string[] {
  if (!toolbeltEnabled()) return []
  const skip = toolbeltSkipSet()
  const out: string[] = []

  if (!skip.has("rg") && !resolveExecutable("rg") && vscodeRipgrepPath()) {
    out.push("rg")
  }
  for (const spec of TOOLBELT_TOOLS) {
    if (skip.has(spec.command)) continue
    if (!assetFor(spec)) continue // unsupported platform/arch
    if (resolveExecutable(spec.command)) continue // user already has it
    out.push(spec.command)
  }
  return out
}

const TOOL_DESC: Record<string, string> = {
  rg: "rg (fast regex search)",
  fd: "fd (fast file finder)",
  jq: "jq (JSON processor)",
  sd: "sd (find & replace)",
  "ast-grep": "ast-grep / sg (structural code search & rewrite)",
  yq: "yq (YAML / TOML / XML processor)",
}

/**
 * The one-line CLAUDE.md / system-prompt note advertising the exposed
 * tools, or null when none are exposed.
 */
export function buildToolbeltAwareness(commands: string[]): string | null {
  if (commands.length === 0) return null
  const parts = commands.map((c) => TOOL_DESC[c] ?? c)
  return (
    "Fast CLI tools are available on your PATH; prefer them when applicable: "
    + parts.join(", ")
    + "."
  )
}
