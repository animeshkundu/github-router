/**
 * `github-router index` — build the semantic code-search index in the
 * foreground, without starting the proxy (`start`/`claude`/`codex`).
 *
 * Phase 4a: drives the CURRENT colbert backend (foreground `init` with
 * progress). Phase 5: `auto` (default) prefers the persistent service
 * backend — foreground all-core encode with CUDA when a GPU is visible —
 * with TRUE DELTA indexing (only changed files are re-embedded); falls
 * back to colbert when the service is not actionable. `--backend` forces
 * `service` or `colbert`. The explicit invocation IS the opt-in — `--search` is not
 * required — but `GH_ROUTER_DISABLE_SEMANTIC_SEARCH=1` still hard-disables
 * (building an index that can never be served is pointless).
 *
 * Exit codes: 0 = fresh or successfully built; 1 = provision/build
 * failure; 2 = usage error (bad workspace, hard-disabled).
 */

import { defineCommand } from "citty";
import consola from "consola";
import * as os from "node:os";
import process from "node:process";

import { validateWorkspace } from "~/lib/code-search";
import {
  colbertProjectDir,
  completedIndexOnDisk,
  freshnessVerdict,
  indexDirSignature,
  readColbertMeta,
  validateIndexIntegrity,
} from "~/lib/colbert/index-store";
import { registerColbertExitHandlers } from "~/lib/colbert/lifecycle";
import { provisionColbert, provisionNextPlaidServer } from "~/lib/colbert/provision";
import { kickBackgroundInit, waitForInit } from "~/lib/colbert/runner";
import {
  ensureServerForeground,
  populateWorkspace,
  selectServerVariant,
  semanticBackend,
  serviceBackendEnabled,
  serviceFreshness,
} from "~/lib/colbert/service-backend";
import { PATHS } from "~/lib/paths";
import { parseBoolEnv } from "~/lib/exec";

const POLL_MS = 10_000;

function cpuCount(): number {
  try {
    const n = os.cpus().length;
    return Number.isSafeInteger(n) && n > 0 ? n : 4;
  } catch {
    return 4;
  }
}

interface IndexStatus {
  workspace: string;
  verdict: string;
  indexOnDisk: boolean;
  shards?: number;
  embeddings?: number;
  integrity?: string;
  head?: string;
  dirty?: boolean;
  lastIndexedAt?: string;
}

async function collectStatus(workspace: string): Promise<IndexStatus> {
  const { verdict, head, dirty } = await freshnessVerdict(workspace);
  const onDisk = await completedIndexOnDisk(workspace);
  const status: IndexStatus = {
    workspace,
    verdict,
    indexOnDisk: onDisk,
  };
  const projectDir = await colbertProjectDir(workspace);
  if (projectDir) {
    const integrity = validateIndexIntegrity(`${projectDir}/index`);
    if (integrity.verdict === "coherent") {
      status.shards = integrity.shardCount;
      status.embeddings = integrity.embeddingCount;
    } else {
      status.integrity = integrity.verdict;
    }
  }
  const meta = await readColbertMeta(workspace);
  if (meta?.lastIndexedAt) status.lastIndexedAt = meta.lastIndexedAt;
  if (head !== undefined) status.head = head.slice(0, 12);
  if (dirty !== undefined) status.dirty = dirty;
  return status;
}

function printStatus(s: IndexStatus): void {
  consola.info(`workspace: ${s.workspace}`);
  consola.info(`verdict:   ${s.verdict}`);
  consola.info(`index:     ${s.indexOnDisk ? "present" : "absent"}`);
  if (s.shards !== undefined) {
    consola.info(`shards:    ${s.shards} (${s.embeddings ?? 0} embeddings)`);
  }
  if (s.integrity && s.integrity !== "not-built") {
    consola.info(`integrity: ${s.integrity}`);
  }
  if (s.head !== undefined)
    consola.info(`head:      ${s.head}${s.dirty ? " (dirty)" : ""}`);
  if (s.lastIndexedAt) consola.info(`indexed:   ${s.lastIndexedAt}`);
}

interface IndexServiceStatus {
  workspace: string;
  backend: string;
  verdict: string;
  indexedAt?: string;
  docCount?: number;
  head?: string;
  dirty?: boolean;
}

async function collectServiceStatus(workspace: string): Promise<IndexServiceStatus> {
  const { verdict, meta, head, dirty } = await serviceFreshness(workspace);
  const status: IndexServiceStatus = {
    workspace,
    backend: "service",
    verdict,
  };
  if (meta?.indexedAt) status.indexedAt = meta.indexedAt;
  if (meta?.docCount !== undefined) status.docCount = meta.docCount;
  if (head !== undefined) status.head = head.slice(0, 12);
  if (dirty !== undefined) status.dirty = dirty;
  return status;
}

function printServiceStatus(s: IndexServiceStatus): void {
  consola.info(`workspace: ${s.workspace}`);
  consola.info(`backend:   ${s.backend}`);
  consola.info(`verdict:   ${s.verdict}`);
  if (s.docCount !== undefined) consola.info(`documents: ${s.docCount}`);
  if (s.head !== undefined)
    consola.info(`head:      ${s.head}${s.dirty ? " (dirty)" : ""}`);
  if (s.indexedAt) consola.info(`indexed:   ${s.indexedAt}`);
}

type IndexBackend = "service" | "colgrep";

function resolveIndexBackend(requested: unknown): { backend: IndexBackend; explicit: boolean } | { error: string } {
  const raw = typeof requested === "string" && requested.length > 0 ? requested.toLowerCase() : "auto";
  if (raw !== "auto" && raw !== "service" && raw !== "colgrep") {
    return { error: `index: --backend must be auto, service, or colgrep (got ${String(requested)})` };
  }
  // Explicit opt-in (flag or env) always means service.
  if (raw === "service" || (raw === "auto" && semanticBackend() === "service")) {
    return { backend: "service", explicit: true };
  }
  if (raw === "colgrep") return { backend: "colgrep", explicit: false };
  // Auto: service when actionable (binary on disk or promoted download +
  // model present), else the colgrep fallback.
  return serviceBackendEnabled()
    ? { backend: "service", explicit: false }
    : { backend: "colgrep", explicit: false };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref?.();
  });
}

export const indexCmd = defineCommand({
  meta: {
    name: "index",
    description:
      "Build the semantic code-search index for a workspace in the foreground (no proxy needed)",
  },
  args: {
    workspace: {
      alias: "w",
      type: "string",
      description: "Absolute path to the repo to index (default: cwd)",
    },
    status: {
      type: "boolean",
      default: false,
      description: "Print index status and exit (no build)",
    },
    timeout: {
      type: "string",
      description: "Max minutes to wait for the build (0 = none, default 0)",
    },
    backend: {
      type: "string",
      description: "Index backend: auto (service with CUDA/CPU autodetect, colgrep fallback), service, or colgrep (default auto)",
    },
    full: {
      type: "boolean",
      default: false,
      description: "Force a full rebuild, ignoring content hashes (service backend)",
    },
    dryRun: {
      type: "boolean",
      default: false,
      description: "Classify changed files without building (service backend)",
    },
  },
  async run({ args }) {
    const rawWorkspace =
      typeof args.workspace === "string" && args.workspace.length > 0
        ? args.workspace
        : process.cwd();
    const ws = validateWorkspace(rawWorkspace);
    if (!ws.ok || !ws.canonical) {
      consola.error(`index: ${ws.error ?? "workspace validation failed"}`);
      process.exitCode = 2;
      return;
    }
    const workspace = ws.canonical;

    if (parseBoolEnv(process.env.GH_ROUTER_DISABLE_SEMANTIC_SEARCH) === true) {
      consola.error(
        "index: semantic search is hard-disabled (GH_ROUTER_DISABLE_SEMANTIC_SEARCH=1); nothing to build",
      );
      process.exitCode = 2;
      return;
    }

    const backendSelection = resolveIndexBackend(args.backend);
    if ("error" in backendSelection) {
      consola.error(backendSelection.error);
      process.exitCode = 2;
      return;
    }
    const { backend, explicit: backendExplicit } = backendSelection;

    if (args.status === true) {
      if (backend === "service") {
        printServiceStatus(await collectServiceStatus(workspace));
      } else {
        printStatus(await collectStatus(workspace));
      }
      return;
    }

    const timeoutMin = args.timeout === undefined ? 0 : Number(args.timeout);
    if (
      args.timeout !== undefined &&
      !(Number.isFinite(timeoutMin) && timeoutMin >= 0)
    ) {
      consola.error(
        "index: --timeout must be a non-negative number of minutes",
      );
      process.exitCode = 2;
      return;
    }
    const deadlineMs =
      timeoutMin > 0
        ? Date.now() + timeoutMin * 60_000
        : Number.POSITIVE_INFINITY;

    // Foreground dedicated build: use all cores unless the operator capped
    // explicitly. Background auto-indexing stays at 25% (the colbert
    // default); an explicit `index` invocation expects speed.
    if (process.env.GH_ROUTER_COLBERT_PARALLEL === undefined) {
      process.env.GH_ROUTER_COLBERT_PARALLEL = String(cpuCount());
      consola.debug(
        `index: parallelism defaulted to ${cpuCount()} sessions (override with GH_ROUTER_COLBERT_PARALLEL)`,
      );
    }

    registerColbertExitHandlers();

    consola.info(
      `Provisioning semantic-search artifacts into ${PATHS.COLBERT_INDICES_DIR}…`,
    );
    try {
      const result = await provisionColbert();
      if (result.status !== "ready") {
        consola.error(
          `index: provision ${result.status}${result.reason ? ` (${result.reason})` : ""}`,
        );
        process.exitCode = 1;
        return;
      }
    } catch (err) {
      consola.error("index: provision threw:", err);
      process.exitCode = 1;
      return;
    }

    // Auto resolves the backend AFTER provisioning (the model dir must
    // exist before serviceBackendEnabled can report actionable). An
    // explicit service request that cannot provision the server binary
    // fails closed; auto silently falls back to colgrep.
    if (backend === "service") {
      let variant: Awaited<ReturnType<typeof selectServerVariant>> | undefined;
      try {
        variant = await selectServerVariant();
        const server = await provisionNextPlaidServer(variant);
        if (server.path) {
          consola.info(`index: service backend ready (${variant}: ${server.path})`);
        } else if (backendExplicit) {
          consola.error(
            `index: service binary unavailable (${server.reason ?? "unknown"}) — retry with --backend=colgrep`,
          );
          process.exitCode = 1;
          return;
        } else {
          consola.warn(
            `index: service binary unavailable (${server.reason ?? "unknown"}) — falling back to colgrep`,
          );
    if (args.full === true || args.dryRun === true) {
      consola.warn(
        "index: --full/--dry-run apply to the service backend only; ignored for colgrep",
      );
    }

    await runColbertIndex(workspace, deadlineMs, timeoutMin);
          return;
        }
      } catch (err) {
        if (backendExplicit) {
          consola.error("index: service provision threw:", err);
          process.exitCode = 1;
          return;
        }
        consola.warn("index: service provision skipped:", err);
        await runColbertIndex(workspace, deadlineMs, timeoutMin);
        return;
      }
      // Foreground service build (all-core encode; CUDA when detected).
      if (variant === undefined) {
        consola.error("index: no service variant resolved");
        process.exitCode = 1;
        return;
      }
      await runServiceIndex(workspace, {
        full: args.full === true,
        dryRun: args.dryRun === true,
        deadlineMs,
        timeoutMin,
        variant,
      });
      return;
    }

    await runColbertIndex(workspace, deadlineMs, timeoutMin);
  },
});

async function runServiceIndex(
  workspace: string,
  opts: {
    full: boolean;
    dryRun: boolean;
    deadlineMs: number;
    timeoutMin: number;
    variant: string;
  },
): Promise<void> {
  const startMs = Date.now();
  const signal =
    Number.isFinite(opts.deadlineMs) && opts.deadlineMs !== Number.POSITIVE_INFINITY
      ? AbortSignal.timeout(Math.max(1, opts.deadlineMs - Date.now()))
      : undefined;

  if (opts.dryRun) {
    const plan = await populateWorkspace(workspace, { dryRun: true }).catch((err) => {
      consola.error("index: dry-run failed:", err);
      process.exitCode = 1;
      return null;
    });
    if (!plan) return;
    consola.info(
      `dry-run: ${plan.scanned} files scanned → ${plan.updatedFiles} to index, ${plan.removedFiles} to remove, ${plan.unchanged} unchanged`,
    );
    return;
  }

  const first = await serviceFreshness(workspace);
  if (first.verdict === "fresh") {
    consola.success("index is already fresh — nothing to build");
    printServiceStatus(await collectServiceStatus(workspace));
    return;
  }

  consola.info(
    `Building service index for ${workspace} (freshness: ${first.verdict}, variant: ${opts.variant})…`,
  );
  const server = await ensureServerForeground();
  if (!server) {
    consola.error(
      "index: service server failed to start — retry with --backend=colgrep",
    );
    process.exitCode = 1;
    return;
  }
  let lastLogMs = 0;
  try {
    const result = await populateWorkspace(workspace, {
      full: opts.full,
      foreground: true,
      ...(signal ? { signal } : {}),
      onProgress: (p) => {
        const now = Date.now();
        if (p.phase !== "done" && now - lastLogMs < POLL_MS) return;
        lastLogMs = now;
        if (p.phase === "done") return;
        consola.info(
          `… ${p.phase}: ${p.scanned}/${p.total} files` +
            (p.phase === "encode" || p.phase === "extract"
              ? ` (${p.updatedFiles} changed, ${p.units} units)`
              : ""),
        );
      },
    });
    const elapsedS = Math.round((Date.now() - startMs) / 1000);
    if (result.status === "unchanged") {
      consola.success(`index ready in ${elapsedS}s (no changes)`);
    } else {
      consola.success(
        `index ready in ${elapsedS}s (delta: ${result.unchanged} unchanged, ${result.updatedFiles} updated, ${result.removedFiles} removed, ${result.units} units)`,
      );
    }
    printServiceStatus(await collectServiceStatus(workspace));
  } catch (err) {
    if (signal?.aborted || Date.now() > opts.deadlineMs) {
      consola.error(
        `index: timed out after ${opts.timeoutMin}min — retry or raise --timeout`,
      );
    } else {
      consola.error("index: service build failed:", err);
    }
    process.exitCode = 1;
  }
}

async function runColbertIndex(
  workspace: string,
  deadlineMs: number,
  timeoutMin: number,
): Promise<void> {
  const first = await freshnessVerdict(workspace);
  if (first.verdict === "fresh") {
    consola.success("index is already fresh — nothing to build");
    printStatus(await collectStatus(workspace));
    return;
  }
  if (first.verdict === "failed") {
    consola.warn(
      "index: last build failed; starting one bounded rebuild attempt",
    );
  }

  consola.info(
    `Building semantic index for ${workspace} (freshness: ${first.verdict})…`,
  );
  kickBackgroundInit(workspace);
  const startMs = Date.now();

  for (;;) {
    if (Date.now() > deadlineMs) {
      consola.error(
        `index: timed out after ${timeoutMin}min — the background build continues; retry or raise --timeout`,
      );
      process.exitCode = 1;
      return;
    }
    // Wait for this process's tracked build; resolves immediately when
    // another proxy owns it, in which case the sleep below paces polling.
    await waitForInit(workspace).catch(() => {});
    const v = await freshnessVerdict(workspace);
    const elapsedS = Math.round((Date.now() - startMs) / 1000);
    if (v.verdict === "fresh") {
      consola.success(`index ready in ${elapsedS}s`);
      printStatus(await collectStatus(workspace));
      return;
    }
    if (
      v.verdict === "failed" ||
      v.verdict === "crashed" ||
      v.verdict === "corrupt"
    ) {
      consola.error(
        `index: build ended ${v.verdict} — lexical code search still works; see the proxy error log for the failure class`,
      );
      process.exitCode = 1;
      return;
    }
    // building | stale | absent: report progress, keep waiting. colgrep
    // is silent on pipes during encode, so disk growth is the signal.
    const sig = indexDirSignature(workspace);
    const progress =
      sig.kind === "observed" ? ` [${sig.signature}]` : " [starting…]";
    consola.info(
      `… ${elapsedS}s elapsed (freshness: ${v.verdict})${progress}`,
    );
    await sleep(POLL_MS);
    // Re-kick if nothing owns the build (crash between kick and track).
    kickBackgroundInit(workspace);
  }
}
