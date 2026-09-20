/**
 * octocode binary manager — runtime download + cache + verify.
 *
 * Responsibilities:
 *   - Resolve the platform-specific release asset URL (see manifest.ts).
 *   - Download into PATHS.OCTOCODE_BIN_DIR, extract the single binary,
 *     chmod +x (POSIX), smoke test (`--version` exits 0).
 *   - Cache with a `.version` marker so upgrades are atomic.
 *   - Concurrency-safe via `withInstallLock` (same lock as toolbelt).
 *   - Best-effort: `ensureOctocode()` returns a structured result, never
 *     throws to the launcher.
 *
 * Fallback chain on download failure:
 *   1. GitHub Releases tarball/zip (primary)
 *   2. `cargo install --locked octocode --version <pinned>` (requires Rust)
 *   3. System `octocode` on PATH (operator pre-installed)
 */

import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";

import consola from "consola";

import { PATHS } from "../paths";
import { runCommandCapture, resolveExecutable } from "../exec";
import { extractTarGzMember, extractZipMember } from "../toolbelt/extract";
import { withInstallLock } from "../update-lock";

import {
  OCTOCODE_VERSION,
  currentOctocodePlatform,
  octocodeAssetName,
  octocodeExeName,
  octocodeReleaseUrl,
} from "./manifest";

const MAX_DOWNLOAD_BYTES = 64 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 120_000;
const SMOKE_TIMEOUT_MS = 15_000;

export type OctocodeBinaryStatus =
  | "ready"
  | "unsupported"
  | "incomplete";

export interface OctocodeBinaryResult {
  status: OctocodeBinaryStatus;
  binaryPath?: string;
  reason?: string;
}

export function octocodeBinaryPath(): string {
  return path.join(PATHS.OCTOCODE_BIN_DIR, octocodeExeName());
}

function versionMarkerPath(): string {
  return path.join(PATHS.OCTOCODE_DIR, ".version");
}

async function installedVersion(): Promise<string | null> {
  try {
    const raw = await readFile(versionMarkerPath(), "utf8");
    return raw.trim() || null;
  } catch {
    return null;
  }
}

async function smokeTest(binaryPath: string): Promise<boolean> {
  try {
    const res = await runCommandCapture([binaryPath, "--version"], {
      timeoutMs: SMOKE_TIMEOUT_MS,
    });
    return res.code === 0;
  } catch {
    return false;
  }
}

async function downloadBytes(url: string): Promise<Buffer | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
    timer.unref?.();
    try {
      const res = await fetch(url, {
        signal: controller.signal,
        headers: { "user-agent": "github-router-octocode-provisioner" },
      });
      if (!res.ok) return null;
      const len = res.headers.get("content-length");
      if (len && Number(len) > MAX_DOWNLOAD_BYTES) return null;
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length === 0 || buf.length > MAX_DOWNLOAD_BYTES) return null;
      return buf;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return null;
  }
}

async function installFromRelease(binaryPath: string): Promise<boolean> {
  const plat = currentOctocodePlatform();
  if (!plat) return false;
  const url = octocodeReleaseUrl(plat);
  const asset = octocodeAssetName(plat);
  consola.info(`octocode: downloading ${asset} (v${OCTOCODE_VERSION})`);
  const buf = await downloadBytes(url);
  if (!buf) return false;

  let exeBytes: Buffer | null = null;
  if (asset.endsWith(".zip")) {
    exeBytes = extractZipMember(buf, "octocode");
  } else if (asset.endsWith(".tar.gz")) {
    exeBytes = extractTarGzMember(buf, "octocode");
  }
  if (!exeBytes) return false;

  await mkdir(PATHS.OCTOCODE_BIN_DIR, { recursive: true });
  const tmpPath = `${binaryPath}.${process.pid}.tmp`;
  try {
    await writeFile(tmpPath, exeBytes, { mode: 0o755 });
    if (process.platform !== "win32") {
      await chmod(tmpPath, 0o755).catch(() => {});
    }
    await (await import("node:fs/promises")).rename(tmpPath, binaryPath);
  } catch {
    await rm(tmpPath, { force: true }).catch(() => {});
    return false;
  }
  return smokeTest(binaryPath);
}

async function installFromCargo(binaryPath: string): Promise<boolean> {
  // Requires a Rust toolchain. `cargo install` drops the binary into
  // ~/.cargo/bin — copy it into our managed dir so PATH drift can't
  // swap it later.
  const cargo = resolveExecutable("cargo");
  if (!cargo) return false;
  consola.info("octocode: release download failed, trying cargo install");
  try {
    const res = await runCommandCapture(
      [cargo, "install", "--locked", "octocode", "--version", OCTOCODE_VERSION],
      { timeoutMs: 10 * 60_000 },
    );
    if (res.code !== 0) return false;
    const cargoBin = path.join(
      process.env.HOME ?? tmpdir(),
      ".cargo",
      "bin",
      octocodeExeName(),
    );
    if (!existsSync(cargoBin)) return false;
    await mkdir(PATHS.OCTOCODE_BIN_DIR, { recursive: true });
    await (await import("node:fs/promises")).copyFile(cargoBin, binaryPath);
    if (process.platform !== "win32") {
      await chmod(binaryPath, 0o755).catch(() => {});
    }
    return smokeTest(binaryPath);
  } catch {
    return false;
  }
}

function systemOctocode(): string | null {
  return resolveExecutable("octocode");
}

/**
 * Ensure the octocode binary is present. Never throws — returns a
 * structured status. Safe to call from a launcher post-serve hook.
 */
export async function ensureOctocode(): Promise<OctocodeBinaryResult> {
  const plat = currentOctocodePlatform();
  if (!plat) {
    return { status: "unsupported", reason: "platform-arch not in manifest" };
  }
  // Env override: operator-managed binary (tests, nix, air-gapped).
  const override = process.env.GH_ROUTER_OCTOCODE_BIN;
  if (override && existsSync(override)) {
    return { status: "ready", binaryPath: override };
  }
  const binaryPath = octocodeBinaryPath();
  const installed = await installedVersion();
  if (installed === OCTOCODE_VERSION && existsSync(binaryPath)) {
    if (await smokeTest(binaryPath)) {
      return { status: "ready", binaryPath };
    }
  }
  // Serialize concurrent provisioners across processes.
  let result: OctocodeBinaryResult = {
    status: "incomplete",
    reason: "download + cargo + PATH all failed",
  };
  await withInstallLock("octocode", async () => {
    const recheck = await installedVersion();
    if (recheck === OCTOCODE_VERSION && existsSync(binaryPath)) {
      if (await smokeTest(binaryPath)) {
        result = { status: "ready", binaryPath };
        return;
      }
    }
    if (await installFromRelease(binaryPath)) {
      await mkdir(PATHS.OCTOCODE_DIR, { recursive: true });
      await writeFile(versionMarkerPath(), OCTOCODE_VERSION + "\n").catch(() => {});
      result = { status: "ready", binaryPath };
      return;
    }
    if (await installFromCargo(binaryPath)) {
      await mkdir(PATHS.OCTOCODE_DIR, { recursive: true });
      await writeFile(versionMarkerPath(), OCTOCODE_VERSION + "\n").catch(() => {});
      result = { status: "ready", binaryPath };
      return;
    }
    const sys = systemOctocode();
    if (sys && (await smokeTest(sys))) {
      result = { status: "ready", binaryPath: sys };
      return;
    }
  });
  // If another process holds the lock, fall back to whatever is on disk.
  if (result.status !== "ready" && existsSync(binaryPath)) {
    if (await smokeTest(binaryPath)) {
      return { status: "ready", binaryPath };
    }
    const sys = systemOctocode();
    if (sys && (await smokeTest(sys))) {
      return { status: "ready", binaryPath: sys };
    }
  }
  return result;
}

/** Synchronous fast-path: managed binary present (no smoke test). */
export function octocodeArtifactsPresent(): boolean {
  const override = process.env.GH_ROUTER_OCTOCODE_BIN;
  if (override && existsSync(override)) return true;
  return existsSync(octocodeBinaryPath());
}

/** Test-only: reset hooks (no global mutable state here beyond fs). */
export const __testing = {
  versionMarkerPath,
};
