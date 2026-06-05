/**
 * PATH-injection helpers for the LLM toolbelt.
 *
 * The toolbelt `bin/` dir is prepended to the spawned agent's PATH so
 * the model can call `rg`/`fd`/`jq`/etc. directly. On Windows the env
 * block is case-insensitive but a plain JS object can hold BOTH `PATH`
 * and `Path` — and the spawned process may then resolve the *un*-edited
 * one, silently ignoring the injection. Every helper here funnels PATH
 * through a single canonical key to make that impossible.
 */

import path from "node:path"

/**
 * The key under which `env` stores PATH, matched case-insensitively.
 * Falls back to the platform-conventional spelling when absent.
 */
export function pathEnvKey(env: NodeJS.ProcessEnv): string {
  for (const key of Object.keys(env)) {
    if (key.toLowerCase() === "path") return key
  }
  return process.platform === "win32" ? "Path" : "PATH"
}

/**
 * Compute the PATH override that prepends `binDir`, reusing the parent's
 * existing key casing so a subsequent merge can't introduce a duplicate
 * case-variant key. Returns a single-entry patch suitable for
 * `Object.assign(vars, ...)`.
 */
export function toolbeltPathOverride(
  parentEnv: NodeJS.ProcessEnv,
  binDir: string,
): Record<string, string> {
  const key = pathEnvKey(parentEnv)
  const current = parentEnv[key] ?? ""
  return {
    [key]: current ? `${binDir}${path.delimiter}${current}` : binDir,
  }
}

/**
 * Defense-in-depth: collapse all case-variant PATH keys in `env` into a
 * single canonical key. Mutates and returns `env`. If duplicates with
 * differing values exist (only possible via a mismatched-casing merge),
 * the longest value wins — the toolbelt-prepended PATH is strictly
 * longer than the original, so this preserves the injection.
 */
export function collapsePathKeys(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const keys = Object.keys(env).filter((k) => k.toLowerCase() === "path")
  if (keys.length <= 1) return env

  let bestValue = ""
  for (const k of keys) {
    const v = env[k] ?? ""
    if (v.length >= bestValue.length) bestValue = v
    delete env[k]
  }
  env[process.platform === "win32" ? "Path" : "PATH"] = bestValue
  return env
}
