import { parsePort } from "./parser"
import { retry, type RetryOptions } from "./retry"

export interface ServiceConfig {
  port: string
  retry?: RetryOptions
}

let activeConfig: ServiceConfig = { port: "8787" }

export function loadConfig(config: ServiceConfig): void {
  parsePort(config.port)
  activeConfig = config
}

export function configSnapshot(): ServiceConfig {
  return activeConfig
}

export async function connect(probe: () => Promise<boolean>): Promise<boolean> {
  return retry(async () => {
    if (!(await probe())) throw new Error("unavailable")
    return true
  }, activeConfig.retry)
}
