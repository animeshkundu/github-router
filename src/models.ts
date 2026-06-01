import { defineCommand } from "citty"
import consola from "consola"

import { ensurePaths } from "./lib/paths"
import { setupCopilotToken, setupGitHubToken } from "./lib/token"
import { getModels, type Model } from "./services/copilot/get-models"

export const models = defineCommand({
  meta: {
    name: "models",
    description:
      "List available GitHub Copilot models and their capabilities. Pass an optional pattern to filter (case-insensitive substring match on id, name, vendor, family).",
  },
  args: {
    pattern: {
      type: "positional",
      required: false,
      description:
        "Substring to filter models by (matches id, name, vendor, or family).",
    },
    json: {
      type: "boolean",
      default: false,
      description: "Emit raw JSON instead of the pretty layout.",
    },
  },
  async run({ args }) {
    await ensurePaths()
    await setupGitHubToken()
    try {
      await setupCopilotToken()
    } catch (err) {
      consola.error("Failed to obtain Copilot token:", err)
      process.exit(1)
    }

    let catalog: Awaited<ReturnType<typeof getModels>>
    try {
      catalog = await getModels()
    } catch (err) {
      consola.error("Failed to fetch Copilot model catalog:", err)
      process.exit(1)
    }

    const all = catalog.data
    const pattern = args.pattern?.toString().trim()
    const filtered = pattern ? filterModels(all, pattern) : all

    if (args.json) {
      process.stdout.write(`${JSON.stringify(filtered, null, 2)}\n`)
      return
    }

    if (filtered.length === 0) {
      consola.warn(
        `No models matched "${pattern}". ${all.length} models available — try a different substring or run without an argument to list everything.`,
      )
      process.exit(1)
    }

    const grouped = groupByVendor(filtered)
    const lines: Array<string> = []
    const header = pattern
      ? `${filtered.length}/${all.length} models match "${pattern}"`
      : `${all.length} models available`
    lines.push(header)
    lines.push("")
    for (const [vendor, list] of grouped) {
      lines.push(`▾ ${vendor} (${list.length})`)
      for (const model of list) {
        lines.push(...formatModel(model))
      }
      lines.push("")
    }
    process.stdout.write(lines.join("\n"))
  },
})

function filterModels(models: Array<Model>, pattern: string): Array<Model> {
  const needle = pattern.toLowerCase()
  return models.filter((m) => {
    const haystack = [
      m.id,
      m.name,
      m.vendor,
      m.capabilities.family,
      m.capabilities.type,
      m.model_picker_category ?? "",
    ]
      .join(" ")
      .toLowerCase()
    return haystack.includes(needle)
  })
}

function groupByVendor(models: Array<Model>): Array<[string, Array<Model>]> {
  const map = new Map<string, Array<Model>>()
  for (const m of models) {
    const key = m.vendor || "(unknown vendor)"
    const bucket = map.get(key)
    if (bucket) bucket.push(m)
    else map.set(key, [m])
  }
  // Stable vendor order: alphabetical for predictability.
  return [...map.entries()].sort(([a], [b]) => a.localeCompare(b))
}

/**
 * Test-only exports. Not part of the public CLI surface — kept out of
 * the default export so they don't show up in IDE autocomplete on
 * `import { ... } from "github-router/models"` consumers.
 */
export const __testing = { filterModels, groupByVendor, formatModel, formatTokens }

function formatModel(model: Model): Array<string> {
  const lines: Array<string> = []
  const tags: Array<string> = []
  if (model.preview) tags.push("preview")
  if (model.is_chat_default) tags.push("chat-default")
  if (model.is_chat_fallback) tags.push("chat-fallback")
  if (model.billing?.is_premium) tags.push("premium")
  if (model.billing?.restricted_to?.length) {
    tags.push(`restricted:${model.billing.restricted_to.join("/")}`)
  }
  if (model.policy && model.policy.state !== "enabled") {
    tags.push(`policy:${model.policy.state}`)
  }
  const tagStr = tags.length > 0 ? ` [${tags.join(", ")}]` : ""
  lines.push(`  • ${model.id}${tagStr}`)
  if (model.name && model.name !== model.id) {
    lines.push(`      name: ${model.name}`)
  }
  const meta: Array<string> = [
    `family: ${model.capabilities.family}`,
    `type: ${model.capabilities.type}`,
  ]
  if (model.capabilities.tokenizer) {
    meta.push(`tokenizer: ${model.capabilities.tokenizer}`)
  }
  if (model.version) {
    meta.push(`version: ${model.version}`)
  }
  lines.push(`      ${meta.join("  ·  ")}`)

  const limits = model.capabilities.limits
  const limitParts: Array<string> = []
  if (limits.max_context_window_tokens) {
    limitParts.push(`ctx ${formatTokens(limits.max_context_window_tokens)}`)
  } else if (limits.max_prompt_tokens) {
    limitParts.push(`prompt ${formatTokens(limits.max_prompt_tokens)}`)
  }
  if (limits.max_output_tokens) {
    limitParts.push(`out ${formatTokens(limits.max_output_tokens)}`)
  }
  if (
    limits.max_non_streaming_output_tokens
    && limits.max_non_streaming_output_tokens !== limits.max_output_tokens
  ) {
    limitParts.push(
      `out-non-stream ${formatTokens(limits.max_non_streaming_output_tokens)}`,
    )
  }
  if (limits.max_inputs) limitParts.push(`inputs ${limits.max_inputs}`)
  if (limits.vision?.max_prompt_images) {
    limitParts.push(`images ${limits.vision.max_prompt_images}`)
  }
  if (limitParts.length > 0) {
    lines.push(`      limits: ${limitParts.join("  ·  ")}`)
  }

  const supports = model.capabilities.supports
  const supportFlags: Array<string> = []
  if (supports.tool_calls) supportFlags.push("tools")
  if (supports.parallel_tool_calls) supportFlags.push("parallel-tools")
  if (supports.streaming) supportFlags.push("streaming")
  if (supports.vision) supportFlags.push("vision")
  if (supports.structured_outputs) supportFlags.push("structured-outputs")
  if (supports.dimensions) supportFlags.push("dimensions")
  if (supports.adaptive_thinking) {
    const min = supports.min_thinking_budget
    const max = supports.max_thinking_budget
    const range
      = min !== undefined && max !== undefined
        ? `(${formatTokens(min)}-${formatTokens(max)})`
        : ""
    supportFlags.push(`adaptive-thinking${range}`)
  }
  if (supports.reasoning_effort && supports.reasoning_effort.length > 0) {
    supportFlags.push(`reasoning:${supports.reasoning_effort.join("/")}`)
  }
  if (supportFlags.length > 0) {
    lines.push(`      supports: ${supportFlags.join(", ")}`)
  }

  if (model.supported_endpoints && model.supported_endpoints.length > 0) {
    lines.push(`      endpoints: ${model.supported_endpoints.join(", ")}`)
  }
  if (model.billing) {
    const billParts: Array<string> = []
    if (model.billing.is_premium) billParts.push("premium")
    if (typeof model.billing.multiplier === "number") {
      billParts.push(`×${model.billing.multiplier}`)
    }
    if (billParts.length > 0) {
      lines.push(`      billing: ${billParts.join(" ")}`)
    }
  }
  return lines
}

/**
 * Format a token count in a compact human-readable form: `1024` →
 * `1k`, `4096` → `4k`, `131072` → `128k`, `1048576` → `1M`. Prefer
 * binary multiples (mebi, kibi) since Claude Code / Copilot context
 * windows are reported in binary units (`1M context` = 1024 × 1024
 * tokens). Fall back to decimal (`64k` for `64000`) when the value
 * is a clean decimal multiple but not binary.
 */
function formatTokens(n: number): string {
  if (n >= 1_048_576 && n % 1_048_576 === 0) return `${n / 1_048_576}M`
  if (n >= 1024 && n % 1024 === 0) return `${n / 1024}k`
  if (n >= 1_000_000 && n % 1_000_000 === 0) return `${n / 1_000_000}M`
  if (n >= 1000 && n % 1000 === 0) return `${n / 1000}k`
  return `${n}`
}
