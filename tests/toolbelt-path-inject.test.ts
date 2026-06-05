import { describe, expect, test } from "bun:test"
import path from "node:path"

import {
  collapsePathKeys,
  pathEnvKey,
  toolbeltPathOverride,
} from "../src/lib/toolbelt/path-inject"

describe("pathEnvKey", () => {
  test("finds existing key case-insensitively", () => {
    expect(pathEnvKey({ Path: "x" })).toBe("Path")
    expect(pathEnvKey({ PATH: "x" })).toBe("PATH")
    expect(pathEnvKey({ path: "x" })).toBe("path")
  })
  test("falls back to platform default when absent", () => {
    const got = pathEnvKey({})
    expect(["PATH", "Path"]).toContain(got)
  })
})

describe("toolbeltPathOverride", () => {
  test("prepends binDir reusing the parent's key casing", () => {
    const bin = path.join("/router", "bin")
    const out = toolbeltPathOverride({ Path: "/usr/bin" }, bin)
    expect(Object.keys(out)).toEqual(["Path"])
    expect(out.Path).toBe(`${bin}${path.delimiter}/usr/bin`)
  })
  test("empty parent → binDir only, no leading delimiter", () => {
    const bin = "/router/bin"
    const out = toolbeltPathOverride({ PATH: "" }, bin)
    expect(out.PATH).toBe(bin)
  })
  test("exactly one path key in the result", () => {
    const out = toolbeltPathOverride({ PATH: "/a", FOO: "b" }, "/bin")
    const pathKeys = Object.keys(out).filter((k) => k.toLowerCase() === "path")
    expect(pathKeys.length).toBe(1)
  })
})

describe("collapsePathKeys", () => {
  test("collapses duplicate Path/PATH into one, keeping the longest value", () => {
    const env: NodeJS.ProcessEnv = {
      Path: "/short",
      PATH: "/router/bin:/usr/bin:/bin",
      OTHER: "x",
    }
    const out = collapsePathKeys(env)
    const pathKeys = Object.keys(out).filter((k) => k.toLowerCase() === "path")
    expect(pathKeys.length).toBe(1)
    expect(out[pathKeys[0]]).toBe("/router/bin:/usr/bin:/bin")
    expect(out.OTHER).toBe("x")
  })
  test("no-op when only one path key exists", () => {
    const env = { PATH: "/usr/bin", FOO: "1" }
    const out = collapsePathKeys({ ...env })
    expect(out).toEqual(env)
  })
})
