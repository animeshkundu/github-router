#!/usr/bin/env bun
/**
 * Catalog capability drift alert.
 *
 * The PRIMARY guard against the class of bug this whole change exists to fix:
 * Copilot ships a capability, the catalog advertises it, and nothing in the
 * proxy ever reads it.
 *
 * WHY THIS AND NOT JUST THE REGISTER
 *
 * `src/lib/catalog-capability-register.ts` + its test catch a developer adding
 * a field to `ModelSupports` / `ModelLimits` without classifying it. That only
 * covers an event WE cause, decided by the same person filling in the register.
 * It cannot see a capability GitHub ships that we never typed at all — and
 * since `getModels()` parses the response with a bare `as ModelsResponse` cast
 * (no runtime validation), an unmodelled key arrives, sits on the object, and
 * is invisible to every type-driven check we could write.
 *
 * So this compares the live catalog's capability KEY SET against a checked-in
 * fixture. Keys, not values: values (limits, model lists, prices) churn
 * constantly and would make the check noise; the key set changes only when a
 * genuinely new capability appears.
 *
 * WHY IT IS NOT A MERGE GATE
 *
 * It needs the network and a valid Copilot token. A network-dependent blocking
 * check fails for reasons unrelated to the diff under review, and a check that
 * fails for unrelated reasons gets disabled. Run it on a schedule, let it open
 * an alert, and keep the merge path deterministic.
 *
 *   bun run scripts/check-catalog-drift.ts
 *
 * Exit codes: 0 no drift, 1 drift detected, 2 could not reach the catalog.
 */

import { readFileSync } from "node:fs"
import * as path from "node:path"

import { ensurePaths } from "~/lib/paths"
import { getModels } from "~/services/copilot/get-models"
import { setupCopilotToken, setupGitHubToken } from "~/lib/token"

const FIXTURE = path.join(import.meta.dirname, "..", "tests", "fixtures", "catalog-capability-keys.json")

/** The sorted union of dotted capability keys across every model. */
export function capabilityKeys(models: Array<Record<string, unknown>>): Array<string> {
  const keys = new Set<string>()
  for (const model of models) {
    const caps = (model.capabilities ?? {}) as Record<string, unknown>
    for (const key of Object.keys((caps.supports ?? {}) as object)) {
      keys.add(`supports.${key}`)
    }
    const limits = (caps.limits ?? {}) as Record<string, unknown>
    for (const key of Object.keys(limits)) {
      if (key === "vision") {
        for (const sub of Object.keys((limits.vision ?? {}) as object)) {
          keys.add(`limits.vision.${sub}`)
        }
      } else {
        keys.add(`limits.${key}`)
      }
    }
  }
  return [...keys].sort()
}

async function main(): Promise<number> {
  const expected = (JSON.parse(readFileSync(FIXTURE, "utf8")) as { keys: Array<string> }).keys

  try {
    // Same bootstrap order the `models` subcommand uses: paths, then the stored
    // GitHub PAT, then the exchanged Copilot token.
    await ensurePaths()
    await setupGitHubToken()
    await setupCopilotToken()
  } catch (err) {
    console.error(`catalog-drift: could not obtain a Copilot token — ${String(err)}`)
    return 2
  }

  let models: Array<Record<string, unknown>>
  try {
    const response = await getModels()
    models = response.data as unknown as Array<Record<string, unknown>>
  } catch (err) {
    console.error(`catalog-drift: could not fetch the catalog — ${String(err)}`)
    return 2
  }

  const actual = capabilityKeys(models)
  const added = actual.filter((k) => !expected.includes(k))
  const removed = expected.filter((k) => !actual.includes(k))

  if (added.length === 0 && removed.length === 0) {
    console.log(`catalog-drift: no drift (${actual.length} keys across ${models.length} models)`)
    return 0
  }

  if (added.length > 0) {
    console.error("catalog-drift: NEW capability keys Copilot now advertises:")
    for (const key of added) console.error(`  + ${key}`)
    console.error(
      "\nEach needs a decision: wire it up, or classify it in "
        + "src/lib/catalog-capability-register.ts (which will require raising "
        + "UNCLASSIFIED_CEILING — deliberately visible in review). Then refresh "
        + "tests/fixtures/catalog-capability-keys.json.",
    )
  }
  if (removed.length > 0) {
    console.error("\ncatalog-drift: capability keys that DISAPPEARED upstream:")
    for (const key of removed) console.error(`  - ${key}`)
    console.error(
      "\nAnything enforcing these is now dead or, worse, silently permissive. "
        + "Check the register before refreshing the fixture.",
    )
  }
  return 1
}

if (import.meta.main) {
  process.exit(await main())
}
