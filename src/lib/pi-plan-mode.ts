/**
 * Plan mode: a Claude Code-style planning mode for `github-router pi`.
 *
 * Pi ships no plan mode (upstream README: "skips features like sub-agents and
 * plan mode"); the reference implementation is an *example*
 * (`examples/extensions/plan-mode/`) that the user must install separately.
 * This module ports the behaviour into the router's own generated extension so
 * every launch has it, tuned for FRONTIER models rather than for a defensive
 * worst case.
 *
 * The design follows Claude Code's own plan mode (`2.1.322`), whose prompt is
 * reproduced here as behaviour rather than quoted, plus the published
 * guidance from Anthropic and OpenAI on planning before coding:
 *
 * 1. **One barrier, the one that matters.** `edit`, `write` and `apply_patch`
 *    leave the active set, and a call that arrives anyway is refused. Nothing
 *    else is gated: bash, powershell, MCP tools, delegation and todo writes are
 *    all available, because a frontier model asked to investigate a codebase
 *    needs them and a hand-maintained read-only command table is both
 *    impossible to keep correct (`awk 'BEGIN{system("sh")}'`) and insulting to
 *    a model that was told what the mode is for. Claude Code gates tools by
 *    capability, not by parsing command strings, and so does this.
 * 2. **One file may be written: the plan.** Claude Code's plan mode is not
 *    read-only, it is *one-write* mode — the model builds its plan
 *    incrementally in a single designated file and the user can open, edit and
 *    approve that file. The file is pinned by the extension (never chosen by
 *    the model), so the exception cannot widen: `write`/`edit` are refused
 *    unless the resolved path is exactly the plan path.
 * 3. **Always on, no `--plan` flag.** The user toggles with `Ctrl+Alt+P` or
 *    `/plan`. A registered flag would have to survive `collectPiPassthroughArgs`
 *    and pi's own unknown-flag rejection; registering nothing keeps that path
 *    untouched.
 * 4. **Exact tool save/restore.** Upstream re-derives the normal set from a
 *    hardcoded `NORMAL_MODE_TOOLS`, which would silently re-enable `edit` and
 *    `write` that a caller's `--tools` narrowing had removed. We snapshot
 *    `pi.getActiveTools()` on entry and restore that array verbatim.
 * 5. **No `@earendil-works/pi-agent-core` import.** Upstream imports its message
 *    types; generated extensions may only import host-provided specifiers
 *    (`typebox`, `@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`,
 *    `@earendil-works/pi-tui`), so the emitted source carries local structural
 *    types and zero runtime imports.
 * 6. **Step text keeps its verb.** Upstream strips a leading `Read`/`Add`/`Use`,
 *    turning "Read the launcher" into "Launcher"; the checklist is what the user
 *    reads while the plan runs, so the action stays.
 *
 * The prompt itself is two blocks, not two hundred lines: the mode contract
 * (what is closed and why) and the workflow (explore, ask, design, write the
 * plan, hand over). Both are modelled on Claude Code's, including its tolerance
 * for the model's judgement — "read-only actions" is a rule the model applies,
 * not a table the harness enforces.
 *
 * Every API the emitted source touches was verified against the pi 1.3.0 tarball
 * (`PI_MIN_VERSION`), not just the current docs: `getActiveTools`/`setActiveTools`
 * (types.d.ts:1282/1291), `registerShortcut` (:1233), `registerCommand` (:1231),
 * `appendEntry` (:1272), `getAllTools` (:1285), `ui.setStatus` (:84),
 * `ui.setWidget` (:101), `ui.theme` (:179), `sessionManager.getEntries`
 * (session-manager.d.ts:334), and `before_agent_start` carrying `messageType`
 * (:729/737). No 1.4/1.5-only API is used, so the 1.3.0 floor stands.
 *
 * Fail-open by construction: the emitted factory feature-probes every API it
 * uses, so a pi that grew or dropped one degrades to "no plan mode" rather than
 * a broken session — the same contract as the statusline footer.
 */

/** A step parsed out of the model's `Plan:` block. */
export interface PlanStep {
  step: number
  text: string
  completed: boolean
}

/**
 * Strip markdown noise from one step's text.
 *
 * Upstream also strips a leading imperative (`Read`/`Add`/`Use`…), which
 * turns "Read the launcher" into "Launcher". Divergence 5: keep the verb. The
 * checklist is what the user reads while the plan runs, and a bare noun loses
 * the action it is meant to check off.
 */
export function cleanPlanStepText(text: string): string {
  return String(text ?? "")
    .replace(/\*{1,2}([^*]+)\*{1,2}/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\s+/g, " ")
    .trim()
}

/**
 * Parse the model's numbered plan into steps.
 *
 * Takes the LAST `Plan:` section on purpose: the caller feeds this everything
 * the model wrote for a turn, including thinking blocks, and with reasoning-max
 * models a draft plan often lands in thinking before the visible one. The
 * visible text block comes last in content order, so last-wins picks the plan
 * the user actually saw.
 */
export function extractPlanSteps(message: string): Array<PlanStep> {
  const items: Array<PlanStep> = []
  const text = String(message ?? "")
  const headers = [...text.matchAll(/\*{0,2}Plan:\*{0,2}\s*\n/gi)]
  if (headers.length === 0) return items
  const lastHeader = headers[headers.length - 1]!
  const planSection = text.slice((lastHeader.index ?? 0) + lastHeader[0].length)
  const numbered = /^\s*(\d+)[.)]\s+(.+)$/gm
  const used = new Set<number>()
  for (const match of planSection.matchAll(numbered)) {
    const raw = (match[2] ?? "").trim().replace(/\*{1,2}$/, "").trim()
    if (raw.length > 5 && !raw.startsWith("/") && !raw.startsWith("-")) {
      const cleaned = cleanPlanStepText(raw)
      if (cleaned.length > 3) {
        // Keep the model's own number when it is usable: the checklist echoes it
        // back, and a plan that starts at "5." would otherwise be renumbered
        // 1..N while the model keeps tagging `[DONE:5]`, which would never match.
        // A duplicate or a zero falls back to position so every step has a key.
        const declared = Number(match[1])
        const step = Number.isInteger(declared) && declared > 0 && !used.has(declared) ? declared : items.length + 1
        used.add(step)
        items.push({ step, text: cleaned, completed: false })
      }
    }
  }
  return items
}

/**
 * Steps the model reported as finished. Accepts `[DONE:2]`, `[DONE 2]`,
 * `Done: 2`, and "Step 2 is complete" — the last one adjacency-anchored so
 * "Step 9 is not done" never marks anything.
 */
export function extractDoneSteps(message: string): Array<number> {
  const text = String(message ?? "")
  const steps: Array<number> = []
  for (const match of text.matchAll(/\[DONE\s*:?\s*(\d+)\]/gi)) {
    steps.push(Number(match[1]))
  }
  for (const match of text.matchAll(/\bDone\s*:\s*(\d+)\b/gi)) {
    steps.push(Number(match[1]))
  }
  for (const match of text.matchAll(
    /\bStep\s*(\d+)\s+(?:is\s+)?(?:done|complete|completed|finished)\b/gi,
  )) {
    steps.push(Number(match[1]))
  }
  return [...new Set(steps)]
}

/** Mark reported steps complete in place; returns how many became complete. */
export function applyDoneSteps(text: string, items: Array<PlanStep>): number {
  let marked = 0
  for (const step of extractDoneSteps(text)) {
    const item = items.find((candidate) => candidate.step === step && !candidate.completed)
    if (item) {
      item.completed = true
      marked++
    }
  }
  return marked
}

/**
 * Whole-plan completion phrasing, consulted only on a run's final message as a
 * fallback for a model that summarizes instead of tagging each step.
 */
export function planAllStepsComplete(message: string): boolean {
  const text = String(message ?? "")
  return (
    /(?:all|every)\s+steps?\s+(?:are|is\s+)?(?:done|complete|completed|finished)/i.test(text) ||
    /\b(?:the\s+)?plan\s+(?:is\s+)?(?:complete|completed|done)\b/i.test(text)
  )
}

/**
 * Tools plan mode removes from the active set AND refuses by name.
 *
 * Two independent barriers, exactly as before — what changed is the SCOPE.
 * Claude Code's plan mode is `disallowedTools: [Edit, Write, NotebookEdit]`;
 * everything else (bash, MCP, subagents, the todo store) stays available and the
 * model is trusted to apply "explore, do not implement". Every extra entry this
 * list used to carry was a claim that a frontier model could not be trusted
 * with a shell it was told to only read with, and each such claim cost
 * capability the planning turn actually needed (`git log`, `rg`, a build to see
 * whether the tests pass).
 *
 * `apply_patch` is here because some hosts expose a patch tool that writes by
 * another name; pi's own writers are `edit` and `write`.
 */
export const PLAN_BLOCKED_TOOLS: ReadonlyArray<string> = Object.freeze([
  "edit",
  "write",
  "apply_patch",
])

/**
 * The plan file, relative to the workspace.
 *
 * Claude Code pins one path per session and tells the model "this is the only
 * file you are allowed to edit". Ours is the repository's existing convention
 * (`.github-router/plans/<slug>/plan.md`, the same artifact `/gh-plan` writes and
 * `/gh-implement` reads), with a stable slug so a resumed session keeps editing
 * the plan it started rather than opening a second one.
 */
export function planFilePath(): string {
  return ".github-router/plans/pi-plan/plan.md"
}

/** Session entry type for persisting plan state across resume. */
export const PLAN_MODE_ENTRY = "gh-router-plan-mode"

/** Status/widget keys, namespaced so another extension cannot collide. */
export const PLAN_STATUS_KEY = "gh-router-plan"
export const PLAN_WIDGET_KEY = "gh-router-plan-steps"

/** Custom message types the emitted extension emits and later filters. */
export const PLAN_CONTEXT_TYPE = "gh-router-plan-context"
export const PLAN_EXEC_TYPE = "gh-router-plan-exec"
export const PLAN_DONE_TYPE = "gh-router-plan-done"
export const PLAN_LIST_TYPE = "gh-router-plan-list"

/**
 * Resolve `path` against `cwd` and decide whether it IS the plan file.
 *
 * Deliberately dumb and deliberately strict: this is the one hole in the write
 * barrier, so it compares `path.resolve`d strings rather than doing prefix
 * arithmetic on the raw input. A model that writes `plan.md` in the right
 * directory passes; `../plan.md`, `<cwd>/plan.md/../secret`, and a symlink-free
 * absolute path to the same target all normalize to the same string, which is
 * the property that matters.
 *
 * The emitted copy cannot import `node:path` (the generated extension and this
 * module have different allowed specifiers), so it carries its own tiny
 * resolver: POSIX normalisation plus a Windows drive/UNC guard. It is not a
 * general path library — it only has to agree with itself between the
 * comparison here and the value `planFilePath()` produces, which is why the
 * relative plan path is a PARAMETER: a `toString()`-serialized function cannot
 * see module scope, and a captured constant would be `undefined` at runtime.
 */
export function isPlanFilePath(cwd: string, target: unknown, rel: string): boolean {
  const raw = typeof target === "string" ? target.trim() : ""
  if (!raw) return false
  const normalize = (input: string): string => {
    const isWindows = /^[a-zA-Z]:[\\/]/.test(input) || input.indexOf("\\") >= 0
    const sep = isWindows ? /\\+/g : /\/+/g
    const unified = input.replace(sep, "/")
    const absolute = isWindows ? unified : unified.startsWith("/") ? unified : "/" + unified
    const parts: Array<string> = []
    for (const segment of absolute.split("/")) {
      if (!segment || segment === ".") continue
      if (segment === "..") {
        parts.pop()
        continue
      }
      parts.push(segment)
    }
    return (isWindows ? "" : "/") + parts.join("/")
  }
  if (typeof rel !== "string" || !rel) return false
  const base = typeof cwd === "string" && cwd.trim() ? cwd.trim() : "/"
  const resolved = raw.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(raw) || raw.indexOf("\\") === 0
    ? normalize(raw)
    : normalize(base + "/" + raw)
  return resolved === normalize(base + "/" + rel)
}

/**
 * The emitted extension section.
 *
 * Pure helpers ride `.toString()` (the same technique the statusline footer
 * uses for `buildPiStatusPayload`) so the code that runs in the product is
 * byte-identical to the code the unit tests exercise — a hand-copied duplicate
 * could drift from its tested twin without any test noticing.
 */
export function buildPiPlanModeSection(): Array<string> {
  return [
    `  // ---- plan mode: Claude-Code-style planning (always on) ----`,
    `  // /plan or Ctrl+Alt+P toggles it. The active tool set is snapshotted on entry`,
    `  // and restored VERBATIM on exit, so a caller's --tools narrowing survives a`,
    `  // toggle instead of being re-derived from a hardcoded "normal mode" list.`,
    `  // ONE barrier: the three writer tools are removed and refused. Everything`,
    `  // else stays, because a frontier model told to explore and not implement`,
    `  // needs a shell and can be trusted with one.`,
    `  try {`,
    `    const PLAN_STATUS_KEY = ${JSON.stringify(PLAN_STATUS_KEY)};`,
    `    const PLAN_WIDGET_KEY = ${JSON.stringify(PLAN_WIDGET_KEY)};`,
    `    const PLAN_ENTRY = ${JSON.stringify(PLAN_MODE_ENTRY)};`,
    `    const PLAN_CONTEXT_TYPE = ${JSON.stringify(PLAN_CONTEXT_TYPE)};`,
    `    const PLAN_EXEC_TYPE = ${JSON.stringify(PLAN_EXEC_TYPE)};`,
    `    const PLAN_DONE_TYPE = ${JSON.stringify(PLAN_DONE_TYPE)};`,
    `    const PLAN_LIST_TYPE = ${JSON.stringify(PLAN_LIST_TYPE)};`,
    `    const PLAN_BLOCKED = new Set(${JSON.stringify([...PLAN_BLOCKED_TOOLS])});`,
    `    const PLAN_FILE_REL = ${JSON.stringify(planFilePath())};`,
    `    const planFilePathOf = (${planFilePath.toString()});`,
    `    const isPlanFilePath = (${isPlanFilePath.toString()});`,
    `    const cleanPlanStepText = (${cleanPlanStepText.toString()});`,
    `    const extractPlanSteps = (${extractPlanSteps.toString()});`,
    `    const extractDoneSteps = (${extractDoneSteps.toString()});`,
    `    const applyDoneSteps = (${applyDoneSteps.toString()});`,
    `    const planAllStepsComplete = (${planAllStepsComplete.toString()});`,
    ``,
    `    let planEnabled = false;`,
    `    let planExecuting = false;`,
    `    let planSteps = [];`,
    `    let toolsBeforePlan = null;`,
    `    let planCwd = "";`,
    `    // Set while the "what next?" prompt is open. agent_end can fire again for`,
    `    // the same plan (a queued follow-up run ends too), and a second prompt on`,
    `    // top of the first would let two Execute answers each send an execution`,
    `    // kick, resetting progress and paying for a redundant turn.`,
    `    let planPromptOpen = false;`,
    ``,
    `    function planPaint(ctx, text, color) {`,
    `      try {`,
    `        const theme = ctx && ctx.ui && ctx.ui.theme;`,
    `        if (theme && typeof theme.fg === "function") return theme.fg(color, text);`,
    `      } catch {}`,
    `      return text;`,
    `    }`,
    ``,
    `    // Resident checklist: a footer status badge plus a widget above the editor.`,
    `    // The router's own statusline footer already forwards extension statuses,`,
    `    // so the badge is visible without this extension owning the footer.`,
    `    function planUpdateUi(ctx) {`,
    `      try {`,
    `        const ui = ctx && ctx.ui;`,
    `        if (!ui) return;`,
    `        if (planExecuting && planSteps.length > 0) {`,
    `          const done = planSteps.filter((s) => s.completed).length;`,
    `          try { ui.setStatus(PLAN_STATUS_KEY, planPaint(ctx, "\\u{1F4CB} " + done + "/" + planSteps.length, "accent")); } catch {}`,
    `        } else if (planEnabled) {`,
    `          try { ui.setStatus(PLAN_STATUS_KEY, planPaint(ctx, "\\u{23F8} plan", "warning")); } catch {}`,
    `        } else {`,
    `          try { ui.setStatus(PLAN_STATUS_KEY, undefined); } catch {}`,
    `        }`,
    `        if (planSteps.length > 0 && (planEnabled || planExecuting)) {`,
    `          const lines = planSteps.map((s) => {`,
    `            const text = s.text.length > 60 ? s.text.slice(0, 57) + "..." : s.text;`,
    `            if (s.completed) return planPaint(ctx, "\\u2611 ", "success") + planPaint(ctx, text, "muted");`,
    `            return planPaint(ctx, "\\u2610 ", "muted") + text;`,
    `          });`,
    `          try { ui.setWidget(PLAN_WIDGET_KEY, lines); } catch {}`,
    `        } else {`,
    `          try { ui.setWidget(PLAN_WIDGET_KEY, undefined); } catch {}`,
    `        }`,
    `      } catch {}`,
    `    }`,
    ``,
    `    // State survives resume through a custom entry; custom entries never reach`,
    `    // the model, so this carries NO context cost. Redundant writes are skipped:`,
    `    // turn_end and agent_end both fire per run, and a long execution would`,
    `    // otherwise append a duplicate entry per turn for the whole transcript.`,
    `    let planPersistKey = null;`,
    `    function planPersist() {`,
    `      try {`,
    `        const data = {`,
    `          enabled: planEnabled,`,
    `          executing: planExecuting,`,
    `          steps: planSteps.map((s) => ({ step: s.step, text: s.text, completed: s.completed })),`,
    `          toolsBeforePlan,`,
    `        };`,
    `        const key = JSON.stringify(data);`,
    `        if (key === planPersistKey) return;`,
    `        planPersistKey = key;`,
    `        pi.appendEntry(PLAN_ENTRY, data);`,
    `      } catch {}`,
    `    }`,
    ``,
    `    function planApplyRestriction() {`,
    `      try {`,
    `        if (typeof pi.getActiveTools !== "function" || typeof pi.setActiveTools !== "function") return;`,
    `        if (toolsBeforePlan === null) toolsBeforePlan = [...pi.getActiveTools()];`,
    `        const kept = toolsBeforePlan.filter((n) => !PLAN_BLOCKED.has(n));`,
    `        // Entry never ADDS a tool: a read tool the caller removed (a --tools`,
    `        // launch) stays removed. With no allowlist there is nothing to add.`,
    `        pi.setActiveTools([...kept]);`,
    `      } catch {}`,
    `    }`,
    ``,
    `    function planRestoreTools() {`,
    `      try {`,
    `        if (toolsBeforePlan !== null && typeof pi.setActiveTools === "function") {`,
    `          pi.setActiveTools([...toolsBeforePlan]);`,
    `        }`,
    `      } catch {}`,
    `      toolsBeforePlan = null;`,
    `    }`,
    ``,
    `    function planEnter(ctx) {`,
    `      if (planEnabled) return;`,
    `      planEnabled = true;`,
    `      planExecuting = false;`,
    `      planPromptOpen = false;`,
    `      planSteps = [];`,
    `      try { if (ctx && typeof ctx.cwd === "string" && ctx.cwd) planCwd = ctx.cwd; } catch {}`,
    `      planApplyRestriction();`,
    `      try { ctx.ui.notify("Plan mode on: edits disabled except " + PLAN_FILE_REL + ". Investigate, then write the plan there. Ctrl+Alt+P or /plan to leave.", "info"); } catch {}`,
    `      planUpdateUi(ctx);`,
    `      planPersist();`,
    `    }`,
    ``,
    `    function planExit(ctx) {`,
    `      if (!planEnabled && !planExecuting) return;`,
    `      planEnabled = false;`,
    `      planExecuting = false;`,
    `      planPromptOpen = false;`,
    `      planRestoreTools();`,
    `      planSteps = [];`,
    `      try { ctx.ui.notify("Plan mode off: full tool access restored.", "info"); } catch {}`,
    `      planUpdateUi(ctx);`,
    `      planPersist();`,
    `    }`,
    ``,
    `    function planToggle(ctx) {`,
    `      if (planEnabled || planExecuting) planExit(ctx);`,
    `      else planEnter(ctx);`,
    `    }`,
    ``,
    `    try {`,
    `      pi.registerCommand("plan", {`,
    `        description: "Toggle plan mode (edits disabled; plan file only)",`,
    `        handler: async (_args, ctx) => { planToggle(ctx); },`,
    `      });`,
    `    } catch {}`,
    `    try {`,
    `      // Literal KeyId rather than Key.ctrlAlt("p"): the generated source then`,
    `      // needs no pi-tui import at all, which keeps it loadable on every build`,
    `      // whose host-provided specifier list is smaller than today's. The value`,
    `      // is exactly what Key.ctrlAlt("p") returns (pi-tui keys.js:118).`,
    `      pi.registerShortcut("ctrl+alt+p", {`,
    `        description: "Toggle plan mode",`,
    `        handler: async (ctx) => { planToggle(ctx); },`,
    `      });`,
    `    } catch {}`,
    `    try {`,
    `      pi.registerCommand("plan-status", {`,
    `        description: "Show plan mode state and the current step list",`,
    `        handler: async (_args, ctx) => {`,
    `          if (!planEnabled && !planExecuting && planSteps.length === 0) {`,
    `            try { ctx.ui.notify("Plan mode is off. /plan (or Ctrl+Alt+P) to start planning.", "info"); } catch {}`,
    `            return;`,
    `          }`,
    `          const done = planSteps.filter((s) => s.completed).length;`,
    `          const body = planSteps.length === 0`,
    `            ? "No steps parsed yet. Ask for a numbered Plan: block."`,
    `            : planSteps.map((s) => (s.completed ? "\\u2713 " : "\\u25CB ") + s.step + ". " + s.text).join("\\n");`,
    `          const head = planExecuting ? "Executing plan (" + done + "/" + planSteps.length + ")" : "Plan mode active";`,
    `          try { ctx.ui.notify(head + "\\n" + body, "info"); } catch {}`,
    `        },`,
    `      });`,
    `    } catch {}`,
    ``,
    `    // Barrier 2: the ONE write exception, enforced by path. A write or edit`,
    `    // whose resolved target is the pinned plan file passes; everything else is`,
    `    // refused, whatever the model believes. The path comes from the extension`,
    `    // and never from the model, which is the property that keeps the exception`,
    `    // from widening into a general write permission.`,
    `    try {`,
    `      pi.on("tool_call", async (event, ctx) => {`,
    `        if (!planEnabled || !event) return undefined;`,
    `        const name = String(event.toolName || "");`,
    `        if (!PLAN_BLOCKED.has(name)) return undefined;`,
    `        try { if (ctx && typeof ctx.cwd === "string" && ctx.cwd) planCwd = ctx.cwd; } catch {}`,
    `        const input = (event.input || {});`,
    `        const target = input.path !== undefined ? input.path : input.file_path;`,
    `        if (isPlanFilePath(planCwd, target, PLAN_FILE_REL)) return undefined;`,
    `        return {`,
    `          block: true,`,
    `          reason: "Plan mode: edits are disabled. The only file you may write is " + PLAN_FILE_REL + ". Record the plan there, or leave plan mode (/plan or Ctrl+Alt+P) to change code.",`,
    `        };`,
    `      });`,
    `    } catch {}`,
    ``,
    `    // Plan-injected context is dropped once neither mode is engaged, so a later`,
    `    // turn is not still told it is read-only or mid-execution. Custom messages`,
    `    // reach this handler as role "custom" with customType intact, which is the`,
    `    // load-bearing check; the text marker is the belt for a host (or an`,
    `    // imported transcript) that flattened the custom role into a user message.`,
    `    const PLAN_STALE_MARKERS = [`,
    `      { marker: "[PLAN MODE ACTIVE]", live: () => planEnabled },`,
    `      { marker: "[EXECUTING PLAN", live: () => planExecuting },`,
    `    ];`,
    `    function planIsStaleContext(m) {`,
    `      if (!m || m.role !== "user" || (m.customType !== undefined)) return false;`,
    `      const content = m.content;`,
    `      const stale = (text) => {`,
    `        if (typeof text !== "string") return false;`,
    `        return PLAN_STALE_MARKERS.some((entry) => !entry.live() && text.indexOf(entry.marker) >= 0);`,
    `      };`,
    `      if (typeof content === "string") return stale(content);`,
    `      if (Array.isArray(content)) return content.some((c) => c && c.type === "text" && stale(c.text));`,
    `      return false;`,
    `    }`,
    ``,
    `    // before_agent_start messages are APPENDED and PERSISTED per run, so a`,
    `    // plan-mode session accrues one block per turn. Two rules keep that from`,
    `    // costing anything or lying to the model:`,
    `    //  - a block is valid only while ITS mode is engaged: the read-only block`,
    `    //    dies the moment execution starts (the model is told full access is`,
    `    //    back), and the execution block dies when the mode ends;`,
    `    //  - of the valid blocks, only the newest of each kind is kept, so a long`,
    `    //    plan does not pay for N copies of the same instructions.`,
    `    try {`,
    `      pi.on("context", async (event) => {`,
    `        if (!event || !Array.isArray(event.messages)) return undefined;`,
    `        const seen = new Set();`,
    `        const output = [];`,
    `        for (let i = event.messages.length - 1; i >= 0; i--) {`,
    `          const m = event.messages[i];`,
    `          const type = m && m.customType;`,
    `          if (type === PLAN_CONTEXT_TYPE || type === PLAN_EXEC_TYPE) {`,
    `            const valid = type === PLAN_CONTEXT_TYPE ? planEnabled : planExecuting;`,
    `            if (!valid || seen.has(type)) continue;`,
    `            seen.add(type);`,
    `          } else if (planIsStaleContext(m)) {`,
    `            continue;`,
    `          }`,
    `          output.push(m);`,
    `        }`,
    `        if (output.length === event.messages.length) return undefined;`,
    `        output.reverse();`,
    `        return { messages: output };`,
    `      });`,
    `    } catch {}`,
    ``,
    `    // The planning contract, modelled on Claude Code's plan-mode reminder: the`,
    `    // mode is closed, the plan file is the ONE exception, and the model is`,
    `    // trusted with everything else. Frontier-model tuning lives here — a`,
    `    // command allowlist, a delegation ban and an MCP namespace deny all told a`,
    `    // capable model to be less useful than it is, and none of them is needed`,
    `    // now that "edits are disabled" is the whole rule and the plan file is the`,
    `    // only write. The workflow is Claude's five phases compressed to what Pi`,
    `    // has: Explore/General-Purpose subagents exist, but the roster is`,
    `    // profile-dependent, so the phase text names the intent, not an agent.`,
    `    const PLAN_BRIEF = [`,
    `      "[PLAN MODE ACTIVE]",`,
    `      "",`,
    `      "Plan mode is active. The user does not want you to execute yet -- you must not edit files,",`,
    `      "run a command that changes the code, or otherwise act on the plan. This supersedes any other",`,
    `      "instruction you have received about doing the work now.",`,
    `      "",`,
    `      "One exception, and it is the whole of it: you may write your plan to",`,
    `      "  " + PLAN_FILE_REL,`,
    `      "Edit and write are refused for every other path. Read, search, and run read-only commands",`,
    `      "freely -- explore enough that the plan is grounded in what the code actually does.",`,
    `      "",`,
    `      "Work the plan like this:",`,
    `      "1. Understand the request, and look for what already exists (functions, utilities, patterns)",`,
    `      "   before proposing anything new. Delegate broad or parallel discovery when that is faster",`,
    `      "   than reading serially yourself.",`,
    `      "2. Ask the user whatever you cannot settle from the code. Do it once, up front, and never",`,
    `      "   ask what exploration could answer.",`,
    `      "3. Design the approach far enough that an implementer would have no open decisions left:",`,
    `      "   which files, what changes in each, what each change is done when, and what would prove it.",`,
    `      "4. Write the plan to the plan file: a short Context section, the recommended approach only,",`,
    `      "   the critical files, the verification steps, and any residual risk. Keep it scannable.",`,
    `      "5. Summarise the plan in your reply too, so the user can answer without opening the file.",`,
    `      "",`,
    `      "Do NOT open an ask_user question or a prose prompt for plan approval. Leaving plan mode is",`,
    `      "the user's action (/plan or Ctrl+Alt+P) -- asking permission to stop planning is the one",`,
    `      "question this mode does not want, and approval you grant yourself is not approval.",`,
    `      "If the user asks for changes, revise the SAME plan file rather than writing a second one.",`,
    `      "The test for every other action: if it would reasonably be described as DOING the work",`,
    `      "rather than planning it, it waits until plan mode is off.",`,
    `    ].join("\\n");`,
    ``,
    `    // Cost contract: inject NOTHING unless plan mode is actually engaged, and`,
    `    // only for a real user turn (a background notification must not re-add it).`,
    `    try {`,
    `      pi.on("before_agent_start", async (event) => {`,
    `        if (!event || event.messageType !== "user") return undefined;`,
    `        if (planEnabled) {`,
    `          return { message: { customType: PLAN_CONTEXT_TYPE, content: PLAN_BRIEF, display: false } };`,
    `        }`,
    `        if (planExecuting && planSteps.length > 0) {`,
    `          const remaining = planSteps.filter((s) => !s.completed).map((s) => s.step + ". " + s.text).join("\\n");`,
    `          const content = [`,
    `            "[EXECUTING PLAN - full tool access enabled]",`,
    `            "",`,
    `            "Remaining steps:",`,
    `            remaining,`,
    `            "",`,
    `            "Execute each step in order.",`,
    `            "After completing a step, include a [DONE:n] tag in your response.",`,
    `          ].join("\\n");`,
    `          return { message: { customType: PLAN_EXEC_TYPE, content, display: false } };`,
    `        }`,
    `        return undefined;`,
    `      });`,
    `    } catch {}`,
    ``,
    `    // Progress tracking after each turn. Reads text AND thinking blocks: with`,
    `    // reasoning-max models the [DONE:n] tags often land in thinking, not text.`,
    `    try {`,
    `      pi.on("turn_end", async (event, ctx) => {`,
    `        if (!planExecuting || planSteps.length === 0 || !event) return;`,
    `        const msg = event.message;`,
    `        if (!msg || msg.role !== "assistant" || !Array.isArray(msg.content)) return;`,
    `        const text = msg.content.map((b) => {`,
    `          if (!b) return "";`,
    `          if (b.type === "text") return b.text || "";`,
    `          if (b.type === "thinking") return b.thinking || "";`,
    `          return "";`,
    `        }).join("\\n");`,
    `        applyDoneSteps(text, planSteps);`,
    `        planUpdateUi(ctx);`,
    `        planPersist();`,
    `      });`,
    `    } catch {}`,
    ``,
    `    // End of a run: parse the plan (planning) or finish the execution.`,
    `    try {`,
    `      pi.on("agent_end", async (event, ctx) => {`,
    `        if (!event || !Array.isArray(event.messages)) return;`,
    `        const last = [...event.messages].reverse().find((m) => m && m.role === "assistant" && Array.isArray(m.content));`,
    `        const lastText = last`,
    `          ? last.content.map((b) => {`,
    `              if (!b) return "";`,
    `              if (b.type === "text") return b.text || "";`,
    `              if (b.type === "thinking") return b.thinking || "";`,
    `              return "";`,
    `            }).join("\\n")`,
    `          : "";`,
    `        if (planExecuting && planSteps.length > 0) {`,
    `          if (planAllStepsComplete(lastText)) {`,
    `            for (const s of planSteps) s.completed = true;`,
    `          }`,
    `          if (planSteps.every((s) => s.completed)) {`,
    `            const list = planSteps.map((s) => "- ~~" + s.text + "~~").join("\\n");`,
    `            // nextTurn, not a triggerTurn: acknowledging the card with an extra`,
    `            // (reasoning-max) model turn would cost real money for a checkmark.`,
    `            try { pi.sendMessage({ customType: PLAN_DONE_TYPE, content: "**Plan complete** \\u2713" + "\\n" + list, display: true }, { deliverAs: "nextTurn" }); } catch {}`,
    `            planExecuting = false;`,
    `            planSteps = [];`,
    `            planUpdateUi(ctx);`,
    `            planPersist();`,
    `          }`,
    `          return;`,
    `        }`,
    `        if (!planEnabled) return;`,
    `        const parsed = extractPlanSteps(lastText);`,
    `        if (parsed.length > 0) planSteps = parsed;`,
    `        if (planSteps.length === 0) return;`,
    `        planUpdateUi(ctx);`,
    `        planPersist();`,
    `        // One prompt at a time: a queued follow-up run also ends here, and a`,
    `        // second Execute answer would re-kick a plan that is already running.`,
    `        if (planPromptOpen) return;`,
    `        let hasUI = false;`,
    `        try { hasUI = !!ctx.hasUI; } catch {}`,
    `        if (!hasUI || typeof ctx.ui.select !== "function") return;`,
    `        planPromptOpen = true;`,
    `        let choice = undefined;`,
    `        try {`,
    `          choice = await ctx.ui.select("Plan mode - what next?", [`,
    `            "Execute the plan (track progress)",`,
    `            "Stay in plan mode",`,
    `            "Refine the plan",`,
    `          ]);`,
    `        } catch { planPromptOpen = false; return; }`,
    `        planPromptOpen = false;`,
    `        if (!choice) return;`,
    `        // The user may have left plan mode while the prompt was open (slash`,
    `        // /plan, Ctrl+Alt+P, /new). Honouring Execute there would silently`,
    `        // re-enter a mode they just exited.`,
    `        if (!planEnabled) return;`,
    `        if (String(choice).indexOf("Execute") === 0) {`,
    `          planEnabled = false;`,
    `          planExecuting = true;`,
    `          planRestoreTools();`,
    `          planUpdateUi(ctx);`,
    `          planPersist();`,
    `          const list = planSteps.map((s) => s.step + ". " + s.text).join("\\n");`,
    `          const first = planSteps[0] ? planSteps[0].text : "";`,
    `          try {`,
    `            pi.sendMessage({ customType: PLAN_LIST_TYPE, content: "**Plan steps (" + planSteps.length + ")**" + "\\n" + list, display: true }, { deliverAs: "followUp" });`,
    `            pi.sendMessage({ customType: PLAN_EXEC_TYPE, content: "Execute the plan." + "\\n" + "Remaining steps:" + "\\n" + list + "\\n" + "Start with: " + first + "\\n" + "After completing a step, include a [DONE:n] tag." }, { triggerTurn: true, deliverAs: "followUp" });`,
    `          } catch {}`,
    `        } else if (choice === "Refine the plan" && typeof ctx.ui.editor === "function") {`,
    `          let refinement = undefined;`,
    `          try { refinement = await ctx.ui.editor("Refine the plan:", ""); } catch { return; }`,
    `          const trimmed = String(refinement || "").trim();`,
    `          if (!trimmed) return;`,
    `          try { pi.sendUserMessage(trimmed, { deliverAs: "followUp" }); } catch {}`,
    `        }`,
    `      });`,
    `    } catch {}`,
    ``,
    `    // Restore after resume: the entry is the source of truth, and the tool set`,
    `    // is re-applied so a resumed plan-mode session is genuinely write-blocked.`,
    `    // State is assigned UNCONDITIONALLY: a fresh session (/new, /fork into an`,
    `    // empty branch) has no entry, and leaving the previous session's flags in`,
    `    // place would keep a stale badge and re-apply a tool snapshot taken from a`,
    `    // different session's roster.`,
    `    try {`,
    `      pi.on("session_start", async (_event, ctx) => {`,
    `        try {`,
    `          if (ctx && typeof ctx.cwd === "string" && ctx.cwd) planCwd = ctx.cwd;`,
    `          const entries = ctx.sessionManager && typeof ctx.sessionManager.getEntries === "function"`,
    `            ? ctx.sessionManager.getEntries()`,
    `            : [];`,
    `          let saved = undefined;`,
    `          for (const entry of entries) {`,
    `            if (entry && entry.type === "custom" && entry.customType === PLAN_ENTRY) saved = entry.data;`,
    `          }`,
    `          const nextEnabled = !!saved && saved.enabled === true;`,
    `          const nextExecuting = !!saved && saved.executing === true;`,
    `          // A restriction left behind by the previous session must not leak`,
    `          // into one that does not want it: this closure survives a session`,
    `          // replacement, and nothing guarantees pi re-derives the roster.`,
    `          if (!nextEnabled && toolsBeforePlan !== null) planRestoreTools();`,
    `          planEnabled = nextEnabled;`,
    `          planExecuting = nextExecuting;`,
    `          planPromptOpen = false;`,
    `          planPersistKey = null;`,
    `          planSteps = saved && Array.isArray(saved.steps)`,
    `            ? saved.steps.map((s) => ({ step: Number(s.step) || 0, text: String(s.text || ""), completed: s.completed === true }))`,
    `            : [];`,
    `          toolsBeforePlan = saved && Array.isArray(saved.toolsBeforePlan) ? [...saved.toolsBeforePlan] : null;`,
    `          // An execution with no steps is a dead end: the checklist is empty and`,
    `          // every execution branch bails on steps.length, so treat it as off.`,
    `          if (planExecuting && planSteps.length === 0) planExecuting = false;`,
    `        } catch {}`,
    `        if (planEnabled) planApplyRestriction();`,
    `        planUpdateUi(ctx);`,
    `      });`,
    `    } catch {}`,
    `  } catch {}`,
    ``,
  ]
}
