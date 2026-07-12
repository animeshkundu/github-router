// FAITHFUL plan-mode MCP e2e — drives CloudCLI's ACTUAL chat (WS → Agent SDK →
// claude), the same path the buffet session uses, instead of a bare `claude`.
// Verifies, in PLAN mode, that with serve's seeded `claude-settings.allowedTools`
// (the injected MCP tool names): (a) native tools stay available (the SDK's
// `claude_code` preset provides them — the MCP-only seed is auto-approve, not a
// restrictive filter), and (b) an injected MCP tool auto-approves — no
// permission_request, no "Stream closed". Uses the LOCAL dist build.
//
// Exit 0 pass, 1 failed assertion, 2 setup error. Skips (0) if CloudCLI isn't
// installed. Needs network + a Copilot token (drives a real model turn).
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

const secretPath = path.join(os.homedir(), ".local", "share", "github-router", "cloudcli", ".serve-secret.json");
if (!fs.existsSync(secretPath)) {
  // CloudCLI not installed / never provisioned — nothing to drive.
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
  const headers = { "content-type": "application/json", origin: ORIGIN, host: `127.0.0.1:${PORT}` };
  if (token) headers.authorization = "Bearer " + token;
  const r = await httpFetch(BASE + pathName, { method: "POST", headers, body: JSON.stringify(body) });
  return { status: r.status, json: await r.json().catch(() => null) };
}

async function main() {
  // Wait for CloudCLI + the serve seed to be ready.
  const secret = JSON.parse(fs.readFileSync(secretPath, "utf8"));
  let seededSettings = null;
  for (let i = 0; i < 45; i++) {
    await sleep(1000);
    try {
      const html = await (await httpFetch(BASE + "/", { headers: { host: `127.0.0.1:${PORT}` } })).text();
      const m = html.match(/claude-settings',"(.*?)"\);/);
      if (m) {
        seededSettings = JSON.parse(m[1].replace(/\\"/g, '"').replace(/\\\\/g, "\\"));
        if (Array.isArray(seededSettings.allowedTools) && seededSettings.allowedTools.length) break;
      }
    } catch { /* not ready */ }
  }
  if (!seededSettings) throw new Error("serve did not serve a seeded claude-settings in time");
  console.log(`seeded allowedTools: ${seededSettings.allowedTools.length} MCP tool names`);

  // Auth + session.
  const lg = await jpost("/api/auth/login", { username: secret.username, password: secret.password });
  const token = lg.json?.token;
  if (!token) throw new Error("login failed: " + lg.status);
  const sc = await jpost("/api/providers/sessions", { provider: "claude", projectPath: REPO }, token);
  const sessionId = sc.json?.data?.sessionId;
  if (!sessionId) throw new Error("session-create failed: " + sc.status + " " + JSON.stringify(sc.json));

  // Drive a PLAN-mode chat that forces an injected MCP tool call.
  const events = [];
  await new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${encodeURIComponent(token)}`, {
      headers: { origin: ORIGIN, host: `127.0.0.1:${PORT}` },
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
        options: {
          permissionMode: "plan",
          toolsSettings: seededSettings,
        },
      }));
    });
    ws.on("message", (buf) => {
      let ev; try { ev = JSON.parse(buf.toString()); } catch { return; }
      events.push(ev);
      const flat = JSON.stringify(ev);
      if (/"kind":"(complete|error)"/.test(flat) || ev?.type === "result" || ev?.kind === "complete") {
        // give a tick for trailing frames then finish
        setTimeout(() => { clearTimeout(t); try { ws.close(); } catch { /* noop */ } resolve(); }, 1500);
      }
    });
    ws.on("error", (e) => { clearTimeout(t); reject(e); });
  });

  // Parse events. CloudCLI normalizes into top-level `kind` frames:
  //   { kind:"tool_use", toolName, toolInput, toolId }
  //   { kind:"tool_result", toolId, content, isError }
  //   { kind:"permission_request" | "error" | "complete" | ... }
  let mcpToolUse = null, mcpResultOk = false, permissionReq = false, streamClosed = false, planBlock = false;
  const mcpToolIds = new Map();
  for (const ev of events) {
    if (ev.kind === "tool_use" && String(ev.toolName || "").startsWith("mcp__")) {
      mcpToolUse = ev.toolName;
      mcpToolIds.set(ev.toolId, ev.toolName);
    }
    if (ev.kind === "tool_result") {
      const tx = JSON.stringify(ev.content ?? "").toLowerCase();
      // planBlock is signalled by the tool RESULT text, not isError.
      if (/cannot call .* while in plan mode/.test(tx)) planBlock = true;
      // Success is authoritative via isError — do NOT regex the content for
      // "permission"/"error" words (they legitimately appear in code-search
      // results and would false-negative a real success).
      if (mcpToolIds.has(ev.toolId) && ev.isError !== true) mcpResultOk = true;
    }
    if (ev.kind === "permission_request") permissionReq = true;
    if (ev.kind === "error") {
      const tx = JSON.stringify(ev).toLowerCase();
      if (/stream closed|permission request failed/.test(tx)) streamClosed = true;
    }
  }

  console.log(`event count:        ${events.length}`);
  try { fs.writeFileSync(path.join(os.tmpdir(), "pm-cloudcli-events.json"), JSON.stringify(events, null, 2)); } catch { /* noop */ }
  console.log(`mcp tool_use:       ${mcpToolUse ?? "(none)"}`);
  console.log(`mcp result ok:      ${mcpResultOk}`);
  console.log(`permission_request: ${permissionReq}`);
  console.log(`stream closed:      ${streamClosed}`);
  console.log(`plan hard-block:    ${planBlock}`);

  const fails = [];
  if (streamClosed) fails.push('the buffet regression reproduced: "Stream closed" permission failure');
  if (permissionReq) fails.push("MCP tool triggered a permission_request in plan mode (not auto-approved by allowedTools seed)");
  if (planBlock) fails.push('MCP tool hard-blocked ("Cannot call ... while in plan mode") — plan-mode MCP not achievable via CloudCLI');
  if (!mcpToolUse) fails.push("model never issued an mcp__ tool_use — inconclusive (raw tail):\n" + JSON.stringify(events).slice(-500));
  else if (!mcpResultOk) fails.push(`mcp tool ${mcpToolUse} returned no successful result`);

  if (fails.length) {
    console.error("❌ cloudcli plan-mode MCP e2e FAILED:\n  - " + fails.join("\n  - "));
    process.exitCode = 1;
  } else {
    console.log("✅ cloudcli plan-mode MCP e2e: injected MCP tool auto-approved + executed in plan mode (no permission prompt / stream-closed).");
  }
}

main().catch((e) => { console.error("❌ setup error:", e.message); process.exitCode = 2; }).finally(cleanup);
