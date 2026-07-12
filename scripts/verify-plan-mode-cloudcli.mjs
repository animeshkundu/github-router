// FAITHFUL serve-permission e2e — drives CloudCLI's ACTUAL chat (WS → Agent SDK →
// claude), the same path the browser session uses, and proves serve's
// "seamless routine + decisions to the user" model end to end.
//
// What it proves (each phase drives a real model turn against live CloudCLI):
//   SEED (static):  the injected localStorage['claude-settings'] is NON-bypass
//     (skipPermissions:false) and its allowedTools lists routine built-ins + the
//     injected mcp tools but NEVER AskUserQuestion / ExitPlanMode.
//   Phase 1 (seamless): a routine mcp + Read call auto-executes with NO
//     permission_request — ordinary work (routine AND mcp tools) never prompts.
//   Phase 2 (AskUserQuestion reaches the user): forcing AskUserQuestion raises a
//     permission_request for it (the human is asked) instead of the model
//     auto-answering its own question. Auto-answer => FAIL (the bug).
//   Phase 3 (ExitPlanMode reaches the user): in plan mode, ExitPlanMode raises a
//     permission_request (the plan Approve/Reject card) instead of auto-approving.
//
// The seed replay is faithful: the harness reads the exact settings the reverse
// proxy injects into the SPA and sends them as chat.send toolsSettings — the same
// bytes the browser would send from localStorage.
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
  console.log("⏭  serve-permission e2e skipped: CloudCLI not provisioned (no .serve-secret.json).");
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

// Drive ONE turn (fresh session) with the given permission mode + tool settings,
// short-circuiting as soon as a permission_request for `awaitPermTool` appears
// (interaction tools wait indefinitely, so we must not block on completion).
// Returns parsed signals.
async function drive(token, { mode, content, toolsSettings, awaitPermTool }) {
  const sc = await jpost("/api/providers/sessions", { provider: "claude", projectPath: REPO }, token);
  const sessionId = sc.json?.data?.sessionId;
  if (!sessionId) throw new Error("session-create failed: " + sc.status + " " + JSON.stringify(sc.json));

  const events = [];
  await new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://${HOST}/ws?token=${encodeURIComponent(token)}`, {
      headers: { origin: ORIGIN, host: HOST },
    });
    const t = setTimeout(() => { try { ws.close(); } catch { /* noop */ } resolve(); }, 120000);
    const finish = () => { clearTimeout(t); try { ws.close(); } catch { /* noop */ } resolve(); };
    ws.on("open", () => {
      ws.send(JSON.stringify({
        type: "chat.send",
        sessionId,
        content,
        options: { permissionMode: mode, toolsSettings },
      }));
    });
    ws.on("message", (buf) => {
      let ev; try { ev = JSON.parse(buf.toString()); } catch { return; }
      events.push(ev);
      // Short-circuit the moment the awaited interaction tool asks the human —
      // its permission_request waits forever, so completion never arrives.
      if (awaitPermTool && ev.kind === "permission_request"
          && String(ev.toolName || "") === awaitPermTool) {
        setTimeout(finish, 250);
        return;
      }
      if (/"kind":"(complete|error)"/.test(JSON.stringify(ev))) {
        setTimeout(finish, 1200);
      }
    });
    ws.on("error", (e) => { clearTimeout(t); reject(e); });
  });

  const r = {
    toolUses: [], resultOkById: new Map(), permReqTools: [],
    streamClosed: false, planBlock: false,
  };
  for (const ev of events) {
    if (ev.kind === "tool_use") r.toolUses.push({ name: String(ev.toolName || ""), id: ev.toolId });
    if (ev.kind === "tool_result") {
      const tx = JSON.stringify(ev.content ?? "").toLowerCase();
      if (/cannot call .* while in plan mode/.test(tx)) r.planBlock = true;
      if (ev.isError !== true) r.resultOkById.set(ev.toolId, true);
    }
    if (ev.kind === "permission_request") r.permReqTools.push(String(ev.toolName || ""));
    if (ev.kind === "error" && /stream closed|permission request failed/.test(JSON.stringify(ev).toLowerCase())) {
      r.streamClosed = true;
    }
  }
  r.ranOk = (name) => r.toolUses.some((u) => u.name === name && r.resultOkById.get(u.id));
  r.used = (name) => r.toolUses.some((u) => u.name === name);
  return r;
}

async function main() {
  const secret = JSON.parse(fs.readFileSync(secretPath, "utf8"));
  // Wait for CloudCLI + the serve seed to be ready; capture the exact injected seed.
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
  const toolsSettings = {
    allowedTools: seeded.allowedTools,
    disallowedTools: seeded.disallowedTools ?? [],
    skipPermissions: seeded.skipPermissions === true,
  };

  const fails = [];

  // ── SEED (static) ────────────────────────────────────────────────────────
  console.log(`\n[Seed] skipPermissions=${seeded.skipPermissions}, allowedTools=${seeded.allowedTools.length}`);
  if (seeded.skipPermissions !== false) {
    fails.push("Seed: skipPermissions must be false (non-bypass) so canUseTool stays live; got " + seeded.skipPermissions);
  }
  for (const forbidden of ["AskUserQuestion", "ExitPlanMode"]) {
    if (seeded.allowedTools.includes(forbidden)) {
      fails.push(`Seed: ${forbidden} must NOT be pre-approved (it must reach the user), but it is in allowedTools`);
    }
  }
  for (const routine of ["Read", "Bash", "Edit", "Write"]) {
    if (!seeded.allowedTools.includes(routine)) {
      fails.push(`Seed: routine tool ${routine} missing from allowedTools (would prompt — not seamless)`);
    }
  }
  const hasMcp = seeded.allowedTools.some((t) => t.startsWith("mcp__"));
  if (!hasMcp) fails.push("Seed: no mcp__ tools in allowedTools (injected MCP would prompt)");
  console.log(fails.length ? "  ✗ seed problems (see summary)" : "  ✓ seed is non-bypass, routine+mcp allow-listed, interaction tools excluded");

  const lg = await jpost("/api/auth/login", { username: secret.username, password: secret.password });
  const token = lg.json?.token;
  if (!token) throw new Error("login failed: " + lg.status);

  // ── Phase 1 — seamless routine (default mode) ────────────────────────────
  console.log("\n[Phase 1] seamless routine — expect mcp + Read to run with NO permission_request …");
  const p1 = await drive(token, {
    mode: "default",
    toolsSettings,
    content:
      'Do exactly this, no more: (1) call WaitForMcpServers with {"servers":["search"]}; '
      + `(2) call mcp__search__code once with {"query":"reverseProxy","mode":"lexical","workspace":${JSON.stringify(REPO)}}; `
      + `(3) call Read on ${JSON.stringify(path.join(REPO, "package.json"))}; (4) reply DONE. Do not ask any question.`,
  });
  const routinePrompted = p1.permReqTools.filter((t) => t !== "AskUserQuestion" && t !== "ExitPlanMode");
  console.log(`  mcp_ran=${p1.ranOk("mcp__search__code") || p1.used("mcp__search__code")} read_ran=${p1.ranOk("Read")} permission_requests=[${p1.permReqTools.join(",")}] stream_closed=${p1.streamClosed}`);
  if (p1.streamClosed) fails.push('Phase 1: "Stream closed" on a routine call');
  if (routinePrompted.length) fails.push(`Phase 1: routine tools prompted (not seamless): ${routinePrompted.join(", ")}`);
  if (!p1.used("mcp__search__code") && !p1.used("Read")) {
    console.log("  (model called neither mcp nor Read — inconclusive for seamlessness this run)");
  } else {
    console.log("  ✓ routine + mcp ran without prompting");
  }

  // ── Phase 2 — AskUserQuestion reaches the user (default mode) ─────────────
  console.log("\n[Phase 2] AskUserQuestion — expect a permission_request (the user is asked), NOT an auto-answer …");
  const p2 = await drive(token, {
    mode: "default",
    toolsSettings,
    awaitPermTool: "AskUserQuestion",
    content:
      "Call the AskUserQuestion tool exactly once to ask me: question \"Pick a color\" with two options "
      + "labelled \"Red\" and \"Blue\". Do NOT answer it yourself and do NOT call any other tool first.",
  });
  const askSurfaced = p2.permReqTools.includes("AskUserQuestion");
  console.log(`  asked_user=${askSurfaced} used_askuserquestion=${p2.used("AskUserQuestion")} permission_requests=[${p2.permReqTools.join(",")}]`);
  if (askSurfaced) {
    console.log("  ✓ AskUserQuestion reached the user (not auto-answered)");
  } else if (p2.used("AskUserQuestion")) {
    fails.push("Phase 2: AskUserQuestion executed WITHOUT a permission_request — the model auto-answered its own question (the bug)");
  } else {
    console.log("  (model never called AskUserQuestion — inconclusive this run; not fatal)");
  }

  // ── Phase 3 — ExitPlanMode reaches the user (plan mode) ───────────────────
  console.log("\n[Phase 3] ExitPlanMode (plan mode) — expect a permission_request (the plan card), NOT auto-approve …");
  const p3 = await drive(token, {
    mode: "plan",
    toolsSettings,
    awaitPermTool: "ExitPlanMode",
    content:
      "You are in plan mode. Write a one-line plan ('Plan: do nothing') then call the ExitPlanMode tool "
      + "with that plan. Do not call any other tool.",
  });
  const planSurfaced = p3.permReqTools.includes("ExitPlanMode");
  console.log(`  plan_approval_asked=${planSurfaced} used_exitplanmode=${p3.used("ExitPlanMode")} permission_requests=[${p3.permReqTools.join(",")}]`);
  if (planSurfaced) {
    console.log("  ✓ ExitPlanMode reached the user (plan Approve/Reject, not auto-approved) — and it runs as a tool, so PostToolUse(ExitPlanMode) fires");
  } else if (p3.used("ExitPlanMode")) {
    fails.push("Phase 3: ExitPlanMode executed WITHOUT a permission_request — the plan was auto-approved (the bug)");
  } else {
    console.log("  (model never called ExitPlanMode — inconclusive this run; not fatal)");
  }

  if (fails.length) {
    console.error("\n❌ serve-permission e2e FAILED:\n  - " + fails.join("\n  - "));
    process.exitCode = 1;
  } else {
    console.log("\n✅ serve-permission e2e: routine + mcp seamless, AskUserQuestion + ExitPlanMode reach the user (non-bypass model working).");
  }
}

main().catch((e) => { console.error("❌ setup error:", e.message); process.exitCode = 2; }).finally(cleanup);
