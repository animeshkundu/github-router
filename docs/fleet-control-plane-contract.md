# Fleet control-plane wire contract (github-router ↔ ai-or-die)

**Single source of truth for the HTTP contract between the github-router fleet client
(consumer) and the ai-or-die `/api/control/*` plane (producer).** Both repos are driven in
parallel; each repo's tests are self-referential, so the only defense against silent drift
is this frozen contract. Any change to a field name, enum literal, type, or error mapping
on EITHER side must update this doc in the SAME change and be mirrored on the other side.

Legend: ✅ verified in source both sides · 🔶 PROPOSED (freeze before the owning cluster
lands) · ⚠️ known drift to fix. Producer literals below are auditor-confirmed against
`server.js` `_controlCreateSession`/`_controlSendMessage`, `control/session-status.js`
`deriveStatus`, `control/event-bus.js`, `control/routes.js`.

---

## REQUIRED FIXES from the contract audit (github-router side)

- **⚠️ DRIFT A (Important — the multi-instance scale bug).** `FleetEvent.at` is a **number**
  (`Date.now()`) on the wire; `client.ts` types it `string`; `tools.ts compareStampedEvents`
  guards numeric time-sort on `typeof at === "string"` → always false → cross-instance
  `await_turn` merge silently falls back to seq order, which is per-instance and meaningless
  across instances. **Fix:** type `FleetEvent.at: number`, compare numerically. This is the
  one finding that breaks the 100-instances-across-machines goal; verify with a test that
  interleaves two instances' events by `at`.
- **⚠️ Widen the consumer types** (Important, NOT a runtime break — `request<T>` does
  `response.json() as T` with no validation, so producer fields pass through untyped today):
  the COMMITTED `client.ts` @ master models only the narrow `CreateSessionResponse`
  `{sessionId,lifecycle,name?}` and the narrow `SendMessageResponse`. The remote
  `feat/fleet-hardening` already widened these (F9/F17); the tunnel-auth consolidation must
  carry the wide versions, not regress to master's narrow ones.
- **Cosmetic** (fix opportunistically): `lastTurnEndedAt` number-vs-`string` (DRIFT B, no
  reader); `interactionState:'exited'` undocumented (DRIFT C); `FleetSessionStatus.sessionStateSeq`
  is dead on the status path (DRIFT D — only emitted on message responses + event `detail`).

---

## Transport

- All routes under `/api/control/*`, `Authorization: Bearer <ai-or-die-bearer>` required.
- github-router attaches `X-Tunnel-Authorization: tunnel <connect-token>` +
  `X-Tunnel-Skip-Anti-Phishing-Page: true` on a `*.devtunnels.ms` https origin (tunnel-auth
  feature) — transparent to the control plane.
- `control/routes.js` passes producer objects through `res.json` UNCHANGED, except: the
  status route wraps `{sessionId, status}`, the events route `encodeCursor`s `{epoch,seq}` →
  `"epoch:seq"` string, and `routeIdempotent` overrides `duplicated:true` on cache replay.

---

## `POST /api/control/sessions/create` ✅+🔶

**Request body** (`CreateSessionInput`):
| field | type | notes |
|---|---|---|
| `agent` | `"claude"\|"codex"\|"copilot"\|"gemini"\|"terminal"` | enum |
| `workingDir` | string | |
| `name` | string? | |
| `start` | boolean? | spawn the PTY immediately |
| `idempotencyKey` | string? | retried create never double-spawns |
| `readyTimeoutMs` | number? | ✅ F17 bounded readiness wait; 0 = return immediately |
| `permissionMode` | `"plan"\|"acceptEdits"\|"default"\|"bypassPermissions"`? | 🔶 F10 — claude only; terminal/codex ignore |
| `agentArgs` | string[]? | 🔶 F10 — appended after the github-router launcher prefix; claude only |

**F10 validation (✅ ai-or-die side landed):** unknown `permissionMode`, non-array `agentArgs`,
or `agentArgs` carrying `--permission-mode` / `--dangerously-skip-permissions` →
`INVALID_ARGUMENT` → **HTTP 400**. Exact 400 body (✅ verified + fixed ai-or-die side):
`{ error: { code: "INVALID_ARGUMENT", message } }`. (The create path originally fell through to
Express's default HTML error body — classification still worked via the 400 status, but the client
surfaced an HTML blob instead of the reason; fixed ai-or-die side to the structured envelope so the
client's `detailToMessage` extracts the clean `error.message`.) Client maps the 400 to ✅
`BAD_REQUEST` (retryable:no), surfacing the upstream `message`.

**Response body** (`CreateSessionResponse`) ✅ F17 — three exit shapes:
- start-fail: `{sessionId, lifecycle:'exited', name, agent:null, ready:false, bound:false, blocker:{kind:'start_error', message}, startError}`
- start-ok: `{sessionId, lifecycle, name, agent, ready, bound, blocker?}`
- no-start: `{sessionId, lifecycle:'created', name, agent, ready:false, bound:false}`

| field | type | notes |
|---|---|---|
| `sessionId` | string | LOCAL id (client prefixes `instanceId:`) |
| `lifecycle` | string | created\|starting\|running\|exited\|crashed |
| `name` | string? | |
| `agent` | string\|null | ✅ producer emits it; consumer may model as `agent?: string\|null` (harmless if unmodeled) |
| `ready` | boolean? | true once driveable |
| `bound` | boolean? | true when a claude JSONL turn-binding is live |
| `blocker` | `{ kind: string; message?: string }`? | ✅ `kind` (NOT `reason`/`type`) |
| `startError` | string? | |

**`blocker.kind` literals (✅ auditor-confirmed):** `start_error` \| `gone` \| `inactive` \|
`trust` \| `binding_pending` \| `starting`.

---

## `POST /api/control/sessions/:id/message` ✅

**Request:** `{ message: string; idempotencyKey: string; awaitMs?: number }`. `awaitMs` is a
best-effort window, NOT a deadline (recommended: `awaitMs:0` + `await_turn`).

**Response body** (`SendMessageResponse`) ✅ F9/F18 — two paths (terminal vs claude):
| field | type | literals / notes |
|---|---|---|
| `messageId` | string | uuid |
| `delivered` | boolean | bytes written to composer — the ONLY signal driving `isError` |
| `confirmed` | boolean | real turn completion |
| `confirmation` | string? | ✅ `delivered`\|`turn_completed`\|`submitted`\|`unconfirmed`\|`no_turn_binding` |
| `confirmationTimedOut` | boolean? | submitted but turn outran awaitMs — NOT a failure |
| `delivery` | `{status}` | ✅ `status` = `delivered` (only) |
| `submission` | `{status}` | ✅ `status` ∈ `not_applicable`\|`submitted`\|`unconfirmed`\|`no_turn_binding` |
| `turn` | `{status, awaiting?}` | ✅ `status` ∈ `not_applicable`\|`completed`\|`pending` |
| `confidence` | string? | terminal=`low`; claude=`high`\|`medium` |
| `interactionState` | string? | see status enum |
| `sessionStateSeq` | number? | ✅ emitted here (bumped on turn_ended/became_busy/became_idle/waiting_input) |
| `duplicated` | boolean? | producer emits `false`; `routeIdempotent` overrides `true` on replay |

---

## `GET /api/control/sessions/:id/status` and `/read` ✅+⚠️

`status` → `{ sessionId, status }`; `read` → `{ sessionId, text, truncated, source, status }`.

**`status` object** (`FleetSessionStatus`, producer = `deriveStatus`, pass-through):
| field | type | literals |
|---|---|---|
| `lifecycle` | string | created\|starting\|running\|exited\|crashed |
| `interactionState` | string | busy\|idle\|waiting_input\|blocked\|unknown\|**exited** (⚠️ DRIFT C: emitted for dead sessions, absent from the producer's own enum comment — document it) |
| `canAcceptInput` | boolean | |
| `confidence` | string | high\|medium\|low |
| `lastTurnEndedAt` | **number (ms)** | ⚠️ DRIFT B: consumer types `string`, no reader today — fix to `number` |
| `awaiting` | `{ kind, prompt?, options?, default? }`? | kind: plan_approval\|choice_question\|tool_approval\|trust_prompt\|next_message |
| `blockReason` | string? | ⚠️ declared both sides but `deriveStatus` NEVER emits it (dead) |
| `sessionStateSeq` | number? | ⚠️ DRIFT D: NOT emitted on the status path (only message + event detail) — dead here |

---

## `GET /api/control/events` ✅+🔶

**Query:** `cursor?`, `timeoutMs?`, `sessionIds?` (comma-joined), `kinds?` (comma-joined).
**Response** (`WaitEventsResponse`): `{ events[], gaps[], cursor, more }`.
- `cursor` is a **STRING** on the wire (`"epoch:seq"`); **OPAQUE** to the client (✅ F22 — never
  parse it; the client only echoes back what the server gave). `more` is always **`false`**.
- **Cursor semantics (✅ verified + review-hardened both sides):**
  - **absent cursor = watch-from-current-head**: the server anchors at the head when no cursor is
    passed, returns events STRICTLY AFTER the wait starts — no history replay, and (post FIX-A) **no
    dropped waking event**. The client correctly sends NO cursor on a watcher's first poll. (The
    original server dropped a fresh watcher's first waking event on a falsy cursor — the core
    create→message→await_turn path; fixed server-side.)
  - **present-but-malformed cursor → HTTP 400 `INVALID_ARGUMENT`** (negative / fractional /
    unsafe-int). The client never malforms a cursor (opaque echo), so it never trips this; if it
    did, it maps 400 → `BAD_REQUEST`.
- event: `{ seq: number, sessionId: string|null, kind: string, at: number, detail? }`.
  ⚠️ **`at` is a NUMBER** (DRIFT A above); `sessionId` is `null` (not omitted) when absent.
- **`kind` literals (✅ frozen `EVENT_KINDS`):** `turn_ended` \| `became_idle` \| `became_busy`
  \| `waiting_input` \| `exited` \| `crashed` \| `session_created` \| `session_deleted`.
  (`crashed` is declared but never appended — lifecycle `'crashed'` is derived by
  `deriveStatus`, not emitted as an event; treat the live set as 7.)
- `gaps[]`: ✅ `{ reason: "restart" }` or `{ reason: "overflow", fromSeq, toSeq }`. The
  consumer's `{reason?}` is a harmless superset. ✅ F15 retention reuses **`overflow`** (with
  `fromSeq`/`toSeq`) when a cursor is older than the retained window — never a new `cursor_too_old`
  reason. **Overflow policy (✅ decided):** the client treats `overflow` as a **model-surfaced
  signal** — it surfaces the gap + advances to the returned fresh cursor (+ post-gap events) and
  does NOT auto-call `GET /snapshot`. `/snapshot` exists for an explicit full-resync but is not
  required (await_turn is a turn-completion watcher; the model gets current state from the fresh
  cursor + a `session_status` re-query). A filtered watcher (post FIX-B per-bucket evicted
  watermark) only sees `overflow` caused by ITS OWN filtered eviction, never another session's.

---

## `GET /api/control/capabilities` ✅ F19 (IMPLEMENTED both sides)

Client queries once per instance (cached), **fails closed** on a known-absent capability,
**fails open** when capabilities can't be determined (404 legacy / 500 / timeout) so an older
server is never blocked.

**Response (✅ verified both sides):** `{ capabilities: string[]; controlVersion?: string }`.
`controlVersion` is a STRING. `capabilities` is a flat `string[]` of snake_case tokens — NOT an
object of booleans (the original ai-or-die build emitted `{ capabilities: { camelCaseBooleans } }`,
which made the client's `new Set(response.capabilities)` throw → fail-open always; fixed ai-or-die
side to the flat array so gating actually works).

**Advertised vocabulary (✅ what ai-or-die emits today — only genuinely-implemented affordances):**
`permission_mode` · `agent_args` · `turn_binding` · `events_cursor` · `events_retention` ·
`session_state_seq`. The client gates `create_session` on `permission_mode` / `agent_args`; the
other four are forward-declarations. **RESERVED, not advertised:** `readiness_barrier` (it's the
F17 create-response behavior, not a queryable flag) and `multiplex_watch` (client-side F23 fan-out,
not a distinct server affordance). The producer MAY keep additive extra keys
(`permissionModes`/`events`/`limits`/…); the client ignores unknown keys.


---

## Error mapping (status → `FleetErrorCode`) ✅+🔶

| HTTP / condition | FleetErrorCode | retryable |
|---|---|---|
| 401 / 403 | `AUTH_FAILED` | no |
| 404 | `SESSION_NOT_FOUND` | no |
| 409 / 412 | `PRECONDITION_FAILED` | no |
| 408 / 504 / abort | `TIMEOUT` | yes |
| Dev Tunnel 502/503/404 + no-host body signal | `NO_HOST` | yes (F4) |
| Dev Tunnel 502/503 w/o no-host proof | `RELAY_ERROR` | yes (F4) |
| network throw | `UNREACHABLE` | yes |
| **400 INVALID_ARGUMENT** | 🔶 **`BAD_REQUEST`** (NEW, surfaces upstream `message`) | no |
| **429 under load** | 🔶 **`RATE_LIMITED`** (NEW, F21, split out of UPSTREAM_ERROR for the backoff path) | yes (backoff) |
| other 5xx | `UPSTREAM_ERROR` | yes |

---

## Tunnel-auth merge invariant (consolidation)

`origin/feat/fleet-tunnel-auth` branched BEFORE F4/F17/F18. The merge MUST **union** both:
- KEEP tunnel-auth's `FleetClientOptions.getTunnelToken`/`onTunnelAuthInvalidate`, the
  origin-pinning in `request()`, the `X-Tunnel-Authorization` attach + retry-once.
- KEEP fleet-hardening's `FleetErrorCode` `NO_HOST`/`RELAY_ERROR`, `mapHttpError(response,
  requestUrl)` signature + no-host detection, the WIDE `CreateSessionResponse`
  (ready/bound/blocker/startError/agent) and `SendMessageResponse`
  (confirmation/delivery/submission/turn), `CreateSessionInput.readyTimeoutMs`.
- tunnel-auth's `request()` rewrite and F4's `mapHttpError` requestUrl-threading touch the
  SAME function — resolve by hand so BOTH the origin-pin/retry loop AND the no-host
  classification survive. Then apply DRIFT A (`at:number`) on top.
