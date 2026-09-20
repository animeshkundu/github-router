/**
 * octocode workspace manager — one MCP subprocess per workspace.
 *
 * Design (per user decisions):
 *   - Max 16 concurrent `octocode mcp` processes (LRU eviction).
 *   - Health check every 30s (MCP `ping`; dead → evict).
 *   - Lazy spawn on first request for a workspace.
 *   - LSP: detect per workspace, fire-and-forget auto-install, spawn
 *     immediately with whatever is already present.
 *   - Config: ensure global octocode config once (see config.ts).
 *   - Graceful shutdown: SIGTERM → wait → SIGKILL; wired via
 *     `registerOctocodeExitHandlers()` (idempotent).
 *
 * MCP stdio: newline-delimited JSON-RPC over child stdin/stdout.
 * Handshake on spawn: `initialize` → `notifications/initialized`.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import process from "node:process";

import consola from "consola";

import { killChildProcessTree } from "../exec";

import { ensureOctocode, octocodeArtifactsPresent, octocodeBinaryPath } from "./binary";
import { ensureGlobalConfig } from "./config";
import { detectLspForWorkspace } from "./lsp-detector";
import { ensureLspServersBackground } from "./lsp-installer";

export const MAX_OCTOCODE_PROCESSES = 16;
export const HEALTH_CHECK_MS = 30_000;
const SPAWN_TIMEOUT_MS = 20_000;
const TOOL_CALL_TIMEOUT_MS = 60_000;

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface OctocodeEntry {
  workspace: string;
  child: ChildProcess;
  lspCsv: string;
  lastUsed: number;
  lastHealth: number;
  healthy: boolean;
  nextId: number;
  pending: Map<number, PendingCall>;
  buffer: string;
  initialized: boolean;
  spawnPromise: Promise<void>;
}

const pool = new Map<string, OctocodeEntry>();
let healthTimer: ReturnType<typeof setInterval> | undefined;
let exitHandlersRegistered = false;

function parseEnvInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function maxProcesses(): number {
  return parseEnvInt("GH_ROUTER_OCTOCODE_MAX_PROCESSES", MAX_OCTOCODE_PROCESSES);
}

function sendJson(entry: OctocodeEntry, obj: unknown): void {
  const line = JSON.stringify(obj) + "\n";
  entry.child.stdin?.write(line);
}

function handleLine(entry: OctocodeEntry, line: string): void {
  if (!line.trim()) return;
  let msg: { id?: number; result?: unknown; error?: { message?: string } };
  try {
    msg = JSON.parse(line) as typeof msg;
  } catch {
    return;
  }
  if (typeof msg.id !== "number") return; // notification — ignore
  const pend = entry.pending.get(msg.id);
  if (!pend) return;
  entry.pending.delete(msg.id);
  clearTimeout(pend.timer);
  if (msg.error) {
    pend.reject(new Error(msg.error.message ?? "octocode MCP error"));
    return;
  }
  pend.resolve(msg.result);
}

function wireStdout(entry: OctocodeEntry): void {
  if (!entry.child.stdout) return;
  entry.child.stdout.setEncoding("utf8");
  const rl = createInterface({ input: entry.child.stdout, crlfDelay: Infinity });
  rl.on("line", (line) => handleLine(entry, line));
  entry.child.on("exit", () => {
    rl.close();
    entry.healthy = false;
    for (const [, pend] of entry.pending) {
      clearTimeout(pend.timer);
      pend.reject(new Error("octocode process exited"));
    }
    entry.pending.clear();
  });
  entry.child.on("error", () => {
    entry.healthy = false;
  });
}

async function handshake(entry: OctocodeEntry): Promise<void> {
  const id = entry.nextId++;
  const result = await rpcCall(entry, id, "initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "github-router", version: "1" },
  });
  void result;
  sendJson(entry, { jsonrpc: "2.0", method: "notifications/initialized" });
  entry.initialized = true;
}

function rpcCall(
  entry: OctocodeEntry,
  id: number,
  method: string,
  params: unknown,
  timeoutMs = SPAWN_TIMEOUT_MS,
): Promise<unknown> {
  return new Promise<unknown>((resolve, reject) => {
    const timer = setTimeout(() => {
      entry.pending.delete(id);
      reject(new Error(`octocode MCP ${method} timed out`));
    }, timeoutMs);
    timer.unref?.();
    entry.pending.set(id, { resolve, reject, timer });
    sendJson(entry, { jsonrpc: "2.0", id, method, params });
  });
}

function evictLru(): void {
  if (pool.size < maxProcesses()) return;
  let oldestKey: string | undefined;
  let oldestTs = Infinity;
  for (const [k, v] of pool) {
    if (v.lastUsed < oldestTs) {
      oldestTs = v.lastUsed;
      oldestKey = k;
    }
  }
  if (oldestKey) destroyEntry(oldestKey);
}

function destroyEntry(key: string): void {
  const entry = pool.get(key);
  if (!entry) return;
  pool.delete(key);
  try {
    killChildProcessTree(entry.child, { detachedGroup: false, graceMs: 2000 });
  } catch {
    // best-effort
  }
}

async function spawnEntry(workspace: string): Promise<OctocodeEntry> {
  evictLru();
  // Resolve binary (env override → managed → ensure download).
  let bin = process.env.GH_ROUTER_OCTOCODE_BIN;
  if (!bin || bin.length === 0) {
    bin = octocodeArtifactsPresent() ? octocodeBinaryPath() : undefined;
  }
  if (!bin) {
    const res = await ensureOctocode();
    if (res.status !== "ready" || !res.binaryPath) {
      throw new Error(`octocode binary unavailable: ${res.reason ?? res.status}`);
    }
    bin = res.binaryPath;
  }
  await ensureGlobalConfig().catch(() => {});

  const detection = detectLspForWorkspace(workspace);
  ensureLspServersBackground(detection.servers);

  const args = ["mcp", "--path", workspace];
  if (detection.csv) args.push(`--with-lsp=${detection.csv}`);

  const child = spawn(bin, args, {
    stdio: ["pipe", "pipe", "ignore"],
    windowsHide: true,
    env: { ...process.env },
  });
  const entry: OctocodeEntry = {
    workspace,
    child,
    lspCsv: detection.csv,
    lastUsed: Date.now(),
    lastHealth: Date.now(),
    healthy: true,
    nextId: 1,
    pending: new Map(),
    buffer: "",
    initialized: false,
    spawnPromise: Promise.resolve(),
  };
  wireStdout(entry);
  entry.spawnPromise = handshake(entry).catch((err) => {
    entry.healthy = false;
    throw err;
  });
  pool.set(workspace, entry);
  startHealthLoop();
  registerOctocodeExitHandlers();
  await entry.spawnPromise;
  return entry;
}

/**
 * Get (or lazily spawn) the octocode MCP process for a workspace.
 * Throws when the binary is unavailable or the handshake fails.
 */
export async function getOctocodeEntry(workspace: string): Promise<OctocodeEntry> {
  const existing = pool.get(workspace);
  if (existing && existing.healthy && existing.child.exitCode === null) {
    existing.lastUsed = Date.now();
    await existing.spawnPromise;
    if (!existing.healthy) {
      destroyEntry(workspace);
    } else {
      return existing;
    }
  } else if (existing) {
    destroyEntry(workspace);
  }
  return spawnEntry(workspace);
}

/**
 * Call an octocode MCP tool for a workspace. Returns the raw `result`.
 */
export async function callOctocodeTool(
  workspace: string,
  toolName: string,
  args: Record<string, unknown>,
  opts: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<unknown> {
  const entry = await getOctocodeEntry(workspace);
  entry.lastUsed = Date.now();
  const id = entry.nextId++;
  const timeoutMs = opts.timeoutMs ?? TOOL_CALL_TIMEOUT_MS;
  const p = rpcCall(entry, id, "tools/call", {
    name: toolName,
    arguments: args,
  }, timeoutMs);
  if (!opts.signal) return p;
  if (opts.signal.aborted) throw new Error("octocode tool call aborted");
  return await Promise.race([
    p,
    new Promise<never>((_, reject) => {
      opts.signal?.addEventListener("abort", () => reject(new Error("octocode tool call aborted")), { once: true });
    }),
  ]);
}

/** List tools from the workspace's octocode server (for diagnostics). */
export async function listOctocodeTools(workspace: string): Promise<unknown> {
  const entry = await getOctocodeEntry(workspace);
  const id = entry.nextId++;
  return rpcCall(entry, id, "tools/list", {});
}

function startHealthLoop(): void {
  if (healthTimer) return;
  healthTimer = setInterval(() => {
    void (async () => {
      for (const [key, entry] of pool) {
        if (entry.child.exitCode !== null) {
          destroyEntry(key);
          continue;
        }
        if (Date.now() - entry.lastHealth < HEALTH_CHECK_MS) continue;
        entry.lastHealth = Date.now();
        try {
          const id = entry.nextId++;
          await rpcCall(entry, id, "ping", {}, 5000);
        } catch {
          entry.healthy = false;
          destroyEntry(key);
          consola.debug(`octocode: evicted unhealthy process for ${entry.workspace}`);
        }
      }
      if (pool.size === 0) stopHealthLoop();
    })().catch(() => {});
  }, 5000);
  healthTimer.unref?.();
}

function stopHealthLoop(): void {
  if (healthTimer) {
    clearInterval(healthTimer);
    healthTimer = undefined;
  }
}

/** Shut down all octocode children (call on proxy exit). */
export function shutdownOctocodeAll(): void {
  stopHealthLoop();
  for (const key of Array.from(pool.keys())) destroyEntry(key);
}

/** Current pool size (for tests/diagnostics). */
export function octocodePoolSize(): number {
  return pool.size;
}

export function registerOctocodeExitHandlers(): void {
  if (exitHandlersRegistered) return;
  exitHandlersRegistered = true;
  const shutdown = (): void => {
    try {
      shutdownOctocodeAll();
    } catch {
      // never throw in exit path
    }
  };
  process.once("exit", shutdown);
  process.once("SIGINT", () => { shutdown(); });
  process.once("SIGTERM", () => { shutdown(); });
}

/** Test-only: clear pool + timers. */
export function __resetOctocodeManagerForTests(): void {
  shutdownOctocodeAll();
  exitHandlersRegistered = false;
}

export const __testing = { pool };
