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
 * 3. **Always on, no `--plan` flag.** The user toggles with `Shift+Tab` (the
 *    Claude Code key; the launcher's `keybindings.json` moves pi's
 *    `app.thinking.cycle` off it, to `Ctrl+Shift+T`), `Ctrl+Alt+P` as the
 *    fallback, or `/plan`. A registered flag would have to survive
 *    `collectPiPassthroughArgs` and pi's own unknown-flag rejection;
 *    registering nothing keeps that path untouched.
 * 4. **The tool set is never touched.** Upstream both re-derives "normal mode"
 *    from a hardcoded `NORMAL_MODE_TOOLS` and narrows the set on entry. We do
 *    neither: narrowing put the model's tool list in front of the `tool_call`
 *    gate, so pi answered `Tool write not found` before the gate ran and the
 *    one-write exception below could never admit anything. Adding a roster
 *    mutation also meant a resumed snapshot could widen the roster a narrower
 *    current launch had installed. Plan mode owns the *gate*, not the roster.
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
 * (`PI_MIN_VERSION`), not just the current docs: `registerShortcut` (:1233),
 * `registerCommand` (:1231), `appendEntry` (:1272), `getAllTools` (:1285),
 * `ui.setStatus` (:84), `ui.setWidget` (:101), `ui.theme` (:179),
 * `sessionManager.getEntries` (session-manager.d.ts:334), and
 * `before_agent_start` carrying `messageType` (:729/737). No 1.4/1.5-only API is
 * used, so the 1.3.0 floor stands.
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
 * Takes the LAST matching heading on purpose: the caller feeds this everything
 * the model wrote for a turn, including thinking blocks, and with reasoning-max
 * models a draft plan often lands in thinking before the visible one. The
 * visible text block comes last in content order, so last-wins picks the plan
 * the user actually saw.
 *
 * Fenced code is stripped first: a numbered list inside a snippet is not a plan.
 *
 * Which headings count: the brief asks for a `Plan:` list, and that is what an
 * obedient reply ends with. It is not the only shape a good reply takes — the
 * brief also says to write Context / recommended approach / critical files /
 * verification, and a reply that follows THAT structure and closes its summary
 * under `## Recommended approach` used to parse as ZERO steps, leaving the
 * checklist, the "what next?" prompt and the Execute kick silently unreachable.
 * So the conventional headings are accepted too. The heading must be alone on
 * its line (prose like "Steps: we will ..." never matches).
 *
 * The regex is inline, not module scope: this function is serialized with
 * `toString()` into the generated extension, where module scope does not exist.
 */
export function extractPlanSteps(message: string): Array<PlanStep> {
  const items: Array<PlanStep> = []
  const text = String(message ?? "").replace(/^[ \t]*(?:```|~~~)[\s\S]*?^[ \t]*(?:```|~~~)[ \t]*$/gm, "")
  const headers = [
    ...text.matchAll(
      /^[ \t]*(?:#{1,6}[ \t]*)?(?:\*\*|__)?[ \t]*(?:plan|recommended approach|steps|implementation plan)[ \t]*(?::[ \t]*)?(?:\*\*|__)?[ \t]*$/gim,
    ),
  ]
  if (headers.length === 0) return items
  const lastHeader = headers[headers.length - 1]!
  let planSection = text.slice((lastHeader.index ?? 0) + lastHeader[0].length)
  // A section ends at the next heading of the same or a higher level, so a
  // `## Verification` list after `## Recommended approach` is not mistaken for
  // plan steps. A headingless marker (`Plan:` / `**Plan:**`) has no level to
  // compare against and keeps the historical whole-tail behaviour.
  const level = (lastHeader[0].match(/^[ \t]*(#{1,6})/) || [])[1]
  if (level) {
    const boundary = new RegExp("^[ \\t]*#{1," + level.length + "}[ \\t]+", "m")
    const rest = planSection.slice(1)
    const hit = rest.search(boundary)
    if (hit >= 0) planSection = planSection.slice(0, hit + 1)
  }
  // A step may be a list item or a sub-heading (`### 3. Do the thing`); both are
  // how a model writes an ordered plan, and the checklist reads the same.
  const numbered = /^[ \t]*(?:#{1,6}[ \t]*)?(\d+)[.)][ \t]+(.+)$/gm
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
 * Tools plan mode refuses, by name, through the `tool_call` handler.
 *
 * These stay ACTIVE. An earlier revision also removed them from the active
 * tool set, described as "two independent barriers" — they were not
 * independent, they were *stacked*: pi resolves a call against the declared
 * tool list in `prepareToolCall()` and answers `Tool <name> not found` BEFORE
 * `beforeToolCall` (the `tool_call` hook) ever runs. So the narrower barrier
 * sat in front of the wider one, the path exception below was unreachable, the
 * model was told a tool it had just been told to use did not exist, and the
 * documented refusal string was never displayed. An obedient model fell back to
 * `bash` — which is allowed — so the unsanctioned route silently won.
 *
 * With the narrowing gone there is ONE barrier and it is reachable: the model
 * gets a call it can make, and a refusal sentence it can act on. The honest
 * scope is unchanged and already documented: `bash` is allowed, so this
 * redirects a cooperative model, it does not contain a hostile one.
 *
 * `apply_patch` has no single target path to compare and is therefore refused
 * outright — that refusal is also reachable for the first time.
 */
export const PLAN_BLOCKED_TOOLS: ReadonlyArray<string> = Object.freeze([
  "edit",
  "write",
  "apply_patch",
])

/**
 * The fallback plan file, relative to the workspace.
 *
 * Used only when the host cannot report a session id. It is deliberately the
 * SAME single path every id-less host shares — there is nothing better to
 * choose, and a fixed path keeps `/plan-status` honest about where the plan
 * went rather than naming a directory that cannot be derived.
 */
export function planFilePath(): string {
  // Delegates rather than retyping the layout: one source of truth, so the
  // fallback cannot drift from the session-derived shape beside it.
  return planFilePathForSession("")
}

/**
 * The plan file for ONE session, relative to the workspace.
 *
 * A fixed path was the original design and it does not survive parallel use.
 * Two sessions in the same repo both passed the path gate — the gate compares a
 * resolved path against this value and has no notion of ownership — so the
 * second plan silently replaced the first, and an `edit` written against the
 * old text failed with a message about fuzzy matching instead of naming the
 * collision. The rest of plan mode was already per-session: the mode flag, the
 * steps and the execution flag live in a `PLAN_MODE_ENTRY` in each session's
 * own transcript. The file was the last piece of shared mutable state.
 *
 * The Claude front-end already does this — its artifact hook reads
 * `tool_input.planFilePath` "per-session; never the globally-newest file in the
 * shared plans dir" (`src/internal-artifact-open.ts`). This is the same
 * contract, with the name derived rather than model-chosen:
 *
 *  - **Derived, not chosen.** A generated three-word name would have to survive
 *    the model restating it, and a resumed session that picked a different name
 *    would fork the plan. A session id is unforgeable and resume-stable for
 *    free, and it keeps the gate an exact-path comparison.
 *  - **Full id, not a hash or a prefix.** The id already appears in the
 *    transcript filename, so a plan directory traces back to the session that
 *    wrote it. UUIDv7 is time-ordered at the front, so a prefix would collide
 *    for launches in the same millisecond.
 *  - **One `<slug>` segment**, so the repository's existing convention
 *    (`.github-router/plans/<slug>/plan.md`, what `/gh-plan` writes and
 *    `/gh-implement` reads, `.complete` beside it) still describes the shape.
 *
 * Sanitized to `[A-Za-z0-9._-]` as belt-and-braces: the id is host-generated,
 * but sanitizing also makes traversal structurally impossible — path separators
 * cannot survive, and a segment that is entirely dots is unreachable anyway
 * because every one of these starts with `pi-plan-`.
 *
 * Sanitizing is LOSSY, and lossy is a collision. pi's own id validator
 * (`assertValidSessionId`) admits `.`, so `a.b` and `a-b` are both legal ids,
 * and `--session-id` lets an operator pick either; mapping one onto the other
 * would reinstate, for that pair, the very bug this function exists to prevent.
 * Dots are therefore KEPT (they are inert inside a prefixed segment). Anything
 * that still had to be ALTERED — a character dropped, or the length cap hit —
 * carries a digest of its original bytes instead of silently merging with its
 * neighbours. Generated UUIDv7 ids are `[0-9a-f-]` and are untouched, so the
 * readable form that traces to the transcript filename stays the common case.
 * FNV-1a rather than a cryptographic digest because this has to survive being
 * inlined into the emitted extension (a `toString()` copy cannot import
 * `node:crypto`), and telling two host-generated ids apart does not need
 * resistance to an attacker who could pick the path outright.
 *
 * Emitted via `.toString()`, so this body carries no module-scope references —
 * the layout strings are inline for that reason, not by preference, and the
 * digest is hand-rolled because `node:crypto` is not importable there.
 */
export function planFilePathForSession(sessionId: unknown): string {
  const raw = typeof sessionId === "string" ? sessionId.trim() : ""
  let slug = ""
  let altered = false
  for (const ch of raw) {
    if (/[A-Za-z0-9._-]/.test(ch)) slug += ch
    else {
      altered = true
      if (slug.length > 0 && !slug.endsWith("-")) slug += "-"
    }
  }
  slug = slug.replace(/^[.-]+|[.-]+$/g, "")
  if (slug.length > 96) {
    slug = slug.slice(0, 96).replace(/[.-]+$/g, "")
    altered = true
  }
  // `altered` so far only tracks dropped characters; a trim that silently
  // shortens a slug is the same loss, so it counts too.
  if (slug !== raw) altered = true
  if (!slug) return ".github-router/plans/pi-plan/plan.md"
  if (altered) {
    // Distinct originals must not share a directory just because the readable
    // part of both sanitized to the same text.
    let hash = 0x811c9dc5
    for (let i = 0; i < raw.length; i++) {
      hash ^= raw.charCodeAt(i)
      hash = Math.imul(hash, 0x01000193) >>> 0
    }
    slug += "-" + hash.toString(16).padStart(8, "0")
  }
  return ".github-router/plans/pi-plan-" + slug + "/plan.md"
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
 * comparison here and the value `planFilePathForSession()` produces, which is
 * why the relative plan path is a PARAMETER: a `toString()`-serialized function
 * cannot see module scope, and a captured constant would be `undefined` at
 * runtime.
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
    `  // /plan, Shift+Tab (freed: the mirror's keybindings.json moves thinking-`,
    `  // level cycling to Ctrl+Shift+T) or Ctrl+Alt+P (the fallback on a host`,
    `  // without that file) toggles it. The tool set is NEVER touched: it used to`,
    `  // be snapshotted on entry and restored on exit, and removing the writers from`,
    `  // it made the path gate below unreachable (pi answers "Tool write not found"`,
    `  // before any handler runs), plus a restored snapshot could widen the roster a`,
    `  // narrower launch installed. ONE barrier instead: the writers stay offered`,
    `  // and the gate refuses every target except the plan file. Everything else`,
    `  // stays, because a frontier model told to explore and not implement needs a`,
    `  // shell and can be trusted with one.`,
    `  try {`,
    `    const PLAN_STATUS_KEY = ${JSON.stringify(PLAN_STATUS_KEY)};`,
    `    const PLAN_WIDGET_KEY = ${JSON.stringify(PLAN_WIDGET_KEY)};`,
    `    const PLAN_ENTRY = ${JSON.stringify(PLAN_MODE_ENTRY)};`,
    `    const PLAN_CONTEXT_TYPE = ${JSON.stringify(PLAN_CONTEXT_TYPE)};`,
    `    const PLAN_EXEC_TYPE = ${JSON.stringify(PLAN_EXEC_TYPE)};`,
    `    const PLAN_DONE_TYPE = ${JSON.stringify(PLAN_DONE_TYPE)};`,
    `    const PLAN_LIST_TYPE = ${JSON.stringify(PLAN_LIST_TYPE)};`,
    `    const PLAN_BLOCKED = new Set(${JSON.stringify([...PLAN_BLOCKED_TOOLS])});`,
    `    const planFilePathForSession = (${planFilePathForSession.toString()});`,
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
    `    let planCwd = "";`,
    `    // The plan file, resolved from THIS session's id and cached for the run.`,
    `    // A fixed path was the original design and it does not survive parallel`,
    `    // use: two sessions in one repo both cleared the gate, so the second plan`,
    `    // silently replaced the first. Resolving from the session id gives each`,
    `    // session its own file with no lock and no coordination, and because the`,
    `    // id is stable across resume the same session keeps editing the same file.`,
    `    // Cached, then re-resolved on every session_start: the derive is cheap but`,
    `    // it must run once per (possibly changing) session, not once per gate hit.`,
    `    let planRel = "";`,
    `    // Set while the "what next?" prompt is open. agent_end can fire again for`,
    `    // the same plan (a queued follow-up run ends too), and a second prompt on`,
    `    // top of the first would let two Execute answers each send an execution`,
    `    // kick, resetting progress and paying for a redundant turn.`,
    `    let planPromptOpen = false;`,
    ``,
    `    // Resolve (once per session) the ONE file this session may write. Every`,
    `    // read site goes through here so the notify, the status line, the brief`,
    `    // and the gate can never disagree about the path.`,
    `    function planRelFor(ctx) {`,
    `      if (planRel) return planRel;`,
    `      let id = "";`,
    `      try {`,
    `        const sm = ctx && ctx.sessionManager;`,
    `        if (sm && typeof sm.getSessionId === "function") id = sm.getSessionId();`,
    `      } catch {}`,
    `      // No second fallback here: planFilePathForSession ALWAYS returns a usable`,
    `      // path (an unusable id becomes the shared fallback inside it), so a`,
    `      // "|| fallback" would be dead code that reads like a live guard.`,
    `      planRel = planFilePathForSession(id);`,
    `      return planRel;`,
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
    `        };`,
    `        const key = JSON.stringify(data);`,
    `        if (key === planPersistKey) return;`,
    `        planPersistKey = key;`,
    `        pi.appendEntry(PLAN_ENTRY, data);`,
    `      } catch {}`,
    `    }`,
    ``,
    `    function planEnter(ctx) {`,
    `      if (planEnabled) return;`,
    `      planEnabled = true;`,
    `      planExecuting = false;`,
    `      planPromptOpen = false;`,
    `      planSteps = [];`,
    `      try { if (ctx && typeof ctx.cwd === "string" && ctx.cwd) planCwd = ctx.cwd; } catch {}`,
    `      try { ctx.ui.notify("Plan mode on: writes refused except " + planRelFor(ctx) + ". Investigate, then write the plan there. Shift+Tab (or /plan) to leave.", "info"); } catch {}`,
    `      planUpdateUi(ctx);`,
    `      planPersist();`,
    `    }`,
    ``,
    `    function planExit(ctx) {`,
    `      if (!planEnabled && !planExecuting) return;`,
    `      planEnabled = false;`,
    `      planExecuting = false;`,
    `      planPromptOpen = false;`,
    `      planSteps = [];`,
    `      try { ctx.ui.notify("Plan mode off: writes allowed everywhere again.", "info"); } catch {}`,
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
    `      // Claude Code's plan-mode key. Pi binds app.thinking.cycle to shift+tab`,
    `      // and reserves it against extension overrides, so the launcher moves that`,
    `      // action off shift+tab in the mirror's keybindings.json — this`,
    `      // registration takes the freed key. Registering anyway is safe when the`,
    `      // key is still bound: pi drops the extension shortcut with a diagnostic`,
    `      // instead of throwing, which is the honest failure mode.`,
    `      pi.registerShortcut("shift+tab", {`,
    `        description: "Toggle plan mode",`,
    `        handler: async (ctx) => { planToggle(ctx); },`,
    `      });`,
    `    } catch {}`,
    `    try {`,
    `      // Literal KeyId rather than Key.ctrlAlt("p"): the generated source then`,
    `      // needs no pi-tui import at all, which keeps it loadable on every build`,
    `      // whose host-provided specifier list is smaller than today's. The value`,
    `      // is exactly what Key.ctrlAlt("p") returns (pi-tui keys.js:118).`,
    `      // Kept as the fallback for a host whose keybindings.json we did not`,
    `      // write (older launcher, hand-run pi against this extension).`,
    `      pi.registerShortcut("ctrl+alt+p", {`,
    `        description: "Toggle plan mode (alternate)",`,
    `        handler: async (ctx) => { planToggle(ctx); },`,
    `      });`,
    `    } catch {}`,
    `    try {`,
    `      pi.registerCommand("plan-status", {`,
    `        description: "Show plan mode state and the current step list",`,
    `        handler: async (_args, ctx) => {`,
    `          if (!planEnabled && !planExecuting && planSteps.length === 0) {`,
    `            try { ctx.ui.notify("Plan mode is off. /plan (or Shift+Tab) to start planning.", "info"); } catch {}`,
    `            return;`,
    `          }`,
    `          const done = planSteps.filter((s) => s.completed).length;`,
    `          const body = planSteps.length === 0`,
    `            ? "No steps parsed yet. Ask for a numbered Plan: block."`,
    `            : planSteps.map((s) => (s.completed ? "\\u2713 " : "\\u25CB ") + s.step + ". " + s.text).join("\\n");`,
    `          const head = planExecuting ? "Executing plan (" + done + "/" + planSteps.length + ")" : "Plan mode active";`,
    `          // Name THIS session's file: with a per-session path, "the plan file"`,
    `          // is no longer a single answer, and the human needs the real one.`,
    `          try { ctx.ui.notify(head + "\\n" + planRelFor(ctx) + "\\n" + body, "info"); } catch {}`,
    `        },`,
    `      });`,
    `    } catch {}`,
    ``,
    `    // THE barrier: one write exception, enforced by resolved path. A write or`,
    `    // edit whose target is the pinned plan file passes; every other target is`,
    `    // refused whatever the model believes. The path comes from the extension`,
    `    // and never from the model, which is what keeps the exception from widening`,
    `    // into a general write permission. It has to be the ONLY barrier: narrowing`,
    `    // the tool set as well would hide these tools from the model, so pi would`,
    `    // answer "Tool write not found" before this handler and the exception could`,
    `    // never fire — see PLAN_BLOCKED_TOOLS.`,
    `    try {`,
    `      pi.on("tool_call", async (event, ctx) => {`,
    `        if (!planEnabled || !event) return undefined;`,
    `        const name = String(event.toolName || "");`,
    `        if (!PLAN_BLOCKED.has(name)) return undefined;`,
    `        try { if (ctx && typeof ctx.cwd === "string" && ctx.cwd) planCwd = ctx.cwd; } catch {}`,
    `        const input = (event.input || {});`,
    `        const target = input.path !== undefined ? input.path : input.file_path;`,
    `        const planFileRel = planRelFor(ctx);`,
    `        if (isPlanFilePath(planCwd, target, planFileRel)) return undefined;`,
    `        return {`,
    `          block: true,`,
    `          reason: "Plan mode: this write is refused. The only file you may write is " + planFileRel + " (pass exactly that path). Record the plan there, or leave plan mode (/plan or Shift+Tab) to change code.",`,
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
    `    // Built per resolved path rather than as a module constant: the plan file`,
    `    // is per-session now, so a constant would name the wrong file for every`,
    `    // session but one. Called once per session (the result is cached on the`,
    `    // resolved path), not once per turn.`,
    `    let planBriefCache = { rel: "", text: "" };`,
    `    function planBriefFor(rel) {`,
    `      if (planBriefCache.rel === rel) return planBriefCache.text;`,
    `      const planBriefLines = [`,
    `        "[PLAN MODE ACTIVE]",`,
    `        "",`,
    `        "Plan mode is active. The user does not want you to execute yet -- you must not edit files,",`,
    `        "run a command that changes the code, or otherwise act on the plan. This supersedes any other",`,
    `        "instruction you have received about doing the work now.",`,
    `        "",`,
    `        "One exception, and it is the whole of it: you may write your plan to",`,
    `        "  " + rel,`,
    `        "Edit and write are refused for every other path. Read, search, and run read-only commands",`,
    `        "freely -- explore enough that the plan is grounded in what the code actually does.",`,
    `        "",`,
    `        "Work the plan like this:",`,
    `        "1. Understand the request, and look for what already exists (functions, utilities, patterns)",`,
    `        "   before proposing anything new. Delegate broad or parallel discovery when that is faster",`,
    `        "   than reading serially yourself.",`,
    `        "2. Ask the user whatever you cannot settle from the code. Do it once, up front, and never",`,
    `        "   ask what exploration could answer.",`,
    `        "3. Design the approach far enough that an implementer would have no open decisions left:",`,
    `        "   which files, what changes in each, what each change is done when, and what would prove it.",`,
    `        "4. Write the plan to the plan file: a short Context section, the recommended approach only,",`,
    `        "   the critical files, the verification steps, and any residual risk. Keep it scannable.",`,
    `        "5. Summarise the plan in your reply too, so the user can answer without opening the file,",`,
    `        "   finishing with a numbered list of the steps -- that list becomes the checklist.",`,
    `        "",`,
    `        "Do NOT open an ask_user question or a prose prompt for plan approval. Leaving plan mode is",`,
    `        "the user's action (/plan or Shift+Tab) -- asking permission to stop planning is the one",`,
    `        "question this mode does not want, and approval you grant yourself is not approval.",`,
    `        "If the user asks for changes, revise this one plan file in place rather than writing a second plan.",`,
    `        "The test for every other action: if it would reasonably be described as DOING the work",`,
    `        "rather than planning it, it waits until plan mode is off.",`,
    `      ].join("\\n");`,
    `      planBriefCache = { rel: rel, text: planBriefLines };`,
    `      return planBriefLines;`,
    `    }`,
    ``,
    `    // Cost contract: inject NOTHING unless plan mode is actually engaged, and`,
    `    // only for a real user turn (a background notification must not re-add it).`,
    `    try {`,
    `      pi.on("before_agent_start", async (event, ctx) => {`,
    `        if (!event || event.messageType !== "user") return undefined;`,
    `        if (planEnabled) {`,
    `          return { message: { customType: PLAN_CONTEXT_TYPE, content: planBriefFor(planRelFor(ctx)), display: false } };`,
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
    `        // /plan, Shift+Tab, /new). Honouring Execute there would silently`,
    `        // re-enter a mode they just exited.`,
    `        if (!planEnabled) return;`,
    `        if (String(choice).indexOf("Execute") === 0) {`,
    `          planEnabled = false;`,
    `          planExecuting = true;`,
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
    `    // Restore after resume: the ENTRY is the source of truth for the mode, the`,
    `    // step list and the badge — and nothing else. The gate below needs no`,
    `    // restore because it reads the live flag.`,
    `    // State is assigned UNCONDITIONALLY: a fresh session (/new, /fork into an`,
    `    // empty branch) has no entry, and leaving the previous session's flags in`,
    `    // place would keep a stale badge for a mode that is not gating anything.`,
    `    try {`,
    `      pi.on("session_start", async (_event, ctx) => {`,
    `        try {`,
    `          if (ctx && typeof ctx.cwd === "string" && ctx.cwd) planCwd = ctx.cwd;`,
    `          // Re-resolve the plan file for THIS session. The id is stable across`,
    `          // resume, so a resumed session lands back on the file it started; a`,
    `          // fork or a new session gets its own, which is the whole point.`,
    `          planRel = "";`,
    `          planRelFor(ctx);`,
    `          const entries = ctx.sessionManager && typeof ctx.sessionManager.getEntries === "function"`,
    `            ? ctx.sessionManager.getEntries()`,
    `            : [];`,
    `          let saved = undefined;`,
    `          for (const entry of entries) {`,
    `            if (entry && entry.type === "custom" && entry.customType === PLAN_ENTRY) saved = entry.data;`,
    `          }`,
    `          const nextEnabled = !!saved && saved.enabled === true;`,
    `          const nextExecuting = !!saved && saved.executing === true;`,
    `          // Nothing here touches the active tool set. Plan mode does not own`,
    `          // it: the only thing that ever changed the roster was the restriction`,
    `          // this design deleted, and a resumed snapshot must never widen the`,
    `          // roster a narrower current launch installed (that was a real bug:`,
    `          // resuming under --tools read,bash silently restored grep).`,
    `          planEnabled = nextEnabled;`,
    `          planExecuting = nextExecuting;`,
    `          planPromptOpen = false;`,
    `          planPersistKey = null;`,
    `          planSteps = saved && Array.isArray(saved.steps)`,
    `            ? saved.steps.map((s) => ({ step: Number(s.step) || 0, text: String(s.text || ""), completed: s.completed === true }))`,
    `            : [];`,
    `          // An execution with no steps is a dead end: the checklist is empty and`,
    `          // every execution branch bails on steps.length, so treat it as off.`,
    `          if (planExecuting && planSteps.length === 0) planExecuting = false;`,
    `        } catch {}`,
    `        planUpdateUi(ctx);`,
    `      });`,
    `    } catch {}`,
    `  } catch {}`,
    ``,
  ]
}
