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

interface WeakeningPattern {
  name: string
  re: RegExp
  /** Where the syntax is meaningful: executable code or a comment directive. */
  scope: "code" | "slash-comment" | "hash-comment"
}

/** Patterns that weaken a gate regardless of language (test exclusivity / focus
 *  idioms shared across JS test runners; kept in COMMON since several languages
 *  reuse them). */
const COMMON_PATTERNS: ReadonlyArray<WeakeningPattern> = [
  // Disabling tests: jest/bun/mocha skip + exclusive-focus (`.only` narrows the
  // suite so other failures stop running — also a weakening).
  { name: "skipped-test", re: /(\.\s*skip\s*\(|\bxit\s*\(|\bxdescribe\s*\(|\.\s*only\s*\()/, scope: "code" },
]

/** Language-specific weakening patterns, selected by the added line's file type. */
const LANG_PATTERNS: Readonly<Record<string, ReadonlyArray<WeakeningPattern>>> = {
  ts: [
    // Silencing the type-checker. Scoped to comments because the directive lives there.
    { name: "ts-suppression", re: /@ts-(ignore|nocheck|expect-error)\b/, scope: "slash-comment" },
    // Casting away type errors.
    { name: "any-cast", re: /\bas\s+any\b|:\s*any\b/, scope: "code" },
    // Silencing the linter. Scoped to comments because the directive lives there.
    { name: "eslint-disable", re: /eslint-disable\b/, scope: "slash-comment" },
  ],
  py: [
    { name: "py-type-ignore", re: /#\s*type:\s*ignore\b/, scope: "hash-comment" },
    { name: "py-noqa", re: /#\s*noqa\b/, scope: "hash-comment" },
    { name: "py-skip", re: /@(pytest\.mark\.skip|unittest\.skip)\b/, scope: "code" },
  ],
  go: [
    { name: "go-skip", re: /\bt\.Skip\s*\(/, scope: "code" },
    { name: "go-nolint", re: /\/\/\s*nolint\b/, scope: "slash-comment" },
  ],
  rust: [
    { name: "rust-ignore", re: /#\[\s*ignore\b/, scope: "code" },
    { name: "rust-allow", re: /#\[\s*allow\s*\(/, scope: "code" },
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
const ALL_PATTERNS: ReadonlyArray<WeakeningPattern> = [
  ...COMMON_PATTERNS,
  ...Object.values(LANG_PATTERNS).flat(),
]

/** Lexical views of one added line. Quoted text is omitted from every view;
 * code excludes comments, while directive views retain only their comment text.
 * This prevents fixture/documentation strings from self-matching without hiding
 * real comment-based suppressions. It is intentionally conservative: an
 * unterminated quote returns the raw line as code and no comment views. */
function lexicalViews(line: string): { code: string; slashComment: string; hashComment: string } {
  let code = ""
  let slashComment = ""
  let hashComment = ""
  let quote: "'" | '"' | "`" | null = null
  let escaped = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!
    if (quote !== null) {
      if (escaped) {
        escaped = false
        continue
      }
      if (ch === "\\") {
        escaped = true
        continue
      }
      if (ch === quote) quote = null
      continue
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      quote = ch
      code += " "
      continue
    }
    if (ch === "/" && line[i + 1] === "/") {
      slashComment = line.slice(i)
      break
    }
    if (ch === "/" && line[i + 1] === "*") {
      slashComment = line.slice(i)
      break
    }
    // `#` starts a comment for Python, but Rust attributes begin `#[` and are
    // executable syntax that must remain in the code view.
    if (ch === "#" && line[i + 1] !== "[") {
      hashComment = line.slice(i)
      break
    }
    code += ch
  }
  return quote === null
    ? { code, slashComment, hashComment }
    : { code: line, slashComment: "", hashComment: "" }
}

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
  let patterns: ReadonlyArray<WeakeningPattern> = ALL_PATTERNS
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
    const views = lexicalViews(added)
    for (const p of patterns) {
      const searchable = p.scope === "code"
        ? views.code
        : p.scope === "slash-comment"
          ? views.slashComment
          : views.hashComment
      if (p.re.test(searchable)) {
        findings.push(file === undefined ? { pattern: p.name, line: added.trim() } : { pattern: p.name, line: added.trim(), file })
      }
    }
  }
  return { weakened: findings.length > 0, findings }
}
