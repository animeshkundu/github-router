/**
 * Plan mode: a Claude Code-style read-only exploration mode for `github-router pi`.
 *
 * Pi ships no plan mode (upstream README: "skips features like sub-agents and
 * plan mode"); the reference implementation is an *example*
 * (`examples/extensions/plan-mode/`) that the user must install separately.
 * This module ports that behaviour into the router's own generated extension so
 * every launch has it, with these deliberate divergences:
 *
 * 1. **Always on, no `--plan` flag.** The user toggles with `Ctrl+Alt+P` or
 *    `/plan`. A registered flag would have to survive `collectPiPassthroughArgs`
 *    and pi's own unknown-flag rejection; registering nothing keeps that path
 *    untouched.
 * 2. **Exact tool save/restore.** Upstream re-derives the normal set from a
 *    hardcoded `NORMAL_MODE_TOOLS`, which would silently re-enable `edit` and
 *    `write` that a caller's `--tools` narrowing had removed. We snapshot
 *    `pi.getActiveTools()` on entry and restore that array verbatim.
 * 3. **Writes blocked by name as well as removed from the active set.** Two
 *    independent barriers: the model cannot see `edit`/`write`, and a tool call
 *    that arrives anyway is refused. `powershell` is refused outright; the
 *    upstream allowlist also lives here without the metacharacter gap.
 * 4. **No `@earendil-works/pi-agent-core` import.** Upstream imports its message
 *    types; generated extensions may only import host-provided specifiers
 *    (`typebox`, `@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`,
 *    `@earendil-works/pi-tui`), so the emitted source carries local structural
 *    types and zero runtime imports.
 * 5. **Step text keeps its verb.** Upstream strips a leading `Read`/`Add`/`Use`,
 *    turning "Read the launcher" into "Launcher"; the checklist is what the user
 *    reads while the plan runs, so the action stays.
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
 * Commands that mutate state. Blocked regardless of position: a read-only
 * prefix such as `git log && rm -rf x` must not slip through on the strength of
 * its first word, so the destructive check is unconditional.
 */
export function isPlanUnsafeCommand(command: string): boolean {
  // Writers and process killers, anchored at a command position (start, or after
  // whitespace / `;` / `|` / `&` / `(`). A bare `\bcp\b` refuses `ls -cp` and a
  // bare `\brm\b` refuses `cat rm.md`; a second command cannot reach this list
  // anyway, because `isPlanSafeCommand` refuses pipes, `;`, `&&` and `$(` before
  // the allowlist runs.
  const destructive = [
    /(^|[\s;|&(])(?:rm|rmdir|mv|cp|mkdir|touch|chmod|chown|chgrp|ln|tee|truncate|dd|shred|sudo|su|killall|pkill|kill)(?=$|\s)/i,
    /(^|[^<])>(?!>)/,
    />>/,
    /\bnpm\s+(install|uninstall|update|ci|link|publish)/i,
    /\byarn\s+(add|remove|install|publish)/i,
    /\bpnpm\s+(add|remove|install|publish)/i,
    /\bpip\s+(install|uninstall)/i,
    /\bapt(-get)?\s+(install|remove|purge|update|upgrade)/i,
    /\bbrew\s+(install|uninstall|upgrade)/i,
    /\bgit\s+(add|commit|push|pull|merge|rebase|reset|checkout|switch|restore|clean|stash|cherry-pick|revert|tag|init|clone|apply|am)\b/i,
    /\bgit\s+branch\s+-[dDmMcC]/i,
    /\breboot\b/i,
    /\bshutdown\b/i,
    /\bsystemctl\s+(start|stop|restart|enable|disable)/i,
    /\bservice\s+\S+\s+(start|stop|restart)/i,
    /(^|[\s;|&(])(?:vim?|nano|emacs|subl|code)(?=$|\s)/i,
    // Writers that the read allowlist would otherwise admit on the strength of
    // a read-only first word. Each of these READS like its harmless neighbour,
    // so plain prefix matching is not enough: `find . -delete` deletes, `sort
    // -o out in` writes, and any `--output` flag redirects git's output to a
    // file without a `>` for the metacharacter guard to catch.
    /\bfind\b[^|;]*\s-(delete|exec|execdir|ok|okdir|fprint|fprint0|fprintf|fls)\b/i,
    // `fd` is the modern `find`: -x/-X/--exec run a command per result.
    /\bfd\b[^|;]*\s(-x|-X|--exec)/i,
    // `jq` in place (gojq/jaq spell it -i, jq itself has no such flag).
    /\bjq\b[^|;]*\s(-i|--in-place)\b/i,
    // A pager that can be told to run something (`bat --pager="sh -c ..."`).
    /\bbat\b[^|;]*--pager/i,
    /\bsort\b[^|;]*\s-o/i,
    /\btree\b[^|;]*\s-o/i,
    /\bnpm\s+audit\s+(fix|--fix)\b/i,
    /\brg\b[^|;]*\s--pre\b/i,
    /\bdate\b[^|;]*\s--?s(et)?\b/i,
    // Flags that run a program the command line does not spell out: a pager
    // (`sort --compress-program`), an external differ, or a textconv filter.
    /--compress-program/i,
    /\bgit\b[^|;]*--(ext-diff|textconv)\b/i,
    /--output(-file)?[= ]/i,
  ]
  return destructive.some((pattern) => pattern.test(command))
}

/** Read-only commands plan mode permits. Anything else is refused. */
export function isPlanReadOnlyCommand(command: string): boolean {
  const safe = [
    /^\s*cat\b/,
    // `less` and `more` are absent on purpose: they write (`less -o log`) and
    // execute (`less +!cmd`), and they are interactive, which a captured bash
    // tool cannot use. `cat`, `head`, `tail` cover the reads they were used for.
    /^\s*head\b/,
    /^\s*tail\b/,
    /^\s*grep\b/,
    /^\s*find\b/,
    /^\s*ls\b/,
    /^\s*pwd\b/,
    /^\s*echo\b/,
    /^\s*printf\b/,
    /^\s*wc\b/,
    /^\s*sort\b/,
    // `uniq` is absent on purpose: `uniq a b` writes `b`, a positional write no
    // flag scan can see, and the useful form (`sort | uniq`) needs a pipe that
    // the metacharacter guard already refuses.
    /^\s*diff\b/,
    /^\s*file\b/,
    /^\s*stat\b/,
    /^\s*du\b/,
    /^\s*df\b/,
    /^\s*tree\b/,
    /^\s*which\b/,
    /^\s*whereis\b/,
    /^\s*type\b/,
    // `env` is absent on purpose: `env <cmd>` runs `<cmd>`, so the allowlist
    // would only be vetting the word `env` and
    // `env python3 -c 'open("x","w").write()'` would pass every other guard.
    // `printenv` stays: it takes only variable names.
    /^\s*printenv\b/,
    /^\s*uname\b/,
    /^\s*whoami\b/,
    /^\s*id\b/,
    /^\s*cal\b/,
    // `date` is pattern-matched rather than prefix-matched: the positional and
    // `-j` forms set the system clock with no `-s` for the deny list to see.
    /^\s*date\s*(\+[\w%:.\-/+, ]*)?$/,
    /^\s*date\s+-u\s*(\+[\w%:.\-/+, ]*)?$/,
    /^\s*uptime\b/,
    /^\s*ps\b/,
    /^\s*free\b/,
    /^\s*git\s+(status|log|diff|show|blame|describe)\b/i,
    /^\s*git\s+(rev-parse|ls-files|ls-tree|ls-remote|shortlog|show-ref)\b/i,
    /^\s*git\s+branch\s*$/i,
    /^\s*git\s+branch\s+(-a|-r|-v|-vv|--list|--show-current)\b/i,
    /^\s*git\s+remote\s*(-v)?\s*$/i,
    /^\s*git\s+config\s+--get\b/i,
    /^\s*npm\s+(list|ls|view|info|search|outdated|audit)/i,
    /^\s*yarn\s+(list|info|why|audit)/i,
    /^\s*node\s+--version/i,
    /^\s*python3?\s+--version/i,
    /^\s*jq\b/,
    // `sed` and `awk` are deliberately ABSENT: both take a script, and a script
    // can shell out (`awk 'BEGIN{system("sh")}'`, `sed -n '1e sh'`,
    // `sed -n '1w /tmp/x'`) with no `|`, `;` or `>` for the guards above to see.
    // A read-only allowlist that has to check a script interpreter for escapes
    // is not a read-only allowlist. `grep`, `rg`, `head`, `tail` and `jq` cover
    // the reads those two were used for.
    /^\s*rg\b/,
    /^\s*fd\b/,
    /^\s*bat\b/,
    /^\s*eza\b/,
  ]
  return safe.some((pattern) => pattern.test(command))
}

/** True when plan mode may execute this bash command. */
export function isPlanSafeCommand(command: string): boolean {
  if (typeof command !== "string") return false
  const trimmed = command.trim()
  if (!trimmed) return false
  if (isPlanUnsafeCommand(trimmed)) return false
  // Shell metacharacters are refused: a pipe or substitution can smuggle a
  // write into an otherwise allowlisted prefix (`ls $(rm -rf /)`), and a second
  // command after `;` or `&&` never reaches the allowlist check at all.
  if (/\||;|&&|\|\||\$\(|`|\n/.test(trimmed)) return false
  return isPlanReadOnlyCommand(trimmed)
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
 * Read tools plan mode keeps available (intersected with the tools this pi
 * actually has — a narrowed `--tools` launch may not have all of them).
 */
export const PLAN_READ_TOOLS: ReadonlyArray<string> = Object.freeze([
  "read",
  "grep",
  "find",
  "ls",
  "bash",
])

/** Tools plan mode refuses by name even if a call slips through. */
export const PLAN_BLOCKED_TOOLS: ReadonlyArray<string> = Object.freeze([
  "edit",
  "write",
  "apply_patch",
])

/**
 * Delegation tools, refused during plan mode for a subtler reason than
 * `PLAN_BLOCKED_TOOLS`: a child session is a separate process with its own
 * tool roster, so `subagent` is a write vector this extension cannot gate —
 * the barrier has no visibility into what the child was told to do. Blocking
 * it is what keeps the mode's promise ("nothing on disk may change") true.
 */
export const PLAN_BLOCKED_DELEGATION: ReadonlyArray<string> = Object.freeze(["subagent"])

/**
 * Shells plan mode refuses outright: unlike `bash`, a PowerShell allowlist is
 * not safely derivable from a command string (aliases, cmdlets that write by
 * default), so plan mode simply has no powershell.
 */
export const PLAN_BLOCKED_SHELLS: ReadonlyArray<string> = Object.freeze(["powershell"])

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
 * The emitted extension section.
 *
 * Pure helpers ride `.toString()` (the same technique the statusline footer
 * uses for `buildPiStatusPayload`) so the code that runs in the product is
 * byte-identical to the code the unit tests exercise — a hand-copied duplicate
 * could drift from its tested twin without any test noticing. They keep their
 * original NAMES on purpose: `isPlanSafeCommand` calls `isPlanUnsafeCommand` and
 * `isPlanReadOnlyCommand` by name, so renaming at emission time would leave
 * dangling references that only fail at runtime.
 */
export function buildPiPlanModeSection(): Array<string> {
  return [
    `  // ---- plan mode: Claude-Code-style read-only exploration (always on) ----`,
    `  // /plan or Ctrl+Alt+P toggles it. The active tool set is snapshotted on entry`,
    `  // and restored VERBATIM on exit, so a caller's --tools narrowing survives a`,
    `  // toggle instead of being re-derived from a hardcoded "normal mode" list.`,
    `  try {`,
    `    const PLAN_STATUS_KEY = ${JSON.stringify(PLAN_STATUS_KEY)};`,
    `    const PLAN_WIDGET_KEY = ${JSON.stringify(PLAN_WIDGET_KEY)};`,
    `    const PLAN_ENTRY = ${JSON.stringify(PLAN_MODE_ENTRY)};`,
    `    const PLAN_CONTEXT_TYPE = ${JSON.stringify(PLAN_CONTEXT_TYPE)};`,
    `    const PLAN_EXEC_TYPE = ${JSON.stringify(PLAN_EXEC_TYPE)};`,
    `    const PLAN_DONE_TYPE = ${JSON.stringify(PLAN_DONE_TYPE)};`,
    `    const PLAN_LIST_TYPE = ${JSON.stringify(PLAN_LIST_TYPE)};`,
    `    const PLAN_READ_TOOLS = ${JSON.stringify([...PLAN_READ_TOOLS])};`,
    `    const PLAN_BLOCKED = new Set(${JSON.stringify([...PLAN_BLOCKED_TOOLS])});`,
    `    const PLAN_NO_DELEGATION = new Set(${JSON.stringify([...PLAN_BLOCKED_DELEGATION])});`,
    `    const PLAN_NO_SHELL = new Set(${JSON.stringify([...PLAN_BLOCKED_SHELLS])});`,
    `    const isPlanUnsafeCommand = (${isPlanUnsafeCommand.toString()});`,
    `    const isPlanReadOnlyCommand = (${isPlanReadOnlyCommand.toString()});`,
    `    const isPlanSafeCommand = (${isPlanSafeCommand.toString()});`,
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
    `    // Set while the "what next?" prompt is open. agent_end can fire again for`,
    `    // the same plan (a queued follow-up run ends too), and a second prompt on`,
    `    // top of the first would let two Execute answers each send an execution`,
    `    // kick, resetting progress and paying for a redundant turn.`,
    `    let planPromptOpen = false;`,
    ``,
    `    // Only add read tools this Pi actually has: the roster differs by profile`,
    `    // (a narrowed --tools launch, MCP-provided tools, no questionnaire here).`,
    `    function planKnownTools(names) {`,
    `      try {`,
    `        const all = typeof pi.getAllTools === "function" ? pi.getAllTools() : [];`,
    `        const known = new Set((all || []).map((t) => (t && t.name) || "").filter(Boolean));`,
    `        if (known.size === 0) return names;`,
    `        return names.filter((n) => known.has(n));`,
    `      } catch { return names; }`,
    `    }`,
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
    `        const snapshot = toolsBeforePlan;`,
    `        const kept = snapshot.filter((n) => !PLAN_BLOCKED.has(n) && !PLAN_NO_DELEGATION.has(n));`,
    `        // Entry may only NARROW. A read tool the caller already removed (a`,
    `        // --tools launch, or a profile that never had it) stays removed: adding`,
    `        // it here would hand the model a tool the launch deliberately withheld.`,
    `        const reads = planKnownTools(PLAN_READ_TOOLS).filter((n) => snapshot.indexOf(n) >= 0 && kept.indexOf(n) < 0);`,
    `        pi.setActiveTools([...kept, ...reads]);`,
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
    `      planApplyRestriction();`,
    `      try { ctx.ui.notify("Plan mode on: read-only. edit/write/delegate disabled, bash allowlisted. Ctrl+Alt+P or /plan to leave.", "info"); } catch {}`,
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
    `        description: "Toggle plan mode (read-only exploration)",`,
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
    `    // Barrier 2: a write call that arrives anyway is refused, whatever the`,
    `    // model believes about its own tool set.`,
    `    try {`,
    `      pi.on("tool_call", async (event) => {`,
    `        if (!planEnabled || !event) return undefined;`,
    `        const name = String(event.toolName || "");`,
    `        if (PLAN_BLOCKED.has(name)) {`,
    `          return { block: true, reason: "Plan mode is read-only: " + name + " is disabled. Present the plan, then leave plan mode (/plan or Ctrl+Alt+P) to make changes." };`,
    `        }`,
    `        if (PLAN_NO_SHELL.has(name)) {`,
    `          return { block: true, reason: "Plan mode is read-only: " + name + " is unavailable. Use bash with a read-only command, or leave plan mode first." };`,
    `        }`,
    `        if (PLAN_NO_DELEGATION.has(name)) {`,
    `          return { block: true, reason: "Plan mode is read-only: " + name + " would hand the work to a child session whose tool set this mode cannot gate. Investigate here, then leave plan mode (/plan or Ctrl+Alt+P) to delegate." };`,
    `        }`,
    `        if (name === "bash") {`,
    `          const command = (event.input && event.input.command) || "";`,
    `          if (!isPlanSafeCommand(String(command))) {`,
    `            return { block: true, reason: "Plan mode: command blocked (not on the read-only allowlist). Leave plan mode first (/plan or Ctrl+Alt+P).\\nCommand: " + command };`,
    `          }`,
    `        }`,
    `        return undefined;`,
    `      });`,
    `    } catch {}`,
    ``,
    `    // Plan-injected context is dropped once neither mode is engaged, so a later`,
    `    // turn is not still told it is read-only or mid-execution. Custom messages`,
    `    // reach this handler as role "custom" with customType intact, which is the`,
    `    // load-bearing check; the text marker is the belt for a host (or an`,
    `    // imported transcript) that flattened the custom role into a user message.`,
    `    // The belt for a host (or an imported transcript) that flattened the custom`,
    `    // role into a plain user message and lost customType. The check above is`,
    `    // the load-bearing one; this only rescues transcripts dumped and reloaded`,
    `    // elsewhere.`,
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
    ``,
    `    // Cost contract: inject NOTHING unless plan mode is actually engaged, and`,
    `    // only for a real user turn (a background notification must not re-add it).`,
    `    try {`,
    `      pi.on("before_agent_start", async (event) => {`,
    `        if (!event || event.messageType !== "user") return undefined;`,
    `        if (planEnabled) {`,
    `          const content = [`,
    `            "[PLAN MODE ACTIVE]",`,
    `            "You are in plan mode - a read-only exploration mode for safe code analysis.",`,
    `            "",`,
    `            "Restrictions:",`,
    `            "- The edit and write tools are disabled; a call to them is refused.",`,
    `            "- Delegation is disabled: a child session would escape these restrictions.",`,
    `            "- Bash is restricted to an allowlist of read-only commands.",`,
    `            "- Nothing on disk may change.",`,
    `            "",`,
    `            'Investigate the code, then create a detailed numbered plan under a "Plan:" header:',`,
    `            "",`,
    `            "Plan:",`,
    `            "1. First step description",`,
    `            "2. Second step description",`,
    `            "",`,
    `            "Do NOT attempt to make changes - describe exactly what you would do.",`,
    `          ].join("\\n");`,
    `          return { message: { customType: PLAN_CONTEXT_TYPE, content, display: false } };`,
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
    `    // is re-applied so a resumed plan-mode session is genuinely read-only.`,
    `    // State is assigned UNCONDITIONALLY: a fresh session (/new, /fork into an`,
    `    // empty branch) has no entry, and leaving the previous session's flags in`,
    `    // place would keep a stale badge and re-apply a tool snapshot taken from a`,
    `    // different session's roster.`,
    `    try {`,
    `      pi.on("session_start", async (_event, ctx) => {`,
    `        try {`,
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
