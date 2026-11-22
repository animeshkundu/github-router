import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import {
  BOOTSTRAP_ENTRY,
  POINTER_SCHEMA_VERSION,
  isSafeEntry,
  parsePointer,
  readInstalledMarker,
  readPointer,
  removePointer,
  writeInstalledMarker,
  writePointer,
} from "~/lib/managed-install/pointer"
import { setManagedDiagnosticReporter } from "~/lib/managed-install/diagnostics"
import { appDir, installedMarkerPath, pointerPath, versionDir } from "~/lib/managed-install/paths"

const dirs: Array<string> = []
const savedAppDir = process.env.GH_ROUTER_APP_DIR

async function useTempAppDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "managed-pointer-"))
  dirs.push(dir)
  process.env.GH_ROUTER_APP_DIR = dir
  return dir
}

/** Create a plausible payload so `readPointer`'s entry check can pass. */
async function publishFakePayload(root: string, version: string, entry: string): Promise<void> {
  const dir = versionDir("self", version)
  await fs.mkdir(path.dirname(path.join(dir, entry)), { recursive: true })
  await fs.writeFile(path.join(dir, entry), "// payload\n")
  void root
}

afterEach(async () => {
  if (savedAppDir === undefined) delete process.env.GH_ROUTER_APP_DIR
  else process.env.GH_ROUTER_APP_DIR = savedAppDir
  setManagedDiagnosticReporter(undefined)
  for (const dir of dirs.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
  }
})

describe("isSafeEntry", () => {
  test("accepts the real entry shapes", () => {
    expect(isSafeEntry("node_modules/github-router/dist/main.js")).toBe(true)
    expect(isSafeEntry("node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js")).toBe(true)
  })

  test("refuses the bootstrap, so a pointer can never exec the bootstrap in a loop", () => {
    expect(isSafeEntry(BOOTSTRAP_ENTRY)).toBe(false)
    expect(isSafeEntry("./dist/bin.js")).toBe(false)
    expect(isSafeEntry("dist/bin.js")).toBe(false)
  })

  test("refuses traversal and absolute paths on every platform", () => {
    expect(isSafeEntry("../evil.js")).toBe(false)
    expect(isSafeEntry("node_modules/../../evil.js")).toBe(false)
    expect(isSafeEntry("node_modules\\..\\..\\evil.js")).toBe(false)
    expect(isSafeEntry("/etc/passwd")).toBe(false)
    expect(isSafeEntry("C:\\Windows\\system32\\x.js")).toBe(false)
    expect(isSafeEntry("c:/windows/x.js")).toBe(false)
    expect(isSafeEntry("")).toBe(false)
  })
})

describe("parsePointer", () => {
  const valid = {
    schemaVersion: POINTER_SCHEMA_VERSION,
    kind: "self",
    version: "0.3.379",
    entry: "node_modules/github-router/dist/main.js",
    runtimeHint: "/usr/local/bin/node",
    registry: "https://registry.npmjs.org/",
    installedAt: "2026-11-22T00:00:00.000Z",
  }

  test("accepts a well-formed pointer and derives the absolute entry path", async () => {
    await useTempAppDir()
    const parsed = parsePointer(JSON.stringify(valid), "self")
    expect(parsed).not.toBeNull()
    expect(parsed!.version).toBe("0.3.379")
    expect(parsed!.entryPath).toBe(
      path.join(versionDir("self", "0.3.379"), "node_modules/github-router/dist/main.js"),
    )
  })

  test("a pointer for the wrong kind is rejected (kind is part of the identity)", () => {
    expect(parsePointer(JSON.stringify(valid), "pi")).toBeNull()
  })

  test("an unknown schemaVersion is treated as absent, not upgraded", () => {
    expect(parsePointer(JSON.stringify({ ...valid, schemaVersion: 99 }), "self")).toBeNull()
    expect(parsePointer(JSON.stringify({ ...valid, schemaVersion: "1" }), "self")).toBeNull()
  })

  test("malformed JSON, non-objects and missing fields are all absent", () => {
    expect(parsePointer("{not json", "self")).toBeNull()
    expect(parsePointer("null", "self")).toBeNull()
    expect(parsePointer("[]", "self")).toBeNull()
    expect(parsePointer(JSON.stringify({ ...valid, version: "" }), "self")).toBeNull()
    expect(parsePointer(JSON.stringify({ ...valid, version: 42 }), "self")).toBeNull()
  })

  test("a version containing path separators cannot escape the version dir", () => {
    expect(parsePointer(JSON.stringify({ ...valid, version: "../.." }), "self")).toBeNull()
    expect(parsePointer(JSON.stringify({ ...valid, version: "a/b" }), "self")).toBeNull()
    expect(parsePointer(JSON.stringify({ ...valid, version: "a\\b" }), "self")).toBeNull()
    expect(parsePointer(JSON.stringify({ ...valid, version: ".." }), "self")).toBeNull()
  })

  test("an unsafe entry is rejected even with an otherwise valid pointer", () => {
    expect(parsePointer(JSON.stringify({ ...valid, entry: "../../x.js" }), "self")).toBeNull()
    expect(parsePointer(JSON.stringify({ ...valid, entry: BOOTSTRAP_ENTRY }), "self")).toBeNull()
  })

  test("a pointer without an entry falls back to the kind's known entry", () => {
    const { entry: _entry, ...withoutEntry } = valid
    void _entry
    const parsed = parsePointer(JSON.stringify(withoutEntry), "self")
    expect(parsed!.entry).toBe("node_modules/github-router/dist/main.js")
  })
})

describe("readPointer / writePointer", () => {
  test("a missing pointer is null (first run, not an error)", async () => {
    await useTempAppDir()
    expect(await readPointer("self")).toBeNull()
  })

  test("round-trips atomically and verifies the entry exists", async () => {
    await useTempAppDir()
    await publishFakePayload("", "0.3.379", "node_modules/github-router/dist/main.js")
    const written = await writePointer({
      kind: "self",
      version: "0.3.379",
      runtimeHint: "/usr/local/bin/node",
      registry: "https://registry.npmjs.org/",
    })
    expect(written.entryPath).toContain("0.3.379")

    const read = await readPointer("self")
    expect(read?.version).toBe("0.3.379")
    expect(read?.runtimeHint).toBe("/usr/local/bin/node")
    expect(read?.registry).toBe("https://registry.npmjs.org/")

    // The file on disk is the schema the plan pinned.
    const raw = JSON.parse(await fs.readFile(pointerPath("self"), "utf8")) as Record<string, unknown>
    expect(raw.schemaVersion).toBe(POINTER_SCHEMA_VERSION)
    expect(raw.kind).toBe("self")
    expect(raw.entry).toBe("node_modules/github-router/dist/main.js")
    expect(typeof raw.installedAt).toBe("string")
  })

  test("a pointer whose payload is gone reads as absent (GC or interrupted publish)", async () => {
    await useTempAppDir()
    await publishFakePayload("", "0.3.379", "node_modules/github-router/dist/main.js")
    await writePointer({ kind: "self", version: "0.3.379" })
    expect((await readPointer("self"))?.version).toBe("0.3.379")

    await fs.rm(versionDir("self", "0.3.379"), { recursive: true, force: true })
    expect(await readPointer("self")).toBeNull()
    // verifyEntry:false is the diagnostic read (it must not care about the tree).
    expect((await readPointer("self", { verifyEntry: false }))?.version).toBe("0.3.379")
  })

  test("a corrupt pointer file is ignored rather than thrown", async () => {
    const root = await useTempAppDir()
    await fs.mkdir(path.dirname(pointerPath("self")), { recursive: true })
    await fs.writeFile(pointerPath("self"), '{"schemaVersion":1,"kind":"self"')
    const warnings: Array<string> = []
    setManagedDiagnosticReporter((_level: string, message: string) => warnings.push(message))
    expect(await readPointer("self")).toBeNull()
    expect(warnings.join("\n")).toContain("not a valid pointer")
    void root
  })

  test("writing an unsafe entry throws before touching the filesystem", async () => {
    await useTempAppDir()
    await expect(writePointer({ kind: "self", version: "1.0.0", entry: "../evil.js" })).rejects.toThrow(
      /unsafe managed entry/,
    )
    expect(await readPointer("self")).toBeNull()
  })

  test("removePointer makes the next read absent", async () => {
    await useTempAppDir()
    await publishFakePayload("", "0.3.379", "node_modules/github-router/dist/main.js")
    await writePointer({ kind: "self", version: "0.3.379" })
    await removePointer("self")
    expect(await readPointer("self")).toBeNull()
  })

  test("self and pi pointers are independent", async () => {
    await useTempAppDir()
    await publishFakePayload("", "0.3.379", "node_modules/github-router/dist/main.js")
    await writePointer({ kind: "self", version: "0.3.379" })
    expect(await readPointer("pi")).toBeNull()
    expect(appDir()).toBe(process.env.GH_ROUTER_APP_DIR!)
  })
})

describe("installed marker", () => {
  test("round-trips provenance and rejects a version mismatch", async () => {
    await useTempAppDir()
    await fs.mkdir(versionDir("self", "0.3.379"), { recursive: true })
    await writeInstalledMarker("self", {
      version: "0.3.379",
      packages: {
        "github-router@0.3.379": {
          resolved: "https://registry.npmjs.org/github-router/-/github-router-0.3.379.tgz",
          integrity: "sha512-abc",
        },
      },
      runtime: "/usr/local/bin/node",
      registry: "https://registry.npmjs.org/",
    })
    const marker = await readInstalledMarker("self", "0.3.379")
    expect(marker?.packages?.["github-router@0.3.379"]?.integrity).toBe("sha512-abc")
    expect(await readInstalledMarker("self", "9.9.9")).toBeNull()

    // A marker whose recorded version disagrees with its directory is not a
    // complete payload — adopt must not trust it.
    await fs.writeFile(
      installedMarkerPath("self", "0.3.379"),
      JSON.stringify({ version: "0.0.1" }),
    )
    expect(await readInstalledMarker("self", "0.3.379")).toBeNull()
  })
})
