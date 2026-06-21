/**
 * Gate-immutability detection (floor invariant 5). A producer must not weaken
 * the gates it is judged by — adding `.skip`, `@ts-ignore`, `as any`, or
 * `eslint-disable` turns a failing gate green without fixing anything, which is
 * the cheapest way to defeat the whole floor guarantee.
 *
 * `detectGateWeakening` scans the ADDED lines of a unified git diff for these
 * patterns. It is deliberately a syntactic heuristic over added lines only (a
 * removed `.skip` is a strengthening, not a weakening) — pure, dependency-free,
 * and used by BOTH the Phase-0 structural-gate Stop-hook (reject the diff) and
 * the kernel's runner (gate-immutability check before accepting an artifact).
 *
 * Patterns are LANGUAGE-SCOPED: each added line is tested only against a shared
 * COMMON set plus the patterns for the file's language (by extension, derived
 * from the diff header). An unknown extension is tested against COMMON only —
 * failing OPEN (no false block) is the safe direction for a Stop hook. This both
 * generalizes beyond TS/JS and removes cross-language false positives (e.g. a Go
 * `.only(` substring is no longer flagged as a skipped JS test).
 */

export interface WeakeningFinding {
  /** Stable category (e.g. "skipped-test", "any-cast"). */
  pattern: string
  /** The offending added line (trimmed) for the report. */
  line: string
  /** The file the line was added to, when derivable from the diff header. */
  file?: string
}

export interface GateImmutabilityResult {
  weakened: boolean
  findings: WeakeningFinding[]
}

/** Patterns that weaken a gate regardless of language (test exclusivity / focus
 *  idioms shared across JS test runners; kept in COMMON since several languages
 *  reuse them). */
const COMMON_PATTERNS: ReadonlyArray<{ name: string; re: RegExp }> = [
  // Disabling tests: jest/bun/mocha skip + exclusive-focus (`.only` narrows the
  // suite so other failures stop running — also a weakening).
  { name: "skipped-test", re: /(\.\s*skip\s*\(|\bxit\s*\(|\bxdescribe\s*\(|\.\s*only\s*\()/ },
]

/** Language-specific weakening patterns, selected by the added line's file type. */
const LANG_PATTERNS: Readonly<Record<string, ReadonlyArray<{ name: string; re: RegExp }>>> = {
  ts: [
    // Silencing the type-checker.
    { name: "ts-suppression", re: /@ts-(ignore|nocheck|expect-error)\b/ },
    // Casting away type errors.
    { name: "any-cast", re: /\bas\s+any\b|:\s*any\b/ },
    // Silencing the linter.
    { name: "eslint-disable", re: /eslint-disable\b/ },
  ],
  py: [
    { name: "py-type-ignore", re: /#\s*type:\s*ignore\b/ },
    { name: "py-noqa", re: /#\s*noqa\b/ },
    { name: "py-skip", re: /@(pytest\.mark\.skip|unittest\.skip)\b/ },
  ],
  go: [
    { name: "go-skip", re: /\bt\.Skip\s*\(/ },
    { name: "go-nolint", re: /\/\/\s*nolint\b/ },
  ],
  rust: [
    { name: "rust-ignore", re: /#\[\s*ignore\b/ },
    { name: "rust-allow", re: /#\[\s*allow\s*\(/ },
  ],
}

/** Map a file path to a language key for `LANG_PATTERNS` (null → COMMON only). */
function langForFile(file: string | undefined): keyof typeof LANG_PATTERNS | null {
  if (!file) return null
  const ext = file.slice(file.lastIndexOf(".")).toLowerCase()
  switch (ext) {
    case ".ts":
    case ".tsx":
    case ".mts":
    case ".cts":
    case ".js":
    case ".jsx":
    case ".mjs":
    case ".cjs":
      return "ts"
    case ".py":
    case ".pyi":
      return "py"
    case ".go":
      return "go"
    case ".rs":
      return "rust"
    default:
      return null
  }
}

/** Union of COMMON + every language — the pre-header default (no file known yet),
 *  so a header-less diff is matched permissively, exactly as before this became
 *  language-scoped. Once a real file header appears, the set narrows to that
 *  file's language (or COMMON only for an unknown extension → fail open). */
const ALL_PATTERNS: ReadonlyArray<{ name: string; re: RegExp }> = [
  ...COMMON_PATTERNS,
  ...Object.values(LANG_PATTERNS).flat(),
]

/** A `diff --git a/x b/x` or `+++ b/x` header → the current file path. */
function fileFromHeader(line: string): string | undefined {
  const git = /^diff --git a\/.+ b\/(.+)$/.exec(line)
  if (git) return git[1]
  const plus = /^\+\+\+ b\/(.+)$/.exec(line)
  if (plus) return plus[1]
  return undefined
}

export function detectGateWeakening(diff: string): GateImmutabilityResult {
  const findings: WeakeningFinding[] = []
  let file: string | undefined
  let patterns: ReadonlyArray<{ name: string; re: RegExp }> = ALL_PATTERNS
  for (const raw of diff.split("\n")) {
    const headerFile = fileFromHeader(raw)
    if (headerFile !== undefined) {
      file = headerFile
      const lang = langForFile(file)
      patterns = lang ? [...COMMON_PATTERNS, ...LANG_PATTERNS[lang]] : COMMON_PATTERNS
      continue
    }
    // Only ADDED content lines (skip the `+++` file header and context/removed).
    if (!raw.startsWith("+") || raw.startsWith("+++")) continue
    const added = raw.slice(1)
    for (const p of patterns) {
      if (p.re.test(added)) {
        findings.push(file === undefined ? { pattern: p.name, line: added.trim() } : { pattern: p.name, line: added.trim(), file })
      }
    }
  }
  return { weakened: findings.length > 0, findings }
}
