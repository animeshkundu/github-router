#!/usr/bin/env bun
/**
 * GATED entry point for the first-mate server-side scheduler daemon (Phase 1).
 *
 * This drives the LIVE first-mate ledger via advance(). It is intentionally not
 * wired into `bun run start` and refuses to run without an explicit opt-in.
 *
 * BEFORE starting it you MUST disarm the Claude-side `[fm-heartbeat]` cron,
 * otherwise the daemon and the heartbeat both drive advance() → split-brain.
 * The fencing lease guards ledger commits, but running two drivers is still
 * wasteful and confusing. Cutover is a deliberate operator step.
 *
 *   GH_ROUTER_FM_DAEMON=1 bun run scripts/first-mate-daemon.ts
 */
import consola from "consola"

import { createControllerDaemon } from "~/lib/first-mate/scheduler"

if (process.env.GH_ROUTER_FM_DAEMON !== "1") {
  consola.warn(
    "first-mate daemon is GATED. Set GH_ROUTER_FM_DAEMON=1 to start it, and disarm the Claude [fm-heartbeat] cron first to avoid split-brain.",
  )
  process.exit(0)
}

const daemon = createControllerDaemon({
  onStuck: (info) => consola.warn("first-mate: stuck units, escalate", info),
})

daemon.start()
consola.info("first-mate daemon started (fencing lease; ticking advance()).")

function shutdown(): void {
  void daemon.stop().finally(() => process.exit(0))
}
process.on("SIGINT", shutdown)
process.on("SIGTERM", shutdown)
