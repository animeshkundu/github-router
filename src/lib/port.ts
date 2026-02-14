export const DEFAULT_PORT = 8787

const PORT_RANGE_MIN = 11000
const PORT_RANGE_MAX = 65535
const MAX_RETRIES = 10

/**
 * Generate a random port in the high range [11000, 65535].
 * Retries up to MAX_RETRIES times if the port is unavailable.
 */
export function generateRandomPort(): number {
  return (
    Math.floor(Math.random() * (PORT_RANGE_MAX - PORT_RANGE_MIN + 1))
    + PORT_RANGE_MIN
  )
}

export { MAX_RETRIES, PORT_RANGE_MAX, PORT_RANGE_MIN }
