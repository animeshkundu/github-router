/**
 * Workspace detector — resolve which workspace an octocode request belongs to.
 *
 * Priority (first hit wins):
 *   1. Explicit `workspace` argument (MCP tool param / route body).
 *   2. `GH_ROUTER_WORKSPACE` env var (single-workspace deployments).
 *   3. `state.serveMode` is false → process.cwd() (claude/codex launch dir).
 *   4. Git toplevel of cwd (`git rev-parse --show-toplevel`), best-effort.
 *
 * Returns an absolute, realpath-canonicalized directory. Throws on
 * unusable input (caller maps to MCP isError / HTTP 400).
 */

import { realpathSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";

import { runCommandCapture } from "../exec";
import { state } from "../state";

export async function resolveWorkspace(explicit?: string): Promise<string> {
  const candidates: Array<string | undefined> = [
    explicit,
    process.env.GH_ROUTER_WORKSPACE,
  ];
  for (const c of candidates) {
    if (c && c.trim().length > 0) return canonicalDir(c.trim());
  }
  // Default: launch cwd (the folder `github-router claude` runs in).
  const cwd = safeCwd();
  // Prefer the git toplevel when cwd is inside a repo — stable identity
  // across subdir invocations.
  const top = await gitToplevel(cwd).catch(() => null);
  if (top) return canonicalDir(top);
  return canonicalDir(cwd);
}

function safeCwd(): string {
  try {
    return process.cwd();
  } catch {
    return process.env.HOME ?? "/tmp";
  }
}

async function gitToplevel(cwd: string): Promise<string | null> {
  try {
    const git = "git";
    const res = await runCommandCapture([git, "rev-parse", "--show-toplevel"], {
      cwd,
      timeoutMs: 4000,
    });
    if (res.code !== 0) return null;
    const out = res.stdout.trim();
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

export function canonicalDir(p: string): string {
  if (!path.isAbsolute(p)) {
    throw new Error("workspace must be an absolute path");
  }
  let real: string;
  try {
    real = realpathSync(p);
  } catch {
    throw new Error("workspace path is not accessible");
  }
  try {
    if (!statSync(real).isDirectory()) {
      throw new Error("workspace must be a directory");
    }
  } catch (err: unknown) {
    if (err instanceof Error && err.message === "workspace must be a directory") {
      throw err;
    }
    throw new Error("workspace path is not accessible", { cause: err });
  }
  return real;
}

/** Expose serve-mode for tests without importing state directly. */
export function isServeMode(): boolean {
  return state.serveMode === true;
}
