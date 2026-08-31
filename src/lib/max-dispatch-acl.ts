import {
  MAX_PROFILE_NATIVE_AGENT_NAMES,
  MAX_PROFILE_NATIVE_MODELS,
  type MaxProfileNativeAgentName,
} from "./max-profile-contract"
import type { Effort } from "./reasoning-effort"

export const MAX_DISPATCH_TOOL_MATCHER = "^(Task|Agent)$"

export const MAX_BROWSE_DISPATCH_AGENT = "worker-browse" as const

const MAX_NATIVE_AGENT_SET = new Set<string>([
  ...MAX_PROFILE_NATIVE_AGENT_NAMES,
  MAX_BROWSE_DISPATCH_AGENT,
])

/** Assert max launches never start without their native Task/Agent ACL. */
export class MaxDispatchGuardInstallError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "MaxDispatchGuardInstallError"
  }
}

export function assertMaxDispatchGuardInstalled(
  maxProfile: boolean,
  installationSucceeded: boolean,
): void {
  if (maxProfile && !installationSucceeded) {
    throw new MaxDispatchGuardInstallError(
      "max profile requires the native Task/Agent ACL hook, but it could not be installed; refusing to start an unguarded max session.",
    )
  }
}

const MAX_ALLOWED_MODEL_BASES = new Set(["gpt-5.6-luna", "gemini-3.7-flash", "grok-4.6"])

/**
 * Claude Code's public Agent schema currently requires one of these built-in
 * model aliases even when the selected custom agent already owns its model in
 * frontmatter. They are transport placeholders in max, not model overrides.
 * Strip them so the role's catalog-validated max model remains authoritative.
 * Case and a trailing `[1m]` are ignored deliberately: neither can turn a
 * client-owned placeholder into an Opus override in the closed max roster.
 */
export const MAX_AGENT_SCHEMA_MODEL_ALIASES = Object.freeze([
  "sonnet",
  "opus",
  "haiku",
  "fable",
] as const)

const MAX_AGENT_SCHEMA_MODEL_ALIAS_SET = new Set<string>(
  MAX_AGENT_SCHEMA_MODEL_ALIASES,
)

function isMaxAgentSchemaModelAlias(model: unknown): boolean {
  if (typeof model !== "string") return false
  return MAX_AGENT_SCHEMA_MODEL_ALIAS_SET.has(baseModel(model.trim()).toLowerCase())
}

export interface MaxDispatchDecision {
  allowed: boolean
  reason?: string
  updatedInput?: Record<string, unknown>
  target?: string
  effort?: Effort
  verdict: "allow" | "deny" | "allow-non-dispatch"
}

function stringField(input: Record<string, unknown>, ...keys: string[]): string | undefined {
  const values = keys
    .filter((key) => Object.prototype.hasOwnProperty.call(input, key))
    .map((key) => input[key])
    .filter((value) => value !== undefined && value !== null)
  if (values.length === 0) return undefined
  if (values.some((value) => typeof value !== "string" || value.trim().length === 0)) return undefined
  const distinct = [...new Set((values as string[]).map((value) => value.trim()))]
  return distinct.length === 1 ? distinct[0] : undefined
}

function baseModel(model: string): string {
  return model.replace(/(?:\[1m\])+$/i, "")
}

export function normalizeMaxDispatchModel(model: unknown): string | undefined {
  if (typeof model !== "string" || model.trim().length === 0) return undefined
  const trimmed = model.trim()
  const base = baseModel(trimmed)
  return MAX_ALLOWED_MODEL_BASES.has(base)
    ? base === "grok-4.6" ? base : `${base}[1m]`
    : undefined
}

export function normalizeMaxDispatchEffort(
  model: string,
  effort: unknown,
): Effort | undefined {
  if (effort === undefined || effort === null) return undefined
  if (typeof effort !== "string") return undefined
  const allowed: ReadonlyArray<Effort> = model === "gpt-5.6-sol"
    ? ["high", "xhigh", "max"]
    : model === "gpt-5.6-luna"
      ? ["none", "low", "medium", "high", "xhigh", "max"]
      : model === "grok-4.6" || model === "gemini-3.7-flash"
        // The optional reviewer/brainstorm fallback swaps these two models;
        // their max-profile effort intersection is deliberately identical.
        ? ["low", "medium", "high"]
        : []
  if (allowed.includes(effort as Effort)) return effort as Effort
  return undefined
}

/**
 * Native max Task/Agent ACL. Role frontmatter owns the fixed model. Required
 * public-schema aliases are stripped as transport placeholders; a client that
 * can express custom ids may override only to Luna, Gemini, or Grok with a
 * live-ladder effort. Sol/Codex/unknown/private ids are rejected. The lead may
 * target any emitted max role; role-to-role edges are unrestricted here.
 */
export function decideMaxDispatchGuard(stdin: string | unknown): MaxDispatchDecision {
  let parsed: unknown
  try {
    parsed = typeof stdin === "string" ? JSON.parse(stdin) : stdin
  } catch {
    return { allowed: false, reason: "max dispatch denied: malformed hook payload", verdict: "deny" }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { allowed: false, reason: "max dispatch denied: hook payload must be an object", verdict: "deny" }
  }
  const payload = parsed as Record<string, unknown>
  if (typeof payload.tool_name !== "string") {
    return { allowed: false, reason: "max dispatch denied: hook payload has no tool_name", verdict: "deny" }
  }
  if (!/^(Task|Agent)$/.test(payload.tool_name)) {
    return { allowed: true, verdict: "allow-non-dispatch" }
  }
  if (!payload.tool_input || typeof payload.tool_input !== "object" || Array.isArray(payload.tool_input)) {
    return { allowed: false, reason: `max dispatch denied: ${payload.tool_name} payload has malformed tool_input`, verdict: "deny" }
  }
  const toolInput = payload.tool_input as Record<string, unknown>
  const target = stringField(toolInput, "subagent_type", "subagentType")
  if (!target || !MAX_NATIVE_AGENT_SET.has(target)) {
    return { allowed: false, reason: `max dispatch denied: target must be one of ${[...MAX_PROFILE_NATIVE_AGENT_NAMES, MAX_BROWSE_DISPATCH_AGENT].join(", ")}`, verdict: "deny" }
  }
  const nativeTarget = target as MaxProfileNativeAgentName | typeof MAX_BROWSE_DISPATCH_AGENT
  const modelValue = toolInput.model
  const schemaAlias = isMaxAgentSchemaModelAlias(modelValue)
  const normalizedModel = modelValue === undefined || schemaAlias
    ? undefined
    : normalizeMaxDispatchModel(modelValue)
  if (modelValue !== undefined && !schemaAlias && !normalizedModel) {
    return { allowed: false, reason: "max dispatch denied: model must be a Claude Code Agent schema alias, Luna[1m], Gemini 3.7 Flash[1m], or bare Grok 4.6", target, verdict: "deny" }
  }
  const requestedEffort = toolInput.thinking ?? toolInput.effort
  const effectiveModel = normalizedModel
    ? baseModel(normalizedModel)
    : nativeTarget === MAX_BROWSE_DISPATCH_AGENT
      // Keep this aligned with BROWSE_DEFAULT_MODEL. Importing worker-agent/engine
      // here would pull the worker runtime into the small hook bundle.
      ? "gpt-5.6-luna"
      : MAX_PROFILE_NATIVE_MODELS[nativeTarget]
  const effort = normalizeMaxDispatchEffort(effectiveModel, requestedEffort)
  if ((toolInput.thinking !== undefined || toolInput.effort !== undefined) && !effort) {
    return { allowed: false, reason: "max dispatch denied: reasoning override is not supported by the selected model", target, verdict: "deny" }
  }
  const updatedInput = { ...toolInput }
  if (normalizedModel) updatedInput.model = normalizedModel
  else delete updatedInput.model
  if (effort) {
    // Claude Code's native Agent payload uses `model` and `effort`; preserve
    // the field it sent rather than inventing a `thinking` key that the
    // dispatcher schema may ignore. This rewrite is only a normalization of
    // the selected model/effort, not a change to the profile's role defaults.
    if (toolInput.thinking !== undefined) updatedInput.thinking = effort
    else updatedInput.effort = effort
  }
  if (toolInput.thinking !== undefined && toolInput.effort !== undefined) {
    delete updatedInput.effort
  }
  if (toolInput.model === undefined && normalizedModel === undefined) delete updatedInput.model
  return { allowed: true, target, effort, updatedInput, verdict: "allow" }
}

export function maxDispatchAllowOutput(updatedInput: Record<string, unknown>): string {
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      updatedInput,
    },
  })
}

export function maxDispatchDenyOutput(reason: string): string {
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  })
}
