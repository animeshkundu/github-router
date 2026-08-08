import { existsSync, readdirSync, statSync } from "node:fs"
import { open } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"

import { describe, expect, test } from "bun:test"

import { CLIENT_REDUNDANCY_MARKERS } from "../../src/lib/tool-loop-guard"

/**
 * Drift canary for the loop guard's Tier A signal.
 *
 * Tier A recognizes tool results in which the CLIENT declares a call
 * redundant — the strongest loop evidence available, because the client has
 * already adjudicated it. The cost of that precision is a coupling to strings
 * the client owns and can reword in any release, and the failure mode is the
 * bad one: Tier A would silently stop matching and nobody would learn until the
 * next runaway burned another 4,000 calls.
 *
 * So this asserts the markers still exist in the installed client. It SKIPS
 * where no client is installed (CI, a fresh container) rather than failing,
 * because absence there proves nothing — the check is meaningful exactly on the
 * machines that actually run the client.
 *
 * On failure: re-derive the marker from a real transcript (under
 * `~/.claude/projects/<slug>/subagents/`, look at `tool_result` contents)
 * and update `CLIENT_REDUNDANCY_MARKERS`. Tier B still bounds the loop in the
 * meantime, so this is a degradation, not an outage.
 */

/** Newest installed Claude Code bundle, or undefined if none is present. */
function installedClaudeBundle(): string | undefined {
  const candidates: Array<string> = []

  const versionsDir = join(homedir(), ".local", "share", "claude", "versions")
  if (existsSync(versionsDir)) {
    for (const entry of readdirSync(versionsDir)) {
      candidates.push(join(versionsDir, entry))
    }
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
 * The RUNTIME string carries real characters — the marker holds a genuine em
 * dash, verified against a stored transcript. The BUNDLE may hold the same
 * string with non-ASCII characters written as `\uXXXX` escapes, which is
 * exactly what Claude Code's build does. Searching only for the raw form finds
 * nothing and reports a false rewording, so both forms count.
 */
function bundleForms(marker: string): Array<string> {
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
 * Streaming byte search. The bundles are ~280 MB, so this reads in chunks and
 * overlaps by the needle length so a match spanning a chunk boundary is not
 * missed. Byte-level (not text) search keeps the multi-byte em dash in the
 * marker from being split by a decoder.
 */
async function bundleContainsAny(
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

describe("client loop-marker canary", () => {
  const bundle = installedClaudeBundle()

  test("the marker set is non-empty and exactly specified", () => {
    // Guards against someone emptying the set and quietly disabling Tier A.
    expect(CLIENT_REDUNDANCY_MARKERS.size).toBeGreaterThan(0)
    for (const marker of CLIENT_REDUNDANCY_MARKERS) {
      expect(marker.trim()).toBe(marker)
      expect(marker.length).toBeGreaterThan(20)
    }
  })

  test("every marker still appears in the installed Claude Code build", async () => {
    if (!bundle) {
      console.log(
        "[canary] no Claude Code install found — skipping marker check",
      )
      return
    }
    for (const marker of CLIENT_REDUNDANCY_MARKERS) {
      const present = await bundleContainsAny(bundle, bundleForms(marker))
      if (!present) {
        throw new Error(
          `Tier A loop marker no longer present in ${bundle}.\n`
            + `Missing: ${JSON.stringify(marker)}\n`
            + "The client reworded it; Tier A is now inert for this case. "
            + "Re-derive it from a real transcript and update "
            + "CLIENT_REDUNDANCY_MARKERS in src/lib/tool-loop-guard.ts.",
        )
      }
      expect(present).toBe(true)
    }
  }, 60_000)
})
