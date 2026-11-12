/**
 * Plan mode is emitted as a STRING into the generated `local:gh-router-pi`
 * extension, so nothing in the import graph typechecks it and no string
 * containment assertion can prove it runs. This suite therefore executes the
 * emitted module (same technique as `tests/pi-prompt-brief.test.ts`), hands its
 * default export a stubbed `pi`, and drives the registered handlers directly.
 *
 * What that buys, in order of how easily it would otherwise be missed:
 *   - the emitted JavaScript parses, and every helper that rides
 *     `Function.prototype.toString()` keeps working after the round trip
 *     (a helper that referenced a module-scope name would throw here first);
 *   - toggling plan mode snapshots and restores the EXACT tool set, including a
 *     `--tools` narrowing that a hardcoded "normal mode" list would resurrect;
 *   - both barriers work: `edit`/`write` leave the active set AND a call to
 *     them is refused — except for the one pinned plan file;
 *   - `before_agent_start` injects nothing unless plan mode is engaged, and
 *     nothing for a non-`user` message even when it is;
 *   - every new Pi API touch fails open when the host does not provide it.
 */

import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { buildPiExtensionSource } from "~/lib/pi-extension"
import * as planModeModule from "~/lib/pi-plan-mode"
import type { PiProfileId } from "~/lib/pi-models-settings"
import {
  PLAN_BLOCKED_TOOLS,
  PLAN_CONTEXT_TYPE,
  PLAN_EXEC_TYPE,
  PLAN_MODE_ENTRY,
  PLAN_STATUS_KEY,
  PLAN_WIDGET_KEY,
  applyDoneSteps,
  buildPiPlanModeSection,
  cleanPlanStepText,
  extractDoneSteps,
  extractPlanSteps,
  isPlanFilePath,
  planAllStepsComplete,
  planFilePath,
  type PlanStep,
} from "~/lib/pi-plan-mode"

/** Inside `node_modules` so nothing in lint or the test glob ever sees it. */
const SANDBOX = join(process.cwd(), "node_modules", ".cache", "gh-router-pi-plan")

afterAll(() => {
  rmSync(SANDBOX, { recursive: true, force: true })
})

type Handler = (event: unknown, ctx: unknown) => unknown

interface Harness {
  pi: Record<string, unknown>
  handlers: Map<string, Handler>
  commands: Map<string, { handler: (args: string, ctx: unknown) => unknown }>
  shortcuts: Map<string, { handler: (ctx: unknown) => unknown }>
  tools: { active: string[]; sets: string[][] }
  entries: Array<{ customType: string; data: unknown }>
  messages: Array<{ customType: string; content: unknown; display?: boolean; options?: unknown }>
  statuses: Map<string, string | undefined>
  widgets: Map<string, string[] | undefined>
  notifications: string[]
}

/**
 * Stub `pi`. `getActiveTools`/`setActiveTools` are backed by a real array so a
 * toggle's restore can be asserted against the snapshot rather than against a
 * copy of the restore logic. Every other member is a recorder.
 */
function stubPi(opts: {
  activeTools?: string[]
  allTools?: string[]
  ui?: Record<string, unknown>
} = {}): Harness {
  const harness: Harness = {
    pi: {},
    handlers: new Map(),
    commands: new Map(),
    shortcuts: new Map(),
    tools: { active: [...(opts.activeTools ?? ["read", "bash", "edit", "write", "grep"])], sets: [] },
    entries: [],
    messages: [],
    statuses: new Map(),
    widgets: new Map(),
    notifications: [],
  }
  const allToolNames = opts.allTools ?? ["read", "bash", "edit", "write", "grep", "find", "ls"]
  const ui = {
    notify: (message: string) => {
      harness.notifications.push(String(message))
    },
    setStatus: (key: string, text: string | undefined) => {
      harness.statuses.set(key, text)
    },
    setWidget: (key: string, content: string[] | undefined) => {
      harness.widgets.set(key, content)
    },
    select: opts.ui?.select ?? (async () => undefined),
    editor: opts.ui?.editor ?? (async () => undefined),
    theme: { fg: (_color: string, text: string) => text },
    ...opts.ui,
  }
  harness.pi = {
    on: (event: string, handler: Handler) => {
      harness.handlers.set(event, handler)
      return () => {}
    },
    registerCommand: (name: string, options: { handler: (args: string, ctx: unknown) => unknown }) => {
      harness.commands.set(name, options)
    },
    registerShortcut: (key: string, options: { handler: (ctx: unknown) => unknown }) => {
      harness.shortcuts.set(key, options)
    },
    registerTool: () => {},
    registerProvider: () => {},
    getActiveTools: () => [...harness.tools.active],
    setActiveTools: (names: string[]) => {
      harness.tools.active = [...names]
      harness.tools.sets.push([...names])
    },
    getAllTools: () => allToolNames.map((name) => ({ name })),
    appendEntry: (customType: string, data: unknown) => {
      harness.entries.push({ customType, data })
    },
    sendMessage: (message: unknown, options?: unknown) => {
      const m = message as { customType: string; content: unknown; display?: boolean }
      harness.messages.push({ ...m, options })
    },
    sendUserMessage: () => {},
    getFlag: () => undefined,
  }
  ;(harness as unknown as { ui: unknown }).ui = ui
  return harness
}

const ctxFor = (harness: Harness, extra: Record<string, unknown> = {}) => {
  const ui = (harness as unknown as { ui: Record<string, unknown> }).ui
  return {
    hasUI: true,
    ui,
    sessionManager: { getEntries: () => [], getSessionId: () => "sess-1" },
    ...extra,
  }
}

async function loadPlanExtension(name: string, harness: Harness, profileId: PiProfileId = "balanced") {
  const source = buildPiExtensionSource({ profileId })
  mkdirSync(SANDBOX, { recursive: true })
  const file = join(SANDBOX, `${name}.ts`)
  writeFileSync(file, source, "utf8")
  const mod = (await import(file)) as { default: (pi: unknown) => void }
  mod.default(harness.pi)
  return harness
}

const assistantMessage = (text: string) => ({
  role: "assistant",
  content: [{ type: "text", text }],
})
const endEvent = (text: string) => ({ type: "agent_end", messages: [assistantMessage(text)] })

describe("plan mode: pure helpers", () => {
  test("command strings are never inspected: there is no allowlist left to fool", () => {
    // This test used to be a 130-line table of read-only commands and the
    // metacharacter tricks that defeated them (`sed -n '1e sh'`,
    // `awk 'BEGIN{system("sh")}'`, `find${IFS}.-delete`), which is exactly why it
    // is gone: a command string cannot be classified by a pattern, and a row
    // added for a new trick never covered the next one. Plan mode now refuses
    // writes by TOOL, so every one of those commands is allowed — and a shell is
    // allowed to do read-only work with it. The guard being deleted is asserted
    // here so a well-meaning revert cannot bring the table back silently.
    const exported = planModeModule as unknown as Record<string, unknown>
    for (const deleted of [
      "isPlanSafeCommand",
      "PLAN_READ_TOOLS",
      "PLAN_BLOCKED_SHELLS",
      "PLAN_MCP_READ_TOOLS",
      "PLAN_BLOCKED_DELEGATION",
      "PLAN_TODO_READ_ACTIONS",
    ]) {
      expect(exported[deleted]).toBeUndefined()
    }
  })

  test("the plan file is the only path the write barrier admits", () => {
    const cwd = "/repo"
    const plan = planFilePath()
    expect(plan).toBe(".github-router/plans/pi-plan/plan.md")
    for (const accepted of [
      plan,
      "/repo/" + plan,
      "./" + plan,
      ".github-router/plans/pi-plan/../pi-plan/plan.md",
      "/repo/.github-router//plans/pi-plan/plan.md",
    ]) {
      expect(isPlanFilePath(cwd, accepted, plan)).toBe(true)
    }
    // Everything else — neighbours, parents, look-alikes, and the classic
    // "traversal that lands somewhere else" — is a write, and writes are refused.
    for (const refused of [
      "",
      "   ",
      "plan.md",
      ".github-router/plans/pi-plan/other.md",
      ".github-router/plans/pi-claude-parity/plan.md",
      ".github-router/plans/pi-plan/plan.md.bak",
      ".github-router/plans/pi-plan",
      "../plan.md",
      // Traversal that climbs out and lands somewhere else. (Note that
      // "../repo/<plan>" DOES resolve to the plan file and is correctly
      // admitted — the check is on the resolved path, not the spelling.)
      "../other/" + plan,
      "/repo/.github-router/plans/pi-plan/plan.md/../../secret.ts",
      "/etc/passwd",
      "src/lib/pi-plan-mode.ts",
    ]) {
      expect(isPlanFilePath(cwd, refused, plan)).toBe(false)
    }
    // A non-string argument is a refusal, not a crash.
    expect(isPlanFilePath(cwd, undefined, plan)).toBe(false)
    expect(isPlanFilePath(cwd, 42, plan)).toBe(false)
  })

  test("a plan that numbers from 5 keeps its numbers so [DONE:5] matches", () => {
    const steps = extractPlanSteps("Plan:\n5. Read the launcher\n6. Add the section")
    expect(steps.map((s) => s.step)).toEqual([5, 6])
    // A repeated number still gets a usable key instead of colliding.
    const dupes = extractPlanSteps("Plan:\n1. Read the launcher\n1. Add the section")
    expect(new Set(dupes.map((s) => s.step)).size).toBe(2)
    expect(applyDoneSteps("[DONE:5]", steps)).toBe(1)
    expect(steps[0].completed).toBe(true)
  })

  test("plan steps parse from the LAST Plan: header", () => {
    const text = [
      "Draft plan (thinking):",
      "Plan:",
      "1. draft first step",
      "2. draft second step",
      "",
      "Here is the plan.",
      "Plan:",
      "1. Read the launcher",
      "2. Add the plan-mode section",
      "3. Verify with tests",
    ].join("\n")
    const steps = extractPlanSteps(text)
    expect(steps.map((s) => s.text)).toEqual([
      "Read the launcher",
      "Add the plan-mode section",
      "Verify with tests",
    ])
    expect(steps.map((s) => s.step)).toEqual([1, 2, 3])
    expect(steps.every((s) => s.completed === false)).toBe(true)
  })

  test("step text drops markdown but keeps the action verb", () => {
    // Divergence from upstream: the checklist is what the user reads while the
    // plan runs, so "Read the launcher" must not collapse to "Launcher".
    expect(cleanPlanStepText("**Read** the `launcher` module")).toBe("Read the launcher module")
    expect(cleanPlanStepText("  Add   the   section  ")).toBe("Add the section")
  })

  test("done markers mark steps and stop at the first hit per step", () => {
    const steps: PlanStep[] = [
      { step: 1, text: "a", completed: false },
      { step: 2, text: "b", completed: false },
      { step: 3, text: "c", completed: false },
    ]
    expect(extractDoneSteps("[DONE:1] then [DONE 2] and Done: 3")).toEqual([1, 2, 3])
    expect(applyDoneSteps("[DONE:1]\n[DONE:1]\nStep 2 is complete", steps)).toBe(2)
    expect(steps.map((s) => s.completed)).toEqual([true, true, false])
    // A negated sentence must not complete anything.
    expect(extractDoneSteps("Step 3 is not done yet")).toEqual([])
  })

  test("whole-plan completion phrasing", () => {
    expect(planAllStepsComplete("All steps complete.")).toBe(true)
    expect(planAllStepsComplete("The plan is done")).toBe(true)
    expect(planAllStepsComplete("Every step is finished")).toBe(true)
    expect(planAllStepsComplete("Step 2 is complete")).toBe(false)
  })
})

describe("plan mode: emission", () => {
  test("every profile emits the mode, and only host-provided specifiers are imported", () => {
    for (const profileId of ["cheapest", "cheapest2", "balanced", "balanced2"] as const) {
      const source = buildPiExtensionSource({ profileId })
      expect(source).toContain('registerCommand("plan"')
      expect(source).toContain("ctrl+alt+p")
      expect(source).toContain('on("tool_call"')
      expect(source).toContain(PLAN_CONTEXT_TYPE)
      expect(source).toContain(PLAN_MODE_ENTRY)
      // Cost contract: no flag surface, so nothing new can reach the model's
      // tool list or the CLI argument parser.
      expect(source).not.toContain('registerFlag("plan"')
      expect(source).not.toContain("pi-agent-core")
    }
  })

  test("the embedded helpers are verbatim copies of the tested functions", () => {
    const section = buildPiPlanModeSection().join("\n")
    expect(section).toContain(isPlanFilePath.toString())
    expect(section).toContain(extractPlanSteps.toString())
    expect(section).toContain(applyDoneSteps.toString())
    expect(section).toContain(planAllStepsComplete.toString())
  })
})

describe("plan mode: generated module runs", () => {
  test("registers commands, shortcut and handlers", async () => {
    const harness = await loadPlanExtension("registers", stubPi())
    expect([...harness.commands.keys()].sort()).toEqual(["plan", "plan-status"])
    expect([...harness.shortcuts.keys()]).toEqual(["ctrl+alt+p"])
    for (const event of ["tool_call", "context", "before_agent_start", "turn_end", "agent_end", "session_start"]) {
      expect(harness.handlers.has(event)).toBe(true)
    }
  })

  test("toggling removes writes and restores the EXACT prior set", async () => {
    // A `--tools` narrowing: `grep` was dropped by the caller, so a hardcoded
    // "normal mode" restore list would wrongly resurrect it.
    const harness = await loadPlanExtension(
      "restore",
      stubPi({ activeTools: ["read", "bash", "edit", "write"] }),
    )
    const ctx = ctxFor(harness)
    const plan = harness.commands.get("plan")!

    await plan.handler("", ctx)
    expect(harness.tools.active).not.toContain("edit")
    expect(harness.tools.active).not.toContain("write")
    // Entry only NARROWS: `grep` was removed by the caller, so plan mode must not
    // add it back. Adding it would hand the model a tool the launch withheld.
    expect(harness.tools.active).not.toContain("grep")
    expect(harness.tools.active).toEqual(["read", "bash"])

    await plan.handler("", ctx)
    expect(harness.tools.active).toEqual(["read", "bash", "edit", "write"])
  })

  test("only the writer tools are refused; everything else a planner needs runs", async () => {
    const harness = await loadPlanExtension(
      "block-tools",
      stubPi({ activeTools: ["read", "bash", "powershell", "subagent", "todo", "edit", "write"] }),
    )
    const ctx = ctxFor(harness)
    const toolCall = harness.handlers.get("tool_call")!

    // Off: nothing blocked.
    expect(await toolCall({ toolName: "edit", input: { path: "src/x.ts" } }, ctx)).toBeUndefined()

    await harness.commands.get("plan")!.handler("", ctx)

    // Writers are refused by name, whatever the arguments claim.
    for (const toolName of PLAN_BLOCKED_TOOLS) {
      for (const input of [undefined, {}, { path: "src/lib/launch.ts" }, { file_path: "src/a.ts" }]) {
        const result = (await toolCall({ toolName, input }, ctx)) as { block?: boolean }
        expect(result?.block).toBe(true)
      }
    }

    // Everything that is not a writer passes, with no argument inspection at
    // all. Each of these used to be refused by a separate rule: destructive bash
    // by the command table, `powershell` by an asymmetry, `subagent`/`workflow`
    // by the delegation block, MCP servers by namespace, and todo writes by a
    // read-action allowlist. A frontier model told "plan, do not implement" does
    // not need the harness to re-litigate any of it, and each rule cost real
    // planning capability (`git log`, a build, a delegated survey of the repo).
    const allowed: Array<[string, unknown]> = [
      ["bash", { command: "git log --oneline -5" }],
      ["bash", { command: "bun test tests/launch.test.ts" }],
      ["powershell", { command: "Get-ChildItem" }],
      ["subagent", { agent: "Explore", task: "map the launcher" }],
      ["subagent_launch", { agent: "General-Purpose", task: "x" }],
      ["workflow", { script: "..." }],
      ["todo", { action: "create", title: "x" }],
      ["todo", { action: "update", id: "x" }],
      ["mcp__gh-router-peers__implement", {}],
      ["mcp__gh-router-cloudagent__create_job", {}],
      ["tool_search", { query: "mcp" }],
      ["read", { path: "src/lib/launch.ts" }],
      ["grep", { pattern: "SIGWINCH" }],
    ]
    for (const [toolName, input] of allowed) {
      expect(await toolCall({ toolName, input }, ctx)).toBeUndefined()
    }
  })

  test("the pinned plan file is written through the refused tool", async () => {
    // The one exception, end to end: `write` is in PLAN_BLOCKED_TOOLS and is
    // still allowed for exactly this path. Claude Code's plan mode is a
    // one-write mode, and without this the model has no way to produce the
    // artifact the user is meant to read and approve.
    const harness = await loadPlanExtension("plan-file", stubPi())
    const ctx = ctxFor(harness, { cwd: "/work/repo" })
    const toolCall = harness.handlers.get("tool_call")!
    await harness.commands.get("plan")!.handler("", ctx)

    expect(
      await toolCall({ toolName: "write", input: { path: planFilePath(), content: "# plan" } }, ctx),
    ).toBeUndefined()
    expect(
      await toolCall(
        { toolName: "write", input: { path: "/work/repo/" + planFilePath(), content: "# plan" } },
        ctx,
      ),
    ).toBeUndefined()
    // An edit of the same file is the same permission (upstream's plan file is
    // an editable Doc, not an append-only log).
    expect(
      await toolCall({ toolName: "edit", input: { path: planFilePath(), oldText: "a", newText: "b" } }, ctx),
    ).toBeUndefined()

    // The exception cannot widen: a sibling file, a look-alike, or a traversal
    // out of the directory is a normal write and stays refused.
    for (const path of [
      "src/lib/launch.ts",
      ".github-router/plans/pi-plan/notes.md",
      ".github-router/plans/other/plan.md",
      "plan.md",
      "../plan.md",
      planFilePath() + "/../../evil.ts",
    ]) {
      const result = (await toolCall({ toolName: "write", input: { path, content: "x" } }, ctx)) as {
        block?: boolean
        reason?: string
      }
      expect(result?.block).toBe(true)
      expect(result?.reason).toContain(planFilePath())
    }
    // `apply_patch` has no single target to check, so it has no exception.
    const patch = (await toolCall(
      { toolName: "apply_patch", input: { patch: "*** Begin Patch" } },
      ctx,
    )) as { block?: boolean }
    expect(patch?.block).toBe(true)
  })

  test("the plan file is still writable after a toggle round trip", async () => {
    // Guards against the exception being wired to a closure that the exit path
    // resets: a second planning session must behave like the first.
    const harness = await loadPlanExtension("plan-file-roundtrip", stubPi())
    const ctx = ctxFor(harness, { cwd: "/work/repo" })
    const plan = harness.commands.get("plan")!
    const toolCall = harness.handlers.get("tool_call")!

    await plan.handler("", ctx)
    await plan.handler("", ctx)
    await plan.handler("", ctx)
    expect(
      await toolCall({ toolName: "write", input: { path: planFilePath(), content: "x" } }, ctx),
    ).toBeUndefined()
    expect(
      ((await toolCall({ toolName: "write", input: { path: "src/x.ts", content: "x" } }, ctx)) as {
        block?: boolean
      })?.block,
    ).toBe(true)
  })

  test("before_agent_start injects nothing at rest and nothing for a non-user turn", async () => {
    const harness = await loadPlanExtension("inject-gate", stubPi())
    const ctx = ctxFor(harness)
    const before = harness.handlers.get("before_agent_start")!

    expect(await before({ messageType: "user", prompt: "hi" }, ctx)).toBeUndefined()

    await harness.commands.get("plan")!.handler("", ctx)
    expect(await before({ messageType: "custom", message: {} }, ctx)).toBeUndefined()

    const result = (await before({ messageType: "user", prompt: "hi" }, ctx)) as {
      message?: { customType: string; content: string; display?: boolean }
    }
    expect(result?.message?.customType).toBe(PLAN_CONTEXT_TYPE)
    expect(result?.message?.display).toBe(false)
    expect(result?.message?.content).toContain("[PLAN MODE ACTIVE]")
    expect(result?.message?.content).not.toContain("systemPrompt")
  })

  test("the injected brief carries the frontier planning contract", async () => {
    // The prompt IS the mechanism now: with the command table gone, these
    // sentences are what keeps a capable model in planning mode. Pinning them
    // keeps a future edit from quietly dropping the parts that matter.
    const harness = await loadPlanExtension("brief", stubPi())
    const ctx = ctxFor(harness)
    await harness.commands.get("plan")!.handler("", ctx)
    const result = (await harness.handlers.get("before_agent_start")!(
      { messageType: "user", prompt: "hi" },
      ctx,
    )) as { message?: { content: string } }
    const brief = result.message!.content

    // The closed door, the one exception, and the precedence claim.
    expect(brief).toContain("[PLAN MODE ACTIVE]")
    expect(brief).toContain("must not edit files")
    expect(brief).toContain("supersedes")
    expect(brief).toContain(planFilePath())
    // Everything else is explicitly open, so the model does not under-use its
    // tools now that no allowlist tells it what is read-only.
    expect(brief).toContain("Read, search, and run read-only commands")
    // Claude Code's five phases, compressed: reuse, ask once, decision-complete
    // design, the plan file's sections, and hand over.
    expect(brief).toContain("what already exists")
    expect(brief).toContain("never")
    expect(brief).toContain("no open decisions left")
    expect(brief).toContain("recommended approach only")
    expect(brief).toContain("verification")
    // Codex's strict-mode rule and the approval norm.
    expect(brief).toContain("Do NOT open an ask_user")
    expect(brief).toContain("Leaving plan mode is")
    // Codex's planning-vs-doing test, in one sentence.
    expect(brief).toContain("DOING the work")
    // The brief must never grow into the enumeration it replaced.
    expect(brief.length).toBeLessThan(2600)
  })

  test("the status badge and checklist widget follow the mode", async () => {
    const harness = await loadPlanExtension("ui", stubPi())
    const ctx = ctxFor(harness)

    expect(harness.widgets.get(PLAN_WIDGET_KEY)).toBeUndefined()

    await harness.commands.get("plan")!.handler("", ctx)
    expect(harness.statuses.get(PLAN_STATUS_KEY)).toContain("plan")
    expect(harness.widgets.get(PLAN_WIDGET_KEY)).toBeUndefined()

    // A parsed plan paints the checklist above the editor.
    await harness.handlers.get("agent_end")!(
      endEvent("Plan:\n1. Read the launcher\n2. Add the section"),
      ctxFor(harness, { ui: { ...(harness as unknown as { ui: object }).ui, select: async () => "Stay in plan mode" } }),
    )
    const widget = harness.widgets.get(PLAN_WIDGET_KEY)
    expect(widget).toHaveLength(2)
    expect(widget![0]).toContain("Read the launcher")

    await harness.commands.get("plan")!.handler("", ctx)
    expect(harness.statuses.get(PLAN_STATUS_KEY)).toBeUndefined()
    expect(harness.widgets.get(PLAN_WIDGET_KEY)).toBeUndefined()
  })

  test("a second agent_end does not open a second prompt or re-kick the plan", async () => {
    // A queued follow-up run (or the execution kick itself) also ends here. Two
    // prompts would let two Execute answers each post an execution message,
    // resetting progress and paying for a redundant turn.
    let prompts = 0
    const harness = await loadPlanExtension(
      "double-prompt",
      stubPi({
        activeTools: ["read", "bash", "edit", "write"],
        ui: {
          select: async () => {
            prompts++
            return "Execute the plan (track progress)"
          },
        },
      }),
    )
    const ctx = ctxFor(harness)
    await harness.commands.get("plan")!.handler("", ctx)
    const agentEnd = harness.handlers.get("agent_end")!
    const event = endEvent("Plan:\n1. Read the launcher\n2. Add the section")

    await agentEnd(event, ctx)
    await agentEnd(event, ctx)
    // One prompt for the planning run; the second call is in execution mode and
    // therefore never reaches the select at all.
    expect(prompts).toBe(1)
    expect(harness.messages.filter((m) => m.customType === PLAN_EXEC_TYPE)).toHaveLength(1)
  })

  test("a toggle during execution restores tools and stops the tracking", async () => {
    const harness = await loadPlanExtension(
      "toggle-executing",
      stubPi({
        activeTools: ["read", "bash", "edit", "write"],
        ui: { select: async () => "Execute the plan (track progress)" },
      }),
    )
    const ctx = ctxFor(harness)
    const plan = harness.commands.get("plan")!
    await plan.handler("", ctx)
    await harness.handlers.get("agent_end")!(
      endEvent("Plan:\n1. Read the launcher\n2. Add the section"),
      ctx,
    )
    expect(harness.tools.active).toEqual(["read", "bash", "edit", "write"])
    expect(harness.statuses.get(PLAN_STATUS_KEY)).toContain("/")

    // Leaving mid-execution is the same exit as leaving during planning: the
    // mode must not stay "executing" with a live badge and no plan.
    await plan.handler("", ctx)
    expect(harness.statuses.get(PLAN_STATUS_KEY)).toBeUndefined()
    expect(harness.widgets.get(PLAN_WIDGET_KEY)).toBeUndefined()
    // With the mode off, a turn_end must not keep persisting progress.
    const persisted = harness.entries.length
    await harness.handlers.get("turn_end")!({ message: assistantMessage("[DONE:1]") }, ctx)
    expect(harness.entries.length).toBe(persisted)
    expect(harness.tools.active).toEqual(["read", "bash", "edit", "write"])
  })

  test("a toggle while the prompt is open cancels the Execute answer", async () => {
    // The select is a real await: the user can leave plan mode while it is up.
    // Honouring the stale answer then would silently re-enter plan execution.
    let release: (value: string | undefined) => void = () => {}
    const pending = new Promise<string | undefined>((resolve) => {
      release = resolve
    })
    const harness = await loadPlanExtension(
      "toggle-during-prompt",
      stubPi({
        activeTools: ["read", "bash", "edit", "write"],
        ui: { select: async () => pending },
      }),
    )
    const ctx = ctxFor(harness)
    const plan = harness.commands.get("plan")!
    await plan.handler("", ctx)
    const pendingEnd = harness.handlers.get("agent_end")!(
      endEvent("Plan:\n1. Read the launcher\n2. Add the section"),
      ctx,
    )
    await plan.handler("", ctx)
    release("Execute the plan (track progress)")
    await pendingEnd
    expect(harness.messages.filter((m) => m.customType === PLAN_EXEC_TYPE)).toHaveLength(0)
    expect(harness.tools.active).toEqual(["read", "bash", "edit", "write"])
  })

  test("executing the plan restores tools, tracks [DONE:n], and completes", async () => {
    const harness = await loadPlanExtension(
      "execute",
      stubPi({
        activeTools: ["read", "bash", "edit", "write"],
        ui: { select: async () => "Execute the plan (track progress)" },
      }),
    )
    const planCtx = ctxFor(harness)
    await harness.commands.get("plan")!.handler("", planCtx)
    expect(harness.tools.active).not.toContain("edit")

    await harness.handlers.get("agent_end")!(
      endEvent("Plan:\n1. Read the launcher\n2. Add the section"),
      ctxFor(harness),
    )
    // Execution restored the caller's tool set verbatim.
    expect(harness.tools.active).toEqual(["read", "bash", "edit", "write"])
    // Two follow-ups: the visible step list and the triggerTurn execution kick.
    expect(harness.messages.map((m) => m.customType)).toContain("gh-router-plan-list")
    expect(harness.messages.map((m) => m.customType)).toContain(PLAN_EXEC_TYPE)

    // turn_end marks progress from a [DONE:n] tag.
    await harness.handlers.get("turn_end")!(
      { message: assistantMessage("Did it. [DONE:1]") },
      ctxFor(harness),
    )
    expect(harness.statuses.get(PLAN_STATUS_KEY)).toContain("1/2")

    // The final message's summary phrasing finishes the remaining step.
    await harness.handlers.get("agent_end")!(
      { type: "agent_end", messages: [assistantMessage("All steps complete.")] },
      ctxFor(harness),
    )
    expect(harness.messages.map((m) => m.customType)).toContain("gh-router-plan-done")
    expect(harness.widgets.get(PLAN_WIDGET_KEY)).toBeUndefined()
  })

  test("stale plan context is filtered out only when both modes are off", async () => {
    const harness = await loadPlanExtension("context-filter", stubPi())
    const context = harness.handlers.get("context")!
    const messages = [
      { role: "user", content: "do the thing" },
      { role: "custom", customType: PLAN_CONTEXT_TYPE, content: "[PLAN MODE ACTIVE]" },
      { role: "user", content: [{ type: "text", text: "[PLAN MODE ACTIVE] ..." }] },
      { role: "user", content: [{ type: "text", text: "[EXECUTING PLAN - full tool access enabled] ..." }] },
      { role: "assistant", content: [{ type: "text", text: "ok" }] },
    ]
    // Both markers go: a later turn must not still believe it is read-only OR
    // mid-execution. A user message that merely mentions plans survives.
    const atRest = (await context({ type: "context", messages }, ctxFor(harness))) as {
      messages: unknown[]
    }
    expect(atRest.messages).toHaveLength(2)

    await harness.commands.get("plan")!.handler("", ctxFor(harness))
    // While planning, the read-only block survives (the run depends on it) but a
    // flattened EXECUTION notice does not: the two instructions contradict each
    // other, and the live mode is the one telling the truth.
    const planning = (await context({ type: "context", messages }, ctxFor(harness))) as {
      messages: Array<{ content: unknown }>
    }
    // Everything but the execution notice survives; `[PLAN MODE ACTIVE]` is
    // still the truth while planning, flattened or not.
    expect(planning.messages).toHaveLength(4)
    expect(JSON.stringify(planning.messages)).toContain("[PLAN MODE ACTIVE]")
    expect(JSON.stringify(planning.messages)).not.toContain("[EXECUTING PLAN")
  })

  test("only the newest plan block survives while the mode is active", async () => {
    // before_agent_start messages are appended AND persisted per run, so a
    // 20-turn planning session would otherwise carry 20 copies of the same
    // instructions into every request. Older copies are dropped; the newest one
    // stays, because the active run depends on it.
    const harness = await loadPlanExtension("context-dedupe", stubPi())
    const context = harness.handlers.get("context")!
    await harness.commands.get("plan")!.handler("", ctxFor(harness))

    const messages = [
      { role: "user", content: "first" },
      { role: "custom", customType: PLAN_CONTEXT_TYPE, content: "[PLAN MODE ACTIVE] v1" },
      { role: "assistant", content: [{ type: "text", text: "ok" }] },
      { role: "user", content: "second" },
      { role: "custom", customType: PLAN_CONTEXT_TYPE, content: "[PLAN MODE ACTIVE] v2" },
    ]
    const out = (await context({ type: "context", messages }, ctxFor(harness))) as {
      messages: Array<{ content: unknown }>
    }
    expect(out.messages).toHaveLength(4)
    expect(String(out.messages[3].content)).toContain("v2")
  })

  test("resume restores state from the custom entry and re-applies the restriction", async () => {
    const harness = stubPi({ activeTools: ["read", "bash", "edit", "write"] })
    const entries = [
      {
        type: "custom",
        customType: PLAN_MODE_ENTRY,
        data: {
          enabled: true,
          executing: false,
          steps: [{ step: 1, text: "Read the launcher", completed: false }],
          toolsBeforePlan: ["read", "bash", "edit", "write"],
        },
      },
    ]
    mkdirSync(SANDBOX, { recursive: true })
    const file = join(SANDBOX, "resume.ts")
    writeFileSync(file, buildPiExtensionSource({ profileId: "balanced" }), "utf8")
    const mod = (await import(file)) as { default: (pi: unknown) => void }
    mod.default(harness.pi)

    await harness.handlers.get("session_start")!(
      { type: "session_start" },
      ctxFor(harness, { sessionManager: { getEntries: () => entries } }),
    )
    expect(harness.statuses.get(PLAN_STATUS_KEY)).toContain("plan")
    expect(harness.widgets.get(PLAN_WIDGET_KEY)).toHaveLength(1)
    expect(harness.tools.active).not.toContain("edit")

    // Leaving afterwards restores the snapshotted set, not a hardcoded one.
    await harness.commands.get("plan")!.handler("", ctxFor(harness))
    expect(harness.tools.active).toEqual(["read", "bash", "edit", "write"])
  })

  test("a fresh session clears plan state instead of inheriting the old session's", async () => {
    const harness = await loadPlanExtension(
      "fresh-session",
      stubPi({ activeTools: ["read", "bash", "edit", "write"] }),
    )
    const ctx = ctxFor(harness)
    await harness.commands.get("plan")!.handler("", ctx)
    expect(harness.statuses.get(PLAN_STATUS_KEY)).toBe("⏸ plan")

    // /new (or a fork into an empty branch) hands `session_start` a session with
    // no plan entry. Carrying the flags over would leave a badge claiming a mode
    // that is not restricting anything, and a snapshot taken from the OLD roster.
    await harness.handlers.get("session_start")!(
      { type: "session_start", reason: "new" },
      ctxFor(harness, { sessionManager: { getEntries: () => [] } }),
    )
    expect(harness.statuses.get(PLAN_STATUS_KEY)).toBeUndefined()
    expect(harness.widgets.get(PLAN_WIDGET_KEY)).toBeUndefined()
    // The live roster is un-restricted too, not just the flags: otherwise a new
    // session is read-only with no badge and no way to toggle out of it.
    expect(harness.tools.active).toEqual(["read", "bash", "edit", "write"])
    const toolCall = harness.handlers.get("tool_call")!
    expect(await toolCall({ toolName: "edit", input: {} }, ctx)).toBeUndefined()
  })

  test("a host without the newer APIs degrades instead of throwing", async () => {
    const harness = stubPi()
    // Simulate an older/leaner Pi: no getAllTools, no setActiveTools, no theme,
    // and a sessionManager whose getEntries throws.
    delete (harness.pi as Record<string, unknown>).getAllTools
    delete (harness.pi as Record<string, unknown>).setActiveTools
    const ui = (harness as unknown as { ui: Record<string, unknown> }).ui
    delete ui.theme
    mkdirSync(SANDBOX, { recursive: true })
    const file = join(SANDBOX, "degraded.ts")
    writeFileSync(file, buildPiExtensionSource({ profileId: "balanced" }), "utf8")
    const mod = (await import(file)) as { default: (pi: unknown) => void }
    expect(() => mod.default(harness.pi)).not.toThrow()

    const ctx = ctxFor(harness, {
      sessionManager: {
        getEntries: () => {
          throw new Error("nope")
        },
      },
    })
    await harness.commands.get("plan")!.handler("", ctx)
    expect(harness.statuses.get(PLAN_STATUS_KEY)).toBe("⏸ plan")
    expect(await harness.handlers.get("session_start")!({}, ctx)).toBeUndefined()
  })
})
