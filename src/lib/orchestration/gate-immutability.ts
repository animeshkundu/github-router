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

/** Each pattern flags a distinct way to make a gate pass without fixing code. */
const WEAKENING_PATTERNS: ReadonlyArray<{ name: string; re: RegExp }> = [
  // Disabling tests: jest/bun/mocha skip + exclusive-focus (`.only` narrows the
  // suite so other failures stop running — also a weakening).
  { name: "skipped-test", re: /(\.\s*skip\s*\(|\bxit\s*\(|\bxdescribe\s*\(|\.\s*only\s*\()/ },
  // Silencing the type-checker.
  { name: "ts-suppression", re: /@ts-(ignore|nocheck|expect-error)\b/ },
  // Casting away type errors.
  { name: "any-cast", re: /\bas\s+any\b|:\s*any\b/ },
  // Silencing the linter.
  { name: "eslint-disable", re: /eslint-disable\b/ },
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
  for (const raw of diff.split("\n")) {
    const headerFile = fileFromHeader(raw)
    if (headerFile !== undefined) {
      file = headerFile
      continue
    }
    // Only ADDED content lines (skip the `+++` file header and context/removed).
    if (!raw.startsWith("+") || raw.startsWith("+++")) continue
    const added = raw.slice(1)
    for (const p of WEAKENING_PATTERNS) {
      if (p.re.test(added)) {
        findings.push(file === undefined ? { pattern: p.name, line: added.trim() } : { pattern: p.name, line: added.trim(), file })
      }
    }
  }
  return { weakened: findings.length > 0, findings }
}
