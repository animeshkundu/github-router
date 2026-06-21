/**
 * Unit tests for the deterministic harness parser
 * (`src/lib/orchestration/harness-parse.ts`). The parser is the language-agnostic
 * primary source of the Stop-gate's check commands, so these pin: (1) bun/TS
 * sealed parity (byte-identical legacy behavior), (2) per-ecosystem command
 * mapping with lockfile-driven runner selection, (3) the shell-safety guard on
 * every emitted command, and (4) that a missing tool drops the check (no
 * false-red). Tool presence is forced via a `resolveExecutable` spy so the suite
 * is deterministic regardless of what's installed on the CI host.
 */

import { afterEach, describe, expect, spyOn, test } from "bun:test"

import { promises as fs } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import * as exec from "../src/lib/exec"
import {
  checksForDescriptor,
  descriptorHash,
  isSafeCommand,
  parseGateDescriptor,
} from "../src/lib/orchestration/harness-parse"

/** Make a temp repo dir with the given files written. */
async function fixture(files: Record<string, string>): Promise<string> {
  const root = await fs.mkdtemp(path.join(tmpdir(), "harness-parse-"))
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel)
    await fs.mkdir(path.dirname(abs), { recursive: true })
    await fs.writeFile(abs, content)
  }
  return root
}

/** Force every tool to resolve (or only the named ones). */
function forceTools(present: "all" | string[] = "all"): void {
  spyOn(exec, "resolveExecutable").mockImplementation((name: string) =>
    present === "all" || present.includes(name) ? `/usr/bin/${name}` : null,
  )
}

afterEach(() => {
  spyOn(exec, "resolveExecutable").mockRestore?.()
})

describe("isSafeCommand", () => {
  test("accepts plain argv check commands", () => {
    for (const c of [
      "npm run lint",
      "go vet ./...",
      "cargo check",
      "make lint",
      "mypy .",
      "ruff check .",
      "pytest -q",
      "./scripts/check.sh",
      "tsc --noEmit",
      "eslint --max-warnings=0 .",
    ]) {
      expect(isSafeCommand(c)).toBe(true)
    }
  })

  test("rejects shell operators, expansion, quoting, %, and newlines", () => {
    for (const c of [
      "a && b",
      "a || b",
      "a | b",
      "a; b",
      "a $(b)",
      "echo `b`",
      "a > out",
      "a < in",
      "rm -rf / & disown",
      'a "b c"',
      "echo %PATH%",
      "a\nb",
      "",
    ]) {
      expect(isSafeCommand(c)).toBe(false)
    }
  })
})

describe("parseGateDescriptor — bun/TS sealed parity", () => {
  test("bun + typecheck + lint → sealed default-ci", async () => {
    forceTools("all")
    const root = await fixture({
      "package.json": JSON.stringify({ scripts: { typecheck: "tsc", lint: "eslint .", test: "bun test" } }),
      "bun.lock": "",
    })
    const d = await parseGateDescriptor(root, { includeTests: false })
    expect(d).toEqual({ kind: "sealed", gateId: "default-ci", workdir: root })
  })

  test("bun + typecheck (no lint) → sealed typecheck-test", async () => {
    forceTools("all")
    const root = await fixture({
      "package.json": JSON.stringify({ scripts: { typecheck: "tsc" } }),
      "bun.lock": "",
    })
    const d = await parseGateDescriptor(root, { includeTests: false })
    expect(d).toEqual({ kind: "sealed", gateId: "typecheck-test", workdir: root })
  })

  test("bun absent → not the sealed path even with a typecheck script", async () => {
    forceTools(["npm", "node"]) // bun NOT present
    const root = await fixture({
      "package.json": JSON.stringify({ scripts: { typecheck: "tsc", lint: "eslint ." } }),
      "package-lock.json": "{}",
    })
    const d = await parseGateDescriptor(root, { includeTests: false })
    expect(d?.kind).toBe("parsed")
  })
})

describe("parseGateDescriptor — Node parsed path + runner selection", () => {
  test("npm lockfile → `npm run <script>`, static checks only by default", async () => {
    forceTools("all")
    const root = await fixture({
      "package.json": JSON.stringify({ scripts: { lint: "eslint .", test: "jest" } }),
      "package-lock.json": "{}",
    })
    const d = await parseGateDescriptor(root, { includeTests: false })
    expect(d?.kind).toBe("parsed")
    if (d?.kind === "parsed") {
      expect(d.checks).toEqual([{ id: "lint", command: "npm run lint" }])
      expect(d.workdir).toBe(root)
    }
  })

  test("includeTests adds the test check", async () => {
    forceTools("all")
    const root = await fixture({
      "package.json": JSON.stringify({ scripts: { lint: "eslint .", test: "jest" } }),
      "package-lock.json": "{}",
    })
    const d = await parseGateDescriptor(root, { includeTests: true })
    expect(d?.kind === "parsed" && d.checks.map((c) => c.id).sort()).toEqual(["lint", "test"])
  })

  test("pnpm and yarn lockfiles pick the right runner", async () => {
    forceTools("all")
    const pnpm = await fixture({
      "package.json": JSON.stringify({ scripts: { lint: "eslint ." } }),
      "pnpm-lock.yaml": "",
    })
    const yarn = await fixture({
      "package.json": JSON.stringify({ scripts: { lint: "eslint ." } }),
      "yarn.lock": "",
    })
    const dp = await parseGateDescriptor(pnpm, { includeTests: false })
    const dy = await parseGateDescriptor(yarn, { includeTests: false })
    expect(dp?.kind === "parsed" && dp.checks[0].command).toBe("pnpm run lint")
    expect(dy?.kind === "parsed" && dy.checks[0].command).toBe("yarn run lint")
  })

  test("a `:fix` lint variant is never emitted (it mutates)", async () => {
    forceTools("all")
    const root = await fixture({
      "package.json": JSON.stringify({ scripts: { "lint:fix": "eslint . --fix" } }),
      "package-lock.json": "{}",
    })
    const d = await parseGateDescriptor(root, { includeTests: false })
    expect(d).toBeNull()
  })
})

describe("parseGateDescriptor — manifest ecosystems", () => {
  test("Cargo.toml → cargo check (typecheck); clippy only when present", async () => {
    forceTools(["cargo"]) // clippy NOT present
    const root = await fixture({ "Cargo.toml": "[package]\nname='x'" })
    const d = await parseGateDescriptor(root, { includeTests: false })
    expect(d?.kind === "parsed" && d.checks).toEqual([{ id: "typecheck", command: "cargo check" }])

    forceTools(["cargo", "cargo-clippy"])
    const d2 = await parseGateDescriptor(root, { includeTests: false })
    expect(d2?.kind === "parsed" && d2.checks.map((c) => c.command).sort()).toEqual(["cargo check", "cargo clippy"])
  })

  test("go.mod → go vet ./... (typecheck), test opt-in", async () => {
    forceTools(["go"])
    const root = await fixture({ "go.mod": "module x\n" })
    const d = await parseGateDescriptor(root, { includeTests: true })
    expect(d?.kind === "parsed" && d.checks.map((c) => c.command)).toEqual(["go vet ./...", "go test ./..."])
  })

  test("python emits a tool only with config evidence AND the tool present", async () => {
    forceTools(["ruff"]) // mypy NOT present
    const root = await fixture({ "pyproject.toml": "[tool.ruff]\n[tool.mypy]\n" })
    const d = await parseGateDescriptor(root, { includeTests: false })
    expect(d?.kind === "parsed" && d.checks).toEqual([{ id: "lint", command: "ruff check ." }])
  })
})

describe("parseGateDescriptor — CI extraction + safety", () => {
  test("a single-line CI `run:` static check is lifted", async () => {
    forceTools("all")
    const root = await fixture({
      "package.json": JSON.stringify({ scripts: { start: "node ." } }), // no static scripts
      "package-lock.json": "{}",
      ".github/workflows/ci.yml":
        "jobs:\n  check:\n    steps:\n      - run: tsc --noEmit\n      - run: echo build && make all\n",
    })
    const d = await parseGateDescriptor(root, { includeTests: false })
    expect(d?.kind === "parsed" && d.checks).toEqual([{ id: "typecheck", command: "tsc --noEmit" }])
  })

  test("every emitted command passes the shell-safety guard", async () => {
    forceTools("all")
    const root = await fixture({
      "package.json": JSON.stringify({ scripts: { typecheck: "tsc", lint: "eslint .", test: "jest" } }),
      "yarn.lock": "",
    })
    const d = await parseGateDescriptor(root, { includeTests: true })
    if (d?.kind === "parsed") for (const c of d.checks) expect(isSafeCommand(c.command)).toBe(true)
  })

  test("missing tools → null (gate stays off rather than false-red)", async () => {
    forceTools([]) // nothing resolves
    const root = await fixture({ "Cargo.toml": "[package]\nname='x'" })
    expect(await parseGateDescriptor(root, { includeTests: false })).toBeNull()
  })
})

describe("descriptorHash / checksForDescriptor", () => {
  test("sealed key is its gate id; parsed key is stable + set-sensitive", () => {
    expect(descriptorHash({ kind: "sealed", gateId: "default-ci", workdir: "/r" })).toBe("sealed:default-ci")
    const a = descriptorHash({
      kind: "parsed",
      ecosystem: "node",
      workdir: "/r",
      evidence: ["package.json"],
      checks: [{ id: "lint", command: "npm run lint" }],
    })
    const aAgain = descriptorHash({
      kind: "parsed",
      ecosystem: "node",
      workdir: "/r2",
      evidence: ["x"],
      checks: [{ id: "lint", command: "npm run lint" }],
    })
    const b = descriptorHash({
      kind: "parsed",
      ecosystem: "node",
      workdir: "/r",
      evidence: ["package.json"],
      checks: [{ id: "lint", command: "npm run lint:other" }],
    })
    expect(a).toBe(aAgain) // independent of workdir/evidence/ecosystem
    expect(a).not.toBe(b) // changes with the command set
  })

  test("checksForDescriptor resolves a sealed gate's command set", () => {
    const checks = checksForDescriptor({ kind: "sealed", gateId: "typecheck-only", workdir: "/r" })
    expect(checks).toEqual([{ id: "typecheck", command: "bun run typecheck" }])
  })
})
