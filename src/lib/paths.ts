import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

function appDir(): string {
  return path.join(os.homedir(), ".local", "share", "github-router")
}

export const PATHS = {
  get APP_DIR() {
    return appDir()
  },
  get GITHUB_TOKEN_PATH() {
    return path.join(appDir(), "github_token")
  },
  get ERROR_LOG_PATH() {
    return path.join(appDir(), "error.log")
  },
}

export async function ensurePaths(): Promise<void> {
  await fs.mkdir(PATHS.APP_DIR, { recursive: true })
  await ensureFile(PATHS.GITHUB_TOKEN_PATH)
}

async function ensureFile(filePath: string): Promise<void> {
  try {
    await fs.access(filePath, fs.constants.W_OK)
  } catch {
    await fs.writeFile(filePath, "")
    await fs.chmod(filePath, 0o600)
  }
}
