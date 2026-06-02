# Browser-control MCP (`--browse`)

The `--browse` flag adds a `browser_*` tool suite to the github-router `/mcp` endpoint. When a model calls one of these tools, the proxy routes the request through a local bridge process to a Chrome / Edge extension running in the user's browser. The extension then drives Chrome's tab, scripting, debugger, and downloads APIs and returns the result back up the chain.

Quick links: the entry point for changes is [`src/lib/browser-mcp/`](../src/lib/browser-mcp/). The extension lives in [`src/browser-ext/`](../src/browser-ext/) and the native-messaging host lives in [`src/browser-bridge/`](../src/browser-bridge/).

## High-level architecture

```
+-------------------------+       JSON-RPC over HTTP/SSE        +----------------------------+
|  Claude (or any MCP     | <---------------------------------> |  github-router /mcp        |
|  client)                |   tools/list, tools/call            |  (handler.ts)              |
+-------------------------+                                      +-------------+--------------+
                                                                               |
                                                                               | in-proc fn call
                                                                               v
                                                                 +----------------------------+
                                                                 |  src/lib/browser-mcp/      |
                                                                 |  - install-check           |
                                                                 |  - native-host-installer   |
                                                                 |  - policy (URL block)      |
                                                                 |  - dispatch (WS client)    |
                                                                 +-------------+--------------+
                                                                               |
                                                                               | localhost WebSocket
                                                                               | (bearer-token auth)
                                                                               v
                                                                 +----------------------------+
                                                                 |  Bridge process            |
                                                                 |  src/browser-bridge/       |
                                                                 |  Spawned by the browser    |
                                                                 |  when the extension calls  |
                                                                 |  connectNative.            |
                                                                 +-------------+--------------+
                                                                               | native messaging
                                                                               | stdio (length-prefixed
                                                                               | JSON)
                                                                               v
                                                                 +----------------------------+
                                                                 |  Browser extension         |
                                                                 |  src/browser-ext/          |
                                                                 |  MV3 service worker;       |
                                                                 |  TOOL_HANDLERS dispatches  |
                                                                 |  to chrome.* APIs.         |
                                                                 +-------------+--------------+
                                                                               |
                                                                               v
                                                                 +----------------------------+
                                                                 |  Browser instance          |
                                                                 |  (Chrome or Edge)          |
                                                                 +----------------------------+
```

The wire schema is the same on both legs (bridge ↔ extension and dispatcher ↔ bridge) so the bridge just forwards frames:

```
request:  { id: string, tool: string, args: Record<string, unknown> }
response: { id: string, ok: true,  data: unknown }
       or { id: string, ok: false, error: string, code?: string }
```

## Capability gate

The browser tools default to OFF. They appear in `tools/list` and accept `tools/call` only when BOTH:

1. The operator opted in (the `--browse` flag on `github-router start` / `claude` / `codex`, OR the `GH_ROUTER_ENABLE_BROWSE=1` env var).
2. At least one supported Chromium-family browser (Chrome or Edge) is detected on disk by `hasSupportedBrowserInstalled()`.

The gate lives at `src/routes/mcp/handler.ts:browserToolsEnabled` and fires symmetrically at both list-time and call-time, mirroring the pattern used by `workerToolsEnabled()` and `standInToolEnabled()` so a client that hardcodes a tool name still gets a -32601 method-not-found.

## Tool surface (19 tools)

Ruthlessly minimal per [`peer-mcp-design.md`](peer-mcp-design.md) "Design principle: ruthlessly minimal MCP tool surface" — every field is required to call the tool, model-tunable in a way that improves outcomes, or directly actionable feedback.

| Tool | Purpose |
| --- | --- |
| `browser_list_tabs` | Enumerate open tabs across all windows. |
| `browser_open_tab` | Open a new tab at a URL and wait for load. |
| `browser_close_tab` | Close one or more tabs. |
| `browser_navigate` | Goto / back / forward / reload an existing tab. |
| `browser_read_page` | Extract rendered text, interactive-element refs + CSS-px bboxes, and viewport metadata `{width, height, devicePixelRatio, scrollX, scrollY}`. |
| `browser_click` | Click an element by ref or selector (synthetic `.click()` — fast path); reports whether navigation followed. |
| `browser_fill` | Type into input / textarea, select option, toggle checkbox / radio (native-setter — fast path). |
| `browser_scroll` | Scroll to top / bottom / by pixels / to a referenced element / wheel at a pointer location (`at-pointer` mode for sub-region scroll). |
| `browser_screenshot` | Capture a base64 PNG of the visible tab area. |
| `browser_keyboard` | Send a chord (Control+L, etc) via CDP `Input.dispatchKeyEvent`. |
| `browser_wait` | Wait for selector / URL regex match / network-idle heuristic. |
| `browser_eval_js` | Evaluate a JS expression in the page's main world (CDP `Runtime.evaluate`). |
| `browser_download` | Trigger a download by URL and wait for completion. |
| `browser_console_logs` | Drain captured console messages since the last call. |
| `browser_network_log` | Drain captured network responses since the last call. |
| `browser_mouse` | Move / click / dblclick / down / up via real CDP `Input.dispatchMouseEvent`. Target via ref, selector, or (x, y). Hover-to-reveal menus, canvas clicks, trusted events. |
| `browser_drag` | Drag from→to. Auto-detects HTML5 native DnD (`draggable="true"` → `Input.setInterceptDrags` + `Input.dispatchDragEvent`) vs pointer DnD (CDP mouse events with `buttons:1` held throughout — for react-dnd / Sortable.js). |
| `browser_type` | Type a string per-keystroke via CDP `Input.dispatchKeyEvent` — fires keydown + keypress + input for search-as-you-type / autocomplete / chip inputs. |
| `browser_locate` | Resolve a single ref or selector to bbox + center + hit-test metadata (`topmostAtCenter`, `pointerEvents`, `visible`, `inView`) without a full page snapshot. |

Element refs returned by `browser_read_page` are intended as the primary input to follow-up `browser_click` / `browser_fill` / `browser_scroll` / `browser_mouse` / `browser_drag` calls. Refs are more robust than CSS selectors against dynamic class names and the model can read them straight out of the page snapshot.

### Humanlike-input design notes (v2)

The `browser_mouse` / `browser_drag` / `browser_type` / `browser_locate` set gives the model real input events the page can't distinguish from a human's, on top of the synthetic-event fast paths (`browser_click` / `browser_fill`). Choose by need: ref-and-go forms → fast path; hover menus / drag / canvas / sites that gate on `event.isTrusted` → CDP path.

Several design constraints are load-bearing:

1. **No cursor-position state.** Every action takes an explicit target (ref, selector, or coordinates). MV3 service-worker termination between LLM tool calls would silently wipe a per-tab `Map<tabId,{x,y}>` cache, leaving a `move` then `down` sequence in an undefined state. Explicit-target-every-call is the robust choice.
2. **Hit-test by default.** When the target is a ref or selector, `browser_mouse` / `browser_drag` / `browser_scroll(at-pointer)` resolve to bbox center AND run `document.elementFromPoint(cx, cy)` in the same in-page script. If the topmost element isn't the target or a descendant, the call fails with `target_obscured: topmost is <tag#id>` so the model gets actionable feedback instead of clicking through an overlay. Pass `force: true` to bypass when an overlay intentionally forwards events.
3. **Per-tab input mutex.** CDP mouse state is global per attachment; two parallel `browser_mouse` / `browser_drag` calls on the same tab would interleave and corrupt each other (one call's `mouseMoved` would land mid-drag of another). The global `MAX_INFLIGHT_TOOLS_CALL=8` cap doesn't help — it's process-wide, not per-tab. `withTabInputLock(tabId, fn)` serialises mouse / drag / type / keyboard / scroll(at-pointer) on the same tab.
4. **Drag mode auto-detect.** Native HTML5 DnD (`draggable="true"` elements) CANNOT be triggered by raw CDP mouse events — Chromium's `dragstart` pipeline is gated behind OS-level drag detection. The `html5` path uses `Input.setInterceptDrags(true)` to capture the `DragData` payload from the `Input.dragIntercepted` event, then dispatches `dragEnter` / `dragOver` / `drop` to the destination. The `pointer` path holds the button (`buttons: buttonBits`) across all intermediate `mouseMoved` events so pointer-event drag handlers (react-dnd, Sortable.js) don't abort. `auto` picks based on the source's `el.draggable` attribute; result includes `mode_used` so the caller can verify which path ran.
5. **`browser_type` typing recipe.** Each character is `keyDown{key, code, text, windowsVirtualKeyCode}` then `keyUp{key, code, windowsVirtualKeyCode}`. `keyDown` with `text` fires `keydown` + `keypress` + `input` together; we deliberately do NOT send a separate `char` event between them — that would double-fire `keypress` / `input` on most sites. Special chars: `\n` → Enter, `\t` → Tab, `\b` → Backspace (dispatched as the named key, no `text` field — else the page receives a literal control character). Other control chars (< 0x20) are rejected up front with an actionable error directing the model to `browser_keyboard`. Iteration is `for (const ch of text)` (Unicode code points), not `text.split("")` (which would split surrogate pairs).
6. **`attachDebuggerOnce` hardening.** Wrapped in `navigator.locks.request("browser-mcp:debugger-attach:" + tabId, ...)` to serialise concurrent attach attempts after MV3 SW respawn (when the in-memory `attachedTabs` Set is wiped but Chrome may have kept the underlying CDP attachment alive). On `"Another debugger is already attached"`, the code catches and trusts the existing attachment.
7. **`browser_read_page` viewport block.** Additive — existing consumers untouched. `{width, height, devicePixelRatio, scrollX, scrollY}` lets the model map a CSS-px `bbox` to a device-px pixel in `browser_screenshot` (`device_px = css_px * devicePixelRatio`).

### Numeric bounds (humanlike-input v2)

Bounds prevent the model from starving its own inflight slot with an absurd parameter combination:

| Field | Min | Max | Default |
| --- | --- | --- | --- |
| `steps` (mouse / drag) | 1 | 100 | 1 (mouse), 15 (drag) |
| `stepDelayMs` (mouse / drag) | 0 | 50 | 8 (mouse), 12 (drag) |
| `delayMs` (type) | 0 | 50 | 0 |
| `text` length (type) | 0 | 4096 | — |
| `deltaX` / `deltaY` (scroll at-pointer) | -10000 | 10000 | 0 (at least one must be non-zero) |

### What's deliberately out of scope

- File upload via CDP `DOM.setFileInputFiles` — sized as a separate follow-up.
- Cross-frame mouse trajectories — CDP mouse events target the top-level page only.
- Bezier-curve / jitter for bot-detection evasion — linear `steps` is "human-like" without crossing into evasion territory.
- Multi-touch / `Input.dispatchTouchEvent`.
- IME composition (`Input.imeSetComposition`) — `browser_type` rejects pre-composed IME input upfront rather than silently mangling.
- Migrating `browser_click` / `browser_fill` to CDP — the synthetic-event fast path is what works for React-controlled inputs in 99% of cases; the new tools are the escape hatch.

## Install detection and prompt-to-install

Every browser tool runs a pre-flight `ensureBridgeReady()` (in [`src/lib/browser-mcp/install-check.ts`](../src/lib/browser-mcp/install-check.ts)) before forwarding to the bridge. The pre-flight checks (in cost order):

1. Is a supported browser installed? → returns `install_required {reason: "no_supported_browser"}` if not.
2. Does the bridge bundle exist on disk? → returns `install_required {reason: "bridge_bundle_missing"}` if not (run `bun run build`).
3. Auto-install the NMH manifest for every detected browser (file write on POSIX, registry write + JSON file on Windows). This is cheap and idempotent.
4. Read the bridge's discovery file at `<APP_DIR>/browser-mcp/bridge.json` and probe its `/health` endpoint with the file's bearer token. Returns `install_required {reason: "bridge_not_running"}` if the file's absent or the probe fails.
5. Check `health.extension_connected`. Returns `install_required {reason: "extension_not_loaded"}` if no extension is currently attached.

The structured `install_required` response is returned as a JSON text block with `isError: true` so the model treats it as actionable failure (not a normal success). The payload includes a `load_unpacked_dir` path pointing at the bundled extension under `src/browser-ext/` so the model or user can complete the install by enabling Developer Mode in chrome://extensions and clicking "Load unpacked".

The pre-flight fires BEFORE any inflight-slot acquisition, preserving the same load-bearing invariant called out in CLAUDE.md for `predictedTooLong`.

### Native-messaging host paths

The NMH installer writes manifests to every plausible per-product directory so the extension can find them regardless of which Chrome / Edge / Chromium variant the user installed. On POSIX it's a JSON file; on Windows it's a JSON file plus an HKCU registry value pointing at the JSON file's path.

| OS | Browser | Location |
| --- | --- | --- |
| Windows | Chrome | `HKCU\Software\Google\Chrome\NativeMessagingHosts\com.githubrouter.browser` → REG_SZ pointing to a manifest JSON under `%LOCALAPPDATA%\github-router\browser-mcp\` |
| Windows | Edge | `HKCU\Software\Microsoft\Edge\NativeMessagingHosts\com.githubrouter.browser` → same manifest payload, separate key |
| macOS | Chrome | `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.githubrouter.browser.json` |
| macOS | Edge | `~/Library/Application Support/Microsoft Edge/NativeMessagingHosts/com.githubrouter.browser.json` |
| Linux | Chrome | `~/.config/google-chrome/NativeMessagingHosts/com.githubrouter.browser.json` |
| Linux | Edge | `~/.config/microsoft-edge/NativeMessagingHosts/com.githubrouter.browser.json` |

Registry writes on Windows go through `reg.exe add ... /f` (no PowerShell, no admin — HKCU only). File modes on POSIX are 0o644 for the manifest and 0o755 for the launcher shim; Windows ignores the POSIX mode arg.

### Where the extension files come from

The extension is plain JSON + JS (no bundler needed), but it has to land under `dist/` so the npm tarball's `"files": ["dist"]` allowlist actually ships it. The `build` script does `tsdown && bun scripts/copy-browser-ext.ts`, so a published package looks like:

```
node_modules/@animeshkundu/github-router/
├── dist/
│   ├── main.js                       (the proxy)
│   ├── browser-bridge/index.js       (the native-messaging host, bundled with ws)
│   └── browser-ext/                  (Load Unpacked target)
│       ├── manifest.json
│       └── background.js
```

`extensionDir()` in [`src/lib/browser-mcp/native-host-installer.ts`](../src/lib/browser-mcp/native-host-installer.ts) prefers `dist/browser-ext/` (production), falls back to `src/browser-ext/` if dist hasn't been built (fresh clone), and can be overridden with `GH_ROUTER_BROWSER_EXT_DIR=<abs path>` for rapid extension iteration without rebuilding between edits.

### Stable extension ID

The extension's `manifest.json` carries a fixed RSA-2048 `key` field. Chrome and Edge derive the extension ID deterministically from this key (sha256 of the DER bytes, first 16 bytes mapped via the hex-value-to-[a-p] alphabet), so the ID is identical whether the user installs via the Chrome Web Store or via Developer Mode "Load unpacked". The same ID lands in the NMH manifest's `allowed_origins` so the extension's native-messaging connection works in both modes.

`computeExtensionIdFromKey()` in [`src/lib/browser-mcp/native-host-installer.ts`](../src/lib/browser-mcp/native-host-installer.ts) implements the derivation.

## Bridge runtime

The bridge is bundled as a single ESM file at `dist/browser-bridge/index.js` (via a second tsdown entry — see `tsdown.config.ts`). It's invoked by Chrome / Edge through a generated launcher shim (`.bat` on Windows, `.sh` on POSIX) the NMH manifest's `path` field points at. The shim wraps `node <bridgeJs>` — node is preferred over bun because bun's stdin handling closes the bridge prematurely on transient SW dormancy. The launcher's interpreter is resolved at install-check time via `which node` / `where node`, with `process.execPath` as the fallback.

The bridge writes a discovery file at `<APP_DIR>/browser-mcp/bridge.json` on boot with `{pid, port, token, startedAt}` so the github-router dispatcher can locate it. The localhost WebSocket binds to a random port on `127.0.0.1` only and requires the bearer token on every frame.

When the extension's service worker takes a nap (MV3 SW dormancy is normal between events), the native-messaging port disconnects and the bridge's stdin closes. The bridge does NOT exit on that signal because it would orphan an in-flight WS client; instead it schedules a 60-second idle exit and re-arms if a WS client is still connected. A new SW spin-up calls `connectNative` again, which spawns a fresh bridge — only one bridge is alive at a time per browser session.

## Navigation policy (defense in depth)

`chrome://settings`, `edge://settings`, `chrome://extensions`, `chrome://flags`, password / management / policy pages, and `chrome-extension://*/options.html` are blocked. `devtools://*` is explicitly allowed (the model can intentionally inspect the DevTools). `file://` is blocked by default; set `GH_ROUTER_BROWSER_ALLOW_FILE_URLS=1` to enable.

Two enforcement layers:

1. **Bridge layer** (authoritative for tool-initiated nav): `preflightUrlPolicy()` in [`src/lib/browser-mcp/policy.ts`](../src/lib/browser-mcp/policy.ts) checks the `url` argument of `browser_open_tab` / `browser_navigate` BEFORE forwarding to the bridge. On block, the dispatcher returns `{blocked: true, reason}` with `isError: true`.
2. **Extension `webNavigation` listener** (catches in-page-initiated nav, e.g. JS redirects, meta-refresh): `chrome.webNavigation.onBeforeNavigate` cancels the navigation by routing the tab back to `about:blank` and logs `[browser-bridge] policy_blocked: <url>` to the console so the next `browser_console_logs` drain surfaces the attempt.

The two layers share the same regex; they're written verbatim in two places (bridge `policy.ts` and extension `background.js`) so neither needs to do a network round-trip to know the policy. When you change one, change the other.

## Profile management

The default profile is whichever browser the user already has running. Chrome / Edge spawn the bridge per-user, so the extension runs against the user's real cookies and login state. This is the whole point of an extension-based approach vs CDP-based automation — the model can drive the user's actual Gmail / GitHub / etc. sessions.

`GH_ROUTER_BROWSER_PROFILE=user` is reserved for a future opt-in to force user-profile mode when an isolated launcher exists. v1 ships user-profile only.

## Concurrency and timeouts

Every browser tool acquires from the shared `MAX_INFLIGHT_TOOLS_CALL = 8` semaphore in `src/lib/mcp-inflight.ts`. A slow download holding a slot is acceptable backpressure; the cap exists to bound total fan-out across all `/mcp` tool calls (peer critics, worker tools, stand_in, browser tools all share it).

Per-tool default + hard-cap timeouts live in `pickTimeout()` at [`src/lib/browser-mcp/dispatch.ts`](../src/lib/browser-mcp/dispatch.ts). Callers can pass a per-call timeout up to the hard cap; the dispatcher clamps it.

## Audit log

Set `GH_ROUTER_LOG_BROWSER_MCP=1` to append one JSON line per tool call to `<APP_DIR>/browser-mcp/audit.log`. Each line carries the tool name, arg byte size, duration, profile mode, and result code (`ok` / `bridge_error` / `exception`). Useful for "what did the model click on" post-hoc forensics. Off by default to avoid noisy default state; matches the `GH_ROUTER_LOG_PEER_MCP` convention.

## Testing

Two suites cover the browser tools:

1. **Gate / policy / unit tests** (always-on under `bun test`):
   - `tests/browser-mcp-gate.test.ts` validates the `--browse` opt-in, the env-var equivalent, the defense-in-depth -32601, and the install_required response shape.
   - `tests/browser-mcp-policy.test.ts` validates every blocked URL pattern and the allow-list.

2. **End-to-end suite** (opt-in via `GH_ROUTER_RUN_BROWSER_E2E=1`):
   - `tests/isolated/browser-mcp-e2e.test.ts` launches Playwright's Chrome for Testing with the extension loaded, installs the NMH manifest into `<userDataDir>/NativeMessagingHosts/` (Chrome for Testing only reads from there, not the system dirs), and exercises all 15 tools against a local fixture server.
   - Gated on the env var so it doesn't clash with tests elsewhere in the suite that mock `os.homedir()`.

To run the E2E suite locally:

```bash
bunx playwright install chromium      # one-time
bun run build                         # bundles the bridge
GH_ROUTER_RUN_BROWSER_E2E=1 bun test tests/isolated/browser-mcp-e2e.test.ts --timeout 90000
```

## Known gotchas (the ones that bit me building this)

1. **`computeExtensionIdFromKey` is not "char + 49"**. The Chrome algorithm maps the hex VALUE (0..15) to a letter (a..p), not the hex character code. The off-by-one bug silently produced a 23-char ID that didn't match Chrome's runtime ID, which caused `connectNative` to fail with "Specified native messaging host not found".

2. **Chrome for Testing uses `<userDataDir>/NativeMessagingHosts/`**, not the system-wide `~/Library/Application Support/.../NativeMessagingHosts/`. The system dirs are correct for the user's real Chrome / Edge install, but Playwright's binary is branded "Google Chrome for Testing" and ignores them.

3. **Bun closes the bridge's stdin prematurely**. The bridge processes binary-stdin frames from Chrome's native messaging; bun does something with stdin that causes the bridge to exit immediately. The launcher prefers `node` and falls back to `process.execPath` only when no node is on PATH.

4. **MV3 service workers go dormant between events**. The bridge's native-messaging port disconnects whenever the SW dies; if the bridge exited on stdin-close, the next SW spin-up would spawn a second bridge process while a WS client is still connected to the first. The bridge stays alive for a 60-second grace window after stdin close, exiting only when no WS clients remain.

5. **`chrome.scripting.executeScript` args must be JSON-serializable**. `undefined` throws "Value is unserializable". Coerce optional args to `null` before passing them to the func.

6. **`webNavigation.onBeforeNavigate` doesn't have a cancel API in MV3**. The "block" is implemented as "let the navigation start, then immediately update the tab to about:blank". This is a slightly racy fallback for in-page-initiated navs; the bridge-layer policy check is the precise enforcement for tool-initiated nav.

7. **`browser_screenshot` requires a real OS rendering surface**. Both `chrome.tabs.captureVisibleTab` and CDP `Page.captureScreenshot` read from the compositor's surface. Chrome-for-Testing launched in plain headed mode without `--headless=new` does NOT have a surface and either call hangs indefinitely (no error, no timeout — just blocks). Real Chrome with a visible window has a surface and works fine. The Playwright E2E harness passes `--headless=new` precisely for this reason. If you're driving Chrome-for-Testing programmatically and need screenshots, add `--headless=new` to its argv.

8. **`browser_type` `windowsVirtualKeyCode` derivation only works for ASCII letters and digits**. `'A'.charCodeAt(0) === 65 === VK_A` and `'5'.charCodeAt(0) === 53 === VK_5` happen to match Windows virtual-key codes, but for every printable non-alphanumeric the charCode collides with an unrelated VK: `'.'.charCodeAt(0) === 46 === VK_DELETE`, `','.charCodeAt(0) === 44 === VK_SEPARATOR`, `'-'.charCodeAt(0) === 45 === VK_INSERT`. The first version of `browser_type` derived `vkc = ch.toUpperCase().charCodeAt(0)` for every char and Chromium silently suppressed text insertion when it saw a keyDown with `vk=DELETE` etc. The fix: gate the derivation behind `/^[a-zA-Z0-9]$/.test(ch)`, else pass `windowsVirtualKeyCode: 0` and let CDP infer event semantics from `key` + `text`. Caught only by typing punctuation against a real input — the E2E suite's letters-only tests all passed silently.

9. **Per-tab input mutex needs a wall-clock release cap**. `withTabInputLock(tabId, fn)` is a Promise-tail-chain mutex. If `fn()` hangs longer than the dispatcher's per-tool WS-side timeout, the dispatcher returns failure to the caller BUT the in-extension fn() keeps awaiting the CDP response. The lock is never released and every subsequent input call on that tabId hangs forever (CDP commands don't abort when the originating WS disconnects). Mitigation: `Promise.race(fn(), timeoutAfter(240_000))` inside the lock — if held > 240s, force-release the queue and emit a console.warn. The wedged CDP call's response is discarded when it eventually arrives.

## See also

- [`peer-mcp-design.md`](peer-mcp-design.md) — the broader MCP design philosophy this builds on (the ruthlessly-minimal tool surface rule, the inflight slot model, the dormant-register pattern).
- [`unsupported-features.md`](unsupported-features.md) — for the list of Anthropic surfaces github-router can't proxy through to Copilot. Browser tools are NOT an Anthropic surface — they're a github-router extension that any MCP client can call.
- [`auth-isolation.md`](auth-isolation.md) — for how the proxy isolates auth from the spawned child env. The bridge launcher inherits the browser's env, not the proxy's, so no auth tokens leak into it.
