// Debug script: launches the same Playwright setup as the E2E test
// but prints what's happening at each step so we can see where the
// extension load / native-messaging spawn breaks.

import { existsSync, readFileSync } from "node:fs"
import { homedir, platform } from "node:os"
import path from "node:path"

import { chromium } from "playwright"

import { extensionDir } from "../src/lib/browser-mcp/native-host-installer"
import { createTestProfileDir, installNmhManifest, stableExtensionId } from "../tests/browser-mcp/_harness"

async function main(): Promise<void> {
  console.log("[debug] platform:", platform())
  console.log("[debug] extensionDir:", extensionDir())
  console.log("[debug] stableExtensionId:", stableExtensionId())

  // Pre-create the userDataDir so we can install the NMH manifest
  // INTO it before Chromium launches and reads from it.
  const userDataDir = createTestProfileDir()
  console.log("[debug] userDataDir:", userDataDir)

  const nmh = installNmhManifest({ userDataDir })
  console.log("[debug] NMH manifests written:")
  for (const mp of nmh.manifestPaths) console.log("  -", mp, existsSync(mp) ? "OK" : "MISSING")
  console.log("[debug] launcher script:", nmh.launcherPath, existsSync(nmh.launcherPath) ? "OK" : "MISSING")
  console.log("[debug] launcher contents:")
  console.log(readFileSync(nmh.launcherPath, "utf8"))

  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    args: [
      // Drop --headless=new — see if windowed mode finds the NMH host
      // when the new-headless mode didn't. Some Chromium versions have
      // restricted NMH in headless contexts.
      `--disable-extensions-except=${extensionDir()}`,
      `--load-extension=${extensionDir()}`,
      "--no-first-run",
      "--no-default-browser-check",
    ],
  })

  // Attach console listener BEFORE the SW spins up.
  context.on("serviceworker", (sw) => {
    console.log("[debug] new service worker:", sw.url())
    sw.on("console", (msg) => console.log("  SW:", msg.type(), msg.text()))
  })

  // Open an about:blank page to ensure tab events fire and wake the SW.
  const page = await context.newPage()
  await page.goto("about:blank")

  console.log("[debug] context launched. Active SW:")
  // Wait up to 10s for a service worker to register.
  let sw
  for (let i = 0; i < 100; i++) {
    sw = context.serviceWorkers().find((w) => w.url().includes("background.js"))
    if (sw) break
    await new Promise((r) => setTimeout(r, 100))
  }
  if (sw) console.log("  ", sw.url())
  else console.log("  NO SERVICE WORKER REGISTERED IN 10s")

  // Wait for the bridge to write its discovery file.
  const bridgePath = path.join(homedir(), ".local", "share", "github-router", "browser-mcp", "bridge.json")
  console.log("[debug] polling", bridgePath, "for 10s")
  let found = false
  for (let i = 0; i < 100; i++) {
    if (existsSync(bridgePath)) {
      console.log("[debug] FOUND bridge.json after", i * 100, "ms")
      console.log(readFileSync(bridgePath, "utf8"))
      found = true
      break
    }
    await new Promise((r) => setTimeout(r, 100))
  }
  if (!found) console.log("[debug] bridge.json never appeared")

  // Wait an extra 5s for SW logs to flush.
  await new Promise((r) => setTimeout(r, 5000))

  console.log("[debug] HOLDING — Ctrl-C to exit. NMH manifests stay in place.")
  console.log("[debug] Inspect:", nmh.manifestPaths.join(" "))
  console.log("[debug] To diagnose: open Chromium's net-internals + native messaging logs.")
  // Park indefinitely so you can poke at Chromium state.
  await new Promise(() => {})

  await context.close()
  nmh.uninstall()
}

main().catch((err) => {
  console.error("[debug] failed:", err)
  process.exit(1)
})
