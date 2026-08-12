export function parsePort(raw: string): number {
  const port = Number.parseInt(raw, 10)
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`invalid port: ${raw}`)
  }
  return port
}
