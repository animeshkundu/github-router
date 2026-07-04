# Artifact Panel v2 — Producer-Side Research & Design Brief

Status: research (read-only investigation, no code changed)
Date: 2026-07-02
Repos on this machine: github-router master @ c8b9443 (PRODUCER), ai-or-die main @ 68ef947 (CONSUMER)
Scope: the github-router PRODUCER side of the ai-or-die artifact review panel. Consumer contract quoted from ai-or-die for grounding; the consumer instance owns its side.

This brief saturates the current producer contract, traces how the agent gets feedback today, enumerates the gaps for the v2 goals (dismiss, refresh, action buttons, interactive plans, push-based structured events both directions), and proposes a first-draft wire contract to converge with the consumer instance.

---

## 0. TL;DR — the state of the world

- **4 MCP tools today:** `artifact_open`, `artifact_poll`, `artifact_reply`, `artifact_end` (`src/lib/artifact/tools.ts:47-109`). All gated on the AIORDIE env trio.
- **Human→agent feedback is fundamentally POLL-based from the producer's vantage.** `artifact_poll` long-polls `GET /poll` in a bounded 2-attempt / ~50s tool-call budget (`tools.ts:8-11,153-179`). The consumer added an *idle-gated PTY push* (ADR-0035) that injects free-text into the terminal as a new turn when the agent is idle — but that is **unstructured free text pasted into stdin**, not a structured tool result. The producer never receives a typed event.
- **Feedback is free-text prompts tied to a DOM anchor** (`selector`, `text`, `sourceLine`), destructively read. There is **no structured action / button-click channel** either direction.
- **Plans render to static styled HTML** (`plan-html.ts`) with per-block `data-source-line` anchors. **Zero interactivity** — no buttons, no form controls that reach the agent. The SDK explicitly lets native controls behave natively but does **not** capture their events (`artifact-sdk-client.js:208-220`).
- **No dismiss, no refresh tool** on the producer. `artifact_open` is idempotent-ish (re-opens/replaces). Refresh happens consumer-side only (file-watch SSE `artifact_review_reload` + a panel reload button).
- **The consumer already has an SSE `/events` channel** (agent→browser: `agent-reply`, `presence`, `ended`). It does **not** currently carry browser→agent structured events; that is the natural home for v2 push.

---

## 1. MCP TOOLS — `src/lib/artifact/tools.ts`

Registered as `NonPersonaMcpTool` entries, `group: "peers"`, `capability: "artifact"` (`tools.ts:32-34`). Frozen array `ARTIFACT_TOOLS` (`tools.ts:47`). MCP-facing names are `mcp__peers__artifact_*` (the `peers` group; note the skill/docs say `mcp__peers__artifact_*`).

Each tool wraps its handler in a try/catch that funnels thrown errors through `errorResult` (`tools.ts:37-44`), and every handler first calls `readArtifactEnv()`, returning `missingEnvResult()` (a `NOT_IN_AIORDIE_TAB` isError envelope) when the trio is absent (`tools.ts:111-117,246-254`).

### 1.1 `artifact_open`
- **Desc** (`tools.ts:50`): "Open a workspace file in ai-or-die's Artifact review panel for human review. Only works inside an ai-or-die tab-backed Claude session."
- **Input schema** (`tools.ts:51-53`): `{ file: string (required) }` — "Workspace-relative or absolute file path to show in the Artifact panel." `additionalProperties:false`.
- **Behavior:** `clientFromEnv(env).open(file, signal)` → `POST /api/artifact/:sessionId/open`.
- **Returns** (`tools.ts:59-62`): `{ viewUrl, next_step: "Tell the user to review at the Artifact panel, then call artifact_poll." }`. Note it drops `sessionId`/`key` from the client response (only surfaces `viewUrl`).

### 1.2 `artifact_poll`
- **Desc** (`tools.ts:67`): "Wait for human Artifact review feedback from ai-or-die and return the prompts/layout warnings/DOM snapshot for the agent to act on."
- **Input schema** (`tools.ts:68`): `{}` (no params).
- **Behavior:** `pollUntilReady()` (`tools.ts:153-179`) loops up to `ARTIFACT_MAX_POLLS_PER_TOOL_CALL=2` (`tools.ts:11`) inside a `ARTIFACT_POLL_TOOL_BUDGET_MS=50_000` budget (`tools.ts:8`), each single poll hinted with `ARTIFACT_SINGLE_POLL_TIMEOUT_MS=25_000` (`tools.ts:9`) clamped by remaining budget minus `ARTIFACT_POLL_RETURN_MARGIN_MS=1_000` (`tools.ts:10`). Returns as soon as `!isWaitingPoll(last)`.
- **Returns** (`tools.ts:199-207` `formatPollResponse`): `definedObject({ status, prompts, layout_warnings, dom_snapshot, next_step })` — undefined fields dropped. If nothing ready after the budget: `{ status:"waiting", next_step:"No human feedback is ready yet. Call artifact_poll again." }` (`tools.ts:174-178`).
- **`next_step` guidance** (`tools.ts:209-213`): waiting → "No human feedback is ready yet. Call artifact_poll again."; ready → "Apply the human Artifact review feedback, then call artifact_reply with a concise summary."
- **Waiting-status vocabulary** (`isWaitingPoll` / `isWaitingStatus`, `tools.ts:181-223`): `waiting | pending | open | idle | timeout | no_feedback` are treated as "keep polling"; **the presence of any non-empty `prompts` overrides status and counts as feedback** (`hasFeedback`, `tools.ts:192-197`). So the consumer's real terminal statuses `review_feedback` / `ended` / `poll` (see §2) map: `review_feedback` → has prompts → ready; `ended` → not in waiting set → returned as-is; `poll` (empty timeout) → not in waiting set either, but empty prompts, so it returns immediately without looping again (minor: `poll` is NOT in the waiting vocabulary, so a bare `poll` timeout ends the tool call rather than re-polling within budget).

### 1.3 `artifact_reply`
- **Desc** (`tools.ts:78`): "Send the agent's reply back to the ai-or-die Artifact review panel after applying or responding to human feedback."
- **Input schema** (`tools.ts:79-81`): `{ text: string (required) }`.
- **Behavior:** `clientFromEnv(env).agentReply(text, signal)` → `POST /api/artifact/:sessionId/agent-reply`.
- **Returns** (`tools.ts:87-91`): `{ ok:true, ...response, next_step:"Wait for further human review, or continue if the review loop is complete." }`.

### 1.4 `artifact_end`
- **Desc** (`tools.ts:96`): "End/close the ai-or-die Artifact review panel when the review loop is complete."
- **Input schema** (`tools.ts:97`): `{}`.
- **Behavior:** `clientFromEnv(env).end(signal)` → `POST /api/artifact/:sessionId/end`.
- **Returns** (`tools.ts:102-106`): `{ ok:true, ...response, next_step:"Artifact review loop ended." }`.

> Note: the fleet doc (`docs/aiordie-fleet.md:82-86`) still describes only three tools (`open/poll/reply`); `artifact_end` is a fourth, real tool. Docs lag the code by one tool.

### 1.5 Gating — `artifactToolsEnabled()` + the AIORDIE env trio
- `src/lib/mcp-capabilities.ts:199-205`: returns true iff `AIORDIE_BASE_URL && AIORDIE_TOKEN && AIORDIE_SESSION_ID` are all set.
- Enforced twice in the MCP handler: filtered out of `tools/list` (`src/routes/mcp/handler.ts:343`) and rejected at `tools/call` with `RPC_METHOD_NOT_FOUND` (`handler.ts:983-993`). Direct handler calls (tests) still return the friendly `NOT_IN_AIORDIE_TAB` isError envelope.
- **Env source:** ai-or-die sets `AIORDIE_BASE_URL`, `AIORDIE_TOKEN`, `AIORDIE_SESSION_ID` on the process when it launches `github-router claude` inside a Terminal tab (ADR-0033; `docs/aiordie-fleet.md:78-88`).
- **`STRIPPED_PARENT_ENV_KEYS`** (`src/lib/launch.ts:86-97`): only `AIORDIE_CLAUDE_BIND`, `AIORDIE_TOKEN`, `AIORDIE_INSECURE_TLS` are stripped from a spawned child's inherited env. **`AIORDIE_SESSION_ID` and `AIORDIE_BASE_URL` are NOT stripped** — they can flow to nested launches; the *token* (the credential) and the TLS relax flag are the security boundary. A nested `github-router claude` therefore cannot inherit the parent tab's bearer.

### 1.6 Is there dismiss / refresh / end?
- **end:** yes (`artifact_end`).
- **refresh:** no dedicated tool. `artifact_open` re-called with the same file re-opens (consumer `store.open` replaces the review, re-broadcasts `artifact_review_opened`). Content refresh is consumer-driven via file-watch SSE.
- **dismiss:** no. "Dismiss" (hide the panel without ending the review loop) has no producer or consumer primitive today; `end` is terminal (sets `status:"ended"`, tears down the watcher).

---

## 2. CLIENT — `src/lib/artifact/client.ts` and the `/api/artifact/*` contract

`ArtifactClient` (`client.ts:70-196`) is a thin typed HTTP client. Base URL trailing-slash-trimmed (`client.ts:78`); every path is `/api/artifact/${encodeURIComponent(sessionId)}/...`.

### 2.1 Methods → endpoints
| Method | HTTP | Path | Body | Notes |
|---|---|---|---|---|
| `open(file)` | POST | `/open` | `{ file }` | `client.ts:85-92` |
| `poll(timeoutMsHint?)` | GET | `/poll` | — | `client.ts:94-102`; hint drives an abort timeout, not a query param |
| `agentReply(text)` | POST | `/agent-reply` | `{ text }` | `client.ts:104-113`; `allowEmptyJson=true` |
| `end()` | POST | `/end` | — | `client.ts:115-124`; `allowEmptyJson=true` |

Response TypeScript shapes (`client.ts:47-68`):
- `ArtifactOpenResponse = { sessionId, key, viewUrl }`.
- `ArtifactPollResponse = { status: string, prompts?, layout_warnings?, dom_snapshot?, next_step?, [k]:unknown }` — deliberately loose (`unknown`) so the consumer can evolve the payload.
- `ArtifactAgentReplyResponse` / `ArtifactEndResponse` = open `{ [k]:unknown }`.

**The producer client only wires 4 of the 8 consumer endpoints.** The other four (`view`, `asset/*`, `prompts`, `layout-warnings`, `events`, `sdk.js`) are **browser↔server**, not agent↔server — the producer never calls them (see §2.5).

### 2.2 Auth-token handling
- Every request sends `Authorization: Bearer ${token}` (`client.ts:151-153`) + `Content-Type: application/json` only when there is a body.
- **`redirect:"error"`** (`client.ts:156`): a redirect is a hard error, so the bearer can never be re-sent to another origin (credential-boundary hardening; mirrors the fleet client).
- **Token provenance:** the *tools* read the token from `process.env.AIORDIE_TOKEN` (`tools.ts:113`). The *`internal-artifact-open` hook* cannot (token stripped from child env + argv leaks to `ps`), so the launcher writes it to a mode-600 `<CLAUDE_CONFIG_DIR>/.aiordie-artifact.json` (`src/lib/paths.ts:1408-1425` `writeArtifactCredsToMirror`) that the hook reads (`internal-artifact-open.ts:81-94`).

### 2.3 Insecure TLS (self-signed loopback)
- `shouldUseInsecureTls(baseUrl)` (`tools.ts:125-138`): relax verification **only** for a literal loopback IP over https (`127.0.0.0/8`, `::1`; `isLoopbackIp` `tools.ts:140-144`). `localhost` requires explicit `AIORDIE_INSECURE_TLS=1` (resolver can be remapped off-loopback). `AIORDIE_INSECURE_TLS=0/false/off` disables even on loopback. **Fail-closed** for any non-loopback host.
- Applied per-request via `applyInsecureTls(init)` (`client.ts:159-164`) — runtime-correct (Bun `tls` / Node undici `dispatcher`); global TLS posture untouched.

### 2.4 Error handling, retries, timeouts
- **Error taxonomy** `ArtifactErrorCode` (`client.ts:3-9`): `UNREACHABLE | AUTH_FAILED | NOT_FOUND | TIMEOUT | UPSTREAM_ERROR | INVALID_RESPONSE`, each carrying `retryable`, optional `status`, `detail` (`client.ts:11-31`).
- **HTTP mapping** (`mapHttpError`, `client.ts:235-273`): 401/403→AUTH_FAILED (not retryable); 404→NOT_FOUND (not retryable); 408/504→TIMEOUT (retryable); 429 or ≥500→UPSTREAM_ERROR retryable, else not.
- **Network mapping** (`mapNetworkError`, `client.ts:275-291`): abort/timeout→TIMEOUT retryable; else UNREACHABLE retryable.
- **Timeout** (`combineSignalAndTimeout`, `client.ts:198-233`): the poll `timeoutMsHint` is turned into an `AbortController` timer merged with the caller signal; cleaned up in `finally`. Single-flight, no internal retry.
- **Retries:** the client itself does **NOT** retry. `retryable` is metadata surfaced to the model (`errorResult` includes `retryable`, `status`, `tools.ts:267-281`). The *tool* layer only re-polls (`artifact_poll`'s 2-attempt loop), and only on the "still waiting" condition, not on errors. Errors bubble straight to the model as an isError envelope. → **Gap:** transient `UNREACHABLE`/`TIMEOUT` on `open`/`reply`/`end` are single-shot; the model must retry manually.
- **Body parse:** reads text then `JSON.parse`; empty body allowed only when `allowEmptyJson` (reply/end) → `{}` (`client.ts:176-194`). Non-JSON → `INVALID_RESPONSE`.

### 2.5 The full consumer `/api/artifact/:sessionId/*` surface (ai-or-die `src/artifact-review.js`)
Mounted after auth (`server.js:1273`). All authed by the same ai-or-die Bearer; sub-resource assets carry the token in the path (`/asset/_auth/<token>/...`, ADR-0033).

| Endpoint | Method | Dir | Request | Response | Producer uses? |
|---|---|---|---|---|---|
| `/open` | POST | agent→srv | `{ file }` | `{ sessionId, key, viewUrl }`; 400 no file, 403 sandbox, 404 ENOENT (`artifact-review.js:717-748`) | **yes** |
| `/view` | GET | browser | — | injected HTML (SDK + eventsUrl + assetBase) (`:750-789`) | no (browser) |
| `/sdk.js` | GET | browser | — | the annotation SDK JS (`:791-797`) | no |
| `/asset/*` | GET | browser | path (+`_auth/<token>`) | file bytes, sandboxed (`:799-834`) | no |
| `/prompts` | POST | browser→srv | `{ prompts: [], domSnapshot? }` | `{ ok, pushed, queued }` (`:836-890`) | no (browser posts; agent reads via `/poll`) |
| `/layout-warnings` | POST | browser→srv | `{ layout_warnings: [] }` | `{ ok, changed }` (`:892-901`) | no |
| `/events` | GET (SSE) | srv→browser | — | SSE `agent-reply` / `presence` / `ended` + heartbeat (`:903-963`) | **no — browser-only today** |
| `/end` | POST | agent→srv | — | `{ ok, status }`; 404 if none (`:965-972`) | **yes** |
| `/poll` | GET (long-poll) | agent→srv | — | `pollPayload` (below) (`:974-1058`) | **yes** |
| `/agent-reply` | POST | agent→srv | `{ text }` | `{ ok, reply }`; broadcasts to browser (`:1060-1070`) | **yes** |

**`pollPayload` shape** (`artifact-review.js:607-621`): `{ status, prompts, next_step, layout_warnings?, dom_snapshot? }` where `status ∈ { review_feedback | ended | poll | missing }` and `next_step` is the literal marker string passed in (`'review_feedback' | 'ended' | 'poll'`). `layout_warnings` omitted on an empty `poll` timeout; `dom_snapshot` included only when present.

**Feedback is destructive-read** (lavish semantics): `/poll` acks (consumes) the queue on `res.finish` (`sendJsonWithAck` `:623-628`, `res.once('finish', ackFeedback)` `:1036-1041`). A given annotation is delivered exactly once.

### 2.6 The prompt / annotation object (the load-bearing shape)
The panel POSTs `/prompts` with `{ prompts: AnnotationItem[], domSnapshot }`. Each `AnnotationItem` is built by the in-iframe SDK (`artifact-sdk-client.js:290-301` `buildAnnotation`):
```json
{
  "uid": "<stable element uid>",
  "selector": "<CSS selector of the annotated element>",
  "tag": "h2",
  "text": "<up to 240 chars of the element's visible text>",
  "prompt": "<the human's comment>",
  "sourceLine": 3,                // present iff a data-source-line ancestor exists
  "target": { ... }              // present for text-range selections (range boundaries)
}
```
- `selector` (`:91-117`), `sourceLine` walks up to the nearest `data-source-line` ancestor (`:118-128`) — **this is exactly what `plan-html.ts` stamps** (§3). Text-range selections add a `target` with `{ selector, path, offset }` range boundaries (`:162-206`).
- The free-text composer (no annotation) posts a **bare string** prompt: `_post('/prompts', ..., { prompts: [text] })` (`artifact-panel.js:619`). So the producer must handle both object and string prompt items — `formatFeedbackForAgent` already normalizes both (`artifact-review.js:93-124`).
- `layout_warnings` items: free-form array recorded verbatim (`recordLayoutWarnings`), surfaced in `pollPayload`. Shape by convention `{ severity, message }` (see test fixture `tests/artifact/tools.test.ts:128`).

---

## 3. PLAN → HTML — `src/lib/artifact/plan-html.ts`

### 3.1 How a plan becomes HTML
- Entry `renderPlanHtml(source, title="Plan")` (`plan-html.ts:137-185`) → `renderMarkdownBody(source)` (`:108-131`) wrapped in a full self-contained document with an inline `<style>` (dark theme, serif body, `--accent:#f4c95d`).
- `renderMarkdownBody` uses `marked` via the low-level `lexer`+`parser` split so it can (a) walk tokens to neutralize dangerous URLs, and (b) tag each top-level block with `data-source-line="N"` (1-based) via `tagSourceLine` (`:99-102,120-129`). The line counter advances by counting `\n` in each token's `raw`.
- **Security posture** (`:1-14, 58-71, 45-56, 87-97`): raw HTML tokens are **escaped** (rendered as visible text, `html()` renderer override) so a `<script>` in the plan markdown can't read the per-session asset token; `javascript:`/`vbscript:`/non-image-`data:` hrefs neutralized to `#`, entity-obfuscated schemes decoded first (`decodeEntities`). This matters because the iframe runs `allow-scripts allow-same-origin`.

### 3.2 Structure / styling / interactivity today
- **Zero interactivity.** Output is static prose: headings/lists/tables/`<pre>`/blockquote, styled by the inline CSS block (`:145-176`). No `<button>`, no `<form>`, no `<input>`, no JS.
- The **only** dynamic hook is `data-source-line` on each block, which the annotation SDK reads to attach `sourceLine` to a comment.
- The **consumer** injects the annotation SDK into any opened HTML (`injectLavishSdk`, `artifact-review.js:778`), and a `.md` artifact is wrapped in `markdownArtifactShell` — but a purpose-built HTML from `renderPlanHtml` is served raw + injected.

### 3.3 What emitting declarative buttons / interactive plan steps would require
1. **A declarative element vocabulary the SDK recognizes.** Today the SDK's `isInteractiveControl` (`artifact-sdk-client.js:208-220`) makes native `<button>`/`<input>` "behave natively" — i.e. clicks are **NOT** annotated **and NOT** forwarded to the agent. A button is inert (its default action, if a link, is blocked by ai-or-die's navigation guard). So buttons need a **new attribute contract** (e.g. `data-aod-action="approve"` `data-aod-value="..."`) that a v2 SDK listens for and forwards as a structured action event.
2. **A producer renderer that emits that vocabulary.** `plan-html.ts` would grow (or gain a sibling) a typed model: plan → steps with per-step controls (approve/skip/edit), decision blocks with option buttons, etc., emitting the `data-aod-*` attributes. Must keep the escaping invariant (no raw-HTML injection) and the CSP-safe no-external-deps rule.
3. **A structured return channel** (see §7) — a button click is not free text; it must arrive at the agent as a typed event `{ action, value, elementId, ... }`, not be squeezed through the free-text `prompt` field.
4. **State/idempotency:** interactive steps imply the artifact has state (which steps are done). Either the agent re-renders the HTML on each turn (file-watch reload already exists) or the panel keeps light client state. A v2 decision.

---

## 4. `src/internal-artifact-open.ts` — purpose

The `internal-artifact-open` subcommand (`internal-artifact-open.ts:141-165`) is a **hands-off auto-open** side-effect hook:
- Registered by the launcher as a `PostToolUse` hook matching `ExitPlanMode`, only inside an ai-or-die tab (`src/claude.ts:608-627`).
- On plan finalization it (a) parses the `ExitPlanMode` payload for `planFilePath` + inline `plan` markdown (`parseExitPlanPayload`, `:69-79`), (b) resolves the markdown preferring the file on disk (`resolvePlanMarkdown`, `:101-112`), (c) renders it via `renderPlanHtml` and writes a sibling `<plan>.aiordie.html` (`writePlanHtml`, `:119-139`), (d) opens THAT html via `ArtifactClient.open` (`:159-160`).
- **Auth:** reads the mode-600 `.aiordie-artifact.json` creds mirror (`readCreds`, `:81-94`) because `AIORDIE_TOKEN` is stripped from the child env.
- **Invariants:** side-effect only — never writes stdout, never throws, always exits 0 (`:143-164`); skips subagent payloads (`isSubagent`, `:60-66`).
- **Why it exists:** so a plan-mode plan lands in the review panel *without* the model having to call `artifact_open` — the "plans auto-open" behavior the skill/directive promise.

---

## 5. SKILL — `src/lib/injected-skills/artifact-review-skill.ts` (+ the CLAUDE.md directive)

### 5.1 Workflow it instructs (`gh-artifact-review`)
- **Default: present HTML, not raw markdown** (`artifact-review-skill.ts:13-18`). Author a self-contained `.html` and open THAT.
- **The Loop** (`:37-42`): (1) `artifact_open` with the absolute `.html` path, relay `viewUrl`; (2) `artifact_poll`, re-poll while waiting; (3) apply edits, `artifact_reply` with a summary; (4) repeat 2-3 until satisfied, then `artifact_end`.
- Playbooks per artifact type (plan/comparison/table/diagram/code/report, `:24-31`), a design-system priority order (`:34-35`), and honest limits (report tool errors verbatim; panel is a review surface not an approver, `:44-47`).
- Materialized only inside a tab (`claude.ts:608-610`); the CLAUDE.md directive `ARTIFACT_PANEL_DIRECTIVE` (`src/lib/claude-md-injection.ts:44-52`) is prepended to the mirrored CLAUDE.md so descendants inherit it.

### 5.2 Panel features it assumes
- Click-a-block / select-text-to-comment annotation (poll returns `selector` + quoted `text` + `sourceLine`, `:40`).
- HTML renders richly + is annotatable element-by-element; plans auto-open pre-rendered (`:17`).
- A **linear** open→poll→reply→end loop with free-text human comments. **No buttons, no interactive steps, no structured actions.**

### 5.3 Where it must change for buttons / interactive plans / push
- The Loop (`:37-42`) is written around `artifact_poll`; a push model means the agent **receives** feedback without an explicit poll (or `artifact_poll` becomes a "drain the event queue" call). The skill must describe: how a pushed action event arrives, how to distinguish a structured action (`approve`/`run step 3`) from a free-text comment, and how to reply/advance.
- New verbs to document: `artifact_dismiss` / `artifact_refresh` (or an `update`/`patch`) and how to author declarative buttons/interactive-plan HTML (the `data-aod-*` attribute contract) so the panel wires them.
- Playbooks should gain "interactive plan" and "decision with buttons" entries.
- The CLAUDE.md directive (`claude-md-injection.ts:44-52`) names `open/poll/reply/end` explicitly — update when the tool set changes.

---

## 6. TESTS — `tests/artifact/*`

### 6.1 `tools.test.ts` (246 lines) — covers:
- `artifactToolsEnabled()` reflects the env trio incrementally (`:70-81`).
- `artifact_open` posts `{ file }`, returns `viewUrl` + next_step, asserts URL/method/Bearer/`redirect:"error"` (`:84-120`).
- `artifact_poll` returns the full feedback payload verbatim (`:122-156`).
- `artifact_end` posts, handles a 204 empty body, returns `{ ok, next_step }` (`:158-190`).
- Missing-trio → `NOT_IN_AIORDIE_TAB` isError for all 4 tools (`:192-207`).
- Insecure-TLS matrix: loopback IP/`::1` → applied; non-loopback → fail-closed; `localhost` needs opt-in; `=0` disables on loopback (`:210-245`).

### 6.2 `plan-html.test.ts` (75 lines) — covers:
- `parseExitPlanPayload` extraction / content-only / malformed (`:6-22`).
- `renderMarkdownBody`: headings/lists/GFM tables, `data-source-line` tagging, raw-HTML escaping, dangerous-URL + entity-obfuscated-scheme neutralization (`:24-65`).
- `renderPlanHtml`: self-contained doc, escaped title (`:67-75`).

### 6.3 Gaps
- **`artifact_reply` has no dedicated test** (only the missing-trio loop touches it) — no assertion of its POST body / URL / return shape.
- **No client-level unit tests** (`client.ts` error taxonomy, HTTP-status→code mapping, timeout/abort merge, non-JSON→INVALID_RESPONSE, `allowEmptyJson`) — all exercised only indirectly through tools.
- **No `pollUntilReady` loop tests** — the 2-attempt / budget / `isWaitingPoll` status-vocabulary logic (the piece most likely to break against the consumer's real `review_feedback|ended|poll` statuses) is untested. In particular the `poll`-status-not-in-waiting-vocabulary edge (§1.2) is unverified.
- **No `internal-artifact-open` integration test** beyond `parseExitPlanPayload` (creds read, html write path, subagent-skip).
- **No test that the producer tolerates the consumer's real payload** (object prompts with `selector`/`target`, bare-string composer prompts, `status:"review_feedback"`).
- No error-mapping tests for `open`/`reply`/`end` transient failures (retryable surfacing).

---

## 7. PRODUCER GAPS for the v2 goals

### 7.1 How the agent gets feedback TODAY (the trace)
1. **Poll path (structured):** agent calls `artifact_poll` → `GET /poll` long-poll → consumer delivers queued `prompts` (destructive read) as a structured tool result. Bounded to a 50s / 2-attempt window per tool call; the agent must keep calling to stay "listening." When the agent finishes its turn and stops calling `artifact_poll`, queued feedback **sits until the next poll**.
2. **Idle PTY push path (unstructured):** ADR-0035 — when `AIORDIE_ARTIFACT_PUSH` is on (default ON) AND no poll is in flight AND the PTY has been quiet ≥1500ms, the consumer formats queued prompts via `formatFeedbackForAgent` and **types them into the terminal stdin** as a new user turn (bracketed paste). This is **free text arriving as if the user typed it** — the producer/agent has no typed signal that it came from the panel, no schema, no action semantics. It is a usability patch, not a structured channel.

So: agent→human is genuinely push (agent-reply → SSE → panel updates instantly). **human→agent is poll, with a free-text PTY-injection fallback.** Neither direction carries structured *actions*.

### 7.2 What each v2 feature needs on the producer

| Feature | Producer need |
|---|---|
| **dismiss** | New tool `artifact_dismiss` → new consumer endpoint (e.g. `POST /dismiss`) that hides the panel but keeps the review alive (distinct from `end`). Or a param on a unified `artifact_close({mode:"dismiss"|"end"})`. Client method + gate + skill copy. |
| **refresh** | New tool `artifact_refresh` (re-render/re-open current file) OR an `artifact_update({file?, html?})` that replaces content and triggers the existing file-watch/SSE reload. Today re-calling `artifact_open` is the only lever and it re-broadcasts `opened`. A first-class refresh makes the intent explicit and lets the producer push new HTML without a filesystem round-trip. |
| **action buttons** | (a) A renderer that emits a declarative button vocabulary (`data-aod-action`/`data-aod-value`) — likely a new `renderInteractive*` in/alongside `plan-html.ts`; (b) the consumer SDK to capture those clicks and forward them; (c) a structured event to reach the agent (below). |
| **interactive plans** | A typed plan model (steps + per-step controls + decision blocks) → HTML with the action vocabulary; producer emits it via `artifact_open`/`artifact_update`. Plan-mode auto-open (`internal-artifact-open.ts`) would render the interactive variant. |
| **receiving PUSHED structured action events** | The core gap. Two options: **(A) subscribe to SSE** — the producer opens `GET /events` (currently browser-only) and the consumer adds a browser→agent event type carrying `{ type:"action", action, value, elementId, selector, sourceLine }`. The producer needs a long-lived SSE consumer + a tool that surfaces the next event(s) (or an idle-push of structured events). **(B) enrich the poll payload** — keep long-poll but let `prompts` items carry a typed discriminant (`kind:"action"` vs `kind:"comment"`). (A) is truer to "fully push-based"; (B) is the smaller delta and reuses the destructive-read/ack machinery. Recommend **A for the push guarantee, with the poll payload also typed so the fallback path (§7.1.2) stays structured** rather than free-text PTY injection. |

### 7.3 Structured-event delivery — what it needs concretely
- **Producer SSE consumer:** an `ArtifactClient.events()` returning an async iterator over `GET /events`, with the same Bearer + `redirect:"error"` + insecure-TLS handling, heartbeat tolerance, and reconnect/backoff. (The consumer SSE at `artifact-review.js:903-963` already sends heartbeats + `ended`.)
- **A queue/tool surface:** either `artifact_poll` returns typed events (comments AND actions) or a new `artifact_events`/`artifact_await` tool drains them. The 50s tool-call budget model (or a longer one under the injected `MCP_TOOL_TIMEOUT=35min`) applies.
- **Replace/augment the PTY free-text push** with a structured injection, OR keep PTY push only as the "agent is idle at prompt" nudge while the real payload rides SSE/poll. The idle-gate residual risk (ADR-0035 §Consequences) argues for moving off raw stdin injection where possible.
- **Ack/idempotency:** structured actions must be single-delivery (the consumer's destructive-read/ack already models this for prompts; extend to action events). A button double-click or an SSE reconnect must not double-fire `approve`.

---

## 8. FIRST-DRAFT WIRE CONTRACT (producer vantage — to converge with the consumer instance)

> This is a **draft** for negotiation, framed from what the producer can send/receive. Field names chosen to extend, not break, the current shapes. Nothing here is implemented.

### 8.1 Typed tool signatures (proposed producer MCP surface)
```
artifact_open({ file: string, mode?: "static" | "interactive" }) -> { viewUrl }
artifact_update({ file?: string, html?: string }) -> { ok, viewUrl }   // refresh/replace content; triggers panel reload
artifact_refresh({}) -> { ok }                                          // re-render current artifact (no content change)
artifact_await({ timeoutMs?: number }) -> { events: ArtifactEvent[], status } // drains queued structured events (comments+actions); push-first, poll-fallback
artifact_reply({ text: string }) -> { ok }
artifact_dismiss({}) -> { ok }                                          // hide panel, keep review alive
artifact_end({}) -> { ok, status }
```
- `artifact_await` supersedes/renames `artifact_poll`, returning a **typed union** so a button click and a text comment are distinguishable. Keep `artifact_poll` as a back-compat alias during migration.
- Interactive-plan authoring is producer-side HTML (§8.3); no separate "render plan" tool needed — the model authors HTML with the action vocabulary, or plan-mode auto-open renders the interactive variant.

### 8.2 The structured event the producer RECEIVES back
```jsonc
// ArtifactEvent — discriminated union, delivered via SSE (push) or artifact_await (drain)
{ "kind": "comment",
  "id": "evt_...",              // stable id for ack/idempotency
  "prompt": "tighten the CTA spacing",
  "text": "Buy now",           // quoted element/selection text (<=240)
  "selector": "main > h2:nth-of-type(1)",
  "sourceLine": 12,             // present iff a data-source-line ancestor exists
  "target": { "selector": "...", "path": [..], "offset": 0 } // text-range only
}
{ "kind": "action",
  "id": "evt_...",
  "action": "approve",         // the data-aod-action value the author declared
  "value": "step-3",           // optional data-aod-value
  "elementId": "plan-step-3",  // author-supplied stable id
  "selector": "...",
  "sourceLine": 14
}
{ "kind": "ended", "id": "evt_..." }   // panel closed by human
```
- `comment` is a superset of today's annotation object (§2.6) plus a `kind` discriminant and an `id` — so the existing panel annotation path maps forward unchanged.
- `action` is the new channel. The producer never sees these today.

### 8.3 The HTML the producer SENDS to render buttons / interactive plans
Declarative attributes on standard elements (no JS in the artifact; the consumer SDK wires them):
```html
<!-- a decision block with option buttons -->
<div class="aod-decision" data-aod-id="db-auth">
  <p>Which auth approach?</p>
  <button data-aod-action="choose" data-aod-value="jwt"     data-aod-id="db-auth">JWT</button>
  <button data-aod-action="choose" data-aod-value="session" data-aod-id="db-auth">Session</button>
</div>

<!-- an interactive plan step -->
<li class="aod-step" data-aod-id="plan-step-3" data-source-line="14">
  Migrate the token store
  <button data-aod-action="approve" data-aod-id="plan-step-3">Approve</button>
  <button data-aod-action="skip"    data-aod-id="plan-step-3">Skip</button>
</li>
```
Contract points to converge with the consumer:
- **Attribute namespace:** `data-aod-action` (required), `data-aod-value` (optional), `data-aod-id` (required, stable, echoed back as `elementId`). Keep `data-source-line` for annotation mapping.
- **SDK behavior change:** the consumer SDK's `isInteractiveControl` (`artifact-sdk-client.js:208-220`) must special-case `[data-aod-action]` — capture the click, emit a `postMessage('artifact-action', {...})` to the panel, which POSTs it (new browser→srv path) and delivers it to the agent via SSE/`/poll`. Native controls without `data-aod-action` keep behaving natively.
- **Producer renderer:** `plan-html.ts` gains an interactive mode that emits this vocabulary from a typed plan model, preserving the raw-HTML-escaping + dangerous-URL invariants (the buttons are author-declared, not model-freeform-HTML, so they pass the escaper by construction).
- **Delivery guarantee:** actions ride the SSE `/events` channel (the "fully push both directions" goal); `artifact_await`/`/poll` is the durable fallback; each event carries an `id` for single-delivery ack (extend the consumer's destructive-read/ack).

### 8.4 Open questions to resolve with the consumer instance
1. SSE-subscribe (option A) vs typed-poll (option B) vs both for structured actions? (Recommend both: SSE for push, typed poll as durable fallback.)
2. Does `dismiss` need a new consumer endpoint or is it a client-only panel state (no producer involvement)?
3. Is `artifact_update({html})` acceptable (push new HTML over the wire) or must all content go through a file on disk (current `open({file})` sandbox model)? The sandbox/`validatePath` design (ADR-0033) currently assumes a file.
4. Attribute namespace + event schema sign-off (`data-aod-*`, the `ArtifactEvent` union).
5. Migration: keep `artifact_poll` as an alias while `artifact_await` lands; version the `/events` event types.

---

## Appendix — key file:line index (producer)
- Tools: `src/lib/artifact/tools.ts` (`ARTIFACT_TOOLS` :47; budgets :8-11; gating/env :111-117; TLS :125-144).
- Client: `src/lib/artifact/client.ts` (methods :85-124; request/auth/redirect :126-195; errors :235-291; timeout :198-233).
- Plan→HTML: `src/lib/artifact/plan-html.ts` (`renderPlanHtml` :137; `renderMarkdownBody` :108; source-line tag :99-102; sanitization :45-97).
- Auto-open hook: `src/internal-artifact-open.ts` (:141-165; creds :81-94; parse :69-79).
- Skill: `src/lib/injected-skills/artifact-review-skill.ts` (loop :37-42).
- CLAUDE.md directive: `src/lib/claude-md-injection.ts` (:44-52, prepend :666-676).
- Gate: `src/lib/mcp-capabilities.ts:199-205`; handler enforcement `src/routes/mcp/handler.ts:343, 983-993`.
- Env strip: `src/lib/launch.ts:86-97`; creds mirror `src/lib/paths.ts:1408-1425`; launcher wiring `src/claude.ts:602-628`.
- Tests: `tests/artifact/tools.test.ts`, `tests/artifact/plan-html.test.ts`.

## Appendix — consumer contract references (ai-or-die @ 68ef947, for grounding)
- Endpoints: `src/artifact-review.js` (open :717; view :750; asset :799; prompts :836; layout-warnings :892; events SSE :903; end :965; poll :974; agent-reply :1060).
- Payload shapes: `pollPayload` :607-621; `feedbackSnapshot` :65-78; `formatFeedbackForAgent` :106-124; annotation object `src/artifact-sdk-client.js:290-301`; interactive-control skip :208-220.
- Panel: `src/public/artifact-panel.js` (prompts POST :505,594,619; reload btn :101).
- ADR-0033 (remote review loop), ADR-0035 (maximized split + idle-gated PTY push, default ON via `AIORDIE_ARTIFACT_PUSH`).


---

## Producer ratification of FROZEN contract v2.0 (2026-07-02)

Verdict: **RATIFIED-WITH-NOTES**. Every producer obligation is implementable; the notes below are omissions/ambiguities/correctness risks that would bite during implementation. Section refs are to the frozen contract.

1. **§3 /refresh endpoint missing.** `artifact_refresh` (§1) and refresh lifecycle (§9) are defined, but §3 endpoint enumeration has no `/refresh`. Producer needs a backing call. Resolve: add `POST /refresh -> {ok}`, or spec refresh = `POST /update` empty body.
2. **§3 /update body not enumerated + INVALID_REQUEST wire signal undefined.** §3 lists `update(N POST)` with no request/response schema (unlike /actions, /history which have explicit bodies). Infer `{file?,html?} -> {ok,viewUrl}` from §1. Critically, `mapHttpError` keys only on HTTP status (400 currently -> UPSTREAM_ERROR non-retryable); to surface `INVALID_REQUEST` the server MUST tag it (e.g. 400 + body `{error:{code:"INVALID_REQUEST"}}`). Define the wire signal so the client can map it.
3. **§1 open `mode` has no wire carrier.** §3 marks `open` Unchanged (body `{file}`), yet `mode:"interactive"` is said to emit panel affordances. Clarify: does the panel detect `data-aod-*` in the served HTML (mode = producer-only hint, no wire change, PREFERRED), or must `/open` body gain `mode` (then it is Changed)?
4. **§1 retry on non-idempotent POSTs risks duplicates.** Retry/backoff on transient TIMEOUT for `reply`/`update`/`end` can double-apply when the first attempt actually succeeded server-side: `reply` -> two chat bubbles (addAgentReply has no dedup); `end` -> spurious NOT_FOUND on the retry. Need either an `idempotencyKey` (fleet client precedent) or an at-least-once caveat + treat end-after-end NOT_FOUND as success. `open`/`update` are naturally idempotent (replace / identical write).
5. **§1 retry list omits dismiss/refresh.** Only open/reply/update/end named. Confirm dismiss/refresh get the same transient-retry or are intentionally single-shot.
6. **§4/§ auto-open: no typed interactive plan MODEL exists at ExitPlanMode.** `internal-artifact-open` and the ExitPlanMode payload carry only markdown (`plan` + `planFilePath`), not a typed step model. Rendering an interactive variant needs a specced markdown->steps transform, else keep auto-open STATIC and make interactive opt-in via explicit `artifact_open(mode:"interactive")`/`update` with model-authored HTML. Also: auto-opened interactive buttons emit actions with no drain loop running post-plan-approval. Recommend: auto-open stays static in v2.
7. **§3 /history has no MCP tool (§1 lists 7 tools, none is history).** Treated as browser-side (panel rebuilds chat on reconnect); producer needs no client method. Post-compaction agent resync is already covered by `artifact_await` with absent cursor replaying up to 200. Confirm history is browser-only.
8. **Producer cannot SSE-push to the agent.** MCP tools are request/response; the producer realizes push via `artifact_await` long-hold (~25s, single request, no client re-loop needed) plus the consumer idle-PTY-push. The producer does NOT maintain an SSE client. §5/§6 (idle-gate, transcript gating, _controlRespond routing) are entirely consumer-side; producer has zero obligation there. §7 security (view ticket, iframe auth) is consumer-side; producer is already conformant (bearer in headers, `redirect:"error"`).

Clean/no-issue producer items: 7-tool + poll-alias signatures map onto `ArtifactClient` cleanly; `open` already parses `{sessionId,key,viewUrl}` (tool just surfaces them); `await` types (comment|action|ended, permissive/ignore-unknown) are additive; `INVALID_REQUEST` is a one-line union add; cursor is opaque (type as string); `plan-html` escaping + dangerous-URL invariants survive because interactive markup is renderer-constructed (attribute values escaped via existing `escapeHtml`), not freeform. Skill/CLAUDE.md verb updates are pure text with old names retained.

Non-blocking clarification: contract return shapes omit `next_step`; producer currently appends `next_step` guidance to every result. Confirm it stays as an additive field (forward-compat rule permits it).
