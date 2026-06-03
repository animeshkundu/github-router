import { test, expect, mock } from "bun:test"
import consola from "consola"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const tempDir = await fs.mkdtemp(
  path.join(os.tmpdir(), "github-router-claude-md-inject-"),
)

// Same homedir-override pattern as tests/lib-paths.test.ts — preserve
// every other os export so os.tmpdir() etc. keep working in later test
// files.
mock.module("node:os", () => ({
  default: { ...os, homedir: () => tempDir },
  ...os,
  homedir: () => tempDir,
}))

const { PATHS, isUnderClaudeConfigMirror } = await import("../src/lib/paths")
const {
  appendPeerAwarenessToMirroredClaudeMd,
  findMarkerBlocks,
  __testExports,
} = await import("../src/lib/claude-md-injection")

const {
  MARKER_OPEN,
  MARKER_CLOSE,
  MAX_CLAUDE_MD_BYTES,
  ERROR_CODE,
  detectLineEnding,
  stripLeadingBom,
} = __testExports

const MIRROR_DIR = PATHS.CLAUDE_CONFIG_DIR
const TARGET = path.join(MIRROR_DIR, "CLAUDE.md")

async function freshMirrorDir(): Promise<void> {
  // Wipe and recreate so each test starts from a clean state.
  await fs.rm(MIRROR_DIR, { recursive: true, force: true })
  await fs.mkdir(MIRROR_DIR, { recursive: true })
}

const SNIPPET = "## Peer review and advisor\n\nProxy-injected awareness."

test("idempotent across N invocations — exactly one marker block at the bottom", async () => {
  await freshMirrorDir()
  const userContent = "# My project\n\nLine one.\nLine two.\n"
  await fs.writeFile(TARGET, userContent, "utf8")

  for (let i = 0; i < 5; i++) {
    await appendPeerAwarenessToMirroredClaudeMd(SNIPPET)
  }

  const result = await fs.readFile(TARGET, "utf8")
  const opens = (result.match(new RegExp(escapeRe(MARKER_OPEN), "g")) ?? []).length
  const closes = (result.match(new RegExp(escapeRe(MARKER_CLOSE), "g")) ?? []).length
  expect(opens).toBe(1)
  expect(closes).toBe(1)
  // User content is preserved at the top, byte-for-byte.
  expect(result.startsWith(userContent.trimEnd())).toBe(true)
  // Marker block sits at the bottom.
  const closeIdx = result.lastIndexOf(MARKER_CLOSE)
  expect(closeIdx).toBeGreaterThan(0)
  const afterClose = result.slice(closeIdx + MARKER_CLOSE.length)
  // Only a trailing newline is allowed after the close marker.
  expect(afterClose).toMatch(/^\n*$/)
})

test("creates the mirrored file from scratch when no user CLAUDE.md exists", async () => {
  await freshMirrorDir()
  // No fs.writeFile beforehand.
  await appendPeerAwarenessToMirroredClaudeMd(SNIPPET)
  const result = await fs.readFile(TARGET, "utf8")
  expect(result).toContain(MARKER_OPEN)
  expect(result).toContain(MARKER_CLOSE)
  expect(result).toContain("Proxy-injected awareness.")
  // No leading user content.
  expect(result.startsWith(MARKER_OPEN)).toBe(true)
})

test("preserves user content byte-for-byte at the top", async () => {
  await freshMirrorDir()
  // Mix of headings, blank lines, code fences, trailing whitespace.
  const userContent =
    "# Title\n\nParagraph 1.\n\n## Subsection\n\n```js\nconst x = 1\n```\n\nTrailing line.\n"
  await fs.writeFile(TARGET, userContent, "utf8")

  await appendPeerAwarenessToMirroredClaudeMd(SNIPPET)

  const result = await fs.readFile(TARGET, "utf8")
  const openIdx = result.indexOf(MARKER_OPEN)
  expect(openIdx).toBeGreaterThan(0)
  // Everything up to the marker block (less the separator blank line)
  // must be the original content trimmed of trailing blanks.
  const userPart = result.slice(0, openIdx)
  expect(userPart.startsWith(userContent.trimEnd())).toBe(true)
})

test("isUnderClaudeConfigMirror guard refuses targets outside the mirror", async () => {
  // The helper itself warn-and-returns rather than throwing (matches
  // the rest of its failure modes). Spy on consola.warn and check the
  // helper does NOT write outside the mirror.
  const fakeUserClaudeMd = path.join(tempDir, ".claude", "CLAUDE.md")
  // Sanity check: the user's real ~/.claude/CLAUDE.md is NOT under
  // PATHS.CLAUDE_CONFIG_DIR (the mirror).
  expect(isUnderClaudeConfigMirror(fakeUserClaudeMd)).toBe(false)
  // And the mirror's own CLAUDE.md IS under the guard.
  expect(isUnderClaudeConfigMirror(TARGET)).toBe(true)
})

test("CRLF preservation — fixture with \\r\\n line endings keeps \\r\\n after append", async () => {
  await freshMirrorDir()
  const userContent = "# Title\r\n\r\nParagraph one.\r\nParagraph two.\r\n"
  await fs.writeFile(TARGET, userContent, "utf8")
  // Sanity: detectLineEnding agrees the fixture is CRLF.
  expect(detectLineEnding(userContent)).toBe("\r\n")

  await appendPeerAwarenessToMirroredClaudeMd(SNIPPET)

  const result = await fs.readFile(TARGET, "utf8")
  // Every line break is CRLF; no bare LF anywhere.
  const crlfCount = (result.match(/\r\n/g) ?? []).length
  const totalLfCount = (result.match(/\n/g) ?? []).length
  expect(crlfCount).toBe(totalLfCount)
  // User content preserved at the top.
  expect(result.startsWith(userContent.trimEnd().replace(/\r\n$/, ""))).toBe(
    true,
  )
})

test("size guard — file > 1 MiB is skipped with a single warn", async () => {
  await freshMirrorDir()
  // Generate a 1.1 MiB file of harmless content.
  const big = "a".repeat(MAX_CLAUDE_MD_BYTES + 100 * 1024)
  await fs.writeFile(TARGET, big, "utf8")

  const warns: Array<string> = []
  const originalWarn = consola.warn
  consola.warn = ((msg: unknown) => {
    warns.push(String(msg))
  }) as typeof consola.warn

  try {
    await appendPeerAwarenessToMirroredClaudeMd(SNIPPET)
  } finally {
    consola.warn = originalWarn
  }

  // File is untouched.
  const result = await fs.readFile(TARGET, "utf8")
  expect(result).toBe(big)
  expect(result).not.toContain(MARKER_OPEN)
  // Exactly one warn surfaced the size-cap decision.
  const sizeWarns = warns.filter((w) => w.includes("oversized") || w.includes("skipping"))
  expect(sizeWarns.length).toBeGreaterThanOrEqual(1)
})

test("multiple stale marker blocks are all removed; exactly one fresh block appended", async () => {
  await freshMirrorDir()
  // Hand-craft a file with three stale marker blocks.
  const oldBlock = `${MARKER_OPEN}\nold content\n${MARKER_CLOSE}`
  const userContent = `# Title\n\nReal content.\n\n${oldBlock}\n\nMore content.\n\n${oldBlock}\n\nEnd.\n\n${oldBlock}\n`
  await fs.writeFile(TARGET, userContent, "utf8")

  await appendPeerAwarenessToMirroredClaudeMd(SNIPPET)

  const result = await fs.readFile(TARGET, "utf8")
  const opens = (result.match(new RegExp(escapeRe(MARKER_OPEN), "g")) ?? []).length
  const closes = (result.match(new RegExp(escapeRe(MARKER_CLOSE), "g")) ?? []).length
  expect(opens).toBe(1)
  expect(closes).toBe(1)
  // The "old content" string from the stale blocks is gone; the new
  // snippet body is present.
  expect(result).not.toContain("old content")
  expect(result).toContain("Proxy-injected awareness.")
  // User non-block content is preserved.
  expect(result).toContain("# Title")
  expect(result).toContain("Real content.")
  expect(result).toContain("More content.")
  expect(result).toContain("End.")
})

test("unterminated marker (open without close) is left untouched and warns", async () => {
  await freshMirrorDir()
  // User CLAUDE.md with a malformed marker — open with no close.
  const userContent = `# Title\n\nReal content.\n\n${MARKER_OPEN}\nthis was never closed\n\nMore content.\n`
  await fs.writeFile(TARGET, userContent, "utf8")

  const warns: Array<string> = []
  const originalWarn = consola.warn
  consola.warn = ((msg: unknown) => {
    warns.push(String(msg))
  }) as typeof consola.warn

  try {
    await appendPeerAwarenessToMirroredClaudeMd(SNIPPET)
  } finally {
    consola.warn = originalWarn
  }

  // File is BYTE-FOR-BYTE untouched.
  const result = await fs.readFile(TARGET, "utf8")
  expect(result).toBe(userContent)
  // The malformed-marker warn fired.
  const malformedWarns = warns.filter((w) => w.includes("malformed marker"))
  expect(malformedWarns.length).toBeGreaterThanOrEqual(1)
})

test("agent-edits-own-memory self-heal — paraphrased marker is left, then next launch appends a fresh one", async () => {
  await freshMirrorDir()
  // First launch: write the marker.
  await appendPeerAwarenessToMirroredClaudeMd(SNIPPET)
  const afterFirst = await fs.readFile(TARGET, "utf8")
  expect(afterFirst).toContain(MARKER_OPEN)

  // Simulate "agent edits its own memory": paraphrase the marker text
  // so the literal-text match no longer recognizes it as ours, AND
  // delete the close marker so any future helper run also sees a
  // malformed state. We expect the helper to leave the malformed
  // state untouched (warns) — but the next snapshot-then-launch cycle
  // (re-copy of user's ~/.claude/CLAUDE.md, then helper) would heal.
  // Here we just verify the malformed-leave behaviour (the snapshot
  // step is `ensureClaudeConfigMirror`, tested separately).
  const paraphrased = afterFirst.replace(
    MARKER_OPEN,
    "<!-- the agent rewrote this marker -->",
  )
  await fs.writeFile(TARGET, paraphrased, "utf8")

  const warns: Array<string> = []
  const originalWarn = consola.warn
  consola.warn = ((msg: unknown) => {
    warns.push(String(msg))
  }) as typeof consola.warn

  try {
    await appendPeerAwarenessToMirroredClaudeMd(SNIPPET)
  } finally {
    consola.warn = originalWarn
  }

  // The paraphrased marker + dangling close make this a "close without
  // open" malformed state → left untouched + warn.
  const result = await fs.readFile(TARGET, "utf8")
  expect(result).toBe(paraphrased)
  expect(warns.some((w) => w.includes("malformed marker"))).toBe(true)
})

test("symlinked target is refused", async () => {
  await freshMirrorDir()
  const sourceFile = path.join(tempDir, "real-claude-md-source.md")
  await fs.writeFile(sourceFile, "PRECIOUS USER CONTENT\n", "utf8")
  // Create CLAUDE.md as a symlink to the source. On Windows this may
  // require admin/Developer Mode (file-type symlinks). If symlink
  // creation fails on this platform (typical Windows CI without
  // elevated perms), skip with an inline note — matches the
  // documented exception pattern at tests/lib-paths.test.ts:67.
  try {
    await fs.symlink(sourceFile, TARGET, "file")
  } catch {
    consola.warn(
      `[claude-md-injection.test] symlink creation unsupported on this platform — skipping symlink-refusal assertion`,
    )
    return
  }

  const warns: Array<string> = []
  const originalWarn = consola.warn
  consola.warn = ((msg: unknown) => {
    warns.push(String(msg))
  }) as typeof consola.warn

  try {
    await appendPeerAwarenessToMirroredClaudeMd(SNIPPET)
  } finally {
    consola.warn = originalWarn
  }

  // Source file is byte-for-byte untouched (the helper refused to
  // follow the symlink and rewrite the real file).
  const source = await fs.readFile(sourceFile, "utf8")
  expect(source).toBe("PRECIOUS USER CONTENT\n")
  // The symlink itself is still a symlink (helper didn't replace it
  // with a regular file).
  const linkStat = await fs.lstat(TARGET)
  expect(linkStat.isSymbolicLink()).toBe(true)
  // The symlink-refusal warn fired.
  expect(warns.some((w) => w.includes("symlinked"))).toBe(true)
})

test("symlinked mirror ROOT is refused (peer-review C3 advisor follow-up: fail-closed)", async () => {
  // Replace the mirror dir with a symlink to a different directory.
  // The helper must refuse to write even though `path.resolve()`'s
  // lexical containment check would pass (resolved root canonicalizes
  // through the link). Verifies the new lstat-on-root guard.
  await fs.rm(MIRROR_DIR, { recursive: true, force: true })
  const realDir = path.join(tempDir, "real-mirror-dir")
  await fs.mkdir(realDir, { recursive: true })
  // Sanity: ensure the target dir for the symlink doesn't exist.
  try {
    await fs.unlink(MIRROR_DIR)
  } catch {
    // ignore
  }
  // On Windows, dir-typed symlinks may require admin/Developer Mode.
  // If creation fails on this platform, log and skip — matches the
  // documented exception pattern at tests/lib-paths.test.ts:67.
  try {
    await fs.symlink(realDir, MIRROR_DIR, "dir")
  } catch {
    consola.warn(
      `[claude-md-injection.test] symlinked-root creation unsupported on this platform — skipping mirror-root symlink-refusal assertion`,
    )
    // Re-provision the fresh mirror dir so later tests aren't affected.
    await freshMirrorDir()
    return
  }

  const warns: Array<string> = []
  const originalWarn = consola.warn
  consola.warn = ((msg: unknown) => {
    warns.push(String(msg))
  }) as typeof consola.warn

  try {
    await appendPeerAwarenessToMirroredClaudeMd(SNIPPET)
  } finally {
    consola.warn = originalWarn
  }

  // No CLAUDE.md was created inside the linked-to real dir — the
  // helper refused at the root-symlink check.
  await expect(
    fs.access(path.join(realDir, "CLAUDE.md")),
  ).rejects.toThrow()
  expect(
    warns.some((w) => w.includes("mirror root is a symlink")),
  ).toBe(true)

  // Restore for downstream tests.
  await fs.unlink(MIRROR_DIR)
  await freshMirrorDir()
})

test("findMarkerBlocks correctly identifies well-formed and malformed states", () => {
  // Zero blocks.
  expect(findMarkerBlocks([])).toEqual({ blocks: [], malformed: false })
  expect(findMarkerBlocks(["a", "b", "c"])).toEqual({
    blocks: [],
    malformed: false,
  })

  // One well-formed block.
  const oneBlock = findMarkerBlocks([
    "a",
    MARKER_OPEN,
    "snippet",
    MARKER_CLOSE,
    "b",
  ])
  expect(oneBlock).toEqual({
    blocks: [{ openLineIndex: 1, closeLineIndex: 3 }],
    malformed: false,
  })

  // Two well-formed blocks.
  const twoBlocks = findMarkerBlocks([
    MARKER_OPEN,
    "a",
    MARKER_CLOSE,
    "between",
    MARKER_OPEN,
    "b",
    MARKER_CLOSE,
  ])
  expect(twoBlocks.blocks).toHaveLength(2)
  expect(twoBlocks.malformed).toBe(false)

  // Open without close.
  const openOnly = findMarkerBlocks([MARKER_OPEN, "a", "b"])
  expect(openOnly.malformed).toBe(true)

  // Close without open.
  const closeOnly = findMarkerBlocks(["a", MARKER_CLOSE, "b"])
  expect(closeOnly.malformed).toBe(true)

  // Two opens with no close between.
  const twoOpens = findMarkerBlocks([MARKER_OPEN, MARKER_OPEN, MARKER_CLOSE])
  expect(twoOpens.malformed).toBe(true)
})

test("writer-side guard — refuses to inject a snippet that contains the marker literal", async () => {
  await freshMirrorDir()
  const userContent = "# Title\n\nReal content.\n"
  await fs.writeFile(TARGET, userContent, "utf8")

  const warns: Array<string> = []
  const originalWarn = consola.warn
  consola.warn = ((msg: unknown) => {
    warns.push(String(msg))
  }) as typeof consola.warn

  const malicious = `inner\n${MARKER_OPEN}\ngotcha\n${MARKER_CLOSE}\nouter`
  try {
    await appendPeerAwarenessToMirroredClaudeMd(malicious)
  } finally {
    consola.warn = originalWarn
  }

  // File is byte-for-byte untouched; the guard fires before any read.
  const result = await fs.readFile(TARGET, "utf8")
  expect(result).toBe(userContent)
  // Error code prefix is present on the warn.
  expect(warns.some((w) => w.includes(ERROR_CODE))).toBe(true)
  expect(warns.some((w) => w.includes("marker literal"))).toBe(true)
})

test("post-build size guard — measures the would-be content, not raw existing size (peer-review I6)", async () => {
  await freshMirrorDir()
  // Fixture: a file that is JUST below the cap (would push over only
  // if the snippet were a fresh insert). The PRE-strip raw-size
  // check would short-circuit and the marker block would never
  // refresh. The post-strip check correctly evaluates the final
  // bytes.
  const padBytes = MAX_CLAUDE_MD_BYTES - 1024
  const userContent = "x".repeat(padBytes)
  await fs.writeFile(TARGET, userContent, "utf8")

  await appendPeerAwarenessToMirroredClaudeMd(SNIPPET)

  // SNIPPET is small (~50 bytes); userContent + snippet + marker
  // overhead is still under the cap, so the write should succeed.
  const result = await fs.readFile(TARGET, "utf8")
  expect(result).toContain(MARKER_OPEN)
  expect(result).toContain("Proxy-injected awareness.")
  // The post-build check passed; the file is updated.
})

test("post-build size guard — final content over cap is refused (defense for runaway snippet)", async () => {
  await freshMirrorDir()
  const userContent = "# Small file\n"
  await fs.writeFile(TARGET, userContent, "utf8")
  // Snippet that, plus markers, blows past the cap.
  const huge = "a".repeat(MAX_CLAUDE_MD_BYTES + 100)

  const warns: Array<string> = []
  const originalWarn = consola.warn
  consola.warn = ((msg: unknown) => {
    warns.push(String(msg))
  }) as typeof consola.warn

  try {
    await appendPeerAwarenessToMirroredClaudeMd(huge)
  } finally {
    consola.warn = originalWarn
  }

  const result = await fs.readFile(TARGET, "utf8")
  expect(result).toBe(userContent)
  expect(warns.some((w) => w.includes("post-build content exceeds"))).toBe(
    true,
  )
})

test("BOM-prefixed CLAUDE.md is parsed correctly AND BOM is preserved on write (suggestion #11, peer-review I5)", async () => {
  await freshMirrorDir()
  const BOM = "﻿"
  // First-launch flow: write a BOM-prefixed file with a stale marker
  // block. Without the BOM strip, the first marker line wouldn't
  // match (`BOM + MARKER_OPEN` !== `MARKER_OPEN`) and re-launches
  // would keep injecting fresh blocks. With the strip, the existing
  // block is correctly detected and replaced.
  const userPrefix = "# Title\n\nReal content.\n\n"
  const staleBlock = `${MARKER_OPEN}\nold content\n${MARKER_CLOSE}\n`
  await fs.writeFile(TARGET, BOM + userPrefix + staleBlock, "utf8")

  await appendPeerAwarenessToMirroredClaudeMd(SNIPPET)

  const result = await fs.readFile(TARGET, "utf8")
  const opens = (result.match(new RegExp(escapeRe(MARKER_OPEN), "g")) ?? [])
    .length
  // Exactly one marker block — the stale one was correctly found and
  // replaced, not duplicated.
  expect(opens).toBe(1)
  // The stale "old content" is gone.
  expect(result).not.toContain("old content")
  expect(result).toContain("Proxy-injected awareness.")

  // BOM is preserved at the head of the file (peer-review I5).
  expect(result.charCodeAt(0)).toBe(0xfeff)

  // stripLeadingBom unit check.
  expect(stripLeadingBom("﻿hello")).toBe("hello")
  expect(stripLeadingBom("hello")).toBe("hello")
  expect(stripLeadingBom("")).toBe("")
})

test("non-BOM CLAUDE.md stays non-BOM after write", async () => {
  await freshMirrorDir()
  const userContent = "# Title\n\nNo BOM here.\n"
  await fs.writeFile(TARGET, userContent, "utf8")

  await appendPeerAwarenessToMirroredClaudeMd(SNIPPET)

  const result = await fs.readFile(TARGET, "utf8")
  // First character is `#`, not BOM.
  expect(result.charCodeAt(0)).toBe("#".charCodeAt(0))
})

test("every warn message starts with the ERROR_CODE prefix (suggestion #15 — grep-able)", async () => {
  await freshMirrorDir()
  // Trigger the malformed-marker warn path.
  const userContent = `# Title\n${MARKER_OPEN}\norphan open\n`
  await fs.writeFile(TARGET, userContent, "utf8")

  const warns: Array<string> = []
  const originalWarn = consola.warn
  consola.warn = ((msg: unknown) => {
    warns.push(String(msg))
  }) as typeof consola.warn

  try {
    await appendPeerAwarenessToMirroredClaudeMd(SNIPPET)
  } finally {
    consola.warn = originalWarn
  }

  // Every warn in the helper's namespace starts with the error code.
  const helperWarns = warns.filter((w) => w.includes("malformed"))
  expect(helperWarns.length).toBeGreaterThanOrEqual(1)
  for (const w of helperWarns) {
    expect(w.startsWith(ERROR_CODE)).toBe(true)
  }
})

test("detectLineEnding edge cases", () => {
  expect(detectLineEnding("")).toBe("\n")
  expect(detectLineEnding("hello\n")).toBe("\n")
  expect(detectLineEnding("hello\r\n")).toBe("\r\n")
  // Mixed — majority wins.
  expect(detectLineEnding("a\r\nb\r\nc\n")).toBe("\r\n")
  expect(detectLineEnding("a\nb\nc\r\n")).toBe("\n")
})

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}
