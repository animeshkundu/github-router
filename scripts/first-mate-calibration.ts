#!/usr/bin/env bun
/**
 * Print the first-mate Tier1 calibration report + dead-letter queue.
 *
 *   bun run scripts/first-mate-calibration.ts
 */
import consola from "consola"

import { DeadLetterQueue, calibrationReport } from "~/lib/first-mate/scheduler/calibration"

consola.log(await calibrationReport())

const dead = (await new DeadLetterQueue().list()).filter((e) => e.dead)
if (dead.length > 0) {
  consola.warn(`dead-letter (quarantined) units: ${dead.length}`)
  for (const e of dead) consola.log(`  ${e.unitKey}: ${e.failures} failures — ${e.lastReason}`)
} else {
  consola.log("dead-letter queue: empty")
}
