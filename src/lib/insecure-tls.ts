/**
 * Runtime-aware "skip TLS verification" for a self-signed direct-HTTPS instance.
 * The mechanism differs by runtime and getting it wrong is silent: the BUILT
 * proxy runs under Node (bin shebang `#!/usr/bin/env node`), whose fetch (undici)
 * IGNORES a per-request `tls` option — only a `dispatcher` relaxes verification.
 * `bun run dev` and the test suite run under Bun, whose fetch honors `tls`. So we
 * detect the runtime and attach the field it actually understands.
 *
 * Shared by the fleet control-plane client and the artifact-review client — both
 * talk to a self-signed ai-or-die instance on loopback. Per-request scope (not a
 * global TLS posture change) keeps Copilot upstream verification untouched.
 */
import { Agent } from "undici"

const IS_BUN = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined"

// One lazily-created insecure dispatcher (Node path), shared across instances. It
// is a SEPARATE connection pool from the global/verified dispatcher, so an
// unverified socket can never be reused by a verified request.
let sharedInsecureDispatcher: Agent | undefined
function insecureDispatcher(): Agent {
  return (sharedInsecureDispatcher ??= new Agent({ connect: { rejectUnauthorized: false } }))
}

/**
 * Attach the runtime-correct TLS-verification-off mechanism to a fetch init for a
 * single self-signed direct-HTTPS instance: Bun → `tls`, Node → an undici
 * `dispatcher`. Exported so BOTH runtime branches are unit-testable under one
 * interpreter (the untested Node branch is exactly what shipped broken).
 */
export function applyInsecureTls(init: Record<string, unknown>, isBun: boolean = IS_BUN): void {
  if (isBun) {
    init.tls = { rejectUnauthorized: false }
  } else {
    init.dispatcher = insecureDispatcher()
  }
}

export { IS_BUN }
