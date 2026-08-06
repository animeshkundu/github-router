/**
 * Provision ast-grep for CI, then FAIL if it is not resolvable.
 *
 * Why this exists: `tests/code-search.test.ts` gates six `mode:"ast"` tests on
 * `test.if(sgAvailable)`, and `resolveAstGrep()` looks in the toolbelt dir then
 * PATH. CI installed neither, so `sgAvailable` was `false` on every run and all
 * six tests SILENTLY SKIPPED while the suite reported green. "The full suite is
 * green" was not an accurate statement about the ast-grep surface.
 *
 * Two halves, and the second is the point:
 *   1. provision ast-grep through the repo's own SHA-pinned toolbelt manifest
 *      (`src/lib/toolbelt/manifest.ts`) rather than a second, drifting pin;
 *   2. HARD-FAIL when it still is not resolvable, so a future regression to
 *      silent skipping breaks the build instead of quietly shrinking coverage.
 *
 * Run before the test step in CI. Locally it is a no-op for anyone who already
 * has ast-grep on PATH.
 */
import process from "node:process"

import consola from "consola"

import { resolveAstGrep } from "~/lib/code-search"
import { provisionToolbelt } from "~/lib/toolbelt/provision"

const alreadyResolvable = resolveAstGrep()
if (alreadyResolvable !== null) {
  consola.info(`ast-grep already resolvable at ${alreadyResolvable}`)
  process.exit(0)
}

consola.info("ast-grep not found — provisioning from the pinned toolbelt manifest")
const exposed = await provisionToolbelt()
consola.info(`toolbelt exposed: ${exposed.join(", ") || "(nothing)"}`)

const resolved = resolveAstGrep()
if (resolved === null) {
  consola.error(
    "ast-grep is STILL not resolvable after provisioning.\n"
    + "The six `mode:\"ast\"` tests in tests/code-search.test.ts use `test.if(sgAvailable)`, "
    + "so without this binary they SKIP and the suite reports green while testing nothing.\n"
    + "Fix the provisioning (see src/lib/toolbelt/manifest.ts) rather than letting the "
    + "structural-search surface go unverified.",
  )
  process.exit(1)
}

consola.success(`ast-grep resolvable at ${resolved} — mode:"ast" tests will run`)
