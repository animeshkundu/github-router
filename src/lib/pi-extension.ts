import type { PiProfileId } from "./pi-models-settings"
import {
  PI_PROVIDER_NAME,
  piAdvisorModel,
  piLeadModel,
  piLeadThinking,
  piOracleModel,
  piOracleThinking,
} from "./pi-models-settings"

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
 */

export function buildPiExtensionSource(opts: {
  profileId: PiProfileId
  searchEnabled: boolean
  browseEnabled: boolean
}): string {
  const advisor = piAdvisorModel(opts.profileId)
  const oracleModel = piOracleModel(opts.profileId)
  const oracleThinking = piOracleThinking(opts.profileId)
  const lines: Array<string> = []
  lines.push(
    `// gh-router-pi extension (${opts.profileId} mode). Generated per launch; do not edit.`,
    `// Executable seams only. Workflow guidance lives in skills/, not here.`,
    `const MCP_URL = (process.env.GH_ROUTER_HOOK_MCP_URL ?? "").replace(/\\/+$/, "");`,
    `const MCP_NONCE = process.env.GH_ROUTER_HOOK_NONCE ?? "";`,
    `const ORACLE_MODEL = ${JSON.stringify(`${PI_PROVIDER_NAME}/${oracleModel}`)};`,
    `const ORACLE_THINKING = ${JSON.stringify(oracleThinking)};`,
    advisor
      ? `const ADVISOR_MODEL = ${JSON.stringify(`${PI_PROVIDER_NAME}/${advisor.model}`)};`
      : `const ADVISOR_MODEL = null;`,
    advisor
      ? `const ADVISOR_THINKING = ${JSON.stringify(advisor.thinking)};`
      : `const ADVISOR_THINKING = null;`,
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
    `  pi.registerTool({`,
    `    name: "oracle",`,
    `    description: "Second opinion before acting on a risky decision. Advisory only: challenges assumptions, never edits. Pass decision, options, and context.",`,
    `    inputSchema: { type: "object", properties: { decision: { type: "string" }, options: { type: "string" }, context: { type: "string" } }, required: ["decision", "context"] },`,
    `    async execute(args, ctx) {`,
    `      return await callMcp("peers", "oracle", { ...args, model: ORACLE_MODEL, thinking: ORACLE_THINKING }, ctx && ctx.signal);`,
    `    },`,
    `  });`,
  )
  if (advisor) {
    lines.push(
      `  pi.registerTool({`,
      `    name: "advisor",`,
      `    description: "Advisory plan review for the lead: review the final plan before presenting it. Never executes.",`,
      `    inputSchema: { type: "object", properties: { plan: { type: "string" }, context: { type: "string" } }, required: ["plan"] },`,
      `    async execute(args, ctx) {`,
      `      return await callMcp("peers", "oracle", { decision: "Review this plan (advisory)", options: args.plan, context: args.context || "", model: ADVISOR_MODEL, thinking: ADVISOR_THINKING }, ctx && ctx.signal);`,
      `    },`,
      `  });`,
    )
  }
  if (opts.searchEnabled) {
    lines.push(
      `  pi.registerTool({`,
      `    name: "code_search",`,
      `    description: "Semantic-first code search over the workspace index (falls back to lexical with a label). Use for finding code by meaning.",`,
      `    inputSchema: { type: "object", properties: { query: { type: "string" }, mode: { type: "string" }, limit: { type: "number" } }, required: ["query"] },`,
      `    async execute(args, ctx) {`,
      `      return await callMcp("search", "code", { query: args.query, mode: args.mode || "semantic", limit: args.limit || 15 }, ctx && ctx.signal);`,
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
      `      inputSchema: { type: "object", properties: { url: { type: "string" }, intent: { type: "string" } } },`,
      `      async execute(args, ctx) {`,
      `        return await callMcp("browser", wireName, args, ctx && ctx.signal);`,
      `      },`,
      `    });`,
      `  }`,
    )
  }
  lines.push(
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

/** Workflow guidance as skills (progressive disclosure, not tools). */
export function buildPiSkills(profileId: PiProfileId): Array<PiSkillDoc> {
  const skills: Array<PiSkillDoc> = [
    {
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
    },
    {
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
    },
    {
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
        profileId === "balanced"
          ? "Send work to reviewer ONLY when the change alters behavior."
          : "Send finished work to reviewer for assessment.",
      ].join("\n"),
    },
  ]
  if (piAdvisorModel(profileId)) {
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
  return skills
}

export interface PiPromptDoc {
  name: string
  content: string
}

/** Saved workflow shortcuts as prompt templates (`/name`). */
export function buildPiPrompts(profileId: PiProfileId): Array<PiPromptDoc> {
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
  if (piAdvisorModel(profileId)) {
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
