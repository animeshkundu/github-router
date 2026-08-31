import { maxProReplacementModel } from "~/lib/max-profile-contract"
import { state } from "~/lib/state"

export type ModelTier = "T0" | "T1" | "T2"

export const T0_MODEL_CHAIN = [
  "gemini-3.5-flash",
  "gemini-3-flash-preview",
  "gpt-5.4-mini",
  "gpt-5-mini",
  "claude-haiku-4.5",
  "gpt-4o-mini",
] as const

export const T1_MODEL_CHAIN = [
  "gpt-5.4-mini",
  "gpt-5-mini",
  "gpt-5.6-sol",
  "gpt-5.5",
  "gemini-3.1-pro-preview",
] as const

export const T2_MODEL_CHAIN = [
  "gpt-5.6-sol",
  "gpt-5.5",
  "claude-opus-4.8",
  "gemini-3.1-pro-preview",
] as const

const TIER_CHAINS = {
  T0: T0_MODEL_CHAIN,
  T1: T1_MODEL_CHAIN,
  T2: T2_MODEL_CHAIN,
} as const


const T0_FALLBACK_RE = /mini|flash|nano|haiku|small/i
const MEMO_TTL_MS = 30_000

type CatalogData = NonNullable<typeof state.models>["data"]

interface MemoEntry {
  data: CatalogData | undefined
  length: number
  catalogKey: string
  expiresAt: number
  value: string | undefined
}

export interface TierModelOptions {
  maxProfile?: boolean
}

const memo: Partial<Record<`${ModelTier}:${"standard" | "max"}`, MemoEntry>> = {}

function catalogIds(data: CatalogData | undefined): string[] {
  if (!data) return []
  return data
    .map((model) => model.id)
    .filter((id): id is string => typeof id === "string" && id.length > 0)
}

function catalogKey(ids: string[]): string {
  return ids.join("\u0000")
}

function chainFor(tier: ModelTier, opts: TierModelOptions): ReadonlyArray<string> {
  if (!opts.maxProfile || tier === "T0") return TIER_CHAINS[tier]
  const replacement = maxProReplacementModel()
  return TIER_CHAINS[tier].flatMap((model): string[] => {
    if (model !== "gemini-3.1-pro-preview") return [model]
    return replacement ? [replacement] : []
  })
}

function resolveFromIds(
  tier: ModelTier,
  ids: string[],
  opts: TierModelOptions,
): string | undefined {
  if (ids.length === 0) return undefined

  const available = new Set(ids)
  for (const model of chainFor(tier, opts)) {
    if (available.has(model)) return model
  }

  if (tier === "T0") return ids.find((id) => T0_FALLBACK_RE.test(id))
  if (opts.maxProfile) {
    return ids.find((id) => id !== "gemini-3.1-pro-preview")
  }
  return ids[0]
}

export function resolveTierModel(
  tier: ModelTier,
  opts: TierModelOptions = {},
): string | undefined {
  const data = state.models?.data
  const length = data?.length ?? 0
  const ids = catalogIds(data)
  const key = catalogKey(ids)
  const now = Date.now()
  const memoKey = `${tier}:${opts.maxProfile ? "max" : "standard"}` as const
  const cached = memo[memoKey]

  if (
    cached &&
    cached.expiresAt > now &&
    cached.data === data &&
    cached.length === length &&
    cached.catalogKey === key
  ) {
    return cached.value
  }

  const value = resolveFromIds(tier, ids, opts)
  memo[memoKey] = {
    data,
    length,
    catalogKey: key,
    expiresAt: now + MEMO_TTL_MS,
    value,
  }

  return value
}
