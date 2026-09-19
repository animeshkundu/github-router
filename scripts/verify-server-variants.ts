/**
 * Verify the next-plaid-api server variant wiring (CPU + CUDA selection).
 *
 * Run: `bun scripts/verify-server-variants.ts`
 *   Optional: `NEXT_PLAID_BIN=/path/to/next-plaid-api` for the live
 *   lifecycle check (embeddings-only mode, no model download).
 *
 * Checks (no binary needed):
 *   - serverArgv: default is --model --int8 without --cuda; cuda:true
 *     adds --cuda; --int8/--cuda never appear without --model.
 *   - Manifest matrix: cpu on all supported platforms, cuda on
 *     linux/win x64 only, everything unpromoted until the promotion
 *     workflow fills SHAs.
 *   - selectServerVariant: GH_ROUTER_NEXTPLAID_VARIANT override wins;
 *     otherwise follows hardware detection (boolean, never throws).
 *   - resolveServerBinaryWithVariant: explicit binary resolves as-is
 *     with --cuda only via GH_ROUTER_NEXTPLAID_CUDA=1.
 *
 * Live (only when a binary is available): spawn embeddings-only server,
 * health check, stop. Short-lived script hygiene: stops the server so the
 * loop drains (never process.exit() with live children).
 */

import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { existsSync } from "node:fs"
import os from "node:os"
import path from "node:path"

import {
  nextPlaidServerAsset,
  nextPlaidServerPromoted,
} from "~/lib/colbert/manifest"
import { serverArgv, startManagedServer } from "~/lib/colbert/service"
import {
  hasCudaGpu,
  resolveServiceBinary,
  resolveServerBinaryWithVariant,
  selectServerVariant,
} from "~/lib/colbert/service-backend"

let failures = 0
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) console.log(`ok   ${name}${detail ? ` (${detail})` : ""}`)
  else {
    failures += 1
    console.log(`FAIL ${name}${detail ? ` (${detail})` : ""}`)
  }
}

function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T): T {
  const saved: Record<string, string | undefined> = {}
  for (const k of Object.keys(vars)) {
    saved[k] = process.env[k]
    if (vars[k] === undefined) delete process.env[k]
    else process.env[k] = vars[k]
  }
  try {
    return fn()
  } finally {
    for (const k of Object.keys(vars)) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
  }
}

// ---- argv matrix ------------------------------------------------------
{
  const base = serverArgv({ indexDir: "/idx", modelDir: "/models", parallel: 2 }, 8080)
  check("argv default has --model --int8, no --cuda",
    base.includes("--model") && base.includes("--int8") && !base.includes("--cuda"))
  const cuda = serverArgv(
    { indexDir: "/idx", modelDir: "/models", parallel: 2, cuda: true }, 8080)
  check("argv cuda:true adds --cuda",
    cuda.includes("--model") && cuda.includes("--int8") && cuda.includes("--cuda"))
  const nomodel = serverArgv({ indexDir: "/idx", parallel: 1, cuda: true, int8: true }, 8080)
  check("argv never passes --int8/--cuda without --model",
    !nomodel.includes("--model") && !nomodel.includes("--int8") && !nomodel.includes("--cuda"))
}

// ---- manifest matrix ---------------------------------------------------
{
  const cpuKeys = ["linux-x64", "win32-x64", "darwin-arm64", "darwin-x64"] as const
  check("manifest cpu asset on all supported platforms",
    cpuKeys.every((k) => {
      const [p, a] = k.split("-") as [NodeJS.Platform, string]
      return nextPlaidServerAsset("cpu", p, a) !== undefined
    }))
  check("manifest cuda asset linux/win x64 only",
    nextPlaidServerAsset("cuda", "linux", "x64") !== undefined &&
    nextPlaidServerAsset("cuda", "win32", "x64") !== undefined &&
    nextPlaidServerAsset("cuda", "darwin", "arm64") === undefined &&
    nextPlaidServerAsset("cuda", "linux", "arm64") === undefined)
  const unpromoted =
    !nextPlaidServerPromoted("cpu") && !nextPlaidServerPromoted("cuda")
  console.log(`info server binaries promoted on this host: ${!unpromoted}`)
}

// ---- variant selection --------------------------------------------------
{
  const gpu = await hasCudaGpu()
  check("hasCudaGpu returns boolean, never throws", typeof gpu === "boolean", `gpu=${gpu}`)
  const forced = await withEnv({ GH_ROUTER_NEXTPLAID_VARIANT: "cuda" }, () => selectServerVariant())
  check("GH_ROUTER_NEXTPLAID_VARIANT=cuda wins", forced === "cuda")
  const forcedCpu = await withEnv({ GH_ROUTER_NEXTPLAID_VARIANT: "cpu" }, () => selectServerVariant())
  check("GH_ROUTER_NEXTPLAID_VARIANT=cpu wins", forcedCpu === "cpu")
  const auto = await withEnv({ GH_ROUTER_NEXTPLAID_VARIANT: undefined }, () => selectServerVariant())
  check("auto variant follows hardware", auto === (gpu ? "cuda" : "cpu"), `auto=${auto}`)
}

// ---- resolution ----------------------------------------------------------
{
  const r = await withEnv(
    { GH_ROUTER_NEXTPLAID_BIN: process.execPath, GH_ROUTER_NEXTPLAID_CUDA: undefined },
    () => resolveServerBinaryWithVariant("cuda"),
  )
  check("explicit binary resolves as-is without --cuda",
    r?.binary === process.execPath && r?.cuda === false)
  const rg = await withEnv(
    { GH_ROUTER_NEXTPLAID_BIN: process.execPath, GH_ROUTER_NEXTPLAID_CUDA: "1" },
    () => resolveServerBinaryWithVariant("cuda"),
  )
  check("explicit binary + GH_ROUTER_NEXTPLAID_CUDA=1 sets cuda",
    rg?.binary === process.execPath && rg?.cuda === true)
  const syncResolved = withEnv({ GH_ROUTER_NEXTPLAID_BIN: process.execPath }, () => resolveServiceBinary())
  check("sync resolver still honours explicit binary", syncResolved === process.execPath)
}

// ---- live lifecycle (optional binary) ------------------------------------
{
  const candidates = [
    process.env.NEXT_PLAID_BIN ?? "",
    process.env.GH_ROUTER_NEXTPLAID_BIN ?? "",
  ].filter((p) => p.length > 0 && existsSync(p))
  if (candidates.length === 0) {
    console.log("SKIP live server check (set NEXT_PLAID_BIN to a next-plaid-api binary)")
  } else {
    const bin = candidates[0]
    const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), "gh-router-svcvar-")))
    let svc: Awaited<ReturnType<typeof startManagedServer>> | null = null
    try {
      const t0 = Date.now()
      // Embeddings-only (no --model): validates spawn → health → stop
      // without a model download.
      svc = await startManagedServer({
        binaryPath: bin,
        indexDir: path.join(dir, "indices"),
        parallel: 1,
        startupTimeoutMs: 30_000,
      })
      console.log(`info server start=${Date.now() - t0}ms url=${svc.url}`)
      check("server healthy", (await svc.client.health()).ok)
    } catch (err) {
      check("server lifecycle", false, (err as Error).message.slice(0, 160))
    } finally {
      await svc?.stop().catch(() => {})
      rmSync(dir, { recursive: true, force: true })
    }
  }
}

if (failures > 0) {
  console.log(`${failures} check(s) failed`)
  process.exitCode = 1
} else {
  console.log("all variant checks passed")
}
