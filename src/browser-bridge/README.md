# github-router browser bridge — native messaging host (Node)

Phase 1 scaffold for the browser-control MCP. This dir holds the Node
script that runs as Chrome's / Edge's native-messaging host: spawned by
the browser when the extension calls `chrome.runtime.connectNative`,
exchanges length-prefixed JSON frames over stdio with the extension,
and exposes a localhost WebSocket so the github-router proxy can
dispatch tool calls into the browser.

## Layout

- `index.ts` — bridge entrypoint. Native-messaging stdio framing,
  HTTP `/health` endpoint, WebSocket server, in-flight request table
  with bearer-token auth + WS heartbeats.

## How it gets invoked

1. User loads the extension (manually via Load Unpacked, or via the
   Web Store once we publish — Phase 6).
2. Extension's background.ts calls `connectNative("com.githubrouter.browser")`.
3. Chrome / Edge reads the NMH manifest at one of:
   - Windows: `HKCU\Software\Google\Chrome\NativeMessagingHosts\com.githubrouter.browser` (Edge: `\Microsoft\Edge\...`)
   - macOS: `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.githubrouter.browser.json`
   - Linux: `~/.config/google-chrome/NativeMessagingHosts/com.githubrouter.browser.json`
4. The `path` field in that manifest points at this bridge's launcher
   script (`.bat` on Windows, `.sh` on POSIX). The launcher invokes
   `node <abs path to dist/browser-bridge.js>`.
5. Bridge writes its random port + bearer token to
   `<APP_DIR>/browser-mcp/bridge.json` (mode 0o600 on POSIX).
6. github-router's dispatcher reads `bridge.json`, opens the WS, sends
   `{id, tool, args}` frames; the bridge forwards each to the
   extension over native messaging stdio.

## Wire protocol

Identical on both sides (no translation in the bridge):

```
request:  { id: string, tool: string, args: Record<string, unknown> }
response: { id: string, ok: true,  data: unknown }
       or { id: string, ok: false, error: string, code?: string }
```

Heartbeats: WS ping/pong every 5s, 3 misses → terminate. Plus an
application-layer `{type: "__heartbeat__", id}` for proxies / wrappers
that swallow control frames.

## Status

- ✅ Stdio framing (4-byte LE length prefix + JSON body).
- ✅ HTTP `/health` + WebSocket server, bearer-token auth, random
  loopback port.
- ✅ Discovery file `bridge.json` with PID + port + token.
- ✅ In-flight pending-request table; per-WS-client cleanup on close.
- ⏳ Build pipeline (Phase 3) — separate esbuild step bundling this
  + its `ws` dep into a single `dist/browser-bridge.js` so the NMH
  manifest's `path` field can point at one file. Currently excluded
  from main `tsconfig.json` / `tsdown`.
- ⏳ NMH manifest installer (Phase 3) — code that writes the
  per-platform manifest JSON + Windows registry keys at install-check
  time.
- ⏳ Launcher shim generator (Phase 3) — `.bat` (Windows) / `.sh`
  (POSIX) wrapper around `node <bridge.js>`.

## See also

- `src/browser-ext/` — the extension that calls `connectNative` to
  spawn this bridge.
- `src/lib/browser-mcp/` — the github-router-side dispatcher that
  talks to this bridge over WS.
