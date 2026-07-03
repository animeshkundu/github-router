#!/usr/bin/env bun
/**
 * Entry point for the first-mate server-side scheduler daemon.
 *
 * This drives the LIVE first-mate ledger via advance(). ON BY DEFAULT
 * (GH_ROUTER_FM_DAEMON=0 disables). It is not auto-spawned by `bun run start`;
 * launching it is still a deliberate step, but the gate now defaults open.
 *
 * With Phase 1.3 wiring, the Claude `[fm-heartbeat]` auto-degrades to a passive
 * failover (it defers via the fencing lease while this daemon holds it), so
 * running both no longer double-drives — but disarming the heartbeat is still
 * cleaner. The fencing lease + OCC guard ledger commits either way.
 *
 *   bun run scripts/first-mate-daemon.ts            # on by default
 *   GH_ROUTER_FM_DAEMON=0 bun run scripts/first-mate-daemon.ts   # disabled
 */
import consola from "consola"

import { acquireDaemonSingleton, createControllerDaemon } from "~/lib/first-mate/scheduler"

if (process.env.GH_ROUTER_FM_DAEMON === "0") {
  consola.warn("first-mate daemon disabled (GH_ROUTER_FM_DAEMON=0).")
  process.exit(0)
}

// Process singleton: refuse to start a second daemon on the same first-mate dir
// (the fencing lease already prevents double-driving, but one process per dir is
// cleaner). A stale pidfile from a crashed daemon is taken over automatically;
// acquisition is atomic (O_EXCL) so two racing daemons can't both win.
const singleton = await acquireDaemonSingleton()
if (!singleton.acquired) {
  consola.warn(
    `first-mate daemon already running (pid ${singleton.existingPid}); refusing to start a second.`,
  )
  process.exit(0)
}

const daemon = createControllerDaemon({
  onStuck: (info) => consola.warn("first-mate: stuck units, escalate", info),
})

daemon.start()
consola.info("first-mate daemon started (fencing lease; ticking advance()).")

function shutdown(): void {
  void singleton.release().finally(() => {
    void daemon.stop().finally(() => process.exit(0))
  })
}
process.on("SIGINT", shutdown)
process.on("SIGTERM", shutdown)
