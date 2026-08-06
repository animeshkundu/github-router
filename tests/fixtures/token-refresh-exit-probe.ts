/**
 * Fixture for `tests/token-lifecycle.test.ts` — run as a CHILD process.
 *
 * Calls `setupCopilotToken()` against a mock token endpoint and then simply
 * returns, exactly like the `models` / `check-usage` one-shot commands do on
 * their success paths. **Whether this process exits is the whole assertion:**
 * the background refresh interval must not pin the event loop open.
 *
 * It must be a separate process because the defect is "the process never
 * exits", which no in-process assertion can observe.
 *
 * The mock lives here rather than in the parent so the child is hermetic — it
 * never reaches the real GitHub, and the parent only has to watch for exit.
 *
 * argv[2] selects the shape under test:
 *   "implicit" — ignore the returned disposer (exercises the `unref()` half)
 *   "disposer" — call the returned disposer (exercises explicit ownership)
 */
import http from "node:http"
import process from "node:process"

const mode = process.argv[2] ?? "implicit"

// `refresh_in: 61` puts the interval at (61-60)*1000 = 1s — the floor. An
// un-unref'd timer at that cadence keeps the loop alive forever, which is
// precisely the reproduction.
const server = http.createServer((req, res) => {
  res.setHeader("content-type", "application/json")
  if (req.url?.includes("/copilot_internal/v2/token")) {
    res.end(JSON.stringify({ token: "mock-copilot-token", refresh_in: 61 }))
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

const stop = await setupCopilotToken()
if (mode === "disposer") stop()

// Close the listener so IT is not what keeps us alive — after this the refresh
// interval is the only thing that could, which is what we are testing.
server.close()

process.stdout.write(`ok:${mode}\n`)

// Deliberately NO process.exit(): a clean exit here means nothing is holding
// the event loop open.
