import { describe, expect, test } from "bun:test"

import {
  buildPiAgentFiles,
  buildPiModelsJson,
  buildPiSettingsJson,
  piProfileModelIds,
  type PiCatalogModel,
  type PiProfileId,
} from "~/lib/pi-models-settings"
import { piTierThresholdFor } from "~/lib/pi-tier-windows"

/**
 * Launch contract: cross-cutting invariants over every profile × flag
 * combination the `pi` launcher can emit. These are the "everything
 * just works" assertions — each guards a live-observed failure:
 *
 * - third-party prose reaching Ctrl+O (pi-subagents skills/prompts)
 * - footer fights (statusline packages vs the router-owned AIC footer)
 * - picker offering models with no models.json row (unroutable)
 * - text-only advertisement killing native images
 * - background-runner tool gaps (async must stay foreground)
 * - supervisor pings from leaves (noise + cost)
 * - Long-tier pricing leaking in via contextWindow
 */
const PROFILES: ReadonlyArray<PiProfileId> = ["cheapest", "balanced"]

const VISION_CATALOG: ReadonlyArray<PiCatalogModel> = [
  {
    id: "gpt-6-luna",
    maxContextTokens: 1_050_000,
    maxPromptTokens: 922_000,
    maxOutputTokens: 128_000,
    efforts: ["high", "max"],
    endpoints: ["responses"],
    vision: true,
    maxImageBytes: 3 * 1024 * 1024,
  },
  {
    id: "gpt-6-sol",
    maxContextTokens: 500_000,
    maxPromptTokens: 400_000,
    maxOutputTokens: 64_000,
    efforts: ["medium", "high"],
    endpoints: ["responses"],
    vision: true,
    maxImageBytes: 3 * 1024 * 1024,
  },
  {
    id: "grok-4.6",
    maxContextTokens: 500_000,
    maxPromptTokens: 300_000,
    maxOutputTokens: 128_000,
    efforts: ["medium"],
    endpoints: ["responses"],
    vision: false,
  },
]

const FLAG_COMBOS = [
  { peers: true, helpers: true, ui: true, searchEnabled: false, browseEnabled: false },
  { peers: true, helpers: true, ui: false, searchEnabled: true, browseEnabled: false },
  { peers: true, helpers: false, ui: false, searchEnabled: false, browseEnabled: true },
  { peers: false, helpers: true, ui: true, searchEnabled: false, browseEnabled: false },
  { peers: false, helpers: false, ui: false, searchEnabled: false, browseEnabled: false },
] as const

describe("pi launch contract: packages", () => {
  for (const profileId of PROFILES) {
    for (const flags of FLAG_COMBOS) {
      const tag = `${profileId} peers=${flags.peers} helpers=${flags.helpers} ui=${flags.ui}`
      test(`${tag}: third-party prose never reaches Ctrl+O`, () => {
        const settings = buildPiSettingsJson({ profileId, catalog: [...VISION_CATALOG], ...flags })
        for (const entry of settings.packages) {
          if (typeof entry === "string") continue
          // Object-form entries must narrow skills AND prompts: bare
          // strings load everything a package declares.
          expect(entry.skills ?? "absent").toEqual([])
          expect(entry.prompts ?? "absent").toEqual([])
          // Pi matches filter patterns with minimatch against
          // root-relative paths: a `./` prefix matches NOTHING and the
          // resource type silently loads empty (observed live as a
          // missing theme + zero helper extensions).
          for (const values of [
            entry.extensions,
            entry.skills,
            entry.prompts,
            entry.themes,
          ]) {
            for (const v of values ?? []) {
              expect(v.startsWith("./")).toBe(false)
            }
          }
        }
      })

      test(`${tag}: no statusline package fights the router footer`, () => {
        const settings = buildPiSettingsJson({ profileId, catalog: [...VISION_CATALOG], ...flags })
        for (const entry of settings.packages) {
          const source = typeof entry === "string" ? entry : entry.source
          expect(source.toLowerCase()).not.toContain("statusline")
        }
        expect(settings.packages).toContain("local:gh-router-pi")
      })

      test(`${tag}: theme field and theme package agree`, () => {
        const settings = buildPiSettingsJson({ profileId, catalog: [...VISION_CATALOG], ...flags })
        const themePkg = settings.packages.find(
          (p) => typeof p === "object" && p.source === "npm:better-claude-code-ui",
        )
        if (flags.ui) {
          expect(settings.theme).toBe("claude-code-dark")
          expect(themePkg).toBeDefined()
          // Themes-only: any code in this package would fight the
          // footer and tool rendering the router already owns.
          expect(themePkg).toMatchObject({ extensions: [], skills: [], prompts: [] })
        } else {
          expect(settings.theme).toBeUndefined()
          expect(themePkg).toBeUndefined()
        }
      })

      test(`${tag}: picker models exactly match models.json rows`, () => {
        const settings = buildPiSettingsJson({ profileId, catalog: [...VISION_CATALOG], ...flags })
        const json = buildPiModelsJson({
          serverUrl: "http://127.0.0.1:8787",
          profileId,
          catalog: [...VISION_CATALOG],
          peers: flags.peers,
        })
        const enabled = new Set(
          settings.enabledModels.map((m) => m.replace(/^gh-router\//, "")),
        )
        const rows = new Set(json.providers["gh-router"].models.map((m) => m.id))
        expect(enabled).toEqual(rows)
        expect(enabled).toEqual(new Set(piProfileModelIds(profileId, { peers: flags.peers })))
      })
    }
  }
})

describe("pi launch contract: vision", () => {
  for (const profileId of PROFILES) {
    test(`${profileId}: vision rows advertise image input + resize budget`, () => {
      const json = buildPiModelsJson({
        serverUrl: "http://127.0.0.1:8787",
        profileId,
        catalog: [...VISION_CATALOG],
      })
      const rows = Object.fromEntries(
        json.providers["gh-router"].models.map((m) => [m.id, m]),
      )
      for (const [id, row] of Object.entries(rows)) {
        const entry = VISION_CATALOG.find((m) => m.id === id)
        if (entry?.vision === false) {
          expect(row.input).toEqual(["text"])
          expect(row.inputLimits).toBeUndefined()
        } else {
          // Fail-open: unknown models advertise image (preflight backstops).
          expect(row.input).toContain("image")
          if (entry?.vision) {
            expect(row.inputLimits?.images?.resize?.maxBytes).toBeGreaterThan(0)
            expect(row.inputLimits?.images?.resize?.maxBytes).toBeLessThanOrEqual(
              4 * 1024 * 1024,
            )
          }
        }
      }
    })
  }
})

describe("pi launch contract: cost ceiling", () => {
  for (const profileId of PROFILES) {
    test(`${profileId}: context windows stay inside cheap tiers, no 1m accounting`, () => {
      const json = buildPiModelsJson({
        serverUrl: "http://127.0.0.1:8787",
        profileId,
        catalog: [...VISION_CATALOG],
      })
      for (const row of json.providers["gh-router"].models) {
        // Tier threshold capped by the catalog total: Long-tier (2x)
        // pricing is structurally unreachable.
        expect(row.contextWindow).toBeLessThanOrEqual(piTierThresholdFor(row.id))
        expect(row.id).not.toContain("[1m]")
        expect(row.maxTokens).toBeGreaterThanOrEqual(16)
      }
      const settings = buildPiSettingsJson({ profileId, catalog: [...VISION_CATALOG], searchEnabled: false, browseEnabled: false })
      expect(settings.compaction.enabled).toBe(true)
      expect(JSON.stringify(settings)).not.toContain("[1m]")
    })
  }
})

describe("pi launch contract: agent files", () => {
  for (const profileId of PROFILES) {
    test(`${profileId}: foreground nesting, honest tools, bare lists`, () => {
      const files = buildPiAgentFiles(profileId)
      for (const content of Object.values(files)) {
        // Detached background runs demonstrably lose read/bash from
        // their registry; foreground shares the parent's full set.
        expect(content).toContain("async: false")
        // Bracket form misparses in splitters; bare form everywhere.
        expect(content).not.toMatch(/^(tools|aliases|allowedAgents): \[/m)
        // No file bindings: handoff is inline prose, runs stay clean.
        expect(content).not.toContain("output:")
        expect(content).not.toContain("defaultReads:")
        expect(content).not.toContain("defaultProgress:")
        // Pinned provider on every delegation edge (cost control).
        expect(content).toContain("model: gh-router/")
      }
      // contact_supervisor is a blocked-writer escalation channel: only
      // the single writer thread may page the supervisor.
      for (const [agentRel, agentContent] of Object.entries(files)) {
        if (agentRel === "agents/general-purpose.md") {
          expect(agentContent).toContain("contact_supervisor")
          expect(agentContent).toContain("allowNestedSubagents: true")
        } else {
          expect(agentContent).not.toContain("contact_supervisor")
        }
      }
      // allowedAgents never dangles without its nesting grant.
      for (const content of Object.values(files)) {
        if (content.includes("allowedAgents:")) {
          expect(content).toContain("allowNestedSubagents: true")
          expect(content).toMatch(/tools: .*\bsubagent\b/)
        }
      }
    })
  }
})
