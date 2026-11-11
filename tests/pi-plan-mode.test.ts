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
 *   - both barriers work: `edit` leaves the active set AND a call to it is
 *     blocked, and `bash` is allowlisted;
 *   - `before_agent_start` injects nothing unless plan mode is engaged, and
 *     nothing for a non-`user` message even when it is;
 *   - every new Pi API touch fails open when the host does not provide it.
 */

import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { buildPiExtensionSource } from "~/lib/pi-extension"
import type { PiProfileId } from "~/lib/pi-models-settings"
import {
  PLAN_BLOCKED_DELEGATION,
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
  isPlanSafeCommand,
  planAllStepsComplete,
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
  test("the read-only allowlist accepts reads and refuses writes", () => {
    for (const command of [
      "git status",
      "git log --oneline -5",
      "git diff HEAD",
      "ls -la",
      "cat package.json",
      "rg TODO src",
      "npm ls",
      "printenv PATH",
      "date +%Y-%m-%d",
      "sort -u in.txt",
      // A file whose name merely starts with a blocked word is not a command.
      "cat rm.md",
      "ls -cp",
      "jq -r .a f",
      "fd -e ts",
      "bat f",
    ]) {
      expect(isPlanSafeCommand(command)).toBe(true)
    }
    for (const command of [
      "rm -rf dist",
      "git commit -m wip",
      "git push",
      "npm install left-pad",
      "sudo ls",
      "echo hi > file.txt",
      "tee out.txt",
      "mv a b",
      // An allowlisted prefix must not launder a second command.
      "git log && rm -rf dist",
      "ls | xargs rm",
      "ls $(rm -rf /)",
      "git diff `whoami`",
      // Read-only-LOOKING first words with a write in the flags.
      "find . -delete",
      "find . -name '*.ts' -exec rm {} \\;",
      "sort -o out.txt in.txt",
      "uniq in.txt out.txt",
      "tree -o out.txt",
      "npm audit fix",
      "date -s 2020-01-01",
      "git log --output=out.txt",
      // Script interpreters that can shell out with no metacharacter at all.
      "sed -n '1e sh' file",
      "awk 'BEGIN{system(\"sh\")}'",
      // Launchers that run a program the allowlist never inspected.
      "env python3 -c 'open(\"x\",\"w\").write(\"hi\")'",
      "env node -e 'require(\"fs\").writeFileSync(\"x\",\"y\")'",
      "env sh -c 'date'",
      // Clock writes with no -s flag.
      "date 0101000020",
      "date -j 0101000020",
      // Programs named by a flag rather than the command line.
      "sort --compress-program=sh in.txt",
      "git diff --ext-diff",
      "git log --textconv",
      // No-space output flags.
      "sort -oout.txt in.txt",
      "tree -oout.txt",
      // In-place / exec-shaped flags on read-looking tools.
      "jq -i . f",
      "jq --in-place '.a=1' f",
      "fd -x sh",
      "fd --exec sh",
      "fd -X sh",
      'bat --pager="sh -c id" f',
      "less -o log f",
      "more f",
      "",
      "   ",
    ]) {
      expect(isPlanSafeCommand(command)).toBe(false)
    }
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
    expect(section).toContain(isPlanSafeCommand.toString())
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

  test("write tool calls are blocked by name even without the tool-set barrier", async () => {
    const harness = await loadPlanExtension("block-tools", stubPi())
    const ctx = ctxFor(harness)
    const toolCall = harness.handlers.get("tool_call")!

    // Off: nothing blocked.
    expect(await toolCall({ toolName: "edit", input: {} }, ctx)).toBeUndefined()

    await harness.commands.get("plan")!.handler("", ctx)
    for (const toolName of [...PLAN_BLOCKED_TOOLS, ...PLAN_BLOCKED_DELEGATION]) {
      const result = (await toolCall({ toolName, input: {} }, ctx)) as { block?: boolean }
      expect(result?.block).toBe(true)
    }
    const powershell = (await toolCall({ toolName: "powershell", input: {} }, ctx)) as {
      block?: boolean
    }
    expect(powershell?.block).toBe(true)
  })

  test("the active set drops delegation too, and restores it verbatim", async () => {
    // A child session has its own tool roster, so the mode cannot gate what a
    // delegated agent writes. Removing `subagent` from the active set is the
    // visible half of that barrier; the tool_call refusal is the other half.
    const harness = await loadPlanExtension(
      "delegation",
      stubPi({ activeTools: ["read", "bash", "subagent", "edit"] }),
    )
    const plan = harness.commands.get("plan")!
    await plan.handler("", ctxFor(harness))
    expect(harness.tools.active).not.toContain("subagent")
    await plan.handler("", ctxFor(harness))
    expect(harness.tools.active).toEqual(["read", "bash", "subagent", "edit"])
  })

  test("bash is allowlisted in plan mode only", async () => {
    const harness = await loadPlanExtension("bash-gate", stubPi())
    const ctx = ctxFor(harness)
    const toolCall = harness.handlers.get("tool_call")!

    expect(await toolCall({ toolName: "bash", input: { command: "rm -rf dist" } }, ctx)).toBeUndefined()
    await harness.commands.get("plan")!.handler("", ctx)
    expect(
      (await toolCall({ toolName: "bash", input: { command: "git status" } }, ctx)) as unknown,
    ).toBeUndefined()
    const blocked = (await toolCall(
      { toolName: "bash", input: { command: "git commit -m x" } },
      ctx,
    )) as { block?: boolean }
    expect(blocked?.block).toBe(true)
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
