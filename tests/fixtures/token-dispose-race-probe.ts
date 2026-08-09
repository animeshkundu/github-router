/**
 * Fixture for `tests/token-lifecycle.test.ts` — run as a CHILD process.
 *
 * Covers the DISPOSAL RACE: the disposer runs while a token exchange is
 * already in flight. Clearing the pending timer is not enough on its own,
 * because the in-flight exchange resolves afterwards and its completion
 * handler would schedule a fresh timer — resurrecting a loop that was
 * explicitly stopped.
 *
 * Detection is by OBSERVED UPSTREAM CALLS, not by process exit. The re-armed
 * timer is `unref()`d, so a leaked one does not hold the event loop open and
 * an exit-based probe cannot see it. What it does do is keep hitting the
 * token endpoint forever. So: dispose mid-flight, then watch. Any exchange
 * after disposal is the bug.
 *
 * A subprocess keeps this hermetic — it drives the real `setupCopilotToken`
 * against a local server without touching the network or the shared module
 * state of the main test process.
 */
import http from "node:http"
import process from "node:process"

let exchanges = 0
let disposed = false
let afterDisposal = 0

// `refresh_in: 61` puts the scheduled refresh ~1s out (61s minus the 120s
// skew, floored at 1s), so refreshes fire fast and a leak shows up quickly.
const server = http.createServer((req, res) => {
  res.setHeader("content-type", "application/json")
  if (req.url?.includes("/copilot_internal/v2/token")) {
    exchanges++
    if (disposed) afterDisposal++
    const delay = exchanges === 2 ? 1200 : 0
    // The second exchange is held open, so the disposer lands mid-flight.
    setTimeout(() => {
      res.end(
        JSON.stringify({ token: `mock-token-${exchanges}`, refresh_in: 61 }),
      )
    }, delay)
    return
  }
  res.statusCode = 404
  res.end("{}")
})

await new Promise<void>((resolve) => {
  server.listen(0, "127.0.0.1", resolve)
})
const address = server.address()
const port = typeof address === "object" && address !== null ? address.port : 0
process.env.GITHUB_API_URL = `http://127.0.0.1:${port}`

// Imported AFTER GITHUB_API_URL is set: `~/lib/api-config` reads it at module
// evaluation time into a top-level const.
const { setupCopilotToken } = await import("../../src/lib/token")
const { state } = await import("../../src/lib/state")
state.githubToken = "gho_mock"
// Explicit source: keeps the probe off the filesystem entirely.
state.githubTokenSource = "explicit"

const stop = await setupCopilotToken()

// Wait for the scheduled refresh to START (it is held open server-side),
// then dispose while it is still in flight.
await new Promise<void>((resolve) => setTimeout(resolve, 1400))
stop()
disposed = true

// Give a resurrected timer ample room to fire. The cadence is ~1s, so 4s is
// several missed opportunities, not a squeaker.
await new Promise<void>((resolve) => setTimeout(resolve, 4000))

server.close()

process.stdout.write(
  `exchanges=${exchanges} afterDisposal=${afterDisposal}\n`,
)
process.stdout.write(
  afterDisposal === 0 ? "ok:no-resurrect\n" : "FAIL:timer-resurrected\n",
)
process.exit(0)
