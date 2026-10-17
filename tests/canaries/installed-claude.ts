import { existsSync, readdirSync, statSync } from "node:fs"
import { open } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"

/**
 * Shared helpers for the canaries that pin this proxy against strings and
 * constants owned by the installed Claude Code build.
 *
 * Every canary here has the same shape and the same justification: we depend on
 * something the client can change in any release, the failure mode is silent
 * (our side stops matching and nobody learns until a user is hurt), and the
 * check is only meaningful on a machine that actually has the client. So they
 * SKIP where no install is present rather than failing, which includes CI.
 */

/** Newest installed Claude Code bundle, or undefined if none is present. */
export function installedClaudeBundle(): string | undefined {
  const candidates: Array<string> = []

  const versionsDir = join(homedir(), ".local", "share", "claude", "versions")
  if (existsSync(versionsDir)) {
    for (const entry of readdirSync(versionsDir)) {
      candidates.push(join(versionsDir, entry))
    }
  }

  // Native-installer launcher. On Windows this is the real executable rather
  // than a shim, so it carries the bundle and is often newer than anything
  // under `versions/`.
  for (const name of ["claude", "claude.exe"]) {
    candidates.push(join(homedir(), ".local", "bin", name))
  }

  // npm-installed layout, for machines that did not use the native installer.
  for (const root of [
    join(homedir(), ".npm-global"),
    join(homedir(), "AppData", "Roaming", "npm"),
    "/usr/local/lib",
    "/usr/lib",
  ]) {
    const cli = join(
      root,
      "node_modules",
      "@anthropic-ai",
      "claude-code",
      "cli.js",
    )
    if (existsSync(cli)) candidates.push(cli)
  }

  const files = candidates.filter((path) => {
    try {
      return statSync(path).isFile()
    } catch {
      return false
    }
  })
  if (files.length === 0) return undefined

  // Newest by mtime: the build most likely in use.
  return files.reduce((newest, path) =>
    statSync(path).mtimeMs > statSync(newest).mtimeMs ? path : newest,
  )
}

/**
 * Representations a marker can take inside a shipped bundle.
 *
 * The RUNTIME string carries real characters — a marker may hold a genuine em
 * dash, verified against a stored transcript. The BUNDLE may hold the same
 * string with non-ASCII characters written as `\uXXXX` escapes, which is
 * exactly what Claude Code's build does. Searching only for the raw form finds
 * nothing and reports a false rewording, so both forms count.
 */
export function bundleForms(marker: string): Array<string> {
  const escaped = [...marker]
    .map((char) => {
      const code = char.codePointAt(0)!
      if (code <= 0x7f) return char
      return `\\u${code.toString(16).padStart(4, "0")}`
    })
    .join("")
  return escaped === marker ? [marker] : [marker, escaped]
}

/**
 * Streaming byte search. The bundles are ~250 MB, so this reads in chunks and
 * overlaps by the needle length so a match spanning a chunk boundary is not
 * missed. Byte-level (not text) search keeps a multi-byte character in a
 * marker from being split by a decoder.
 */
export async function bundleContainsAny(
  path: string,
  needles: Array<string>,
): Promise<boolean> {
  const targets = needles.map((needle) => Buffer.from(needle, "utf8"))
  const chunkSize = 8 * 1024 * 1024
  const overlap = Math.max(...targets.map((target) => target.length))
  const buffer = Buffer.alloc(chunkSize + overlap)

  const handle = await open(path, "r")
  try {
    let carried = 0
    let position = 0
    for (;;) {
      const { bytesRead } = await handle.read(
        buffer,
        carried,
        chunkSize,
        position,
      )
      if (bytesRead === 0) return false
      position += bytesRead
      const filled = carried + bytesRead
      const window = buffer.subarray(0, filled)
      if (targets.some((target) => window.indexOf(target) !== -1)) return true
      carried = Math.min(overlap, filled)
      buffer.copy(buffer, 0, filled - carried, filled)
    }
  } finally {
    await handle.close()
  }
}

/**
 * True when EVERY marker of one contract group is present.
 *
 * A group is a conjunction of facts, not a list of alternatives: the
 * auto-compact groups pair the 100K/1M constants with the call site that
 * feeds them to the env parser and raises the effective value to the floor.
 * A build that renamed the constants satisfies neither half, and one that
 * kept the names but dropped the `Math.max` satisfies only the half that
 * proves nothing on its own.
 *
 * It lives here, and is asserted directly, because the two are easy to
 * confuse: `bundleContainsAny` takes an ALTERNATIVES list, so a group
 * evaluated with the wrong combinator would still pass on the build that
 * happens to be installed today and only stop discriminating later, when
 * nothing is watching. The helper is deliberately generic over the marker
 * list so a test can drive it with synthetic content on a machine that has no
 * client installed at all (CI).
 */
export async function bundleContainsAll(
  path: string,
  needles: ReadonlyArray<string>,
): Promise<boolean> {
  const found = await Promise.all(
    needles.map((needle) => bundleContainsAny(path, [needle])),
  )
  return found.every(Boolean)
}

/**
 * True when at least one contract group fully matches.
 *
 * Groups ARE alternatives to each other: each one pins the same behavior as
 * minified identifiers rolled across releases, so a developer on an older
 * build must keep passing on the older group.
 */
export async function anyContractGroupMatches(
  path: string,
  groups: ReadonlyArray<ReadonlyArray<string>>,
): Promise<boolean> {
  const matches = await Promise.all(
    groups.map((group) => bundleContainsAll(path, group)),
  )
  return matches.some(Boolean)
}
