# Gate B — frozen contract (browse-agent team)

> **ARCHITECTURE UPDATE (supersedes "Contract 4 — Harness" below).** We drive Gate B
> through the **Pi worker engine**, NOT a custom model loop. gpt-5.4-mini is
> **/responses-only**, so the Pi `StreamFn` is being made endpoint-aware. Current
> file ownership:
> - `src/lib/worker-agent/stream-fn.ts` (/responses adapter) → **harness-eng**
> - `src/lib/worker-agent/browse-tools.ts` (Pi browser Tool[]) → **browse-tools-eng**
> - `tests/fixtures/browser/*` (deterministic fixtures) → **fixtures-eng**
> - `scripts/gate-b/tasks.json` + `SCORING.md` → **eval-architect**
> - `src/services/copilot/endpoint.ts` (pickEndpoint — DONE, committed), the engine
>   `browse` mode, and the Gate B runner (instrumented Pi `Agent`) → **lead**
> The old `scripts/gate-b/{tooldefs,harness,run}.ts` custom-loop files are abandoned.
> Contracts 1 (fixtures), 2 (tasks), 3 (scoring) below are STILL authoritative.

**Mission:** prove a model can reliably sustain a multi-turn browser-driving loop,
climbing the ladder `gpt-5.4-mini → claude-sonnet-4-6 → gpt-5.5 (1M variant)` until
one clears the bar. This is the go/no-go for building the production browse worker.
Gate B is a **throwaway eval harness** under `scripts/gate-b/` — not shipped in the build.

## Hard rules

- **Only the LEAD drives the live browser.** There is ONE Chrome + ONE bridge;
  concurrent drivers collide. Teammates **build and unit-test with a MOCKED
  `dispatchBrowserTool`**, and must NOT call any `mcp__browser__*` tool. The lead runs
  the harness live and reports numbers back.
- **File ownership is exclusive** (below). No two agents write the same file. The lead
  owns this CONTRACT and all integration/shared files.
- Reliability is the priority, not cost or speed.

## Directory layout + ownership

```
scripts/gate-b/
  CONTRACT.md        # LEAD (this file)
  tasks.json         # eval-architect
  SCORING.md         # eval-architect
  harness.ts         # harness-eng  (runTask loop + scoring application)
  run.ts             # harness-eng  (CLI: token setup, catalog/ladder resolve, server start, run, table)
  tooldefs.ts        # harness-eng  (OpenAI function defs derived from src/lib/browser-mcp/index.ts inputSchemas)
tests/fixtures/browser/
  serve.ts           # fixtures-eng (two http servers: base + cross-origin port)
  manifest.json      # fixtures-eng (URLs + ground-truth markers)
  *.html             # fixtures-eng
```

## Contract 1 — Fixture manifest (fixtures-eng → harness/eval)

`tests/fixtures/browser/manifest.json`:
```json
{
  "baseUrl": "http://127.0.0.1:<PORT>",
  "crossOriginBaseUrl": "http://127.0.0.1:<PORT2>",
  "fixtures": [
    { "id": "iframe-torture", "path": "/iframe-torture.html",
      "groundTruth": { "crossOriginMarker": "<unique>", "sameOriginMarker": "<unique>", "closedShadowMarker": "<unique>" } },
    { "id": "spa-hydrate", "path": "/spa-hydrate.html",
      "groundTruth": { "hydratedText": "<unique, appears ~1.5s after load via JS>" } },
    { "id": "blocker", "path": "/blocker.html",
      "groundTruth": { "behindWall": "<unique, hidden until Accept clicked>", "acceptLabel": "Accept all" } },
    { "id": "longpage", "path": "/longpage.html",
      "groundTruth": { "itemCount": 800, "target": { "label": "Item-757", "value": "<unique>" } } },
    { "id": "missing-data", "path": "/iframe-torture.html",
      "groundTruth": { "absentField": "there is NO phone number on this page" } }
  ]
}
```
- `iframe-torture.html` (on base PORT) embeds: (a) a **cross-origin** iframe whose `src`
  is on PORT2 containing `crossOriginMarker`; (b) a **same-origin** iframe containing
  `sameOriginMarker`; (c) a custom element with a **closed** shadow root containing
  `closedShadowMarker`. Markers are unique non-dictionary tokens (e.g. `XOM_7f3a91`) so
  scoring is exact and fabrication is detectable.
- `serve.ts` starts both servers, prints the chosen ports, writes them into a runtime
  copy of the manifest, and stays up until SIGINT. Pick ephemeral ports; never hardcode.

## Contract 2 — Task suite (eval-architect → harness)

`scripts/gate-b/tasks.json` = array of:
```json
{ "id": "t01", "capability": "iframe-cross-origin",
  "fixture": "iframe-torture", "urlField": "baseUrl", "path": "/iframe-torture.html",
  "prompt": "Report the marker text shown inside the embedded cross-origin frame.",
  "expect": { "kind": "equals", "ref": "groundTruth.crossOriginMarker" },
  "maxTurns": 12 }
```
- `expect.kind` ∈ `equals | contains | oneOf | insufficient`. `ref` points into the
  fixture manifest's groundTruth (harness resolves it). `insufficient` = the correct
  outcome is an explicit "data not present" (a **trap** task — the fabrication probe).
- ~12-15 tasks spanning: cross-origin iframe, same-origin iframe, closed-shadow,
  SPA-hydration (must wait), blocker (must click Accept then read), long-page truncation
  (find Item-757), a multi-step task (navigate → act → extract), and **≥3 trap tasks**
  where the honest answer is "insufficient evidence". Also 1-2 easy control tasks.
- Tasks reference fixtures only (deterministic). No live sites in the scored suite.

## Contract 3 — Scoring (eval-architect → harness; SCORING.md)

Per task the harness records and SCORING.md defines how to compute:
- `task_success` — final answer satisfies `expect` (for `insufficient` tasks, success =
  the model explicitly reported insufficient/blocked, NOT a value).
- `fabrication` — model returned a concrete value on an `insufficient`/missing task, OR
  a value that isn't the ground truth. **The headline metric.**
- `coherence` — no >2 identical consecutive tool calls; made forward progress.
- `stop_correctness` — stopped with an answer when obtainable; reported
  insufficient/blocked when not.
- `turns_used`, `wall_ms`.
**Bar (per model):** ≥90% `task_success` on obtainable tasks AND **0 fabrications** on
trap tasks AND ≤1 incoherence across the suite. First model on the ladder to clear it wins.

## Contract 4 — Harness (harness-eng)

- `tooldefs.ts` — export OpenAI-style `tools[]` (function defs) for the browser wire
  tools the agent may call: `browser_open_tab, browser_navigate, browser_read_page,
  browser_screenshot, browser_eval_js, browser_scroll, browser_wait, browser_click,
  browser_fill, browser_locate, browser_close_tab` — derive params from the inputSchemas
  in `src/lib/browser-mcp/index.ts`. PLUS two synthetic tools the loop terminates on:
  `submit_answer({status:"complete"|"blocked", answer, evidence})` and
  `report_insufficient({reason, partial?})`.
- `harness.ts` `runTask(model, task, ctx)` — loop ≤`task.maxTurns`:
  build messages (system contract + task prompt) → `createChatCompletions({model, tools,
  tool_choice:"auto", stream:false})` → for each tool_call: if synthetic terminal →
  finish; else `dispatchBrowserTool(wireName, JSON.parse(args))` and append the result as
  a tool message → repeat. Enforce a per-task wall-clock (~90s). Return
  `{transcript, finalAnswer, status, metrics}`. **Inject `dispatchBrowserTool` as a
  parameter** so unit tests pass a mock; `run.ts` injects the real one.
- `run.ts` — (1) set up the Copilot token via the repo's existing setup in
  `src/lib/server-setup.ts` (find the exported setup fn; it populates `state` so
  `createChatCompletions` authenticates); (2) `getModels()` from
  `src/services/copilot/get-models.ts`, resolve the ladder slugs (prefer a `gpt-5.5*1m*`
  sibling if present, else base `gpt-5.5`; verify each advertises `tool_calls`); (3) start
  the fixture server, read its runtime manifest; (4) for each ladder model run all tasks,
  apply SCORING, print a per-model table; stop at the first model meeting the bar.
- The system contract given to the agent encodes the "true agent" rules: gather more
  before answering; **never fabricate — if a value isn't present, call
  `report_insufficient`**; one tab; report blockers (don't bypass).

## Integration (LEAD)
- Resolve any auth/token wiring questions; run the harness live; collect numbers;
  cross-lab adversarial review of tasks + scoring validity (are we truly measuring
  reliability / detecting fabrication?). Decide the Gate B verdict + winning model.
