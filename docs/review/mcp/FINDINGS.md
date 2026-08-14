# MCP injected-surface audit: cross-tool findings

Aggregation of the 71 per-tool audits under `docs/review/mcp/<group>/<tool>.md`. Each doc followed `_TEMPLATE.md`; this file synthesizes their section-4 findings and section-5 verdicts into ranked, batched, actionable work. All `file:line` citations are carried through from the per-tool docs; where two docs shared a fact it was reconciled against the cited source.

## 1. Executive summary

Seventy-one injected MCP tools were reviewed across nine groups: artifact (8), browser (19), decide (1), first-mate (10), fleet (15), orchestrate (4), peers (6), search (2), workers (6).

**Verdict distribution: 55 Y, 16 N.**

| Group | Tools | Y | N |
|---|---|---|---|
| artifact | 8 | 7 | 1 |
| browser | 19 | 16 | 3 |
| decide | 1 | 1 | 0 |
| first-mate | 10 | 8 | 2 |
| fleet | 15 | 10 | 5 |
| orchestrate | 4 | 3 | 1 |
| peers | 6 | 4 | 2 |
| search | 2 | 2 | 0 |
| workers | 6 | 4 | 2 |
| **Total** | **71** | **55** | **16** |

**Severity totals: 1 Critical, 60 Important, 145 Suggestion.**

Overall health is good. Every N verdict is a fixable description or documentation defect, not a broken tool: no tool is unreachable in its default configuration, no schema rejects a well-formed call, and every security-relevant claim that was checked (fleet "tokens never returned", the stand_in advisor-not-decider bound, the first-mate write-token gate) held up against code. The single Critical is conditional (it bites only under a user-side `peers` config-key collision). The failures cluster: the same root causes recur across many tools, so most of the 16 N verdicts and the bulk of the 60 Important findings collapse into roughly eight batched fixes. The most consequential are model-facing misroutes (a description naming a removed tool, five surfaces naming the wrong model version, three worker defaults naming the wrong model, the awareness snippet advertising compressor tools that `tools/list` drops) and one systemic documentation drift (root CLAUDE.md describing the whole 19-tool browser surface as default `--browse` when only 6 lead tools ship there).

## 2. Critical findings

**Exactly one Critical, and it is conditional.** The artifact-prefix concern the review set was seeded to test was investigated and disproven in the default case: all eight artifact tools ARE in the `peers` group (`src/lib/artifact/tools.ts:13`), so under the normal launch the directive's `mcp__peers__artifact_*` paths resolve correctly. There is no unconditional Critical anywhere in the surface.

- **[Critical, conditional] Artifact panel directive hardcodes `mcp__peers__` and drifts under a `peers` collision** -- `src/lib/claude-md-injection.ts:48-53` (wiring `src/claude.ts:807-811`). `ARTIFACT_PANEL_DIRECTIVE` hardcodes the model-facing paths `mcp__peers__artifact_open` and the sibling `_update` / `_await` / `_reply` / `_end` / `_dismiss` / `_refresh` / `_poll`. But the `peers` config key is not fixed: `resolveGroupKeysFromMirror` (`src/lib/codex-mcp-config.ts:621-633`) renames the router's own server to `gh-router-peers` (then a numbered fallback) whenever a user already owns `mcpServers.peers`. On that path the tools list as `mcp__gh-router-peers__artifact_*`, so the directive instructs the model to call a tool at a server it does not own. Repro: user has `mcpServers.peers` in the canonical/mirrored `~/.claude.json`; launch `github-router claude` in an ai-or-die tab; the model follows the directive, calls `mcp__peers__artifact_open`, which targets the user's own `peers` server (no such tool) and the panel never opens. Every other surface (`buildPeerAwarenessSnippet`, the persona `.md` routing strings) already threads the resolved key; this directive is the one surface that breaks the never-route-at-the-user-same-named-server invariant the surrounding collision machinery exists to guarantee. Fix: thread the resolved `peersKey` into `prependArtifactPanelDirectiveToMirroredClaudeMd` and build `mcp__<peersKey>__artifact_*` dynamically; update `tests/isolated/claude-md-injection.test.ts:623` to assert the resolved-key path, not the bare literal.

Severity note: the per-tool doc classified this Critical per the stated standard (a model-facing instruction routing to a non-owned server under a concrete supported path). The precondition is low-probability (requires a user-owned `peers` key), so a maintainer could reasonably schedule it as high-Important; it is stated here at the doc's assigned Critical with its conditional nature explicit.

## 3. Systemic / cross-cutting issues

These themes each recur across multiple tools. Fixing the root once resolves many findings. Ordered by leverage.

### S1. Root CLAUDE.md describes all 19 browser tools as default `--browse`; only 6 lead tools ship there

Root `CLAUDE.md:145-149` says `--browse` "adds 19 browser-control tools" and lists all 19 inline with no mention of `--power-browse`, and asserts refs from `read_page` are the primary input to act / mouse / drag -- but `read_page`, `mouse`, `drag`, and 10 others are `browser_power`-gated. Ground truth is the gate table at `docs/browser-mcp-design.md:371`: `browser` (`--browse`) = open_tab, navigate, screenshot, act; `browser_compound` (+ compressor) = observe, extract; `browser_power` (+ `--power-browse` / `GH_ROUTER_ENABLE_POWER_BROWSE=1`) = list_tabs, close_tab, read_page, scroll, keyboard, wait, eval_js, download, mouse, drag, type, diagnostics, find. Default lead surface is 6 tools.

- Affected tools: drag, wait, scroll, type, mouse, read_page, open_tab, close_tab, find, eval_js (and named in list_tabs, diagnostics, download, navigate, observe).
- Root cause: root CLAUDE.md was not updated when the `--power-browse` tier split landed; the design doc is correct.
- Batched fix: rewrite the CLAUDE.md:147 sentence to state the two-tier split -- 6 lead tools under `--browse` (act / observe / extract / navigate / screenshot / open_tab), the 13 L0/L1 primitives behind `--power-browse` -- mirroring `docs/browser-mcp-design.md:371-373`. One edit closes about ten findings. Documentation-only; the runtime gate is correct.

### S2. Awareness snippet advertises compressor-backed browser tools on the plain `--browse` gate

`buildPeerAwarenessSnippet` names `__act` (INTENT mode), `__observe`, and `__extract` whenever `browseAvailable` is true, and the call site passes `browseAvailable: state.browseEnabled` (`src/claude.ts:1024`) -- the plain `--browse` opt-in. But `observe`/`extract` are dropped from `tools/list`/`tools/call` when `browserCompoundToolsEnabled()` is false (no `gpt-5.4-mini` / `claude-sonnet-4.6` / `claude-haiku-4.5` with `tool_calls` in the catalog), and `act`'s INTENT path throws a raw exception in the same condition. Misroute: a `--browse` session on a compressor-less catalog reads `__extract(schema, instruction)` in its system prompt, calls `mcp__browser__extract`, and gets `-32601` (or a raw throw for `act` INTENT).

- Affected tools: observe, extract, act, find (the ref-acquisition side of the same gap).
- Root cause: the snippet gate (`state.browseEnabled`) is coarser than the tool gate (`browserCompoundToolsEnabled()`).
- Batched fix: thread a `compoundBrowseAvailable` (= `browserCompoundToolsEnabled()`) opt into `buildPeerAwarenessSnippet` and gate the `__act` INTENT / `__observe` / `__extract` clauses on it; the always-available lead tools (`__navigate`/`__open_tab`/`__screenshot`) stay on the plain gate. Bites only degraded/lesser-tier catalogs (enterprise always carries a fallback), hence Important not Critical, but it yields a real `-32601`. `act.md` additionally recommends gating INTENT-mode `act` behind `browserCompoundToolsEnabled()` (or returning a clean isError envelope) so its advertised intent resolution cannot silently throw.

### S3. Worker `thinking` descriptions refreshed

Worker reasoning defaults now match the live per-mode constants: explore, implement, test, plan, and browse default to `high`; review retains `xhigh`, which clamps to `high` on its default Gemini model. Every mode still accepts an explicit higher tier when its resolved model supports one, and per-call overrides continue to outrank session defaults and built-ins.

- Root cause of the prior drift: shared prose outlived changes to the per-mode defaults.
- Resolved by checking each mode against its own `*_DEFAULT_THINKING` constant rather than blanket-editing one shared assumption.

### S4. opus_critic model selection refreshed

opus_critic now prefers `claude-opus-5`, whose single base slug is natively 1M. On catalogs without Opus 5 it falls back to `claude-opus-4.6-1m`, then `claude-opus-4-6`. Its allowed efforts include `xhigh`; `defaultEffort` remains `high` to preserve the prior latency profile.

### S5. Worker model defaults refreshed

Worker defaults now match `engine.ts`: review uses `gemini-3.1-pro-preview` (`xhigh`, clamped to high), explore uses `gpt-5.6-luna` at `high`, plan uses `claude-opus-5` at `high`, implement/test use `gpt-5.6-sol` at `high`, and browse uses `gpt-5.6-luna` at `high`. Per-call and session overrides can restore higher effort where supported. Explore/implement/review keep a free-string `model` override and document the recommended 1M sol/terra/flash ladder.

### S6. Descriptions naming removed/non-surfaced tools produce `-32601`

- browser type (`src/lib/browser-mcp/index.ts:466`) twice routes the model to `browser_fill` -- folded into `browser_act` and NOT on the MCP surface. A model that calls `mcp__browser__fill` gets `-32601`. Fix: repoint to `browser_act` with `action:"fill"`.
- codex_implementer is documented under the `peers` group in root `CLAUDE.md:129` and `docs/peer-mcp-design.md:12` as an HTTP tool, but `PERSONAS_WRITE` is excluded from the peers `tools/list` (`handler.ts:267-285` builds from `PERSONAS_READ` only); a `mcp__peers__codex_implementer` call 404s. Its only real surface is the `codex-implementer` subagent routing to `mcp__codex-cli__codex` (stdio), `--codex-cli` only. Fix: reword both docs to describe a stdio-routed subagent, not a peers HTTP tool.
- Root cause: tool folds/renames not swept from descriptions and docs.
- Batched fix: grep the descriptions and docs for every removed/renamed tool name (`browser_fill`, `browser_click`, `worker_implement`, `worker_explore`, `web_search`, `code_search`) and repoint each to its live surface. Related: `web`'s error strings still say `web_search` (`peer-mcp-personas.ts:824,840`) and `implement`'s description says `worker_implement calls` (`:1290-1291`).

### S7. Fleet group has zero system-prompt and zero CLAUDE.md presence; per-tool descriptions carry the entire routing load

`buildPeerAwarenessSnippet` names no `fleet` clause even when `--fleet` is enabled (unlike browser/decide/workers/first-mate which each get a gated sentence), and root CLAUDE.md has no fleet section. So each fleet tool's ONLY model-facing surface is its own `description`, and several are under-specified for that load:
- search (`tools.ts:749`) collides conceptually with `mcp__search__code`/`mcp__search__web` and never disambiguates remote-vs-local; "fleet instance" is an undefined routing term.
- stop_session (`tools.ts:589`) is destructive and irreversible but described in four words with no irreversibility signal and no pointer to `send_keys op:"interrupt"`.
- create_session (`tools.ts:538,541`) omits the `agent` enum (`claude|codex|copilot|gemini|terminal`) and the load-bearing `start:true` semantics.
- read_file (`tools.ts:723`) omits that `path` is an unsanitized, potentially out-of-sandbox read on a remote host with all path policy delegated to the remote.
- respond (`tools.ts:529`) and several others lack a when-NOT contrast with `send_message`/`send_keys`.
- git_show (`tools.ts:771-777`) has three overlapping revision knobs (`ref`/`rev`/`commit`) and spreads all args to the remote.
- Root cause: fleet's deliberate opt-in-niche omission from the system prompt was defensible but was made without hardening the descriptions to carry the full routing + safety signal.
- Batched fix: (a) add one gated `fleet` clause to `buildPeerAwarenessSnippet` (threaded on `fleetToolsEnabled()`) naming the group and the remote-vs-local cue, plus a short root-CLAUDE.md "Fleet session-control MCP (`--fleet`)" section and a Design-docs index entry for `docs/aiordie-fleet.md`; (b) harden the individual descriptions per their per-tool docs.

### S8. first-mate operator-tool docs looser than the code; the merge gate is misrepresented

- merge_pr (`tools.ts:428`): the description omits that the merge is irreversible, and `CLAUDE.md:139` + `docs/first-mate-design.md:388-396` advertise a `verifyAndConsumeApproval`/`decisions.json` human-approval gate that the TOOL handler does NOT call (it is controller-only, `controller.ts:1515`; the tool is a raw REST merge at `service.ts:879`). Real gates remain (head guard, ownership, CI), so it will not merge an arbitrary PR -- hence Important not Critical -- but the advertised human-approval guarantee is absent on the one irreversible tool. Also "CI green" overstates: a CI-less repo merges on human review alone.
- abandon_mission (`tools.ts:610`): described as "wind the mission down" but is local-ledger-only -- open PRs stay open and cloud agents keep running on GitHub.
- Ownership phrasing "active first-mate mission repo" on merge_pr/close_pr/mark_ready (`tools.ts:428,489,534`) is looser than the code's PR-to-unit correlation test (`tools.ts:700-704,717-727`).
- board vs advance vs mission_status (`tools.ts:413,332,650`) have near-duplicate descriptions with no in-surface differentiator.
- Root CLAUDE.md:139 omits `abandon_mission` and `add_units` from the first-mate tool inventory.
- Batched fix: (a) state in the `merge_pr` description that the merge is immediate/irreversible and relies on head+ownership+CI guards plus out-of-band human authorization, and scope the `verifyAndConsumeApproval` claim to the controller path; (b) add the local-ledger-only boundary to `abandon_mission`; (c) replace "active first-mate mission repo" with "correlated to a first-mate unit, else requires allow_unowned" on all three PR tools; (d) add reciprocal when-not clauses differentiating board/advance/mission_status; (e) add `abandon_mission` + `add_units` to CLAUDE.md:139.

### S9. Untyped `...response` spreads leak server fields into model context

Several handlers spread the raw upstream response into the model-facing result rather than projecting to the minimal actionable envelope, contrary to the ruthlessly-minimal-MCP-tool-surface principle:
- artifact `update`/`reply`/`refresh`/`dismiss`/`end` success paths spread `...response` (`src/lib/artifact/tools.ts:99-104,163-164`) where the type carries a `[key:string]: unknown` index signature.
- fleet `send_keys` spreads the full `SendKeysResponse` including diagnostic `keysId` (`tools.ts:505`).
- Batched fix: project each to `{ ok: true, next_step }` (artifact) / `{ delivered }` plus a documented `duplicated` (fleet) so no diagnostic-only field reaches the model. Today the artifact types are empty so there is no live leak, but the pattern invites one. Low priority.

### S10. Unenforced schema/limit claims and inert schema fields

- `additionalProperties:false` is not enforced at the MCP boundary (`src/routes/mcp/handler.ts:1173`), so pass-through-all-args reaches upstreams. Concretely defeats the declared closed schema on fleet `git_show` (`tools.ts:777` spreads `args`). Origin-bounded (URL-encoded onto a pinned base), so hygiene not a vuln.
- Size caps asserted but not enforced: url "Max 8 KB" (`open_tab` `index.ts:101`, `navigate` `:150`, `download` `:349`) and eval_js "Max 100 KB" (`index.ts:319-322`) are stated in descriptions but no code checks length. Either enforce or drop the claim.
- Inert schema fields: fleet `read_session` `format` ("reserved for future") is a no-op the handler never reads (`tools.ts:340-347`). first-mate `scaffold_repo` `detection_overrides` is an untyped `anyProp` blob while the runtime `.strict()` validator rejects unknown keys (`tools.ts:164-174,276`).
- Batched fix: one "make the schema honest" pass -- enforce the caps or delete them, drop `format`, type `detection_overrides`, and pluck declared fields explicitly in `git_show` instead of spreading `args`.

### S11. Design-doc `peer-mcp-design.md` staleness (maintainer-facing, cited by every peers/worker surface)

`docs/peer-mcp-design.md` is the scope reference the peers and worker descriptions and root CLAUDE.md point to, and it is stale: it never mentions `gemini_reviewer` (`:12,29-30`), says "three peer-model review tools" (`:155`, actual is four+), the minimal-surface enumeration (`:322`) omits gemini_reviewer, the worker-default table (`:359-365`) shows explore as gpt-5.4-mini and review as gpt-5.5, and the opus rows (`:203,205`) say 4.7. `docs/agent-orchestration-design.md:173-175` also names the orchestrate tools under the stale `mcp__workers__` prefix. Batched fix: one design-doc reconciliation pass -- add the gemini_reviewer row + cap-table entry, fix the "three -> four" count, correct the worker-default table against `engine.ts`, sweep opus 4.7 -> 4.6, and rename the orchestration rows to `mcp__orchestrate__*`.

### S12. Verify/run gate-immutability gap (orchestrate)

`verify_workflow` cannot check the gate-immutability invariant on the path the model uses: the three sealed gate ids (`default-ci`/`typecheck-test`/`typecheck-only`) are enumerated only in `run_workflow`'s `gateId` enum (`peer-mcp-personas.ts:1783`), never in `verify_workflow`'s description or `knownGateIds`. A model that composes an IR with a bogus executable gate and calls `verify_workflow` without `knownGateIds` gets `ok:true` (only the non-empty-string check runs, `verify.ts:141`), then `run_workflow` rejects the same IR with `UNKNOWN_GATE_ID`. `run_workflow` re-verifies as defense in depth so the bad IR never executes -- the cost is a wasted round-trip and a defeated catches-it-before-execution promise. Fix: default `knownGateIds` to `sealedGateIds()` (`gate-registry.ts:43`) inside the handler when omitted, or name the three sealed ids in the description. Related: `decompose`'s `context` field is accepted, documented, and fed by the `/gh-orchestrate` skill but severed at all three call sites (`decompose-live.ts:108`, `decompose.ts:98,120`), so the research brief is silently discarded -- thread `context` end to end into the driver's `userText` (or remove it from the schema and the skill).

### S13. worker-browse dispatcher/schema prompt-field mismatch (hard error)

The shared `dispatcherPrompt` tells the `worker-browse` dispatcher to pass `prompt` (`src/lib/worker-dispatch.ts:236-237`), but the browse tool requires `task` and rejects unknown keys (`peer-mcp-personas.ts:1922,2325-2336`). A literal-following dispatcher sends `{prompt}` -> hard `isError` "arguments.task is required". Fix: make `dispatcherPrompt` name `task` for `mode === "browse"` (cleaner, keeps the surface minimal) or accept `prompt` as an alias in `runBrowseToolCall`; add a test asserting the browse dispatcher prompt names `task`.

## 4. Per-group verdict roll-up

| Group | Tool | Verdict | One-line top finding |
|---|---|---|---|
| artifact | artifact_await | Y | Stale capability comment names legacy `artifact_poll` (`personas.ts:736`) |
| artifact | artifact_dismiss | Y | Clean; sole note is an out-of-scope client retry-comment mismatch |
| artifact | artifact_end | Y | Add end-vs-dismiss contrast for the BYO-client path |
| artifact | artifact_open | N | [Critical] directive hardcodes `mcp__peers__`, drifts under a `peers` collision (S1/sec 2) |
| artifact | artifact_poll | Y | Waiting `next_step` re-anchors on the deprecated tool instead of `artifact_await` |
| artifact | artifact_refresh | Y | CLAUDE.md directive conflates refresh (reload) with update (change content) |
| artifact | artifact_reply | Y | Untyped `...response` spread can leak server diagnostics (S9) |
| artifact | artifact_update | Y | Project success payload to `{ok, next_step}` (S9) |
| browser | act | N | INTENT mode needs a compressor but is `browser`-gated -> raw throw (S2) |
| browser | close_tab | Y | powerNote lists 9 of 13 power tools, drops close_tab/list_tabs/wait/download |
| browser | diagnostics | Y | Document `total`/`returned` so a `limit`-truncated result is legible |
| browser | download | N | Extension 60s internal wait undercuts advertised 300s `maxMs` (`background.js:1649`) |
| browser | drag | Y | Root CLAUDE.md:147 drift -- drag is `--power-browse`, not `--browse` (S1) |
| browser | eval_js | Y | "Max 100 KB" asserted but unenforced; chrome://extensions reachable via eval_js (S10) |
| browser | extract | Y | Awareness snippet advertises `__extract` on the wrong gate (S2) |
| browser | find | Y | Default `--browse` returns no ref, so `act` REF mode is unreachable (S1/S2) |
| browser | keyboard | Y | "single characters" competes with `browser_type`; add when-NOT signal |
| browser | list_tabs | Y | Missing from powerNote though it is the id-provider for the suite |
| browser | mouse | Y | Root CLAUDE.md:147 flat-19 framing vs the `browser_power` sub-gate (S1) |
| browser | navigate | Y | Inherited `open_tab` policy omits file:// + extension-page blocks |
| browser | observe | Y | Awareness snippet names `__observe` on a gate that can drop it (S2) |
| browser | open_tab | Y | "HTTP status" mislabels a synthetic load-complete flag (200/0) |
| browser | read_page | Y | Description cites legacy extractor caps, not the default CDP path (~500/32KiB) |
| browser | screenshot | Y | Add observe-vs-screenshot routing; note it also accepts JPEG + activates the tab |
| browser | scroll | Y | Root CLAUDE.md:147 `--power-browse` tier drift (S1) |
| browser | type | N | Description routes to removed `browser_fill` -> -32601 (S6) |
| browser | wait | Y | Root CLAUDE.md:147 lists `wait` as `--browse`; it is `--power-browse` (S1) |
| decide | stand_in | Y | Optional: qualify the "~6KB cap" as JSON-path-only |
| first-mate | abandon_mission | N | Description hides that abandon is local-only; PRs + cloud agents stay live (S8) |
| first-mate | add_units | Y | Note invalid `dependsOn` is silently dropped, same-batch indices only |
| first-mate | advance | Y | Malformed `review_plan` verdict is a silent no-op; expose per-kind verdict schema |
| first-mate | board | Y | No when-not clause vs `advance` (observe vs drive-state) (S8) |
| first-mate | close_pr | Y | "active mission repo" looser than the unit-correlation ownership test (S8) |
| first-mate | mark_ready | Y | Same ownership overstatement; note OPEN-only + alreadyReady no-op (S8) |
| first-mate | merge_pr | N | Irreversible + docs advertise an approval gate the tool never calls (S8) |
| first-mate | mission_status | Y | Near-duplicate of `board` with no differentiator (S8) |
| first-mate | scaffold_repo | Y | `detection_overrides` untyped `anyProp` vs `.strict()` validator (S10) |
| first-mate | start_mission | Y | Design doc omits `plan_gate`/`ci_required`; skill clause nested under worker gate |
| fleet | await_turn | Y | Fold send->await_turn pattern + reliable/flicker contract into the description (S7) |
| fleet | create_session | N | Description omits `agent` enum + load-bearing `start:true` (S7) |
| fleet | drive_task | Y | Add a `fleet` awareness clause so the composite beats the primitives (S7) |
| fleet | git_show | Y | `ref`/`rev`/`commit` triple + pass-through-all-args defeats the closed schema (S10) |
| fleet | list_dir | Y | Add a when-to-use/read-only clause (description is the only signal) (S7) |
| fleet | list_instances | Y | Name the `fleet` group in `buildPeerAwarenessSnippet` (S7) |
| fleet | list_sessions | Y | Give the `fleet` group one gated system-prompt sentence (S7) |
| fleet | read_file | N | Description omits unsanitized, out-of-sandbox remote read (S7) |
| fleet | read_session | Y | Inert `format` schema field -- drop until it does something (S10) |
| fleet | respond | N | `delivered:false` returned as success; sibling `send_message` raises isError (S7) |
| fleet | search | N | Name collides with `mcp__search__*`; no remote-vs-local disambiguator (S7) |
| fleet | send_keys | Y | Add when-NOT clause vs `send_message`/`respond` (S7) |
| fleet | send_message | Y | Stale "LOUD isError on unconfirmed delivery" in `aiordie-fleet.md:64` |
| fleet | session_status | Y | Name the returned status fields; steer completion queries to `await_turn` |
| fleet | stop_session | N | Destructive/irreversible, four-word description, no interrupt pointer (S7) |
| orchestrate | attest_step | Y | Propagate the completeness-not-security caveat into the awareness snippet |
| orchestrate | decompose | N | `context` accepted + skill-fed but severed at three call sites (S12) |
| orchestrate | run_workflow | Y | Return-shape summary omits the 4-status + `{ok:false,error}` union |
| orchestrate | verify_workflow | Y | `ok:true` without `knownGateIds` waves through a gateId run_workflow rejects (S12) |
| peers | codex_critic | Y | Two em dashes vs the session's own style directive (Suggestion) |
| peers | codex_implementer | N | Documented as a peers HTTP tool; really a stdio-only subagent -> 404 (S6) |
| peers | codex_reviewer | Y | "~16s" is a `high` latency but the tool defaults to `xhigh` |
| peers | gemini_critic | Y | Only critic missing a when-NOT redirect to line-level review |
| peers | gemini_reviewer | Y | Absent from `docs/peer-mcp-design.md` entirely (S11) |
| peers | opus_critic | Y | Prefers Opus 5 native 1M; 4.6-1m → 4.6 fallback; high default, xhigh allowed (S4) |
| search | code | Y | Clean; record that `context_lines` is an intentional omission |
| search | web | Y | Error strings still say `web_search`, not the renamed `web` (S6) |
| workers | browse | Y | `gpt-5.6-luna`/high; dispatcher field mismatch tracked in S13 |
| workers | explore | Y | `gpt-5.6-luna`/high; free-string 1M override ladder documented (S5) |
| workers | implement | Y | No when-to-prefer clause vs `implementer` subagent + `codex_implementer` (S6) |
| workers | plan | Y | `claude-opus-5`/high; higher effort remains caller-selectable (S3/S5) |
| workers | review | N | Description says `gpt-5.5`; actual `gemini-3.1-pro-preview` (S5) |
| workers | test | Y | Root CLAUDE.md:133 says "three worker tools"; there are five (S11) |

## 5. Recommended fix batches

Ordered by leverage. Model-facing behavior fixes first (misroutes, `-32601`, wrong defaults, hard errors), then documentation-only drift.

### A. Model-facing behavior fixes (misroutes, errors, wrong defaults)

- [ ] A1 -- Critical, conditional (S1/sec 2). `src/lib/claude-md-injection.ts:48-53` + `src/claude.ts:807-811`: thread the resolved `peersKey` into `ARTIFACT_PANEL_DIRECTIVE`; build `mcp__<peersKey>__artifact_*` dynamically. Update `tests/isolated/claude-md-injection.test.ts:623` to assert the resolved-key path.
- [ ] A2 (S6). `src/lib/browser-mcp/index.ts:466`: repoint `browser type`'s description from `browser_fill` to `browser_act` with `action:"fill"` (removes a `-32601`).
- [ ] A3 (S13). `src/lib/worker-dispatch.ts:236-237`: make `dispatcherPrompt` name `task` (not `prompt`) for `mode === "browse"`; add a test. Removes a hard `isError` on a literal-following `worker-browse` dispatch.
- [x] A4 (S5). Worker model descriptions now match the live defaults: review `gemini-3.1-pro-preview`, explore `gpt-5.6-luna`/high, plan `claude-opus-5`/high, implement/test `gpt-5.6-sol`/high, and browse `gpt-5.6-luna`/high.
- [x] A5 (S3). Worker thinking descriptions reflect each mode's effective default and clamp behavior.
- [x] A6 (S4). opus_critic now prefers Opus 5, exposes xhigh, and documents the 4.6 fallback chain.
- [ ] A7 (S2). Thread `compoundBrowseAvailable` (= `browserCompoundToolsEnabled()`) into `buildPeerAwarenessSnippet` (`src/claude.ts:1024`); gate the `__act` INTENT / `__observe` / `__extract` clauses on it. Also gate `act` INTENT behind `browserCompoundToolsEnabled()` (or return a clean isError) in `src/lib/browser-mcp/index.ts:622` so it cannot raw-throw.
- [ ] A8 (S12). `verify_workflow` handler: default `knownGateIds` to `sealedGateIds()` when omitted (keep the arg as override). `decompose`: thread `context` end to end into the driver `userText` (`decompose-live.ts:108`, `decompose.ts:98,120`) -- or remove it from the schema and the `/gh-orchestrate` skill.
- [ ] A9 (S8). `merge_pr` description (`tools.ts:428`): state the merge is immediate/irreversible and relies on head+ownership+CI plus out-of-band human authorization (the tool does not call `verifyAndConsumeApproval`); reword "CI green" for CI-less repos. `abandon_mission` (`tools.ts:610`): add the local-ledger-only boundary. Replace "active first-mate mission repo" -> "correlated to a first-mate unit, else requires allow_unowned" on `tools.ts:428,489,534`.
- [ ] A10 (S7). Harden fleet descriptions: `search` remote-vs-local disambiguator (`tools.ts:749`); `stop_session` irreversibility + `send_keys op:"interrupt"` pointer (`:589`); `create_session` `agent` enum + `start:true` (`:538,541`); `read_file` sandbox-boundary clause (`:723`); `respond` set `isError` on `delivered:false` (`:529`, mirror `send_message:438`).
- [ ] A11. `first-mate advance` (`controller.ts:878-930`): surface a per-kind `verdict_schema` hint (or enumerate shapes in the `verdict` field, `tools.ts:337-341`) and stop silently dropping unknown-shaped verdicts. `run_workflow` (`personas.ts:1764-1765`): expand the return-shape summary to the four statuses + `{ok:false,error}` branch.

### B. Schema-honesty fixes (S9, S10)

- [ ] B1. Enforce or delete asserted size caps: url "Max 8 KB" (`index.ts:101,150,349`), eval_js "Max 100 KB" (`:319-322`).
- [ ] B2. Drop the inert fleet `read_session` `format` field (`tools.ts:340`); type `scaffold_repo` `detection_overrides` as a real object schema (`tools.ts:276`) matching `ScaffoldDetectionOverridesSchema`.
- [ ] B3. `git_show` (`tools.ts:771-777`): collapse `ref`/`rev`/`commit` to one `ref`; pluck declared fields explicitly instead of spreading `args`.
- [ ] B4. Project untyped `...response` spreads to minimal envelopes: artifact `update`/`reply`/`refresh`/`dismiss`/`end` (`tools.ts:99-104,163-164`); fleet `send_keys` (`tools.ts:505`, drop `keysId`).

### C. Documentation-only drift

- [ ] C1 (S1). Root `CLAUDE.md:147`: rewrite the browser paragraph to the two-tier split (6 lead `--browse` tools; 13 `browser_power` primitives behind `--power-browse`), mirroring `docs/browser-mcp-design.md:371-373`. Closes about ten browser findings.
- [ ] C2 (S6/S11). Root `CLAUDE.md:129` + `docs/peer-mcp-design.md:12`: reword `codex_implementer` to a stdio-routed `codex-implementer` subagent (not a peers HTTP tool).
- [ ] C3 (S11). `docs/peer-mcp-design.md`: add gemini_reviewer where still missing (persona list, cap table, minimal-surface enum) and fix any stale persona counts. The worker-default and Opus model rows are now current. `docs/agent-orchestration-design.md`: rename stale orchestration rows `mcp__workers__*` -> `mcp__orchestrate__*`.
- [ ] C4 (S7/S8). Root CLAUDE.md: add `abandon_mission` + `add_units` to the first-mate inventory (`:139`); add a "Fleet session-control MCP (`--fleet`)" section + a Design-docs index entry for `docs/aiordie-fleet.md`. `CLAUDE.md:133`: "three worker tools" -> "five" (add `plan`, `test`); note `implement`/`test` both accept `worktree`.
- [ ] C5. `docs/first-mate-design.md`: add `plan_gate`/`ci_required` to the `start_mission` bullet (`:26-28`), and explicit `merge_pr`/`close_pr` entries (`:26-44`); scope the `verifyAndConsumeApproval` claim (`:388-396`) to the controller path. `docs/aiordie-fleet.md:64`: fix the stale "LOUD isError on unconfirmed delivery" line; add `drive_task` to the inventory (`:62-67`).
- [ ] C6. Low-priority description polish (each a Suggestion in its doc): add when-NOT redirects (`gemini_critic` line-level review; `board`/`advance`; `implement` vs `implementer` subagent; `screenshot` vs `observe`); qualify `codex_reviewer` "~16s" as a `high` latency; align `web` error strings (`personas.ts:824,840`) to the renamed `web`; refresh the `artifact_await` capability comment (`personas.ts:736`).
