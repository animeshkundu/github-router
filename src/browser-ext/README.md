# github-router browser bridge — Chrome / Edge extension (MV3)

Phase 1 scaffold for the browser-control MCP. This dir holds the MV3
extension source that runs inside the user's Chrome / Edge browser,
talks to the local bridge process (`src/browser-bridge/`) over native
messaging, and dispatches `browser_*` tool calls from Claude to the
right Chrome API.

## Layout

- `manifest.json` — MV3 manifest. Fixed `key` field pins the extension
  ID across Load-Unpacked and Web Store installs (so the NMH manifest's
  `allowed_origins` matches in both modes). Permissions are the minimal
  set needed by the 15 planned tools.
- `background.ts` — service worker. Connects to the NMH bridge on
  install / startup; dispatches `{id, tool, args}` frames against a
  `TOOL_HANDLERS` table. Phase 1 ships only `__ping__` (liveness);
  Phase 4 adds the 15 real handlers.

## Status

- ✅ Manifest in place; stable extension key embedded.
- ✅ Background service worker scaffold compiles, connects, dispatches.
- ⏳ Tool handlers (Phase 4) — 15 tools per the approved plan.
- ⏳ Navigation-block listener (Phase 5).
- ⏳ Build pipeline — currently excluded from main `tsconfig.json` /
  `tsdown` because the extension is browser-platform (DOM + chrome.*
  globals), not Node-platform. Phase 3 wires a separate esbuild step
  with its own per-dir `tsconfig` + `@types/chrome` dep.
- ⏳ Icons — manifest currently has no `icons` / `action` block to
  avoid Chrome Load-Unpacked warnings about missing PNGs. Phase 6 adds
  proper icons.

## How it will install (Phase 3+)

1. `github-router claude --browse` flips the capability gate.
2. On launch the proxy materializes the extension into a stable app dir
   (`<APP_DIR>/browser-ext/`, i.e. `~/.local/share/github-router/browser-ext/`
   on POSIX, `%LOCALAPPDATA%\github-router\browser-ext\` on Windows) and
   stamps the running version into its `manifest.json`. The first
   `browser_*` tool call's pre-flight writes the NMH manifest JSON +
   (Windows) registry key pointing at the bundled bridge launcher.
3. Dispatcher returns `install_required` with `load_unpacked_dir` set to
   that stable `<APP_DIR>/browser-ext/` path for the user / model to Load
   Unpacked.
4. User loads the extension → it auto-connects to the bridge → the
   next tool call succeeds. Because the stable path never changes across
   npx/bunx upgrades, that one-time Load Unpacked stays valid and later
   upgrades reload transparently (version-mismatch → `chrome.runtime.reload()`).

## Manifest key (stable extension ID)

The `key` field is the base64-encoded DER of an RSA-2048 public key
generated for this project. Chrome derives the extension ID
deterministically from this key, so the ID is the same whether the
user installs via Load Unpacked or via the Web Store (when we
publish — Phase 6). The corresponding private key is NOT in this
repo — it's only needed by the Chrome Web Store publishing flow.

## See also

- `src/browser-bridge/` — the Node NMH host this extension talks to.
- `src/lib/browser-mcp/` — the github-router-side dispatcher / gate.
- The approved plan in
  `~/.local/share/github-router/claude-config/.../plans/we-want-to-create-tidy-minsky.md`.
