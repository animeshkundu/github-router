import type { PiProfileId } from "./pi-models-settings"
import {
  PI_PROVIDER_NAME,
  piAdvisorModel,
  piLeadModel,
  piLeadThinking,
  piOracleModel,
  piOracleThinking,
} from "./pi-models-settings"
import {
  AIC_STATUSLINE_DISABLE_ENV,
} from "./aic-statusline-settings"
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
 * Design (Pi-cooperative): executable seams only — oracle/advisor
 * consult, semantic search, and browser dispatch all POST JSON-RPC
 * `tools/call` to the running proxy's `/mcp/<group>` with the
 * per-launch nonce (the same `GH_ROUTER_HOOK_MCP_URL/NONCE` channel the
 * Claude hooks use), then return the text. No custom provider, no
 * compaction replacement: `session_before_compact` only routes the
 * summary model and always falls back to Pi native on failure.
 *
 * Statusline footer (always on): this extension owns Pi's footer and
 * renders the SAME `internal-aic-status` runner Claude Code uses, fed a
 * natively-built Claude-shaped payload — one renderer, identical
 * segments. There is deliberately no third-party statusline package and
 * no `statusLine` settings block (the community bridge only reads the
 * user's real global/project settings, never the launch mirror).
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

export function buildPiExtensionSource(opts: {
  profileId: PiProfileId
  searchEnabled: boolean
  browseEnabled: boolean
  peers?: boolean
}): string {
  const peers = opts.peers !== false
  const advisor = peers ? piAdvisorModel(opts.profileId) : undefined
  const oracleModel = piOracleModel(opts.profileId)
  const oracleThinking = piOracleThinking(opts.profileId)
  const lines: Array<string> = []
  lines.push(
    `// gh-router-pi extension (${opts.profileId} mode). Generated per launch; do not edit.`,
    `// Executable seams only. Workflow guidance lives in skills/, not here.`,
    `import { Type } from "typebox";`,
    `import { spawn } from "node:child_process";`,
    ``,
    ...(peers
      ? [
          `const OracleParams = Type.Object({`,
          `  decision: Type.String({ description: "The risky decision to get a second opinion on" }),`,
          `  options: Type.Optional(Type.String({ description: "Options considered" })),`,
          `  context: Type.String({ description: "Missing-context gaps and background the cold-start oracle needs" }),`,
          `});`,
        ]
      : []),
    ...(advisor
      ? [
          `const AdvisorParams = Type.Object({`,
          `  plan: Type.String({ description: "The final plan to review (advisory)" }),`,
          `  context: Type.Optional(Type.String({ description: "Background context" })),`,
          `});`,
        ]
      : []),
    `const CodeSearchParams = Type.Object({`,
    `  query: Type.String({ description: "What to find" }),`,
    `  mode: Type.Optional(Type.String({ description: "semantic (default), lexical, exact, regex, or ast" })),`,
    `  limit: Type.Optional(Type.Number({ description: "Max results" })),`,
    `});`,
    `const BrowserParams = Type.Object({`,
    `  url: Type.Optional(Type.String({ description: "URL to act on" })),`,
    `  intent: Type.Optional(Type.String({ description: "What to do on the page" })),`,
    `});`,
    `async function toolText(promise) {`,
    `  const text = await promise;`,
    `  return { content: [{ type: "text", text }], details: undefined };`,
    `}`,
    `const MCP_URL = (process.env.GH_ROUTER_HOOK_MCP_URL ?? "").replace(/\\/+$/, "");`,
    `const MCP_NONCE = process.env.GH_ROUTER_HOOK_NONCE ?? "";`,
    ...(peers
      ? [
          `const ORACLE_MODEL = ${JSON.stringify(`${PI_PROVIDER_NAME}/${oracleModel}`)};`,
          `const ORACLE_THINKING = ${JSON.stringify(oracleThinking)};`,
        ]
      : []),
    ...(advisor
      ? [
          `const ADVISOR_MODEL = ${JSON.stringify(`${PI_PROVIDER_NAME}/${advisor.model}`)};`,
          `const ADVISOR_THINKING = ${JSON.stringify(advisor.thinking)};`,
        ]
      : []),
    `const LEAD_MODEL = ${JSON.stringify(`${PI_PROVIDER_NAME}/${piLeadModel(opts.profileId)}`)};`,
    `const LEAD_THINKING = ${JSON.stringify(piLeadThinking(opts.profileId))};`,
    ``,
    `async function callMcp(group, tool, args, signal) {`,
    `  const res = await fetch(MCP_URL + "/mcp/" + group, {`,
    `    method: "POST",`,
    `    headers: { "content-type": "application/json", accept: "application/json", authorization: "Bearer " + MCP_NONCE },`,
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
    `export default function (pi) {`,
    ...(peers
      ? [
          `  pi.registerTool({`,
          `    name: "oracle",`,
          `    label: "Oracle",`,
          `    description: "Second opinion before acting on a risky decision. Advisory only: challenges assumptions, never edits. Pass decision, options, and context.",`,
          `    parameters: OracleParams,`,
          `    async execute(_toolCallId, params, signal) {`,
          `      return await toolText(callMcp("peers", "oracle", { decision: params.decision, options: params.options || "", context: params.context, model: ORACLE_MODEL, thinking: ORACLE_THINKING }, signal));`,
          `    },`,
          `  });`,
        ]
      : []),
  )
  if (advisor) {
    lines.push(
      `  pi.registerTool({`,
      `    name: "advisor",`,
      `    label: "Advisor",`,
      `    description: "Advisory plan review for the lead: review the final plan before presenting it. Never executes.",`,
      `    parameters: AdvisorParams,`,
      `    async execute(_toolCallId, params, signal) {`,
      `      return await toolText(callMcp("peers", "oracle", { decision: "Review this plan (advisory)", options: params.plan, context: params.context || "", model: ADVISOR_MODEL, thinking: ADVISOR_THINKING }, signal));`,
      `    },`,
      `  });`,
    )
  }
  if (opts.searchEnabled) {
    lines.push(
      `  pi.registerTool({`,
      `    name: "code_search",`,
      `    label: "Code search",`,
      `    description: "Semantic-first code search over the workspace index (falls back to lexical with a label). Use for finding code by meaning.",`,
      `    parameters: CodeSearchParams,`,
      `    async execute(_toolCallId, params, signal) {`,
      `      return await toolText(callMcp("search", "code", { query: params.query, mode: params.mode || "semantic", limit: params.limit || 15 }, signal));`,
      `    },`,
      `  });`,
    )
  }
  if (opts.browseEnabled) {
    lines.push(
      `  const BROWSER_TOOLS = ["browser_open_tab", "browser_navigate", "browser_screenshot", "browser_act", "browser_observe", "browser_extract"];`,
      `  for (const wireName of BROWSER_TOOLS) {`,
      `    pi.registerTool({`,
      `      name: wireName,`,
      `      description: "Browser control (" + wireName + "). Returns install_required with setup steps when the extension is not loaded.",`,
      `      parameters: BrowserParams,`,
      `      async execute(_toolCallId, params, signal) {`,
      `        return await toolText(callMcp("browser", wireName, { url: params.url || "", intent: params.intent || "" }, signal));`,
      `      },`,
      `    });`,
      `  }`,
    )
  }
  lines.push(
    // Statusline footer (always on — like Claude's operating defaults, not a
    // flag surface): owns Pi's footer with the shared internal-aic-status
    // runner. No third-party statusline package, no settings block.
    ...buildPiStatuslineFooterSection(),
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
 * delegation/review pipeline rides `--swe`. A bare launch emits NO
 * skills at all.
 */
export function buildPiSkills(opts: {
  profileId: PiProfileId
  peers?: boolean
  swe?: boolean
  search?: boolean
}): Array<PiSkillDoc> {
  const peers = opts.peers !== false
  const skills: Array<PiSkillDoc> = []
  if (peers) {
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
        "Call the `oracle` tool with the decision, the options considered, and the",
        "missing-context gaps. The oracle is cold-start: it sees only what you pass.",
        "Its verdict is advisory — verify with tests and code, never substitute votes",
        "for verification.",
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
        "Use `code_search` (semantic by default) before broad reads. The response",
        "labels its `source`: `semantic`, `lexical`, or `lexical-fallback` — a",
        "fallback is never silent, so retry narrower on fallback rather than",
        "assuming full coverage.",
      ].join("\n"),
    })
  }
  if (opts.swe === true) {
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
        "Recommended loop: scout (Explore) before you understand the code, worker",
        "(General-Purpose) to implement, fresh reviewers to check, worker to apply",
        "feedback. Keep delegated tasks scoped with file:line evidence on return.",
        opts.profileId === "balanced"
          ? "Send work to reviewer ONLY when the change alters behavior."
          : "Send finished work to reviewer for assessment.",
      ].join("\n"),
    })
    if (peers && piAdvisorModel(opts.profileId)) {
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
          "with the `advisor` tool before presenting it. Advisory only: it never",
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
 * pipeline is SWE-pipeline surface: only `--swe` emits prompts, so a
 * bare launch advertises none.
 */
export function buildPiPrompts(opts: {
  profileId: PiProfileId
  swe?: boolean
}): Array<PiPromptDoc> {
  if (opts.swe !== true) return []
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
        "Review the final plan with the advisor tool (advisory) before presenting it: ${1:-the current plan}.",
      ].join("\n"),
    })
  }
  return prompts
}
