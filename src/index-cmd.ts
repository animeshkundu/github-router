/**
 * `github-router index` — build the semantic code-search index in the
 * foreground, without starting the proxy (`start`/`claude`/`codex`).
 *
 * Phase 4a: drives the CURRENT colbert backend (foreground `init` with
 * progress). The explicit invocation IS the opt-in — `--search` is not
 * required — but `GH_ROUTER_DISABLE_SEMANTIC_SEARCH=1` still hard-disables
 * (building an index that can never be served is pointless). With
 * `GH_ROUTER_SEMANTIC_BACKEND=service`, the command additionally
 * pre-pulls the server binary for the auto-detected variant (GPU→cuda,
 * else cpu); the CLI surface (workspace/status/timeout/exit codes) stays
 * stable across backends.
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
  selectServerVariant,
  semanticBackend,
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

    if (args.status === true) {
      printStatus(await collectStatus(workspace));
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

    // Service backend selected: pre-pull the server binary for the
    // auto-detected variant now, so the first query doesn't pay the
    // download + cold start. Best-effort — a miss just defers to the
    // lazy provision on first query (or the colgrep/lexical fallback).
    if (semanticBackend() === "service") {
      try {
        const variant = await selectServerVariant();
        const server = await provisionNextPlaidServer(variant);
        if (server.path) {
          consola.info(`index: service backend ready (${variant}: ${server.path})`);
        } else {
          consola.warn(
            `index: service binary unavailable (${server.reason ?? "unknown"}) — first query provisions on demand`,
          );
        }
      } catch (err) {
        consola.warn("index: service provision skipped:", err);
      }
    }

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
  },
});
