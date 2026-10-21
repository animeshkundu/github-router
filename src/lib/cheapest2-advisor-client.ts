import { CHEAPEST2_PROFILE_ADVISOR_CLIENT_MODEL } from "./cheapest2-profile-contract"

const ADVISOR_FLAG = "--advisor"

function featureEnvEnabled(value: string | undefined): boolean {
  if (value === undefined) return true
  return !["", "0", "false", "no", "off"].includes(value.trim().toLowerCase())
}

export function cheapest2AdvisorClientEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (env.CLAUDE_CODE_DISABLE_ADVISOR_TOOL) return false
  return featureEnvEnabled(env.CLAUDE_CODE_ENABLE_EXPERIMENTAL_ADVISOR_TOOL)
}

export function withFixedCheapest2AdvisorArg(
  args: ReadonlyArray<string>,
  enabled = cheapest2AdvisorClientEnabled(),
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
  const fixed = [ADVISOR_FLAG, CHEAPEST2_PROFILE_ADVISOR_CLIENT_MODEL]
  if (separator < 0) return [...sanitized, ...fixed]
  return [
    ...sanitized.slice(0, separator),
    ...fixed,
    ...sanitized.slice(separator),
  ]
}
