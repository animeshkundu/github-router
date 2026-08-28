import { FAST_PROFILE_ADVISOR_CLIENT_MODEL } from "./fast-profile-contract"

const ADVISOR_FLAG = "--advisor"

function featureEnvEnabled(value: string | undefined): boolean {
  if (value === undefined) return true
  return !["", "0", "false", "no", "off"].includes(value.trim().toLowerCase())
}

/** Match Claude Code's hard-disable and experimental-enable opt-out semantics. */
export function fastAdvisorClientEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (env.CLAUDE_CODE_DISABLE_ADVISOR_TOOL) return false
  return featureEnvEnabled(env.CLAUDE_CODE_ENABLE_EXPERIMENTAL_ADVISOR_TOOL)
}

/**
 * Remove every caller-supplied Advisor option and insert the fixed fast value.
 *
 * This parser intentionally keeps scanning after `--`: that separator marks
 * github-router-to-Claude passthrough, not an exemption from the fixed profile.
 * The fixed option is inserted before the first separator so Claude Code parses
 * it as an option rather than positional input. A separate `--advisor` consumes
 * its next token only when it is a value rather than another option; malformed
 * missing-value forms are simply removed.
 */
export function withFixedFastAdvisorArg(
  args: ReadonlyArray<string>,
  enabled = fastAdvisorClientEnabled(),
): string[] {
  const sanitized: string[] = []
  for (let index = 0; index < args.length; index++) {
    const token = args[index]!
    if (token === ADVISOR_FLAG) {
      const next = args[index + 1]
      if (next !== undefined && next !== "--" && !next.startsWith("-")) index++
      continue
    }
    if (token.startsWith(`${ADVISOR_FLAG}=`)) continue
    sanitized.push(token)
  }
  if (!enabled) return sanitized
  const separator = sanitized.indexOf("--")
  const fixed = [ADVISOR_FLAG, FAST_PROFILE_ADVISOR_CLIENT_MODEL]
  if (separator < 0) return [...sanitized, ...fixed]
  return [
    ...sanitized.slice(0, separator),
    ...fixed,
    ...sanitized.slice(separator),
  ]
}
