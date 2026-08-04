/**
 * Mechanical enforcement of the catalog capability register.
 *
 * The register is only worth having if its claims are CHECKED. A hand-maintained
 * list of "we handle this" is exactly the sort of thing that drifts, and the
 * register was introduced to stop drift, so it had better not be a new source
 * of it. Every classification is therefore verified:
 *
 *   - exhaustiveness  — the field names are parsed out of `get-models.ts`, so a
 *                       new field on either interface fails CI until classified;
 *   - ENFORCED        — a fixture MUTATION must change an observable outcome;
 *   - CONSUMED        — the identifier must be read outside the pretty-printer;
 *   - DISPLAY_ONLY    — the identifier must appear ONLY in the pretty-printer;
 *   - the ratchet     — the unenforced population must not grow.
 */

import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import { readFileSync, readdirSync, statSync } from "node:fs"
import * as path from "node:path"

import {
  CAPABILITY_REGISTER,
  UNCLASSIFIED_CEILING,
} from "~/lib/catalog-capability-register"
import { state } from "~/lib/state"
import type { Model, ModelsResponse } from "~/services/copilot/get-models"
import { checkOutboundImages } from "~/lib/vision-preflight"

const repoRoot = path.resolve(import.meta.dirname, "..")
const getModelsSrc = readFileSync(
  path.join(repoRoot, "src", "services", "copilot", "get-models.ts"),
  "utf8",
)
const modelsPrinterSrc = readFileSync(path.join(repoRoot, "src", "models.ts"), "utf8")

/**
 * Extract the field names declared directly inside `interface <name> { … }`.
 * Nested object literals (`vision?: { … }`) are skipped at depth > 1 and the
 * nested block is handled by an explicit second call, so `vision.*` fields get
 * their own dotted keys.
 */
function interfaceFields(src: string, name: string): Array<string> {
  const start = src.indexOf(`interface ${name} {`)
  if (start === -1) throw new Error(`interface ${name} not found`)
  let depth = 0
  let i = src.indexOf("{", start)
  const fields: Array<string> = []
  let line = ""
  for (; i < src.length; i++) {
    const ch = src[i] as string
    if (ch === "{") depth++
    else if (ch === "}") {
      depth--
      if (depth === 0) break
    }
    if (ch === "\n") {
      const m = /^\s*([A-Za-z_][\w]*)\??\s*:/.exec(line)
      if (m && depth === 1) fields.push(m[1] as string)
      line = ""
    } else {
      line += ch
    }
  }
  return fields
}

/** Field names of the inline `vision?: { … }` block inside ModelLimits. */
function visionSubFields(src: string): Array<string> {
  const anchor = src.indexOf("vision?: {")
  if (anchor === -1) throw new Error("ModelLimits.vision block not found")
  // Start AFTER the opening brace so the `vision` declaration line itself is
  // not scooped up as one of its own sub-fields.
  const open = src.indexOf("{", anchor) + 1
  const end = src.indexOf("}", open)
  const block = src.slice(open, end)
  return [...block.matchAll(/^\s*([A-Za-z_][\w]*)\??\s*:/gm)].map((m) => m[1] as string)
}

function declaredKeys(): Array<string> {
  const supports = interfaceFields(getModelsSrc, "ModelSupports").map((f) => `supports.${f}`)
  const limits = interfaceFields(getModelsSrc, "ModelLimits")
    .filter((f) => f !== "vision")
    .map((f) => `limits.${f}`)
  const vision = visionSubFields(getModelsSrc).map((f) => `limits.vision.${f}`)
  return [...supports, ...limits, ...vision]
}

/**
 * Count PROPERTY READS of a capability field across `src/`, excluding the
 * pretty-printer and the type/register declarations themselves.
 *
 * Matching is on `.field` / `["field"]` rather than the bare word: these fields
 * are only ever reached as property accesses (`supports.vision`,
 * `limits.vision.max_prompt_images`), and a bare-word search would count every
 * prose mention of "streaming" or "dimensions" in a comment and make the check
 * meaningless.
 *
 * Done in-process on purpose. An earlier version shelled out to a child
 * process, which threw on every invocation and returned a sentinel — so both
 * the DISPLAY_ONLY and CONSUMED assertions passed without ever examining a
 * single file. A check that cannot fail proves nothing.
 */
const EXCLUDED_FILES = new Set([
  "models.ts",
  "services/copilot/get-models.ts",
  "lib/catalog-capability-register.ts",
])

function collectSourceFiles(dir: string, acc: Array<string> = []): Array<string> {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "vendor") continue
    const full = path.join(dir, entry)
    if (statSync(full).isDirectory()) collectSourceFiles(full, acc)
    else if (full.endsWith(".ts")) acc.push(full)
  }
  return acc
}

const SRC_ROOT = path.join(repoRoot, "src")
const SOURCE_FILES = collectSourceFiles(SRC_ROOT).filter((f) => {
  const rel = path.relative(SRC_ROOT, f).replaceAll("\\", "/")
  return !EXCLUDED_FILES.has(rel)
})

function readSitesOutsidePrinter(key: string): number {
  // Match the PARENT-QUALIFIED path, not the bare leaf. Several capability
  // names collide with wire fields of the same name — `parallel_tool_calls` is
  // both a `supports` bit and a request-body field, and a leaf-only search
  // counts the latter as evidence for the former. Searching `supports.x` /
  // `supports?.x` (and `vision.x` / `limits.x`) removes that ambiguity.
  const segments = key.split(DOT)
  const leaf = segments[segments.length - 1] as string
  const parent = segments[segments.length - 2] as string
  const needles = [
    parent + DOT + leaf,
    parent + QUESTION + DOT + leaf,
  ]
  let n = 0
  for (const file of SOURCE_FILES) {
    const text = readFileSync(file, "utf8")
    for (const needle of needles) {
      let from = text.indexOf(needle)
      while (from !== -1) {
        n++
        from = text.indexOf(needle, from + needle.length)
      }
    }
  }
  return n
}

const QUESTION = "?"
const DOT = "."

function visionModel(over: Partial<Record<string, unknown>> = {}): Model {
  return {
    id: "fixture",
    name: "fixture",
    object: "model",
    vendor: "test",
    version: "1",
    preview: false,
    model_picker_enabled: true,
    capabilities: {
      family: "test",
      object: "model",
      tokenizer: "o200k",
      type: "chat",
      supports: { vision: true, ...(over.supports as object) },
      limits: {
        vision: {
          max_prompt_images: 1,
          max_prompt_image_size: 3145728,
          supported_media_types: ["image/png"],
          ...(over.vision as object),
        },
      },
    },
  } as unknown as Model
}

const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
const png = { base64: PNG, declaredMimeType: "image/png" }

let saved: ModelsResponse | undefined
beforeEach(() => {
  saved = state.models
})
afterEach(() => {
  state.models = saved
})

function withModel(m: Model): void {
  state.models = { object: "list", data: [m] } as ModelsResponse
}

describe("the checker itself works", () => {
  // An earlier version of `readSitesOutsidePrinter` shelled out to a child
  // process that threw on every call and returned a sentinel, so the
  // DISPLAY_ONLY and CONSUMED suites below passed without reading a single
  // file. These two assertions make that failure mode impossible to repeat: if
  // the mechanism breaks, this fails first and says so.
  test("finds a path that is genuinely read, and not one that is not", () => {
    expect(SOURCE_FILES.length).toBeGreaterThan(50)
    expect(readSitesOutsidePrinter("supports.adaptive_thinking")).toBeGreaterThan(0)
    expect(readSitesOutsidePrinter("supports.definitely_not_a_real_capability")).toBe(0)
  })

  test("is parent-qualified, so a same-named wire field is not counted", () => {
    // `parallel_tool_calls` exists both as a capability bit and as a request
    // body field. Only the former should count toward `supports.*`.
    expect(readSitesOutsidePrinter("supports.parallel_tool_calls")).toBe(0)
  })
})

describe("register exhaustiveness", () => {
  test("every declared capability field is classified", () => {
    const missing = declaredKeys().filter((k) => !(k in CAPABILITY_REGISTER))
    // A new field on ModelSupports / ModelLimits lands here until someone
    // decides — in a reviewable diff — whether we enforce it.
    expect(missing).toEqual([])
  })

  test("the register carries no entry for a field that no longer exists", () => {
    const declared = new Set(declaredKeys())
    const stale = Object.keys(CAPABILITY_REGISTER).filter((k) => !declared.has(k))
    expect(stale).toEqual([])
  })

  test("every DISPLAY_ONLY / UNUSED entry carries a justification", () => {
    for (const [key, entry] of Object.entries(CAPABILITY_REGISTER)) {
      if (entry.classification === "DISPLAY_ONLY" || entry.classification === "UNUSED") {
        expect(entry.note.length, `${key} needs a note`).toBeGreaterThan(20)
      }
    }
  })
})

describe("the live-catalog fixture stays in step with the register", () => {
  // The fixture is what `scripts/check-catalog-drift.ts` compares the LIVE
  // catalog against on a schedule. That script needs the network, so it is not
  // a merge gate; this offline assertion is, and it stops the fixture and the
  // register drifting apart between scheduled runs.
  test("fixture keys and register keys are the same set", () => {
    const fixture = JSON.parse(
      readFileSync(path.join(repoRoot, "tests", "fixtures", "catalog-capability-keys.json"), "utf8"),
    ) as { keys: Array<string> }
    expect([...fixture.keys].sort()).toEqual(Object.keys(CAPABILITY_REGISTER).sort())
  })
})

describe("the ratchet", () => {
  test("the unenforced population has not grown", () => {
    const unenforced = Object.entries(CAPABILITY_REGISTER).filter(
      ([, e]) => e.classification === "DISPLAY_ONLY" || e.classification === "UNUSED",
    )
    // Raising UNCLASSIFIED_CEILING is allowed but must be an explicit edit a
    // reviewer sees — otherwise "add it as UNUSED with a sentence" is the
    // cheapest way to green CI, which is precisely the failure being guarded.
    expect(unenforced.length).toBeLessThanOrEqual(UNCLASSIFIED_CEILING)
  })
})

describe("DISPLAY_ONLY is checked, not asserted", () => {
  test("a DISPLAY_ONLY field really is absent outside the pretty-printer", () => {
    const offenders: Array<string> = []
    for (const [key, entry] of Object.entries(CAPABILITY_REGISTER)) {
      if (entry.classification !== "DISPLAY_ONLY") continue
      const count = readSitesOutsidePrinter(key)
      if (count > 0) offenders.push(`${key} (${count} read site(s))`)
    }
    // If this fails, the field gained a real consumer — promote it to CONSUMED
    // or ENFORCED (and lower the ratchet ceiling).
    expect(offenders).toEqual([])
  })

  test("the pretty-printer genuinely mentions them", () => {
    for (const [key, entry] of Object.entries(CAPABILITY_REGISTER)) {
      if (entry.classification !== "DISPLAY_ONLY") continue
      const field = key.split(".").pop() as string
      expect(modelsPrinterSrc, `${key} claims DISPLAY_ONLY`).toContain(field)
    }
  })
})

describe("ENFORCED is proven by mutation, not by reference", () => {
  test("supports.vision — flipping it changes the verdict", () => {
    withModel(visionModel())
    expect(checkOutboundImages("fixture", [png]).ok).toBe(true)

    withModel(visionModel({ supports: { vision: false } }))
    expect(checkOutboundImages("fixture", [png]).ok).toBe(false)
  })

  test("limits.vision.max_prompt_images — raising it admits a second image", () => {
    withModel(visionModel())
    expect(checkOutboundImages("fixture", [png, png]).ok).toBe(false)

    withModel(visionModel({ vision: { max_prompt_images: 5 } }))
    expect(checkOutboundImages("fixture", [png, png]).ok).toBe(true)
  })

  test("limits.vision.max_prompt_image_size — lowering it rejects the same image", () => {
    withModel(visionModel())
    expect(checkOutboundImages("fixture", [png]).ok).toBe(true)

    withModel(visionModel({ vision: { max_prompt_image_size: 8 } }))
    expect(checkOutboundImages("fixture", [png]).ok).toBe(false)
  })

  test("limits.vision.supported_media_types — removing the type rejects it", () => {
    withModel(visionModel())
    expect(checkOutboundImages("fixture", [png]).ok).toBe(true)

    withModel(visionModel({ vision: { supported_media_types: ["image/webp"] } }))
    const verdict = checkOutboundImages("fixture", [png])
    expect(verdict.ok).toBe(false)
    if (verdict.ok) throw new Error("unreachable")
    expect(verdict.message).toContain("image/webp")
  })

  test("the remaining ENFORCED fields are covered by their own suites", () => {
    // tool_calls: tests/mcp-capabilities*.test.ts + worker model-resolve.
    // reasoning_effort: the thinking-translation + worker clamp suites.
    // max_prompt_tokens: the persona window-overflow preflight suite.
    // Listed here so the mapping from register entry to proving test is
    // discoverable rather than folklore.
    const enforced = Object.entries(CAPABILITY_REGISTER)
      .filter(([, e]) => e.classification === "ENFORCED")
      .map(([k]) => k)
    expect(enforced).toContain("supports.tool_calls")
    expect(enforced).toContain("supports.reasoning_effort")
    expect(enforced).toContain("limits.max_prompt_tokens")
  })
})

describe("CONSUMED is checked", () => {
  test("a CONSUMED field is read somewhere outside the pretty-printer", () => {
    const offenders: Array<string> = []
    for (const [key, entry] of Object.entries(CAPABILITY_REGISTER)) {
      if (entry.classification !== "CONSUMED") continue
      if (readSitesOutsidePrinter(key) <= 0) offenders.push(key)
    }
    expect(offenders).toEqual([])
  })
})
