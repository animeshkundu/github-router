import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { PATHS } from "../src/lib/paths"
import { state } from "../src/lib/state"
import {
  refreshCopilotToken,
  setupGitHubToken,
} from "../src/lib/token"

const originalFetch = globalThis.fetch
const originalDateNow = Date.now
const originalTokenPathDescriptor = Object.getOwnPropertyDescriptor(
  PATHS,
  "GITHUB_TOKEN_PATH",
)
const originalCopilotToken = state.copilotToken
const originalGithubToken = state.githubToken

let tempDir = ""
let tokenPath = ""

function jsonResponse(value: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(value), {
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
  })
}

function installDeviceFlowFetch(token = "new-github-token") {
  const fetchMock = mock(async (input: string | URL | Request) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url

    if (url.endsWith("/login/device/code")) {
      return jsonResponse({
        device_code: "device-code",
        user_code: "ABCD-1234",
        verification_uri: "https://github.com/login/device",
        expires_in: 900,
        interval: 0,
      })
    }
    if (url.endsWith("/login/oauth/access_token")) {
      return jsonResponse({
        access_token: token,
        token_type: "bearer",
        scope: "read:user",
      })
    }
    if (url.endsWith("/user")) {
      return jsonResponse({ login: "token-test-user" })
    }
    throw new Error(`Unexpected fetch in token test: ${url}`)
  })
  globalThis.fetch = fetchMock as unknown as typeof fetch
  return fetchMock
}

async function tempFiles(): Promise<Array<string>> {
  return (await fs.readdir(tempDir)).filter((name) => name.endsWith(".tmp"))
}

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "github-router-token-"))
  tokenPath = path.join(tempDir, "github_token")
  await fs.writeFile(tokenPath, "")
  Object.defineProperty(PATHS, "GITHUB_TOKEN_PATH", {
    configurable: true,
    value: tokenPath,
  })
})

afterEach(async () => {
  globalThis.fetch = originalFetch
  Date.now = originalDateNow
  if (originalTokenPathDescriptor) {
    Object.defineProperty(
      PATHS,
      "GITHUB_TOKEN_PATH",
      originalTokenPathDescriptor,
    )
  }
  state.copilotToken = originalCopilotToken
  state.githubToken = originalGithubToken
  if (tempDir) await fs.rm(tempDir, { recursive: true, force: true })
})

describe("Copilot token refresh", () => {
  test("coalesces concurrent refresh triggers into one upstream fetch", async () => {
    const releases: Array<() => void> = []
    const fetchMock = mock(
      () =>
        new Promise<Response>((resolve) => {
          releases.push(() =>
            resolve(
              jsonResponse({
                expires_at: 999_999,
                refresh_in: 300,
                token: "single-flight-token",
              }),
            ),
          )
        }),
    )
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const refreshes = Array.from({ length: 20 }, () =>
      refreshCopilotToken("interval"),
    )

    expect(fetchMock).toHaveBeenCalledTimes(1)
    for (const release of releases) release()
    await Promise.all(refreshes)

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(state.copilotToken).toBe("single-flight-token")
  })

  test("applies outcome-specific 401 cooldowns while interval refreshes proceed", async () => {
    let now = 1_000_000
    Date.now = () => now
    let fetchCount = 0
    const fetchMock = mock(async () => {
      fetchCount++
      if (fetchCount === 4 || fetchCount === 5) {
        return new Response("deliberate refresh failure", { status: 400 })
      }
      return jsonResponse({
        expires_at: 999_999,
        refresh_in: 300,
        token: `token-${fetchCount}`,
      })
    })
    globalThis.fetch = fetchMock as unknown as typeof fetch

    await refreshCopilotToken("interval")
    expect(fetchCount).toBe(1)

    now += 29_999
    await refreshCopilotToken("401-retry")
    expect(fetchCount).toBe(1)

    now += 1
    await refreshCopilotToken("401-retry")
    expect(fetchCount).toBe(2)

    // An interval refresh ignores the just-recorded success cooldown.
    await refreshCopilotToken("interval")
    expect(fetchCount).toBe(3)

    now += 30_000
    await refreshCopilotToken("interval")
    expect(fetchCount).toBe(4)

    // An interval refresh also ignores the just-recorded failure cooldown.
    await refreshCopilotToken("interval")
    expect(fetchCount).toBe(5)

    now += 4_999
    await refreshCopilotToken("401-retry")
    expect(fetchCount).toBe(5)

    now += 1
    await refreshCopilotToken("401-retry")
    expect(fetchCount).toBe(6)
  })
})

describe("atomic GitHub credential writes", () => {
  test("writes a private exclusive temp file and renames it over the destination", async () => {
    await fs.writeFile(tokenPath, "old-token")
    installDeviceFlowFetch()

    const realWriteFile = fs.writeFile.bind(fs)
    const realRename = fs.rename.bind(fs)
    let tempPath = ""
    let writeOptions: unknown
    let renameFrom = ""
    let renameTo = ""
    const writeSpy = spyOn(fs, "writeFile").mockImplementation(
      async (file, data, options) => {
        tempPath = String(file)
        writeOptions = options
        await realWriteFile(file, data, options)
      },
    )
    const renameSpy = spyOn(fs, "rename").mockImplementation(
      async (from, to) => {
        renameFrom = String(from)
        renameTo = String(to)
        await realRename(from, to)
      },
    )

    try {
      await setupGitHubToken({ force: true })
    } finally {
      writeSpy.mockRestore()
      renameSpy.mockRestore()
    }

    expect(tempPath).not.toBe(tokenPath)
    expect(path.dirname(tempPath)).toBe(path.dirname(tokenPath))
    expect(writeOptions).toEqual({ mode: 0o600, flag: "wx" })
    expect(renameFrom).toBe(tempPath)
    expect(renameTo).toBe(tokenPath)
    expect(await fs.readFile(tokenPath, "utf8")).toBe("new-github-token")
    expect(await tempFiles()).toEqual([])
  })

  test("preserves the destination and removes a partial temp file when writing fails", async () => {
    await fs.writeFile(tokenPath, "old-token")
    installDeviceFlowFetch()

    const realWriteFile = fs.writeFile.bind(fs)
    let failedTempPath = ""
    const writeSpy = spyOn(fs, "writeFile").mockImplementation(
      async (file, _data, options) => {
        failedTempPath = String(file)
        await realWriteFile(file, "partial-token", options)
        throw new Error("simulated mid-write failure")
      },
    )

    try {
      await expect(setupGitHubToken({ force: true })).rejects.toThrow(
        "simulated mid-write failure",
      )
    } finally {
      writeSpy.mockRestore()
    }

    expect(await fs.readFile(tokenPath, "utf8")).toBe("old-token")
    expect(failedTempPath).not.toBe("")
    expect(await tempFiles()).toEqual([])
  })

  test("refuses a pre-existing temp path instead of overwriting it", async () => {
    await fs.writeFile(tokenPath, "old-token")
    installDeviceFlowFetch()

    const realWriteFile = fs.writeFile.bind(fs)
    let plantedPath = ""
    let plantedContentsAfterRefusal = ""
    let receivedOptions: unknown
    const writeSpy = spyOn(fs, "writeFile").mockImplementation(
      async (file, data, options) => {
        plantedPath = String(file)
        receivedOptions = options
        await realWriteFile(file, "pre-existing-file")
        try {
          await realWriteFile(file, data, options)
        } catch (error) {
          plantedContentsAfterRefusal = await fs.readFile(file, "utf8")
          throw error
        }
      },
    )

    try {
      await expect(setupGitHubToken({ force: true })).rejects.toMatchObject({
        code: "EEXIST",
      })
    } finally {
      writeSpy.mockRestore()
    }

    expect(receivedOptions).toEqual({ mode: 0o600, flag: "wx" })
    expect(plantedContentsAfterRefusal).toBe("pre-existing-file")
    expect(plantedPath).not.toBe("")
    expect(await fs.readFile(tokenPath, "utf8")).toBe("old-token")
    expect(await tempFiles()).toEqual([])
  })

  // Windows does not implement POSIX mode bits for chmod/writeFile; this
  // credential is protected there by the parent directory ACL instead. The
  // cross-platform test above still verifies that mode:0o600 is requested.
  test.skipIf(process.platform === "win32")(
    "retains mode 0o600 after the POSIX rename",
    async () => {
      installDeviceFlowFetch()

      await setupGitHubToken({ force: true })

      const stat = await fs.stat(tokenPath)
      expect(stat.mode & 0o777).toBe(0o600)
    },
  )
})
