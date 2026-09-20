/**
 * LSP auto-installer — best-effort provisioning of language servers.
 *
 * Per user decision: "auto install and use". Each server has a
 * platform-aware install recipe. Installs run in parallel with a hard
 * timeout; failures are swallowed (octocode still works tree-sitter-only
 * without LSP — degraded, not broken).
 *
 * Never blocks search: `ensureLspServers()` is fire-and-forget from the
 * workspace spawn path; the MCP process starts immediately with whatever
 * is already installed.
 */

import consola from "consola";

import { resolveExecutable, runCommandCapture } from "../exec";

const INSTALL_TIMEOUT_MS = 120_000;

export interface LspInstallResult {
  server: string;
  installed: boolean;
  reason?: string;
}

async function isOnPath(bin: string): Promise<boolean> {
  return resolveExecutable(bin) !== null;
}

async function runInstall(
  server: string,
  cmd: Array<string>,
): Promise<LspInstallResult> {
  try {
    const res = await runCommandCapture(cmd, { timeoutMs: INSTALL_TIMEOUT_MS });
    if (res.code === 0) {
      return { server, installed: true };
    }
    return { server, installed: false, reason: `exit ${res.code}` };
  } catch (err) {
    return {
      server,
      installed: false,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

function installRecipe(server: string): Array<string> | null {
  const npm = resolveExecutable("npm");
  const cargo = resolveExecutable("cargo");
  const go = resolveExecutable("go");
  const gem = resolveExecutable("gem");
  const rustup = resolveExecutable("rustup");

  switch (server) {
    case "rust-analyzer":
      if (rustup) return [rustup, "component", "add", "rust-analyzer"];
      if (cargo) return [cargo, "install", "rust-analyzer"];
      return null;
    case "typescript-language-server":
      if (npm) return [npm, "install", "-g", "typescript-language-server", "typescript"];
      return null;
    case "pyright":
      if (npm) return [npm, "install", "-g", "pyright"];
      return null;
    case "gopls":
      if (go) return [go, "install", "golang.org/x/tools/gopls@latest"];
      return null;
    case "ruby-lsp":
      if (gem) return [gem, "install", "ruby-lsp"];
      return null;
    case "intelephense":
      if (npm) return [npm, "install", "-g", "intelephense"];
      return null;
    case "clangd":
    case "jdtls":
      // System package manager territory (apt/brew/pacman) — document as
      // prerequisite rather than attempting a privileged install.
      return null;
    default:
      return null;
  }
}

/**
 * Ensure LSP servers are installed. Returns per-server results.
 * Skips servers already on PATH. Never throws.
 */
export async function ensureLspServers(
  servers: ReadonlyArray<string>,
): Promise<Array<LspInstallResult>> {
  const results: Array<LspInstallResult> = await Promise.all(
    servers.map(async (server): Promise<LspInstallResult> => {
      const bin = server === "pyright" ? "pyright-langserver" : server;
      if (await isOnPath(bin)) return { server, installed: true };
      if (await isOnPath(server)) return { server, installed: true };
      const recipe = installRecipe(server);
      if (!recipe) {
        return { server, installed: false, reason: "no auto-install recipe (install manually)" };
      }
      consola.info(`octocode: installing LSP server ${server}`);
      const r = await runInstall(server, recipe);
      if (!r.installed) {
        consola.debug(`octocode: LSP install failed for ${server}: ${r.reason}`);
      }
      return r;
    }),
  );
  return results;
}

/** Fire-and-forget wrapper for the spawn path — never rejects. */
export function ensureLspServersBackground(servers: ReadonlyArray<string>): void {
  if (servers.length === 0) return;
  void ensureLspServers(servers).catch((err) => {
    consola.debug("octocode: background LSP install failed:", err);
  });
}
