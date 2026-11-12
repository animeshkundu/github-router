import type { PiProfileId } from "./pi-models-settings"
import {
  PI_PROVIDER_NAME,
  piAdvisorModel,
  piLeadModel,
  piLeadThinking,
  piOracleEnabled,
  piOracleToolReachable,
} from "./pi-models-settings"
import { isBalancedFamily, isCheapestFamily } from "./profile-family"
import {
  AIC_STATUSLINE_DISABLE_ENV,
} from "./aic-statusline-settings"
import { buildPiPlanModeSection } from "./pi-plan-mode"
import {
  PI_STATUS_COMMAND_ENV,
  PI_STATUSLINE_DEBOUNCE_MS,
  PI_STATUSLINE_TIMEOUT_MS,
  PI_STATUSLINE_WIDTH_FALLBACK,
  buildPiStatusPayload,
} from "./pi-statusline"

/**
 * The gh-router Pi extension source, generated per launch into the
 * isolated mirror (`extensions/gh-router-pi/index.ts`).
 *
 * Design (Pi-cooperative): executable seams only. Model-facing tools are
 * NOT registered here — every scoped MCP group is published as a native Pi
 * server in the mirror's `mcp.json` (`src/lib/pi-mcp-config.ts`), which
 * brings `tool_search`, the `mcp_servers` roster and per-server `exposure`
 * that a hand-wrapped `registerTool` cannot. What stays is the work no MCP
 * server can do: the statusline footer, plan mode, the memory bridge, and
 * (cheapest family only) the prompt-submit relay, which POSTs JSON-RPC
 * `tools/call` to the running proxy with the per-launch nonce (the same
 * `GH_ROUTER_HOOK_MCP_URL/NONCE` channel the Claude hooks use).
 *
 * No custom provider, no compaction replacement: `session_before_compact`
 * only routes the summary model and always falls back to Pi native on
 * failure.
 *
 * Statusline footer (always on): this extension owns Pi's footer and
 * renders the SAME `internal-aic-status` runner Claude Code uses, fed a
 * natively-built Claude-shaped payload — one renderer, identical
 * segments. There is deliberately no third-party statusline package and
 * no `statusLine` settings block (the community bridge only reads the
 * user's real global/project settings, never the launch mirror).
 *
 * Plan mode (always on): Claude Code ships plan mode as a mode; Pi ships it
 * only as an example extension a user has to install. `src/lib/pi-plan-mode.ts`
 * generates the equivalent into this same package — see
 * `buildPiPlanModeSection` for the two independent write barriers, the
 * snapshot/restore of the tool set, and the divergences from upstream.
 */

/**
 * Statusline footer section for the generated extension. Owns Pi's footer
 * and renders the shared `internal-aic-status` runner (the same binary
 * Claude Code invokes) with a natively-built Claude-shaped payload, so Pi
 * shows byte-identical segments: `[AIC x.xx]` pinned ahead of the rich
 * session line.
 *
 * Fail-open everywhere: disabled via `GH_ROUTER_DISABLE_AIC_STATUSLINE=1`
 * or a missing command env (the launcher always sets it — see `src/pi.ts`);
 * every Pi API access is guarded (extension APIs drift across Pi versions);
 * a hung runner is killed at `PI_STATUSLINE_TIMEOUT_MS`; any error clears
 * back to Pi's native footer, never a broken session.
 *
 * Width: the runner drops segments right-to-left from `COLUMNS`; the last
 * footer width is fed back into the next spawn, and `render()` truncates
 * ANSI-aware as a backstop (same two-layer approach as the retired bridge).
 */
export function buildPiStatuslineFooterSection(): Array<string> {
  return [
    `  // Statusline footer: [AIC x.xx] + rich session line, identical to github-router claude.`,
    `  {`,
    `    const STATUS_COMMAND = (process.env.${PI_STATUS_COMMAND_ENV} ?? "").trim();`,
    `    const STATUS_DISABLED = process.env.${AIC_STATUSLINE_DISABLE_ENV} === "1";`,
    `    if (STATUS_COMMAND && !STATUS_DISABLED) {`,
    `      const buildPayload = (${buildPiStatusPayload.toString()});`,
    `      const DEBOUNCE_MS = ${PI_STATUSLINE_DEBOUNCE_MS};`,
    `      const TIMEOUT_MS = ${PI_STATUSLINE_TIMEOUT_MS};`,
    `      let sessionStartMs = 0;`,
    `      let lastSessionId = null;`,
    `      let lastWidth = ${PI_STATUSLINE_WIDTH_FALLBACK};`,
    `      let lines: Array<string> = [];`,
    `      let lastApplied = "\\0none";`,
    `      let timer: ReturnType<typeof setTimeout> | null = null;`,
    `      let controller: AbortController | null = null;`,
    ``,
    `      function truncateVisible(line: string, maxWidth: number): string {`,
    `        if (!(maxWidth > 0)) return line;`,
    `        let output = "";`,
    `        let width = 0;`,
    `        let i = 0;`,
    `        while (i < line.length) {`,
    `          const ch = line[i];`,
    `          if (ch === "\\u001b") {`,
    `            let j = i + 1;`,
    `            const next = line[j];`,
    `            if (next === "[") {`,
    `              j++;`,
    `              while (j < line.length) {`,
    `                const code = line.charCodeAt(j);`,
    `                if (code >= 64 && code <= 126) { j++; break; }`,
    `                j++;`,
    `              }`,
    `            } else if (next === "]") {`,
    `              j++;`,
    `              while (j < line.length) {`,
    `                if (line[j] === "\\u0007") { j++; break; }`,
    `                if (line[j] === "\\u001b" && line[j + 1] === "\\\\") { j += 2; break; }`,
    `                j++;`,
    `              }`,
    `            } else {`,
    `              j = Math.min(line.length, i + 2);`,
    `            }`,
    `            output += line.slice(i, j);`,
    `            i = j;`,
    `            continue;`,
    `          }`,
    `          if (width >= maxWidth) return output;`,
    `          output += ch;`,
    `          width++;`,
    `          i++;`,
    `        }`,
    `        return output;`,
    `      }`,
    ``,
    `      function runStatusCommand(command: string, input: string, cwd: string, signal: AbortSignal | undefined): Promise<string> {`,
    `        return new Promise((resolve) => {`,
    `          let child: ReturnType<typeof spawn> | undefined;`,
    `          try {`,
    `            child = spawn(command, { cwd, shell: true, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, COLUMNS: String(lastWidth) } });`,
    `          } catch { resolve(""); return; }`,
    `          let stdout = "";`,
    `          let done = false;`,
    `          let timeout: ReturnType<typeof setTimeout> | null = null;`,
    `          const finish = (value: string): void => {`,
    `            if (done) return;`,
    `            done = true;`,
    `            if (timeout) clearTimeout(timeout);`,
    `            try { signal?.removeEventListener("abort", onAbort); } catch {}`,
    `            resolve(value);`,
    `          };`,
    `          const onAbort = (): void => {`,
    `            try { child?.kill("SIGTERM"); } catch {}`,
    `            finish("");`,
    `          };`,
    `          if (signal) {`,
    `            if (signal.aborted) { onAbort(); return; }`,
    `            try { signal.addEventListener("abort", onAbort, { once: true }); } catch {}`,
    `          }`,
    `          timeout = setTimeout(() => {`,
    `            try { child?.kill("SIGTERM"); } catch {}`,
    `            finish("");`,
    `          }, TIMEOUT_MS);`,
    `          child.stdout.on("data", (chunk) => { stdout += String(chunk); });`,
    `          child.on("error", () => finish(""))`,
    `          child.on("close", (code) => {`,
    `            if (code !== 0) { finish(""); return; }`,
    `            finish(stdout.replace(/\\r\\n/g, "\\n").trim());`,
    `          });`,
    `          try { child.stdin.write(input); child.stdin.end(); } catch { finish(""); }`,
    `        });`,
    `      }`,
    ``,
    `      function applyFooter(ctx: any): void {`,
    `        const key = lines.join("\\0");`,
    `        if (key === lastApplied) return;`,
    `        lastApplied = key;`,
    `        try {`,
    `          if (lines.length === 0) { ctx.ui.setFooter(undefined); return; }`,
    `          const frozen = [...lines];`,
    `          ctx.ui.setFooter((_tui: any, _theme: any, footerData: any) => ({`,
    `            dispose() {},`,
    `            invalidate() {},`,
    `            render(width: number) {`,
    `              if (typeof width === "number" && width > 0) lastWidth = width;`,
    `              const out = frozen.map((l) => truncateVisible(l, lastWidth));`,
    `              try {`,
    `                const statuses = footerData?.getExtensionStatuses?.();`,
    `                const entries = statuses?.entries ? Array.from(statuses.entries()) : [];`,
    `                for (const pair of entries) {`,
    `                  const text = String((pair as Array<unknown>)[1] ?? "").trim();`,
    `                  if (text) out.push(truncateVisible(text, lastWidth));`,
    `                }`,
    `              } catch {}`,
    `              return out;`,
    `            },`,
    `          }));`,
    `        } catch {}`,
    `      }`,
    ``,
    `      async function refresh(ctx: any): Promise<void> {`,
    `        try {`,
    `          if (!ctx || !ctx.hasUI) return;`,
    `        } catch { return; }`,
    `        let entries: Array<unknown> = [];`,
    `        let modelInfo: Record<string, unknown> = {};`,
    `        let usageInfo: Record<string, unknown> | null = null;`,
    `        let sessionId: string | null = null;`,
    `        try {`,
    `          const sm = ctx.sessionManager;`,
    `          if (sm) {`,
    `            if (typeof sm.getBranch === "function") entries = sm.getBranch();`,
    `            else if (typeof sm.getEntries === "function") entries = sm.getEntries();`,
    `            if (typeof sm.getSessionId === "function") {`,
    `              const sid = sm.getSessionId();`,
    `              if (typeof sid === "string" && sid) sessionId = sid;`,
    `            }`,
    `          }`,
    `        } catch {}`,
    `        try {`,
    `          const m = ctx.model ?? {};`,
    `          modelInfo = { id: m.id, displayName: m.displayName, name: m.name, contextWindow: m.contextWindow };`,
    `        } catch {}`,
    `        try {`,
    `          if (typeof ctx.getContextUsage === "function") {`,
    `            const u = ctx.getContextUsage();`,
    `            if (u) usageInfo = { tokens: u.tokens, contextWindow: u.contextWindow, percent: u.percent };`,
    `          }`,
    `        } catch {}`,
    `        if (lastSessionId !== null && sessionId !== null && sessionId !== lastSessionId) {`,
    `          sessionStartMs = Date.now();`,
    `          lines = [];`,
    `          lastApplied = "\\0reset";`,
    `        }`,
    `        if (sessionId !== null) lastSessionId = sessionId;`,
    `        if (!sessionStartMs) sessionStartMs = Date.now();`,
    `        let payload: Record<string, unknown>;`,
    `        try {`,
    `          payload = buildPayload({ cwd: ctx.cwd, sessionId, model: modelInfo, contextUsage: usageInfo, entries }, { nowMs: Date.now(), sessionStartMs });`,
    `        } catch { return; }`,
    `        try { controller?.abort(); } catch {}`,
    `        controller = new AbortController();`,
    `        const signal = controller.signal;`,
    `        let text = "";`,
    `        try {`,
    `          text = await runStatusCommand(STATUS_COMMAND, JSON.stringify(payload), ctx.cwd, signal);`,
    `        } catch { text = ""; }`,
    `        if (signal.aborted) return;`,
    `        const first = (text.split("\\n")[0] ?? "").trim();`,
    `        lines = first ? [first] : [];`,
    `        applyFooter(ctx);`,
    `      }`,
    ``,
    `      function schedule(ctx: any): void {`,
    `        try {`,
    `          if (timer) clearTimeout(timer);`,
    `        } catch {}`,
    `        try {`,
    `          timer = setTimeout(() => { timer = null; void refresh(ctx); }, DEBOUNCE_MS);`,
    `        } catch {}`,
    `      }`,
    ``,
    `      for (const event of ["session_start", "turn_start", "turn_end", "model_select", "session_compact", "session_tree", "session_switch", "session_fork"]) {`,
    `        try {`,
    `          pi.on(event, (_event: any, ctx: any) => { schedule(ctx); });`,
    `        } catch {}`,
    `      }`,
    `      try {`,
    `        pi.on("session_shutdown", (_event: any, ctx: any) => {`,
    `          try { if (timer) clearTimeout(timer); } catch {}`,
    `          timer = null;`,
    `          try { controller?.abort(); } catch {}`,
    `          controller = null;`,
    `          lines = [];`,
    `          lastApplied = "\\0none";`,
    `          sessionStartMs = 0;`,
    `          lastSessionId = null;`,
    `          try { ctx?.ui?.setFooter(undefined); } catch {}`,
    `        });`,
    `      } catch {}`,
    `    }`,
    `  }`,
  ]
}

export interface PiBridgeExtensionInput {
  stats: { staticFiles: number; scopedRules: number; imports: number; skipped: number }
  scopedRules: Array<{ file: string; body: string; globs: Array<string>; source: string }>
}

/**
 * Memory-bridge section for the generated extension: path-scoped rules
 * lazy-attach on `read/edit/write` tool results (once per rule per
 * session, mirroring `pi-code/claude-rules.ts`), plus `/memory` (bridge
 * inventory + auto-memory locations, on-demand only) and `/context`
 * (what bridged vs skipped). Fail-open: every handler is try/catch and
 * returns undefined on any error so Pi native behavior is preserved.
 */
export function buildPiMemoryBridgeSection(bridge: PiBridgeExtensionInput): Array<string> {
  // Cap embedded rule bodies so one giant rule can't bloat the mirror
  // extension source (static slice already has its own 24KB budget).
  // Strip NUL bytes: a single literal U+0000 in an embedded body breaks
  // strict downstream JSON consumers (observed as a workflow-preflight
  // `Unexpected character '\u0000'` parse failure).
  const cappedRules = bridge.scopedRules.map((r) => ({
    file: r.file.replaceAll("\0", ""),
    body: (r.body.length > 8000 ? `${r.body.slice(0, 8000)}\n…[truncated by gh-router memory bridge]` : r.body).replaceAll(
      "\0",
      "",
    ),
    globs: r.globs,
    source: r.source,
  }))
  const payload = JSON.stringify({ stats: bridge.stats, scopedRules: cappedRules })
  return [
    `  // Memory bridge: lazy path-scoped rules + /memory + /context (on-demand only).`,
    `  {`,
    `    let BRIDGE = null;`,
    `    try { BRIDGE = ${payload}; } catch { BRIDGE = null; }`,
    `    const attached = new Set();`,
    `    function globToRegExp(glob) {`,
    `      let g = String(glob || "").trim().replace(/^\\.\\//, "").replace(/^\\/+/, "");`,
    `      let re = "";`,
    `      for (let k = 0; k < g.length;) {`,
    `        const c = g[k];`,
    `        if (c === "*") {`,
    `          if (g[k + 1] === "*") {`,
    `            if (g[k + 2] === "/") { re += "(?:.*/)?"; k += 3; }`,
    `            else { re += ".*"; k += 2; }`,
    `          } else { re += "[^/]*"; k += 1; }`,
    `          continue;`,
    `        }`,
    `        if (c === "?") { re += "[^/]"; k += 1; continue; }`,
    `        if ("+()|^$.{}[]\\\\".includes(c)) re += "\\\\" + c; else re += c;`,
    `        k += 1;`,
    `      }`,
    `      if (!g.includes("/")) re = "(?:.*/)?" + re;`,
    `      try { return new RegExp("^" + re + "$"); } catch { return null; }`,
    `    }`,
    `    function ruleMatches(rule, touchedPath, cwd) {`,
    `      try {`,
    `        const cands = [touchedPath];`,
    `        const base = String(touchedPath || "").split("/").pop() || "";`,
    `        if (base) cands.push(base);`,
    `        let rel = touchedPath || "";`,
    `        try {`,
    `          if (cwd && String(touchedPath).startsWith(String(cwd))) rel = String(touchedPath).slice(String(cwd).length).replace(/^\\/+/, "");`,
    `        } catch {}`,
    `        if (rel) cands.push(rel);`,
    `        for (const g of (rule.globs || [])) {`,
    `          const re = globToRegExp(g);`,
    `          if (!re) continue;`,
    `          for (const c of cands) { try { if (re.test(c)) return true; } catch {} }`,
    `        }`,
    `      } catch {}`,
    `      return false;`,
    `    }`,
    `    try {`,
    `      pi.on("tool_result", async (event, ctx) => {`,
    `        try {`,
    `          if (!BRIDGE || !Array.isArray(BRIDGE.scopedRules) || BRIDGE.scopedRules.length === 0) return undefined;`,
    `          if (event.isError) return undefined;`,
    `          if (event.toolName !== "read" && event.toolName !== "edit" && event.toolName !== "write") return undefined;`,
    `          const rel = event.input && event.input.path;`,
    `          if (typeof rel !== "string" || !rel) return undefined;`,
    `          let abs = rel;`,
    `          try { const cwd = ctx.cwd || ""; abs = rel.startsWith("/") ? rel : (cwd ? cwd + "/" + rel : rel); } catch {}`,
    `          const bodies = [];`,
    `          for (const rule of BRIDGE.scopedRules) {`,
    `            try {`,
    `              if (attached.has(rule.file)) continue;`,
    `              if (!ruleMatches(rule, abs, ctx.cwd || "")) continue;`,
    `              attached.add(rule.file);`,
    `              bodies.push(rule.body);`,
    `            } catch {}`,
    `          }`,
    `          if (bodies.length === 0) return undefined;`,
    `          return { content: [...(event.content || []), ...bodies.map((text) => ({ type: "text", text }))] };`,
    `        } catch { return undefined; }`,
    `      });`,
    `    } catch {}`,
    `    try {`,
    `      pi.registerCommand("memory", {`,
    `        description: "Show bridged memory inventory and auto-memory locations (on-demand; nothing auto-injected)",`,
    `        handler: async (_args, ctx) => {`,
    `          try {`,
    `            const s = (BRIDGE && BRIDGE.stats) || { staticFiles: 0, scopedRules: 0, imports: 0, skipped: 0 };`,
    `            const lines = ["Memory bridge (gh-router)", " Static files: " + s.staticFiles, " Scoped rules (lazy): " + s.scopedRules, " Imports: " + s.imports, " Skipped: " + s.skipped, " Auto-memory: ~/.claude/projects/<slug>/memory/MEMORY.md (on-demand read only)", " Pi memory: ~/.pi/agent/memory/ (your own pi-memory install, snapshotted)"];`,
    `            try {`,
    `              const files = (BRIDGE.scopedRules || []).map((r) => r.file);`,
    `              if (files.length > 0) lines.push(" Scoped files:", ...files.slice(0, 20).map((f) => "  - " + f));`,
    `            } catch {}`,
    `            lines.push("cwd: " + (ctx.cwd || ""));`,
    `            ctx.ui.notify(lines.join("\\n"), "info");`,
    `          } catch {}`,
    `        },`,
    `      });`,
    `    } catch {}`,
    `    try {`,
    `      pi.registerCommand("context", {`,
    `        description: "Show what the gh-router memory bridge loaded",`,
    `        handler: async (_args, ctx) => {`,
    `          try {`,
    `            const s = (BRIDGE && BRIDGE.stats) || { staticFiles: 0, scopedRules: 0, imports: 0, skipped: 0 };`,
    `            ctx.ui.notify("Bridge context: " + s.staticFiles + " static, " + s.scopedRules + " scoped (attached " + attached.size + "), " + s.imports + " imports, " + s.skipped + " skipped. Native AGENTS.md/CLAUDE.md still load via Pi.", "info");`,
    `          } catch {}`,
    `        },`,
    `      });`,
    `    } catch {}`,
    `  }`,
  ]
}

export function buildPiExtensionSource(opts: {
  profileId: PiProfileId
  bridge?: PiBridgeExtensionInput
}): string {
  // Cheapest-only, like the advisor some profiles carry: the brief is the
  // front-end half of the same floor-raising surface `buildPiAppendSystem`
  // writes the consult contract for, and `balanced` is deliberately floor-free
  // on both counts.
  const promptBrief = isCheapestFamily(opts.profileId)
  const lines: Array<string> = []
  lines.push(
    `// gh-router-pi extension (${opts.profileId} mode). Generated per launch; do not edit.`,
    `// Executable seams only. Workflow guidance lives in skills/, not here.`,
    `import { spawn } from "node:child_process";`,
    ``,
    `function stripNul(s) { return String(s ?? "").replace(/\\0/g, ""); }`,
    ...(promptBrief
      ? [
          `const MCP_URL = (process.env.GH_ROUTER_HOOK_MCP_URL ?? "").replace(/\\/+$/, "");`,
          `const MCP_NONCE = process.env.GH_ROUTER_HOOK_NONCE ?? "";`,
          `const PI_WORKSPACE = (process.env.GH_ROUTER_WORKSPACE ?? "").trim();`,
          // Backstop only. The proxy bounds its own rewrite at
          // CHEAPEST_REWRITE_TIMEOUT_MS (30s) and answers with an empty text
          // block on a timeout, so this is what catches a hung socket rather
          // than the normal slow path. Kept above the proxy's bound on purpose:
          // below it we would abort work the proxy was about to return.
          `const BRIEF_TIMEOUT_MS = 45000;`,
        ]
      : []),
    `const LEAD_MODEL = ${JSON.stringify(`${PI_PROVIDER_NAME}/${piLeadModel(opts.profileId)}`)};`,
    `const LEAD_THINKING = ${JSON.stringify(piLeadThinking(opts.profileId))};`,
    `void LEAD_MODEL; void LEAD_THINKING;`,
    ``,
    ...(promptBrief
      ? [
          // The prompt-submit relay is the extension's only MCP call now. Every
          // model-facing tool arrives through Pi's own `mcp.json` (native MCP),
          // so the workspace header is set on the server entry rather than
          // here; this call still sends it because the hook channel is a raw
          // fetch and the proxy reads the header, not a workspace argument.
          `async function callMcp(group, tool, args, signal) {`,
          `  const headers = { "content-type": "application/json", accept: "application/json", authorization: "Bearer " + MCP_NONCE };`,
          `  if (PI_WORKSPACE) { headers["X-GH-Workspace"] = PI_WORKSPACE; }`,
          `  const res = await fetch(MCP_URL + "/mcp/" + group, {`,
          `    method: "POST",`,
          `    headers,`,
          `    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: args } }),`,
          `    signal,`,
          `  });`,
          `  if (!res.ok) throw new Error("mcp " + group + "/" + tool + " -> HTTP " + res.status);`,
          `  const body = await res.json();`,
          `  if (body.error) return "Error: " + body.error.message;`,
          `  const content = body.result && body.result.content;`,
          `  if (!Array.isArray(content)) return "";`,
          `  return content.map((c) => c.text || "").join("\\n");`,
          `}`,
          ``,
        ]
      : []),
    `export default function (pi) {`,
  )
  if (opts.bridge && opts.bridge.scopedRules.length + opts.bridge.stats.staticFiles > 0) {
    lines.push(...buildPiMemoryBridgeSection(opts.bridge))
  }
  lines.push(
    // Statusline footer (always on — like Claude's operating defaults, not a
    // flag surface): owns Pi's footer with the shared internal-aic-status
    // runner. No third-party statusline package, no settings block.
    ...buildPiStatuslineFooterSection(),
    // Plan mode: always on, no flag. Claude Code ships plan mode as a mode; Pi
    // ships it as an example extension, so parity means generating it per launch.
    ...buildPiPlanModeSection(),
    `  // Route compaction summaries to the mode's cheap capable model;`,
    `  // ALWAYS fall back to Pi native (return undefined) on any failure.`,
    `  pi.on("session_before_compact", async (event) => {`,
    `    try {`,
    `      const preparation = event.preparation;`,
    `      if (!preparation || !Array.isArray(preparation.messagesToSummarize)) return undefined;`,
    `      return undefined; // v1: observe only; native pipeline stays authoritative.`,
    `    } catch {`,
    `      return undefined;`,
    `    }`,
    `  });`,
    ...(promptBrief
      ? [
          // The Claude front-end for this is the `UserPromptSubmit` hook
          // (`internal-prompt-submit`), which runs in its own process and can
          // import the rewrite code. This extension cannot: it is a generated
          // STRING whose only imports are typebox and node:child_process. So the
          // rewrite runs in the PROXY and this handler is a thin relay.
          `  // Cheapest-profile execution brief, injected ABOVE the model's turn.`,
          `  // Produced server-side; this only relays the prompt and re-emits the`,
          `  // result as a custom message. Additive: the user prompt stays the user`,
          `  // turn and systemPrompt is never replaced.`,
          `  let briefShapeWarned = false;`,
          `  pi.on("before_agent_start", async (event, ctx) => {`,
          `    try {`,
          `      if (!event || typeof event !== "object") return undefined;`,
          `      // Shape probe: Pi 1.3 carries messageType; the older flat shape does`,
          `      // not, and a missing discriminator would make the brief silently`,
          `      // never fire. Report once rather than no-op forever.`,
          `      if (!("messageType" in event)) {`,
          `        if (!briefShapeWarned) {`,
          `          briefShapeWarned = true;`,
          `          try { ctx.ui.notify("gh-router: this Pi build's before_agent_start has no messageType, so the cheapest prompt brief is inactive. Re-run github-router pi to update Pi.", "warning"); } catch {}`,
          `        }`,
          `        return undefined;`,
          `      }`,
          `      if (event.messageType !== "user") return undefined;`,
          `      // Stand down inside a pi-subagents async runner: that process hosts`,
          `      // CHILD sessions which load this extension too, and every child would`,
          `      // otherwise spend a brief of its own. pi-subagents marks the process`,
          `      // with PI_SUBAGENT_CHILD=1 (subagent-runner.js). Foreground subagents`,
          `      // run with ambient extensions off, so they never reach here.`,
          `      if (process.env.PI_SUBAGENT_CHILD === "1") return undefined;`,
          `      const prompt = String(event.prompt || "").trim();`,
          `      if (!prompt) return undefined;`,
          `      const sm = ctx && ctx.sessionManager;`,
          `      const sid = sm && typeof sm.getSessionId === "function" ? sm.getSessionId() : "";`,
          `      if (typeof sid !== "string" || !sid) return undefined;`,
          `      const ac = new AbortController();`,
          `      const timer = setTimeout(() => { try { ac.abort(); } catch {} }, BRIEF_TIMEOUT_MS);`,
          `      let reply = "";`,
          `      try {`,
          `        reply = await callMcp("search", "prompt_brief", PI_WORKSPACE ? { prompt, session_id: sid, workspace: PI_WORKSPACE } : { prompt, session_id: sid }, ac.signal);`,
          `      } finally { clearTimeout(timer); }`,
          `      const text = stripNul(String(reply || "")).trim();`,
          `      // Fail open: a miss, a refusal, or a transport error injects NOTHING`,
          `      // and never blocks the prompt. callMcp returns an "Error: " string`,
          `      // for a JSON-RPC error and throws on a non-OK HTTP status. The`,
          `      // proxy answers a decline (wrong profile, trivial prompt, already`,
          `      // spent, rewrite timeout) with an empty text block.`,
          `      if (!text || text.indexOf("Error: ") === 0 || text.indexOf("prompt_brief") === 0) return undefined;`,
          `      // display:false keeps it context, not conversation (convertToLlm maps`,
          `      // every custom message to a user message regardless of display).`,
          `      return { message: { customType: "gh-router-prompt-brief", content: text, display: false } };`,
          `    } catch {`,
          `      return undefined;`,
          `    }`,
          `  });`,
        ]
      : []),
    `}`,
    ``,
  )
  return `${lines.join("\n")}\n`
}

export interface PiSkillDoc {
  dir: string
  content: string
}

/**
 * Workflow guidance as skills (progressive disclosure, not tools).
 * Ownership mirrors the Claude launcher: peer consult prose rides
 * `--peers`, semantic-search prose rides `--search`, and the
 * delegation/review pipeline rides `--swe` AND `--peers` — without
 * agents + the subagent provider its prose dangles, so peerless+swe
 * emits none. A bare launch emits NO skills at all.
 */
export function buildPiSkills(opts: {
  profileId: PiProfileId
  peers?: boolean
  swe?: boolean
  search?: boolean
}): Array<PiSkillDoc> {
  const peers = opts.peers !== false
  const skills: Array<PiSkillDoc> = []
  if (peers && piOracleEnabled(opts.profileId)) {
    // The oracle is reachable two ways, and the skill must name the one this
    // profile actually has. Copilot profiles carry the stateless MCP persona
    // (and the same-named subagent for follow-ups); a profile whose peer group
    // filters the persona out carries only the subagent, so naming the MCP tool
    // there would send the model after a tool that answers -32601. Every shipped
    // profile reaches the persona today (including `local`, whose consult runs
    // on the local tier); the subagent-only wording stays for a profile that
    // ever narrows the allowlist back.
    const oracleReachable = piOracleToolReachable(opts.profileId)
    const oracleBody = oracleReachable
      ? [
          "Call `mcp__gh-router-peers__oracle` (load it with `tool_search` if it is",
          "not in the tool list yet) with the decision, the options considered, and",
          "the missing-context gaps. The oracle is cold-start: it sees only what you",
          "pass. Its verdict is advisory — verify with tests and code, never",
          "substitute votes for verification. (The MCP tool is the one-shot consult;",
          "the `oracle` subagent is the same role for interactive follow-ups — same",
          "name, different invocation. Prefer the tool for a single verdict.)",
        ]
      : [
          "Delegate to the `oracle` subagent through the `subagent` tool with the",
          "decision, the options considered, and the missing-context gaps. The",
          "oracle is cold-start and tool-less: it sees only what you pass, and it",
          "cannot read the repository on its own. Its verdict is advisory — verify",
          "with tests and code, never substitute votes for verification.",
        ]
    skills.push({
      dir: "gh-oracle",
      content: [
        "---",
        "name: gh-oracle",
        "description: Consult the oracle for a second opinion on risky decisions. Use when the decision itself feels risky.",
        "---",
        "",
        "# Oracle consult",
        "",
        ...oracleBody,
      ].join("\n"),
    })
  }
  if (opts.search === true) {
    skills.push({
      dir: "gh-search-first",
      content: [
        "---",
        "name: gh-search-first",
        "description: Search the workspace semantically before reading broadly. Use when locating code by meaning.",
        "---",
        "",
        "# Search first",
        "",
        "Use `mcp__gh-router-search__code` (semantic by default; load it with",
        "`tool_search` if it is not in the tool list yet) before broad reads. The",
        "response labels its `source`: `semantic`, `lexical`, or",
        "`lexical-fallback` — a fallback is never silent, so retry narrower on",
        "fallback rather than assuming full coverage.",
      ].join("\n"),
    })
  }
  if (opts.swe === true && peers) {
    // The roster line must not name a consultant this profile has neither a
    // tool nor an agent file for: balanced and `local` are advisor-free, so
    // they name the oracle alone. Composing the sentence per case keeps a `, .`
    // (or a comma before nothing) out of the prose — which is also what a
    // profile with neither consultant would get.
    const advisor = piAdvisorModel(opts.profileId)
    const oracle = piOracleEnabled(opts.profileId)
    const consults = advisor
      ? "`oracle`/`advisor` for consults"
      : oracle
        ? "`oracle` for consults"
        : undefined
    const rosterLine = consults
      ? `for verification, ${consults} (builtin \`scout\` and`
      : "for verification. (Builtin `scout` and"
    skills.push({
      dir: "gh-delegate",
      content: [
        "---",
        "name: gh-delegate",
        "description: Delegate scoped work to subagents with isolated context. Use for recon, implementation, and review loops.",
        "---",
        "",
        "# Delegate",
        "",
        "You may delegate via the `subagent` tool to this roster only: `Explore`",
        "for discovery, `General-Purpose` for scoped implementation, `reviewer`",
        rosterLine,
        "`worker` are disabled in this session; their aliases resolve here.)",
        "Recommended loop: `Explore` to map the code, paste the brief excerpts",
        "into the `General-Purpose` brief to implement, `reviewer` to check,",
        "`General-Purpose` to apply feedback. Keep delegated tasks",
        "scoped with file:line evidence on return.",
        "Call `subagent` directly (agent + task). Reserve `workflowScript`",
        "workflows for genuinely parallel or scripted multi-step fanout —",
        "our agents run foreground and background runs add spawn overhead.",
        "After any subagent work completes, always write the final answer",
        "yourself; never end on tool output or completion notices alone.",
        isBalancedFamily(opts.profileId)
          ? "Send work to reviewer ONLY when the change alters behavior."
          : "Send finished work to reviewer for assessment.",
      ].join("\n"),
    })
    if (piAdvisorModel(opts.profileId)) {
      skills.push({
        dir: "gh-advisor",
        content: [
          "---",
          "name: gh-advisor",
          "description: Advisory review of the final plan before presenting it. Use when the lead has a plan ready.",
          "---",
          "",
          "# Advisor review",
          "",
          "The lead plans directly (there is no Plan subagent). Review the final plan",
          "with the `advisor` subagent before presenting it. Advisory only: it never",
          "executes and never overrides verification.",
        ].join("\n"),
      })
    }
  }
  return skills
}

export interface PiPromptDoc {
  name: string
  content: string
}

/**
 * Saved workflow shortcuts as prompt templates (`/name`). The review
 * pipeline is SWE-pipeline surface: only `--swe` AND `--peers` emit
 * prompts (peerless launches have no agents behind them), so a bare
 * launch advertises none.
 *
 * `/parallel-review` intentionally shadows the packaged pi-subagents
 * prompt of the same name (package prompts are filtered to `[]` in
 * settings): ours routes to our pinned-model `reviewer`, not the
 * default-model builtin. `/review` is novel — no packaged collision.
 */
export function buildPiPrompts(opts: {
  profileId: PiProfileId
  swe?: boolean
  peers?: boolean
}): Array<PiPromptDoc> {
  if (opts.swe !== true || opts.peers === false) return []
  const prompts: Array<PiPromptDoc> = [
    {
      name: "review",
      content: [
        "---",
        'description: Review the current changes with the reviewer subagent',
        'argument-hint: "[focus]"',
        "---",
        "Have the reviewer subagent review the current changes. Focus on ${1:-correctness, tests, and simplicity}.",
      ].join("\n"),
    },
    {
      name: "parallel-review",
      content: [
        "---",
        'description: Run parallel reviewer passes over the change',
        'argument-hint: "[focus]"',
        "---",
        "Run parallel reviewers: one for correctness, one for tests, one for unnecessary complexity. Focus: ${1:-the current diff}.",
      ].join("\n"),
    },
  ]
  if (piAdvisorModel(opts.profileId)) {
    prompts.push({
      name: "plan-review",
      content: [
        "---",
        'description: Advisory review of the current plan before presenting',
        'argument-hint: "[plan]"',
        "---",
        "Review the final plan with the advisor subagent (advisory) before presenting it: ${1:-the current plan}.",
      ].join("\n"),
    })
  }
  return prompts
}
