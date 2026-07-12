// FAITHFUL plan-mode MCP e2e — drives CloudCLI's ACTUAL chat (WS → Agent SDK →
// claude), the same path the buffet session uses, instead of a bare `claude`.
//
// SELF-PROVING two-phase test (each phase drives a real plan-mode model turn):
//   Phase A (negative control): allowedTools=[] (the pre-fix / buffet state) —
//     asserts the MCP call does NOT auto-approve (permission_request fires). This
//     proves the seed is load-bearing: if this phase ever PASSES, the seed became
//     a no-op and the guard is worthless.
//   Phase B (positive): serve's real seeded allowedTools — asserts the MCP tool
//     auto-approves + executes (isError:false, no permission_request / "Stream
//     closed"), and that the native toolset is intact (WaitForMcpServers runs).
//
// Uses the LOCAL dist build. Exit 0 pass, 1 failed assertion, 2 setup error.
// Skips (0) if CloudCLI isn't provisioned. Needs network + a Copilot token.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";

// `fetch` is a Node 18+ global; alias it once so eslint's no-undef is satisfied.
const httpFetch = globalThis.fetch;

const REPO = process.cwd();
const PORT = 5560 + Math.floor(Math.random() * 30);
const BASE = `http://127.0.0.1:${PORT}`;
const ORIGIN = BASE;
const HOST = `127.0.0.1:${PORT}`;

const secretPath = path.join(os.homedir(), ".local", "share", "github-router", "cloudcli", ".serve-secret.json");
if (!fs.existsSync(secretPath)) {
  console.log("⏭  cloudcli plan-mode e2e skipped: CloudCLI not provisioned (no .serve-secret.json).");
  process.exit(0);
}

console.log(`booting serve on :${PORT} (local dist) …`);
const serve = spawn(
  process.execPath,
  ["dist/main.js", "serve", "--no-open", "--no-install", "--port", String(PORT)],
  { cwd: REPO, stdio: "ignore", env: {
    ...process.env,
    GH_ROUTER_DISABLE_SEMANTIC_SEARCH: "1",
    GH_ROUTER_DISABLE_TOOLBELT: "1",
    GH_ROUTER_DISABLE_KEEP_AWAKE: "1",
  } },
);
function cleanup() {
  try {
    if (process.platform === "win32") spawnSync("taskkill", ["/F", "/T", "/PID", String(serve.pid)]);
    else process.kill(-serve.pid, "SIGTERM");
  } catch { /* gone */ }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function jpost(pathName, body, token) {
  const headers = { "content-type": "application/json", origin: ORIGIN, host: HOST };
  if (token) headers.authorization = "Bearer " + token;
  const r = await httpFetch(BASE + pathName, { method: "POST", headers, body: JSON.stringify(body) });
  return { status: r.status, json: await r.json().catch(() => null) };
}

// Drive ONE plan-mode turn (fresh session) that forces WaitForMcpServers +
// mcp__search__code, with the given `allowedTools`. Returns parsed signals.
async function drive(token, allowedTools) {
  const sc = await jpost("/api/providers/sessions", { provider: "claude", projectPath: REPO }, token);
  const sessionId = sc.json?.data?.sessionId;
  if (!sessionId) throw new Error("session-create failed: " + sc.status + " " + JSON.stringify(sc.json));

  const events = [];
  await new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://${HOST}/ws?token=${encodeURIComponent(token)}`, {
      headers: { origin: ORIGIN, host: HOST },
    });
    const t = setTimeout(() => { try { ws.close(); } catch { /* noop */ } resolve(); }, 120000);
    ws.on("open", () => {
      ws.send(JSON.stringify({
        type: "chat.send",
        sessionId,
        content:
          "You are in PLAN mode. Do exactly this: (1) call the WaitForMcpServers tool "
          + 'with {"servers":["search"]} and wait for it to report ready; (2) then call '
          + `the mcp__search__code tool exactly once with {"query":"reverseProxy","mode":"lexical","workspace":${JSON.stringify(REPO)}}; `
          + "(3) then reply with the single word DONE. Do not call ExitPlanMode.",
        options: { permissionMode: "plan", toolsSettings: { allowedTools, disallowedTools: [], skipPermissions: true } },
      }));
    });
    ws.on("message", (buf) => {
      let ev; try { ev = JSON.parse(buf.toString()); } catch { return; }
      events.push(ev);
      if (/"kind":"(complete|error)"/.test(JSON.stringify(ev))) {
        setTimeout(() => { clearTimeout(t); try { ws.close(); } catch { /* noop */ } resolve(); }, 1500);
      }
    });
    ws.on("error", (e) => { clearTimeout(t); reject(e); });
  });

  const r = { mcpToolUse: null, mcpResultOk: false, nativeRan: false, permissionReq: false, streamClosed: false, planBlock: false };
  const mcpIds = new Map();
  for (const ev of events) {
    if (ev.kind === "tool_use") {
      if (String(ev.toolName || "").startsWith("mcp__")) { r.mcpToolUse = ev.toolName; mcpIds.set(ev.toolId, 1); }
      if (ev.toolName === "WaitForMcpServers") r.nativeRanId = ev.toolId;
    }
    if (ev.kind === "tool_result") {
      const tx = JSON.stringify(ev.content ?? "").toLowerCase();
      if (/cannot call .* while in plan mode/.test(tx)) r.planBlock = true;
      if (mcpIds.has(ev.toolId) && ev.isError !== true) r.mcpResultOk = true;
      if (ev.toolId === r.nativeRanId && ev.isError !== true) r.nativeRan = true;
    }
    if (ev.kind === "permission_request") r.permissionReq = true;
    if (ev.kind === "error" && /stream closed|permission request failed/.test(JSON.stringify(ev).toLowerCase())) r.streamClosed = true;
  }
  return r;
}

async function main() {
  const secret = JSON.parse(fs.readFileSync(secretPath, "utf8"));
  // Wait for CloudCLI + the serve seed to be ready.
  let seeded = null;
  for (let i = 0; i < 45; i++) {
    await sleep(1000);
    try {
      const html = await (await httpFetch(BASE + "/", { headers: { host: HOST } })).text();
      const m = html.match(/claude-settings',"(.*?)"\);/);
      if (m) {
        seeded = JSON.parse(m[1].replace(/\\"/g, '"').replace(/\\\\/g, "\\"));
        if (Array.isArray(seeded.allowedTools) && seeded.allowedTools.length) break;
      }
    } catch { /* not ready */ }
  }
  if (!seeded) throw new Error("serve did not serve a seeded claude-settings in time");
  console.log(`seeded allowedTools: ${seeded.allowedTools.length} MCP tool names`);

  const lg = await jpost("/api/auth/login", { username: secret.username, password: secret.password });
  const token = lg.json?.token;
  if (!token) throw new Error("login failed: " + lg.status);

  const fails = [];

  // Phase A — negative control: empty allowedTools must FAIL to auto-approve.
  console.log("\n[Phase A] negative control (allowedTools=[]) — expect the MCP call to be gated …");
  const a = await drive(token, []);
  console.log(`  mcp tool_use=${a.mcpToolUse} ok=${a.mcpResultOk} permission_request=${a.permissionReq} stream_closed=${a.streamClosed}`);
  if (!a.mcpToolUse) {
    console.log("  (model didn't call the MCP tool — can't assert the negative control this run; not fatal)");
  } else if (a.mcpResultOk && !a.permissionReq && !a.streamClosed) {
    fails.push("Phase A: MCP tool auto-approved in plan mode WITHOUT the seed — the seed is a no-op / the guard is worthless");
  } else {
    console.log("  ✓ gated without the seed (permission_request/stream-closed or not-ok) — seed is load-bearing");
  }

  // Phase B — positive: serve's real seed must auto-approve + execute.
  console.log("\n[Phase B] positive (serve's seeded allowedTools) — expect the MCP call to execute …");
  const b = await drive(token, seeded.allowedTools);
  console.log(`  mcp tool_use=${b.mcpToolUse} ok=${b.mcpResultOk} native_ran=${b.nativeRan} permission_request=${b.permissionReq} stream_closed=${b.streamClosed} plan_block=${b.planBlock}`);
  if (b.streamClosed) fails.push('Phase B: the buffet regression reproduced with the seed ("Stream closed")');
  if (b.permissionReq) fails.push("Phase B: MCP tool triggered permission_request even WITH the seed (not auto-approved)");
  if (b.planBlock) fails.push('Phase B: MCP tool hard-blocked ("Cannot call ... while in plan mode")');
  if (!b.mcpToolUse) fails.push("Phase B: model never issued an mcp__ tool_use (inconclusive)");
  else if (!b.mcpResultOk) fails.push(`Phase B: mcp tool ${b.mcpToolUse} returned no successful result`);
  if (b.mcpResultOk && !b.nativeRan) fails.push("Phase B: native WaitForMcpServers did not run (seed may be restricting the native toolset)");

  if (fails.length) {
    console.error("\n❌ cloudcli plan-mode MCP e2e FAILED:\n  - " + fails.join("\n  - "));
    process.exitCode = 1;
  } else {
    console.log("\n✅ cloudcli plan-mode MCP e2e: gated WITHOUT the seed, auto-approved + executed WITH it (native toolset intact).");
  }
}

main().catch((e) => { console.error("❌ setup error:", e.message); process.exitCode = 2; }).finally(cleanup);
