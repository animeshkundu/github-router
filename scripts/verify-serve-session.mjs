#!/usr/bin/env node
// Verify what a `github-router serve` Claude session actually sees.
//
// The reliable way to validate serve's injection layer WITHOUT depending on
// CloudCLI's Agent-SDK spawn: boot serve to generate the CLAUDE_CONFIG_DIR
// mirror, then run the real `claude` binary in the SAME headless stream-json
// mode CloudCLI uses (`--print --output-format stream-json`) against that
// mirror, and inspect the `init` control message. That message is the ground
// truth of the session's registered agents, MCP servers, and permission mode —
// exactly what our mirror injection controls.
//
// Usage:  node scripts/verify-serve-session.mjs
// Exits 0 on success, 1 on a failed assertion, 2 on setup error. Skips (exit 0)
// with a clear message if the `claude` binary isn't installed.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const REPO = process.cwd();
const PORT = 5460 + Math.floor(Math.random() * 30);

function resolveClaude() {
  if (process.env.CLAUDE_CLI_PATH && fs.existsSync(process.env.CLAUDE_CLI_PATH)) {
    return process.env.CLAUDE_CLI_PATH;
  }
  const win = process.platform === "win32";
  // Mirror CloudCLI's own resolution so this probe runs the SAME binary a serve
  // session does. CloudCLI (`server/shared/claude-cli-path.js`) sets the SDK's
  // `pathToClaudeCodeExecutable` to `resolveClaudeCodeExecutablePath()`, which
  // with CLAUDE_CLI_PATH unset resolves `where.exe claude` — the first
  // `claude.exe` on PATH (the system install) — and only falls back to the
  // SDK-bundled binary when that lookup fails. So: PATH first, bundled last.
  const probe = spawnSync(win ? "where" : "which", ["claude"], { encoding: "utf8" });
  const found = (probe.stdout || "").split(/\r?\n/).find((l) => l.trim() && fs.existsSync(l.trim()));
  if (found) return found.trim();
  const native = path.join(os.homedir(), ".local", "bin", win ? "claude.exe" : "claude");
  if (fs.existsSync(native)) return native;
  // CloudCLI's fallback when `where.exe claude` finds nothing: the claude the
  // Agent SDK bundles under `claude-agent-sdk-<platform>-<arch>/`.
  const arch = process.arch; // "x64" | "arm64" | …
  const plat = win ? "win32" : process.platform === "darwin" ? "darwin" : "linux";
  const bundled = path.join(
    os.homedir(), ".local", "share", "github-router", "cloudcli",
    "node_modules", "@anthropic-ai", `claude-agent-sdk-${plat}-${arch}`,
    win ? "claude.exe" : "claude",
  );
  if (fs.existsSync(bundled)) return bundled;
  return null;
}

function latestMirror() {
  const base = path.join(os.homedir(), ".local", "share", "github-router", "claude-config");
  if (!fs.existsSync(base)) return null;
  const dirs = fs
    .readdirSync(base)
    .map((d) => path.join(base, d))
    .filter((p) => fs.statSync(p).isDirectory())
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return dirs[0] ?? null;
}

const claude = resolveClaude();
if (!claude) {
  console.log("⏭  verify-serve-session skipped: `claude` binary not found (set CLAUDE_CLI_PATH).");
  process.exit(0);
}

console.log(`booting serve on :${PORT} to generate the mirror …`);
const serve = spawn(
  process.execPath,
  ["dist/main.js", "serve", "--no-open", "--no-install", "--port", String(PORT)],
  {
    cwd: REPO,
    stdio: "ignore",
    env: {
      ...process.env,
      GH_ROUTER_DISABLE_SEMANTIC_SEARCH: "1",
      GH_ROUTER_DISABLE_TOOLBELT: "1",
      GH_ROUTER_DISABLE_KEEP_AWAKE: "1",
    },
  },
);

function cleanup() {
  try {
    if (process.platform === "win32") spawnSync("taskkill", ["/F", "/T", "/PID", String(serve.pid)]);
    else process.kill(-serve.pid, "SIGTERM");
  } catch {
    /* already gone */
  }
}

async function main() {
  // Wait for the enhancement layer to FULLY provision the mirror before probing.
  // The `agents/` dir is created early (before its .md files and before
  // settings.json is finalized), so waiting only for the dir to exist
  // races the probe against a half-written mirror. Require the complete surface:
  // mcpServers injected, the injected allow-rules present (a `mcp__` rule in
  // permissions.allow — written AFTER the permission-mode config, so it proves the
  // settings.json is finalized), permissions.defaultMode NON-bypass (canUseTool
  // stays live so AskUserQuestion/ExitPlanMode reach the user), and a peer agent
  // .md on disk.
  const mirrorComplete = (m) => {
    try {
      if (!m || !fs.existsSync(path.join(m, "agents"))) return false;
      const cj = JSON.parse(fs.readFileSync(path.join(m, ".claude.json"), "utf8"));
      if (!cj.mcpServers || Object.keys(cj.mcpServers).length === 0) return false;
      const sj = JSON.parse(fs.readFileSync(path.join(m, "settings.json"), "utf8"));
      if (!sj.permissions) return false;
      if (sj.permissions.defaultMode === "bypassPermissions") return false; // must be NON-bypass
      const allow = Array.isArray(sj.permissions.allow) ? sj.permissions.allow : [];
      if (!allow.some((r) => typeof r === "string" && r.startsWith("mcp__"))) return false;
      return fs.readdirSync(path.join(m, "agents")).some((f) => /-codex-critic\.md$/.test(f));
    } catch {
      return false;
    }
  };
  let mirror = null;
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const m = latestMirror();
    if (mirrorComplete(m)) {
      mirror = m;
      break;
    }
  }
  if (!mirror) throw new Error("serve mirror was not fully provisioned in time");
  console.log(`mirror: ${mirror}`);

  // Probe the real claude in headless stream-json mode against the mirror.
  // Scrub CLAUDE_CODE_COORDINATOR_MODE from the PROBE env: the serve mirror's
  // settings.json is the surface under test (serve strips coordinator mode from
  // it), but the SDK also honors an ambient CLAUDE_CODE_COORDINATOR_MODE, and a
  // runner invoked from a FleetView/coordinator shell would inherit it and see a
  // truncated toolset regardless of the mirror. Scrubbing it makes this assert
  // the mirror, not the runner's shell.
  const probeEnv = { ...process.env, CLAUDE_CONFIG_DIR: mirror };
  delete probeEnv.CLAUDE_CODE_COORDINATOR_MODE;
  const out = await new Promise((resolve) => {
    const c = spawn(
      claude,
      ["--print", "--output-format", "stream-json", "--input-format", "stream-json", "--verbose"],
      { cwd: REPO, env: probeEnv },
    );
    let buf = "";
    c.stdout.on("data", (d) => (buf += d));
    c.stderr.on("data", (d) => (buf += d));
    const t = setTimeout(() => { c.kill(); resolve(buf); }, 30000);
    c.on("close", () => { clearTimeout(t); resolve(buf); });
    c.stdin.write(JSON.stringify({ type: "user", message: { role: "user", content: "hi" } }) + "\n");
    c.stdin.end();
  });

  let init = null;
  for (const line of out.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const j = JSON.parse(line);
      if (j.subtype === "init") { init = j; break; }
    } catch { /* non-JSON diagnostic line */ }
  }
  if (!init) throw new Error("no init message from claude — probe failed:\n" + out.slice(0, 400));

  const agents = init.agents || [];
  const mcp = (init.mcp_servers || []).map((m) => m.name || m);
  const tools = init.tools || [];
  // NOTE: the bare native `worker` agent is a COORDINATOR-mode construct; in the
  // correct single-agent serve state (coordinator mode stripped) it's absent —
  // our injected worker-* agents replace it. Assert the injected built-ins, the
  // review coordinator, a peer critic, and a worker to cover each injected class.
  const expectAgents = ["Explore", "Plan", "general-purpose", "peer-review-coordinator", "codex-critic", "worker-explore"];
  const expectMcp = ["peers", "search", "workers", "orchestrate", "decide"];
  // The built-in tools coordinator mode strips — the exact gap that let the
  // "Glob is not enabled in this context" bug ship. A serve session MUST expose
  // the direct toolset, not just delegation tools (Task/SendMessage/Workflow).
  const expectTools = ["Read", "Glob", "Grep", "Bash", "Edit", "Write"];

  const fails = [];
  for (const a of expectAgents) if (!agents.includes(a)) fails.push(`missing agent: ${a}`);
  for (const m of expectMcp) if (!mcp.includes(m)) fails.push(`missing mcp server: ${m}`);
  for (const t of expectTools) if (!tools.includes(t)) fails.push(`missing built-in tool: ${t} (coordinator-mode toolset strip?)`);
  if (init.permissionMode === "bypassPermissions") fails.push(`permissionMode=${init.permissionMode} (want NON-bypass so AskUserQuestion/ExitPlanMode reach the user)`);

  console.log(`agents:         ${JSON.stringify(agents)}`);
  console.log(`mcp_servers:    ${JSON.stringify(mcp)}`);
  console.log(`tools:          ${JSON.stringify(tools)}`);
  console.log(`permissionMode: ${init.permissionMode}`);

  if (fails.length) {
    console.error("❌ serve session verification FAILED:\n  - " + fails.join("\n  - "));
    process.exitCode = 1;
  } else {
    console.log("✅ serve session verified: built-in tools + injected agents, MCP servers, and default (non-bypass) mode all present.");
  }
}

main()
  .catch((e) => { console.error("❌ setup error:", e.message); process.exitCode = 2; })
  .finally(cleanup);
