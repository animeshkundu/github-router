/**
 * Normalize Claude Code's local 1M-context decoration at model boundaries.
 *
 * `[1m]` is a client-side accounting marker, not part of a Copilot catalog id.
 * Claude Code can append its own marker to a picker value that is already
 * decorated by the router, producing a reachable doubled suffix. Keep the
 * helper dependency-free so launch/profile code and request preprocessing use
 * exactly the same trailing-suffix rule without an import cycle.
 */
export interface TrailingOneMSuffix {
  base: string
  hadSuffix: boolean
}

/** Strip every trailing `[1m]` marker, case-insensitively. */
export function stripTrailingOneMSuffix(id: string): TrailingOneMSuffix {
  const match = id.match(/(?:\[1m\])+$/i)
  if (!match || match.index === undefined) {
    return { base: id, hadSuffix: false }
  }
  return { base: id.slice(0, match.index), hadSuffix: true }
}

/** Reapply at most one canonical `[1m]` marker when the input had one. */
export function normalizeTrailingOneMSuffix(id: string): string {
  const { base, hadSuffix } = stripTrailingOneMSuffix(id)
  return hadSuffix ? `${base}[1m]` : base
}

/** Append one marker without ever creating a doubled suffix. */
export function withTrailingOneMSuffix(id: string): string {
  const { base } = stripTrailingOneMSuffix(id)
  return `${base}[1m]`
}
