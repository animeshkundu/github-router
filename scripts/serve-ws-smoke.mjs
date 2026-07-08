#!/usr/bin/env node
// Node smoke test for the serve reverse proxy's positive WebSocket path.
// The bun unit test skips this (bun's node:http can't relay upgrade sockets),
// but the shipped runtime is Node — so CI transpiles the module with
//   bun build src/lib/serve/reverse-proxy.ts --target=node --format=esm --outfile <tmp>
// and runs this under node to cover the /ws + /shell relay for real.
import http from "node:http";
import { pathToFileURL } from "node:url";
import { WebSocket, WebSocketServer } from "ws";

const modulePath = process.argv[2];
if (!modulePath) {
  console.error("usage: node scripts/serve-ws-smoke.mjs <built-reverse-proxy.mjs>");
  process.exit(2);
}
const { startReverseProxy } = await import(pathToFileURL(modulePath).href);

function getFreePort() {
  return new Promise((resolve) => {
    const s = http.createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}

// Fake CloudCLI-like upstream: WS echo + greeting.
const upstream = http.createServer((_q, r) => { r.writeHead(404); r.end(); });
const wss = new WebSocketServer({ server: upstream });
wss.on("connection", (ws) => {
  ws.send("hello");
  ws.on("message", (m) => ws.send(`echo:${m}`));
});
await new Promise((r) => upstream.listen(0, "127.0.0.1", () => r()));
const upPort = upstream.address().port;

const bindPort = await getFreePort();
const proxy = await startReverseProxy({
  targetHost: "127.0.0.1",
  targetPort: upPort,
  bindHost: "127.0.0.1",
  bindPort,
  authToken: "smoke-token",
});

const msgs = [];
const result = await new Promise((resolve) => {
  const ws = new WebSocket(`ws://127.0.0.1:${bindPort}/ws`, {
    headers: { origin: proxy.url },
  });
  const t = setTimeout(() => resolve("TIMEOUT " + JSON.stringify(msgs)), 8000);
  ws.on("message", (m) => {
    msgs.push(String(m));
    if (msgs.length === 1) ws.send("ping");
    if (msgs.length === 2) { clearTimeout(t); ws.close(); resolve("OK"); }
  });
  ws.on("error", (e) => { clearTimeout(t); resolve("ERR " + e.message); });
});

await proxy.close();
wss.close();
upstream.close();

if (result === "OK" && msgs[0] === "hello" && msgs[1] === "echo:ping") {
  console.log("✅ serve WS smoke: /ws relay round-trip OK under node");
  process.exit(0);
}
console.error(`❌ serve WS smoke failed: ${result} (msgs=${JSON.stringify(msgs)})`);
process.exit(1);
