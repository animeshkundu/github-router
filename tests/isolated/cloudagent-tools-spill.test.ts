/**
 * The relay cap on the Cloud Agent tools, in isolation.
 *
 * `mode: "full"` on `get_job_logs` hands the service's raw trace to
 * `relaySafeText`. Live traces measure 233 KB to 7.5 MB, so the oversized path
 * is not an edge case — it is what that mode always does. The text must spill to
 * a durable file and come back as a bounded preview, never as a partial JSON
 * document, and the bearer must not be in either copy.
 *
 * Isolation: `relaySafeText` resolves `PATHS.WORKER_DIFFS_DIR` from
 * `os.homedir()`, which `mock.module` patches process-globally. This file
 * therefore runs in its own process (lane 2) and imports nothing that reads
 * `PATHS` until after the mock is installed.
 *
 * Cross-platform: no `process.platform === "win32"` skips (Windows-first CI).
 */

import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test"
import { readFileSync, rmSync } from "node:fs"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "cloudagent-spill-home-"))

mock.module("node:os", () => ({
  default: { ...os, homedir: () => tempHome },
  ...os,
  homedir: () => tempHome,
}))

const { CloudAgentClient } = await import("../../src/lib/cloudagent-client")
const {
  CLOUDAGENT_TOOLS,
  resetCloudAgentClientForTesting,
  setCloudAgentClientForTesting,
} = await import("../../src/lib/cloudagent-tools")
const { firstText } = await import("../../src/lib/attachments")
const { PATHS } = await import("../../src/lib/paths")
const { resolveMaxResultBytes } = await import("../../src/lib/worker-agent/relay-cap")
const { state } = await import("../../src/lib/state")

const SYNTHETIC_TOKEN = "synthetic-cloudagent-bearer-not-a-credential"
const JOB_ID = "7f3a6c1e-0000-4000-8000-000000000001"
const CAP = resolveMaxResultBytes()

/** A trace comfortably over the relay cap: 512 messages with real-looking text. */
function oversizedTrace(): unknown {
  return {
    id: JOB_ID,
    chatHistory: Array.from({ length: 512 }, (_, index) => ({
      role: { label: index % 2 === 0 ? "assistant" : "tool" },
      items: [{
        $type: "TextContent",
        text: `step ${index}: ${"the agent read a file and ran a command ".repeat(20)}`,
      }],
    })),
  }
}

function installFullTraceClient(raw: string): void {
  const client = new CloudAgentClient({
    environment: "prod",
    tokenProvider: async () => SYNTHETIC_TOKEN,
    retryDelaysMs: [],
    fetchImpl: (async () =>
      new Response(raw, {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch,
  })
  setCloudAgentClientForTesting(client)
}

function pathFromTrailer(out: string): string {
  const marker = "full result saved to: "
  const at = out.lastIndexOf(marker)
  expect(at).toBeGreaterThan(-1)
  return out.slice(at + marker.length).trim().replace(/]$/, "")
}

beforeEach(() => {
  state.cloudAgentEnvironment = "prod"
  resetCloudAgentClientForTesting()
})

afterAll(async () => {
  resetCloudAgentClientForTesting()
  await fs.rm(tempHome, { recursive: true, force: true })
})

describe("get_job_logs mode full on an oversized trace", () => {
  test("spills to a file and returns a bounded preview instead of a truncated document", async () => {
    const raw = JSON.stringify(oversizedTrace())
    expect(Buffer.byteLength(raw, "utf8")).toBeGreaterThan(CAP)
    installFullTraceClient(raw)

    const result = await CLOUDAGENT_TOOLS.find((tool) => tool.toolNameHttp === "get_job_logs")!.handler({
      jobId: JOB_ID,
      mode: "full",
    })
    const out = firstText(result)

    // Bounded: the relay never sees more than the cap.
    expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(CAP)
    // Announced: the caller is told the rest is on disk and where.
    expect(out).toContain("full result saved to:")

    const savedPath = pathFromTrailer(out)
    expect(path.isAbsolute(savedPath)).toBe(true)
    expect(savedPath.startsWith(PATHS.WORKER_DIFFS_DIR)).toBe(true)
    // Nothing is lost: the file is the service's bytes, verbatim.
    expect(readFileSync(savedPath, "utf8")).toBe(raw)

    rmSync(savedPath, { force: true })
  })

  test("neither the preview nor the spilled file carries the bearer", async () => {
    const raw = JSON.stringify(oversizedTrace())
    installFullTraceClient(raw)

    const out = firstText(
      await CLOUDAGENT_TOOLS.find((tool) => tool.toolNameHttp === "get_job_logs")!.handler({
        jobId: JOB_ID,
        mode: "full",
      }),
    )
    const savedPath = pathFromTrailer(out)
    const saved = readFileSync(savedPath, "utf8")

    for (const candidate of [out, saved]) {
      expect(candidate).not.toContain(SYNTHETIC_TOKEN)
      expect(candidate).not.toContain("Bearer")
    }

    rmSync(savedPath, { force: true })
  })
})
