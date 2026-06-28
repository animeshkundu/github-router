# Fleet-hardening progress (github-router side)

Tracks the github-router-side clusters from `../ai-or-die/docs/fleet-fixes-holistic-plan.md`.
Scope is `src/lib/fleet/*` + `src/lib/launch.ts` (+ the synthetic-config writer for F2).
The ai-or-die repo is owned by another driver and is not touched here.

---

## F4 — connectivity diagnostics classification ✅

Distinguish "tunnel up, no host" from "slow" / "unreachable" so `list_instances`
reports an actionable connectivity class instead of a blanket `TIMEOUT`.

**Changes**

- `src/lib/fleet/client.ts`
  - `FleetErrorCode` gains `NO_HOST` and `RELAY_ERROR` (documented inline).
  - `mapHttpError(response, requestUrl)` now threads the request URL and classifies:
    - **NO_HOST** — asserted ONLY when the host is a Dev Tunnel host
      (`*.devtunnels.ms` / `*.tunnels.api.visualstudio.com`) AND a Dev-Tunnel-specific
      no-host body signal matches (curated substring list in
      `DEVTUNNEL_NO_HOST_SIGNALS`), on a 502/503/404. Never asserted on a generic
      connection-refused / DNS failure or a plain upstream 5xx.
    - **RELAY_ERROR** — a Dev Tunnel 502/503 with no no-host proof (a live host under
      load also returns 502/503), kept distinct from `TIMEOUT` and `UPSTREAM_ERROR`.
    - **TIMEOUT** — 408/504 and aborts (unchanged), kept distinct from NO_HOST.
    - **UPSTREAM_ERROR** — non-Dev-Tunnel 5xx and other statuses (unchanged); a
      non-Dev-Tunnel 502 stays UPSTREAM_ERROR even if its body says "no host".
  - `mapNetworkError` unchanged: aborts → TIMEOUT, all other throws → UNREACHABLE, so
    connection-refused / DNS failures can never be mis-read as NO_HOST.
- `src/lib/fleet/tools.ts`
  - `isFleetErrorCode` type guard extended with `NO_HOST` / `RELAY_ERROR` so probe
    pass-through preserves the new codes.
  - `FleetInstanceProbeResult` (unreachable arm) gains an optional `hint`; `probeInstance`
    attaches a short, model-actionable hint per code via `fleetProbeHint`.

**Key constraint honored.** NO_HOST requires Dev-Tunnel-specific proof; it is not
inferred from a bare status code, a generic network failure, or a non-Dev-Tunnel host.

**Tests** (`test/fleet/client.test.ts`, `test/fleet/tools.test.ts`)

- Dev Tunnel fast 502/503 with a no-host body → `NO_HOST` (text + JSON-envelope bodies).
- Dev Tunnel 502 without a no-host signal → `RELAY_ERROR`.
- Dev Tunnel generic 500 → `UPSTREAM_ERROR`.
- Non-Dev-Tunnel 502 with a no-host body → `UPSTREAM_ERROR` (NO_HOST not over-asserted).
- Connection refused / DNS failure on a Dev Tunnel url → `UNREACHABLE` (never NO_HOST).
- Abort and 504 → `TIMEOUT` (kept distinct from NO_HOST).
- `list_instances` surfaces `error:"NO_HOST"` + an actionable `hint`, alongside
  `TIMEOUT` / `UNREACHABLE` for sibling instances.

**Gate:** `bun test test/fleet/` (35 pass) + `bun run typecheck` + `bun run lint:all` all green.

---

## F5 — Dev Tunnel URL shape validation ✅

Reject the common wrong Dev Tunnel registration form at registry-load time with a
corrective hint, instead of letting it silently 302 to the tunnel-management endpoint.

**Changes** (`src/lib/fleet/registry.ts`)

- New `assertDevTunnelUrlShape(id, parsedUrl)`, called in `parseInstance` after the
  existing protocol/host allow-check.
- Scoped STRICTLY to Dev Tunnel relay hosts via `DEVTUNNEL_HOST_RE`
  (`*.devtunnels.ms` and the legacy `*.tunnels.api.visualstudio.com`). Any other host
  (localhost, raw IPs, generic `https://host:port`) returns early and is unaffected.
- Rule: the canonical forwarded-port host fuses the port into the hostname
  (`<id>-<port>.<cluster>.devtunnels.ms`). The wrong form
  `<id>.<cluster>.devtunnels.ms:<port>` carries an explicit `:port`. Since `URL.port`
  is empty for a default port (`:443` on https), an explicit **non-default** port on a
  Dev Tunnel host is unambiguously the wrong shape → `INVALID_CONFIG`.
- The error message echoes back the corrected URL, built by splitting the leftmost
  hostname label and fusing `-<port>` (e.g. `https://abc.uks1.devtunnels.ms:3000` →
  suggests `https://abc-3000.uks1.devtunnels.ms`).

**Key constraint honored.** Only `*.devtunnels.ms` / `*.tunnels.api.visualstudio.com`
hosts are validated; `:443` (default) passes; non-devtunnels `:port` URLs are untouched.

**Tests** (`test/fleet/registry.test.ts`, new `F5 Dev Tunnel URL shape` describe)

- Wrong `<id>.<cluster>.devtunnels.ms:<port>` form → `INVALID_CONFIG` with the corrected
  `<id>-<port>...` form echoed in the message.
- Correct `<id>-<port>.<cluster>.devtunnels.ms` form passes (incl. with explicit `:443`).
- `localhost:8787`, `127.0.0.1:9000`, `example.com:3000` all pass unchanged.
- Legacy `*.tunnels.api.visualstudio.com:<port>` is rejected with the corrected hint too.

**Gate:** `bun test test/fleet/` (40 pass) + `bun run typecheck` + `bun run lint:all` all green.

---

## F9 — send_message isError = delivery only + confirmation states ✅

The tool previously folded "confirmation didn't arrive within awaitMs" into `isError`,
so a genuinely long claude turn that outran `awaitMs` returned a false error even though
delivery succeeded. F9 splits the two: `isError` reflects DELIVERY only; confirmation /
turn state is surfaced as non-error, actionable structured fields.

**Changes** (`src/lib/fleet/tools.ts`, `send_message` handler + description)

- `isError = !delivered` ONLY. Delivery is considered failed when the upstream says
  `delivered === false` OR the structured `delivery.status` is `"failed"`/`"error"`.
- A delivered-but-unconfirmed result (after our `awaitMs` window or the upstream's
  `confirmationTimedOut`) now returns `delivered:true` with `confirmationPending:true` +
  `confirmationTimedOut:true` and a `message` pointing at `await_turn` — NOT an error.
- Normalized booleans `delivered` / `confirmed` are written last so they're consistent
  regardless of upstream shape; the shared `delivery`/`submission`/`turn`/`confirmation`
  contract fields (from `SendMessageResponse` in `client.ts`) pass through unchanged.
- Tool description now documents the **recommended `awaitMs:0` + `await_turn` pattern**:
  send with `awaitMs:0` for a fast delivery ack that never blocks, then `await_turn`
  (filtered to the sessionId) to observe real turn completion. The `awaitMs` arg is
  documented as a best-effort window, NOT a deadline, and the `idempotencyKey` note
  states a retried send never re-types.

**Surfaced states (minimal + actionable):** `delivered + confirmed` (clean success),
`delivered + confirmationPending/confirmationTimedOut` (success, completion pending →
await_turn), and `!delivered` (the only `isError` case). No new diagnostic-only fields
were added; the existing contract passthrough is preserved.

**Tests** (`test/fleet/tools.test.ts`)

- Delivered + confirmation timed out (`awaitMs:250`) → `isError` falsy, `delivered:true`,
  `confirmed:false`, `confirmationPending:true`, `confirmationTimedOut:true`, message
  references `await_turn` (rewrites the old test that asserted the now-wrong isError:true).
- Delivery failure (`delivered:false` + `delivery.status:"failed"`) → `isError:true`, no
  `confirmationPending`.
- Structured `delivery.status:"error"` with `delivered` omitted → `isError:true`
  (delivery sub-status alone drives the failure).
- Delivered + confirmed (`awaitMs:500`) → `isError` falsy, `confirmed:true`, no
  `confirmationPending`/`confirmationTimedOut`.

**Gate:** `bun test test/fleet/` (43 pass) + `bun run typecheck` + `bun run lint:all` all green.
