export const DEFAULT_PORT = 8787
export const DEFAULT_CODEX_MODEL = "gpt5.3-codex"

const PORT_RANGE_MIN = 11000
const PORT_RANGE_MAX = 65535

/** Generate a random port number in the range [11000, 65535]. */
export function generateRandomPort(): number {
  return (
    Math.floor(Math.random() * (PORT_RANGE_MAX - PORT_RANGE_MIN + 1))
    + PORT_RANGE_MIN
  )
}
