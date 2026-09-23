import { CHEAPEST_PROFILE_ADVISOR_CLIENT_MODEL } from "./cheapest-profile-contract"

const ADVISOR_FLAG = "--advisor"

function featureEnvEnabled(value: string | undefined): boolean {
  if (value === undefined) return true
  return !["", "0", "false", "no", "off"].includes(value.trim().toLowerCase())
}

/** Match Claude Code's hard-disable and experimental-enable opt-out semantics. */
export function cheapestAdvisorClientEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (env.CLAUDE_CODE_DISABLE_ADVISOR_TOOL) return false
  return featureEnvEnabled(env.CLAUDE_CODE_ENABLE_EXPERIMENTAL_ADVISOR_TOOL)
}

/**
 * Remove every caller-supplied Advisor option and insert the fixed cheapest
 * value (the BARE `gpt-6-sol` — 200K default window — see
 * `CHEAPEST_PROFILE_ADVISOR_CLIENT_MODEL`). Same parser semantics as the
 * cheap variant: keeps scanning after `--`, and the fixed option is inserted
 * before the first separator so Claude Code parses it as an option.
 */
export function withFixedCheapestAdvisorArg(
  args: ReadonlyArray<string>,
  enabled = cheapestAdvisorClientEnabled(),
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
  const fixed = [ADVISOR_FLAG, CHEAPEST_PROFILE_ADVISOR_CLIENT_MODEL]
  if (separator < 0) return [...sanitized, ...fixed]
  return [
    ...sanitized.slice(0, separator),
    ...fixed,
    ...sanitized.slice(separator),
  ]
}
