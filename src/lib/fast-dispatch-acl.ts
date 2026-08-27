/**
 * Pure policy for the fast profile's native Task/Agent delegation graph.
 *
 * This policy is compiled into the hook rather than read from per-launch files,
 * so cleanup or a partial runtime-file write cannot silently disarm the guard.
 * It is an in-session Task/Agent ACL, not a shell sandbox: role tool lists
 * narrow the available tools while this graph narrows native dispatch edges.
 */

export const FAST_NATIVE_AGENT_NAMES = [
  "scout",
  "implementer",
  "reviewer",
  "planner",
  "critic",
] as const

export type FastNativeAgentName = (typeof FAST_NATIVE_AGENT_NAMES)[number]

const FAST_NATIVE_AGENT_SET = new Set<string>(FAST_NATIVE_AGENT_NAMES)

/** Frozen authority graph: each key is a caller and each value its targets. */
export const FAST_DISPATCH_GRAPH: Readonly<Record<FastNativeAgentName, ReadonlySet<FastNativeAgentName>>> =
  Object.freeze({
    scout: new Set<FastNativeAgentName>(),
    implementer: new Set<FastNativeAgentName>(["reviewer", "critic"]),
    reviewer: new Set<FastNativeAgentName>(),
    planner: new Set<FastNativeAgentName>(["reviewer", "scout", "critic"]),
    critic: new Set<FastNativeAgentName>(),
  })

/** The hook matcher is intentionally limited to native dispatch tool names. */
export const FAST_DISPATCH_TOOL_MATCHER = "^(Task|Agent)$"

interface DispatchPayload {
  tool_name?: unknown
  tool_input?: unknown
  agent_type?: unknown
  agent_id?: unknown
  parent_tool_use_id?: unknown
  agentType?: unknown
  agentId?: unknown
  parentToolUseId?: unknown
}

export interface FastDispatchGuardResult {
  allowed: boolean
  reason?: string
  caller?: FastNativeAgentName | "lead"
  target?: FastNativeAgentName
  verdict: "allow-non-dispatch" | "allow" | "deny"
}

function hasOwn(obj: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key)
}

function valuesForAliases(obj: Record<string, unknown>, names: ReadonlyArray<string>): Array<unknown> {
  return names.filter((name) => hasOwn(obj, name)).map((name) => obj[name])
}

/**
 * Resolve an aliased string field. Null and undefined are marker values. One
 * concrete value is accepted, while different concrete aliases are a conflict.
 */
function resolveAliasedString(
  obj: Record<string, unknown>,
  names: ReadonlyArray<string>,
): { present: boolean; value?: string; malformed: boolean; conflict: boolean } {
  const values = valuesForAliases(obj, names)
  if (values.length === 0) return { present: false, malformed: false, conflict: false }
  const concrete = values.filter((value) => value !== undefined && value !== null)
  if (concrete.some((value) => typeof value !== "string" || value.trim().length === 0)) {
    return { present: true, malformed: true, conflict: false }
  }
  const distinct = [...new Set((concrete as Array<string>).map((value) => value.trim()))]
  if (distinct.length > 1) return { present: true, malformed: false, conflict: true }
  return { present: true, value: distinct[0], malformed: false, conflict: false }
}

function deny(
  reason: string,
  target?: FastNativeAgentName,
  caller?: FastNativeAgentName | "lead",
): FastDispatchGuardResult {
  return { allowed: false, reason, target, caller, verdict: "deny" }
}

/**
 * Evaluate one raw Claude Code PreToolUse payload.
 *
 * Classification happens before strict parsing. A malformed or unrelated
 * ordinary-tool hook therefore passes through, while a recognized Task/Agent
 * dispatch fails closed on malformed input or identity.
 */
export function decideFastDispatchGuard(stdin: string | unknown): FastDispatchGuardResult {
  let parsed: unknown
  try {
    parsed = typeof stdin === "string" ? JSON.parse(stdin) : stdin
  } catch {
    return deny("fast dispatch denied: malformed hook payload")
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return deny("fast dispatch denied: hook payload must be an object")
  }

  const payload = parsed as DispatchPayload
  if (typeof payload.tool_name !== "string") {
    return deny("fast dispatch denied: hook payload has no tool_name")
  }
  const toolName = payload.tool_name
  if (!/^(Task|Agent)$/.test(toolName)) {
    return { allowed: true, verdict: "allow-non-dispatch" }
  }

  if (!payload.tool_input || typeof payload.tool_input !== "object" || Array.isArray(payload.tool_input)) {
    return deny(`fast dispatch denied: ${toolName} payload has malformed tool_input`)
  }
  const targetResult = resolveAliasedString(
    payload.tool_input as Record<string, unknown>,
    ["subagent_type", "subagentType"],
  )
  if (targetResult.malformed) {
    return deny(`fast dispatch denied: ${toolName} target identity is malformed`)
  }
  if (targetResult.conflict) {
    return deny(`fast dispatch denied: ${toolName} target aliases conflict`)
  }
  const targetValue = targetResult.value
  if (!targetValue || !FAST_NATIVE_AGENT_SET.has(targetValue)) {
    return deny(
      `fast dispatch denied: ${toolName} target must be one of ${FAST_NATIVE_AGENT_NAMES.join(", ")}`,
    )
  }
  const target = targetValue as FastNativeAgentName

  const callerType = resolveAliasedString(payload as Record<string, unknown>, ["agent_type", "agentType"])
  const callerId = resolveAliasedString(payload as Record<string, unknown>, ["agent_id", "agentId"])
  const parentMarker = resolveAliasedString(payload as Record<string, unknown>, [
    "parent_tool_use_id",
    "parentToolUseId",
  ])
  if (callerType.malformed || callerId.malformed || parentMarker.malformed) {
    return deny(`fast dispatch denied: ${toolName} caller identity is malformed`, target)
  }
  if (callerType.conflict || callerId.conflict || parentMarker.conflict) {
    return deny(`fast dispatch denied: ${toolName} caller identity aliases conflict`, target)
  }

  const callerTypeValue = callerType.value
  const callerIdValue = callerId.value
  const parentValue = parentMarker.value

  // A non-null agent id or parent marker cannot impersonate a role by itself.
  // A valid role may be accompanied by either marker as supplemental evidence.
  if (!callerTypeValue && callerIdValue) {
    return deny(`fast dispatch denied: ${toolName} has agent_id without agent_type`, target)
  }
  if (!callerTypeValue && parentValue) {
    return deny(`fast dispatch denied: ${toolName} has only a parent execution marker`, target)
  }

  // Absent or null identity fields are the only lead representation. Empty
  // strings and non-string values were rejected above; unknown roles fail closed.
  if (!callerTypeValue) {
    const hasPresentMarker = callerType.present || callerId.present || parentMarker.present
    const hasUnresolvedNonNullMarker = [callerType, callerId, parentMarker].some(
      (marker) => marker.value !== undefined,
    )
    if (hasPresentMarker && hasUnresolvedNonNullMarker) {
      return deny(`fast dispatch denied: ${toolName} has no resolvable caller role`, target)
    }
    return { allowed: true, caller: "lead", target, verdict: "allow" }
  }
  if (!FAST_NATIVE_AGENT_SET.has(callerTypeValue)) {
    return deny(`fast dispatch denied: unknown caller role ${JSON.stringify(callerTypeValue)}`, target)
  }
  const caller = callerTypeValue as FastNativeAgentName
  const allowedTargets = FAST_DISPATCH_GRAPH[caller]
  if (!allowedTargets.has(target)) {
    return deny(`fast dispatch denied: ${caller} cannot invoke ${target}`, target, caller)
  }
  return { allowed: true, caller, target, verdict: "allow" }
}

/** JSON response consumed by Claude Code's PreToolUse hook protocol. */
export function fastDispatchDenyOutput(reason: string): string {
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  })
}
