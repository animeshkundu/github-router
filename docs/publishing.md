# Publishing & runtime ops

How releases ship to npm and Docker, how to upgrade a running proxy, and the env vars
that tune fetch / inactivity timeouts. See [`../CLAUDE.md`](../CLAUDE.md) for project
overview.

## Publishing

The canonical npm package is the **unscoped** `github-router` (NOT `@animeshkundu/github-router`).
Users install via `npm install -g github-router`. The scoped name in package.json is for
GitHub Packages compatibility only.

**CI publishing** (preferred): Every push to `master` triggers the Release workflow
(`.github/workflows/release.yml`), which auto-bumps the version, publishes to npmjs.org
via OIDC trusted publishing (no token needed), creates a GitHub release, and builds Docker
images. Uses Node 24 (npm 11.11.0) for OIDC support.

**Manual publishing** (fallback):
```bash
export NPM_TOKEN=npm_...
./publish/release.sh          # auto-bump patch
./publish/release.sh 0.4.0    # explicit version
```

The release script builds, tests, temporarily rewrites package.json to the unscoped name,
publishes, and restores. See `publish/release.sh` for details.

## Upgrading a running proxy

A running proxy (`npx github-router@latest claude` from earlier) is **pinned to its
installed version** and will NOT auto-update when a new release is published. To pick up
a new release:

```bash
# 1. Confirm the new version is live on npm
npm view github-router version

# 2. Identify the running proxy(ies). Each `claude` session spawns one.
ps aux | grep -E 'github-router|bun.*dist/main' | grep -v grep

# 3. WAIT for any in-flight Claude Code request to settle, then kill the
#    proxy. Killing mid-stream loses the current request only — the Claude
#    Code session itself reconnects on the next prompt, but the in-flight
#    response is lost.
kill <PID>

# 4. Force re-fetch (npm 11 prefers-online by default; this is belt-and-suspenders
#    for stale npx caches):
rm -rf ~/.npm/_npx/*github-router*

# 5. Restart
npx github-router@latest claude

# 6. Verify the new build is serving by hitting the /version endpoint with
#    the proxy's actual port (visible in `ps` output as `--port` or implied
#    from the random port the proxy chose):
curl http://localhost:<PORT>/version
# → {"name":"github-router","version":"0.3.X","gitSha":"..."}
```

## Tunable env vars

Set before launching `claude`:

- `UPSTREAM_FETCH_TIMEOUT_MS` — overall fetch-phase timeout in ms. Default `0` = no
  timeout. Set a positive integer if you need a hard ceiling on Copilot fetches.
- `UPSTREAM_INACTIVITY_TIMEOUT_MS` — body-phase inactivity timeout in ms. Default `300000`
  (5 min — sits well above Copilot's ~60s idle cut and accommodates reasoning models'
  long thinking-pauses between token bursts; the previous 75s default aborted live
  `/v1/messages` requests at bytes=134k–163k mid-stream when gpt-5.5/opus-4.7-xhigh
  went quiet to think). **Do NOT lower below 5 min** without re-reading the 134-163k
  mid-stream abort history above — reasoning models go quiet for minutes between
  token bursts, and a tighter timeout reaps live requests as if they were stalled.

  **HTTP/2 interaction (read before touching this value).** The 5-minute default is
  reasoned entirely in HTTP/1.1 terms: it deliberately lets the upstream sever an
  idle connection first, because under HTTP/1.1 that costs the one request on that
  socket. Under HTTP/2 the same event costs the whole session — every concurrent
  request shares it — so the blast radius this timeout was designed around does not
  hold. That is why `GH_ROUTER_UPSTREAM_ALLOW_H2` exists and defaults to off.

- `GH_ROUTER_UPSTREAM_ALLOW_H2` — set to `1` to permit HTTP/2 upstream. Default off.

  undici enables h2 for itself (`lib/core/connect.js`); the project never chose it.
  With h2 off, a connection-fatal fault costs one request instead of every in-flight
  one. Verify what a host actually negotiates with `bun run check:alpn`.

  **This is a mitigation of a correlated factor, not a fix for a known cause.** The
  observed fault is a TLS `bad_record_mac` alert (OpenSSL alert 20, received — the
  peer could not authenticate a record we sent) whose origin is still unexplained.
  h2 is the variable separating the failing configuration from the clean ones, but
  correlation is all there is; a service-side TLS terminator defect and a
  client-side native TLS fault both remain live candidates, and transport-agnostic
  causes are NOT excluded (h2 differs in write sizes, buffer ownership, connection
  lifetime, and bytes-per-connection, so such a defect could still surface only
  under h2). Flip this to `1` to run the comparison honestly rather than assuming.

  **Exposure is Node-version-gated.** Node ≤24's built-in fetch reads
  `Symbol.for("undici.globalDispatcher.1")`, whose wrapper hardcodes
  `allowH2:false`, so h2 is unreachable there regardless of this setting. Node ≥26
  reads `.2` and negotiates h2. A dependency bump does not change this; a runtime
  bump does. Bun sends no ALPN extension at all.

  **Rates matter when comparing arms.** At an observed ~4 faults per 11 hours, a
  clean hour has a ~70% chance of being luck. Distinguishing arms at 5% needs on
  the order of 12 equivalent hours each, measured in requests and upload bytes
  rather than wall time.

- `GH_ROUTER_UPSTREAM_MAX_CONNECTIONS` — per-origin connection cap. Default `256`.
  Without h2 multiplexing each concurrent request needs its own socket, so this
  bounds a parallel-agent burst. Generous on purpose: streaming responses hold a
  connection for the whole completion, so a tight cap head-of-line blocks real
  traffic — a worse failure than the one it guards against.
