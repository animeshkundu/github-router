#!/usr/bin/env node

/**
 * `github-router update` — bring the managed install up to date, on demand.
 *
 * The user-facing half of `lib/managed-install/update.ts`. Deliberately keeps
 * citty's surface tiny and does the reporting itself, because the interesting
 * outcomes are not exit-code-shaped: "another process is installing", "the
 * registry did not answer", "installed, but `~/.local/bin` is not on PATH" are
 * all successes-with-a-note, and burying them behind a non-zero exit would make
 * `update` unusable in a script or a shell profile.
 *
 * `--quiet` exists for the detached background child (`scheduleBackgroundSelfInstall`),
 * whose stdio is `ignore` anyway but whose ARGV is visible in `ps`, and for anyone
 * wiring this into a cron job.
 */

import { defineCommand } from "citty"
import consola from "consola"

import { PI_MIN_VERSION } from "./lib/pi-version-check"
import { readPointer } from "./lib/managed-install/pointer"
import {
  OPTIONAL_PACKAGES,
  type OptionalPackage,
  ensureOptionalPackage,
  isOptionalPackage,
  optionalInstallDisabled,
} from "./lib/managed-install/optional"
import { managedInstallDisabled } from "./lib/managed-install/npm-env"
import {
  checkForUpdate,
  currentManagedVersion,
  runManagedUpdate,
  type UpdateReport,
} from "./lib/managed-install/update"
import type { ManagedKind } from "./lib/managed-install/paths"

export interface RunUpdateOptions {
  self: boolean
  pi: boolean
  check: boolean
  version?: string
  force: boolean
  quiet: boolean
  /** Also install the heavy optional payloads (default on, `--no-optional`). */
  optional?: boolean
  /**
   * Install the optional payloads and nothing else.
   *
   * This is what the on-demand path spawns (`scheduleOptionalInstall`): a rerank
   * or a structural search that found no payload wants THAT payload, not a
   * self-update, and definitely not a managed Pi appearing on a developer's
   * source checkout as a side effect of a search.
   */
  optionalOnly?: boolean
  /**
   * Install only this optional payload (`--optional-pkg <name>`).
   *
   * What `scheduleOptionalInstall` passes: a structural-search miss wants the
   * grammar set, and must not start a 547 MB ONNX download as a side effect.
   */
  optionalPkg?: OptionalPackage
}

/**
 * Which kinds to act on.
 *
 * Bare `update` maintains both, which is the useful default for the user's stated
 * goal ("my install should just stay current"). `--self`/`--pi` narrow it, and an
 * explicit `--version` implies `--self` so `update --version 1.2.3` never
 * accidentally re-pins Pi.
 */
export function resolveKinds(opts: Pick<RunUpdateOptions, "self" | "pi" | "version">): Array<ManagedKind> {
  if (opts.self && opts.pi) return ["self", "pi"]
  if (opts.self) return ["self"]
  if (opts.pi) return ["pi"]
  if (opts.version) return ["self"]
  return ["self", "pi"]
}

function printCheck(kind: ManagedKind, report: UpdateReport["check"]): void {
  const label = kind === "pi" ? "Pi" : "github-router"
  const installed = report.installedVersion ?? "not installed"
  if (!report.targetVersion) {
    // `npm view` failed. Saying "0.3.379 → unknown" presents a network failure as
    // "maybe there is a newer one", which in a cron job is indistinguishable from
    // a real pending update. Say the thing that is actually true, and exit
    // non-zero (the caller counts a null target as a failure).
    consola.warn(`${label}: ${installed}; could not determine the latest version (npm view failed)`)
    return
  }
  if (report.upToDate) {
    consola.info(`${label}: ${installed} (up to date)`)
    return
  }
  consola.info(`${label}: ${installed} → ${report.targetVersion}`)
}

/** First non-empty line of a multi-line diagnostic. */
function firstLine(text: string | undefined): string | null {
  if (!text) return null
  const line = text.split(/\r?\n/).find((part) => part.trim().length > 0)
  return line ? line.trim() : null
}

function printOutcome(kind: ManagedKind, report: UpdateReport): void {
  const label = kind === "pi" ? "Pi" : "github-router"
  const outcome = report.outcome
  if (!outcome) return
  switch (outcome.kind) {
    case "installed":
    case "adopted":
      consola.success(
        `${label} ${outcome.version} ${outcome.kind === "adopted" ? "adopted" : "installed"} at ${outcome.entryPath ?? ""}`,
      )
      if (report.launcher) {
        consola.info(
          report.launcher.written
            ? `Launcher installed: ${report.launcher.path}`
            : `Launcher up to date: ${report.launcher.path}`,
        )
      }
      for (const shim of report.shims ?? []) {
        if (shim.outcome === "refused") {
          consola.warn(`Left ${shim.path} alone (not written by github-router).`)
        }
      }
      if (report.pathHint) {
        // Printed as info, not warn: nothing is broken, the command just is not
        // reachable by name yet. One copy-pasteable line, no rc editing.
        consola.info(report.pathHint)
      }
      if (report.gc && report.gc.removedVersions.length > 0) {
        consola.debug(`${label}: removed old versions ${report.gc.removedVersions.join(", ")}`)
      }
      return
    case "disabled":
      consola.info(`${label}: managed install is disabled (${outcome.detail ?? "GH_ROUTER_NO_MANAGED_INSTALL"}).`)
      return
    case "locked":
      consola.warn(`${label}: ${outcome.detail ?? "another install is in progress"}`)
      return
    case "no-npm":
      consola.warn(`${label}: ${outcome.detail ?? "npm not found on PATH"}`)
      return
    case "backoff":
      consola.warn(`${label}: ${firstLine(outcome.detail) ?? "backing off after a failed attempt"}`)
      return
    case "failed":
      // The detail embeds npm's stderr. Print its first line as the message and
      // the rest at debug, so a broken registry is one readable sentence on the
      // console instead of a wall of npm internals ending mid-filename — while
      // still being available under --verbose.
      consola.error(`${label}: ${firstLine(outcome.detail) ?? "install failed"}`)
      if (outcome.detail && outcome.detail.includes("\n")) consola.debug(outcome.detail)
      return
  }
}

export async function runUpdate(opts: RunUpdateOptions): Promise<number> {
  let kinds = opts.optionalOnly ? [] : resolveKinds(opts)
  let failures = 0

  if (kinds.length > 0 && managedInstallDisabled()) {
    // `--check` would otherwise print "not installed → 0.3.379" on a machine
    // where the managed layer is switched OFF, which reads as an update that is
    // about to happen and never will.
    if (!opts.quiet) {
      consola.info(
        "managed install is disabled (GH_ROUTER_NO_MANAGED_INSTALL), so there is nothing to install or check for github-router/Pi.",
      )
    }
    // NOT `return 0`: the optional payloads have their own, unrelated off switch
    // (`GH_ROUTER_NO_OPTIONAL_INSTALL`). Returning here would make a bare
    // `github-router update` on a machine with the managed layer disabled skip
    // reranking/grammar payloads that the user never opted out of — the two
    // switches are documented as independent, so they must behave that way.
    kinds = []
  }

  for (const kind of kinds) {
    if (opts.check) {
      const report = await checkForUpdate(kind, { version: opts.version, force: opts.force })
      if (!opts.quiet) printCheck(kind, report)
      // "Could not find out" is a FAILURE for anything that parses the exit code
      // (a cron job, a CI step, a wrapper script). Printing a warning and exiting
      // 0 makes a broken registry indistinguishable from "you are up to date".
      if (report.targetVersion === null) failures += 1
      continue
    }
    const report = await runManagedUpdate({
      kind,
      version: opts.version,
      force: opts.force,
      check: false,
    })
    if (!opts.quiet) printOutcome(kind, report)
    if (report.outcome?.kind === "failed") failures += 1
  }

  if (opts.check && opts.optionalOnly) {
    // Both halves of this combination are silently empty: `--optional-only` makes
    // `kinds` empty, and `--check` skips the optional block. Left alone the
    // command prints nothing and exits 0, which reads as "everything is fine".
    if (!opts.quiet) {
      consola.warn(
        "--check does not inspect the optional payloads (they are installed on demand), so --check --optional-only has nothing to report.",
      )
    }
    return failures === 0 ? 0 : 1
  }

  if (opts.optional !== false && !opts.check && !optionalInstallDisabled()) {
    // Optional payloads are the difference between a 66 MB and a 586 MB install,
    // so they are NOT installed with the package. `update` is where a user asks
    // for the whole thing, and where a failure is visible instead of silently
    // degrading search quality. A failure here is a WARNING, never a non-zero
    // exit: reranking and structural search both have documented fallbacks.
    const wanted: ReadonlyArray<OptionalPackage> =
      opts.optionalPkg === undefined ? OPTIONAL_PACKAGES : [opts.optionalPkg]
    const results = []
    for (const pkg of wanted) {
      const result = await ensureOptionalPackage(pkg, { force: opts.force })
      results.push({ pkg, ...result })
    }
    for (const result of results) {
      if (result.dir) {
        if (!opts.quiet) consola.success(`${result.pkg} ready at ${result.dir}`)
      } else if (!opts.quiet) {
        consola.warn(`${result.pkg} unavailable: ${result.detail ?? "unknown error"}`)
      }
    }
  }

  return failures === 0 ? 0 : 1
}

/**
 * A bare `update` may also be the FIRST thing a user runs after `npm i -g`, in
 * which case there is nothing managed yet and the honest answer is "here is where
 * it would go". `checkForUpdate` already reports that as "not installed → latest",
 * so nothing extra is needed; the pointer read below is only for the debug line.
 */
export const update = defineCommand({
  meta: {
    name: "update",
    description: `Install or refresh the managed github-router/Pi payload (Pi floor ${PI_MIN_VERSION})`,
  },
  args: {
    self: {
      type: "boolean",
      default: false,
      description: "Update github-router only",
    },
    pi: {
      type: "boolean",
      default: false,
      description: "Update the managed Pi only",
    },
    check: {
      type: "boolean",
      default: false,
      description: "Report what would change; install nothing",
    },
    version: {
      type: "string",
      description: "Install an exact version instead of npm's latest",
    },
    force: {
      type: "boolean",
      default: false,
      description: "Ignore the failure backoff and reinstall even if the version matches",
    },
    quiet: {
      type: "boolean",
      default: false,
      description: "Only report problems (used by the background self-install)",
    },
    "optional-only": {
      type: "boolean",
      default: false,
      description:
        "Install the heavy optional payloads and nothing else (internal: what a rerank or structural search spawns on demand)",
    },
    "optional-pkg": {
      type: "string",
      description: `Install only this optional payload (${OPTIONAL_PACKAGES.join(", ")}). Internal: used by --optional-only spawns so a grammar miss does not download the ONNX runtime.`,
    },
    optional: {
      type: "boolean",
      default: true,
      description:
        "Also install the heavy optional payloads (transformers/ONNX for reranking, tree-sitter grammars) into the shared optional dir. --no-optional skips them; reranking then falls back to BM25F and structural ranking to the regex heuristic.",
    },
  },
  async run({ args }) {
    // Validate BEFORE any work. An unknown name must not degrade to "install
    // everything": for this pair that means a 547 MB ONNX download triggered by
    // a typo, and it must not degrade to "install nothing" either, which would
    // look like success.
    const rawOptionalPkg = args["optional-pkg"]
    if (
      rawOptionalPkg !== undefined
      && !(typeof rawOptionalPkg === "string" && isOptionalPackage(rawOptionalPkg))
    ) {
      consola.error(
        `--optional-pkg must be one of: ${OPTIONAL_PACKAGES.join(", ")} (got ${JSON.stringify(rawOptionalPkg)}).`,
      )
      process.exitCode = 2
      return
    }

    const pointer = await readPointer("self", { verifyEntry: false })
    consola.debug(
      `managed: live self version ${pointer?.version ?? "none"} (live pointer ${await currentManagedVersion("self") ?? "none"})`,
    )
    const code = await runUpdate({
      self: args.self,
      pi: args.pi,
      check: args.check,
      version: typeof args.version === "string" ? args.version : undefined,
      force: args.force,
      quiet: args.quiet,
      optional: args.optional,
      optionalOnly: args["optional-only"],
      ...(typeof rawOptionalPkg === "string" && isOptionalPackage(rawOptionalPkg)
        ? { optionalPkg: rawOptionalPkg }
        : {}),
    })
    process.exitCode = code
  },
})
