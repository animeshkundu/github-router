import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { MANAGED_MARKER, ensureLauncher } from "~/lib/managed-install/launcher"
import { cliBinDir, launcherPath, versionDir } from "~/lib/managed-install/paths"
import { writePointer } from "~/lib/managed-install/pointer"
import {
  ensureShims,
  isOnPath,
  isOurShim,
  pathHint,
  shimBases,
  shimBodies,
  shimDir,
} from "~/lib/managed-install/shim"

const dirs: Array<string> = []
const savedAppDir = process.env.GH_ROUTER_APP_DIR

async function useTempAppDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "managed-shim-"))
  dirs.push(dir)
  process.env.GH_ROUTER_APP_DIR = dir
  return dir
}

async function writeFakePayload(stdout: string): Promise<void> {
  const entry = path.join(versionDir("self", "1.2.3"), "node_modules/github-router/dist/main.js")
  await fs.mkdir(path.dirname(entry), { recursive: true })
  await fs.writeFile(
    path.join(versionDir("self", "1.2.3"), "node_modules/github-router/package.json"),
    JSON.stringify({ name: "github-router", version: "1.2.3", dependencies: {} }),
  )
  await fs.writeFile(entry, `process.stdout.write(${JSON.stringify(stdout)})\n`)
  await writePointer({ kind: "self", version: "1.2.3" })
}

afterEach(async () => {
  if (savedAppDir === undefined) delete process.env.GH_ROUTER_APP_DIR
  else process.env.GH_ROUTER_APP_DIR = savedAppDir
  for (const dir of dirs.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
  }
})

describe("shim bodies", () => {
  test("POSIX: one executable sh file per kind, exec-ing the launcher", () => {
    const bodies = shimBodies("self", "/app/m/self/launcher.mjs", "linux")
    expect(bodies).toHaveLength(1)
    expect(bodies[0]!.path.endsWith(path.join("cli-bin", "github-router"))).toBe(true)
    expect(bodies[0]!.mode).toBe(0o755)
    expect(bodies[0]!.content).toContain("exec \"$RUNTIME\" \"$LAUNCHER\" \"$@\"")
    // The marker is what lets a later run recognise its own file.
    expect(bodies[0]!.content).toContain(MANAGED_MARKER)
    // No shell-rc editing, no hardcoded interpreter path.
    expect(bodies[0]!.content).not.toContain("/usr/bin/env node")
  })

  test("Windows: .cmd AND .ps1, both carrying the marker", () => {
    const bodies = shimBodies("self", "C:\\app\\m\\self\\launcher.mjs", "win32")
    const names = bodies.map((b) => path.basename(b.path)).sort()
    expect(names).toEqual(["github-router.cmd", "github-router.ps1"])
    for (const body of bodies) expect(body.content).toContain(MANAGED_MARKER)
    const cmd = bodies.find((b) => b.path.endsWith(".cmd"))!
    // CRLF line endings or cmd.exe misparses the multi-line body.
    expect(cmd.content).toContain("\r\n")
    expect(cmd.content).toContain("%*")
    expect(cmd.content).toContain("%ERRORLEVEL%")
    // `%ERRORLEVEL%` inside a `( )` block is expanded when the BLOCK is parsed,
    // so the obvious `where node && ( node ... & exit /b %ERRORLEVEL% )` exits
    // with where's status (0) and every Windows hook looks successful. The exits
    // must therefore be reached through labels, on their own lines.
    const lines = cmd.content.split("\r\n").map((line) => line.trim())
    for (const line of lines) {
      if (!line.startsWith("exit /b %ERRORLEVEL%")) continue
      const index = lines.indexOf(line)
      expect(lines.slice(Math.max(0, index - 3), index).some((prev) => prev.startsWith(":gh_shim_"))).toBe(true)
    }
    expect(cmd.content).not.toMatch(/\(\r\n[\s\S]*exit \/b %ERRORLEVEL%[\s\S]*\r\n\)/)
  })

  test("an unchanged shim that lost its executable bit is repaired, not reported as unchanged", async () => {
    // Content equality is not "nothing to do": a shim that lost its mode (unzip, a
    // copy, a restore from a backup) stays `permission denied` forever while the
    // equality branch keeps saying "unchanged".
    if (process.platform === "win32") return
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "shim-mode-"))
    dirs.push(dir)
    process.env.GH_ROUTER_APP_DIR = dir
    const first = await ensureShims("self", path.join(dir, "launcher.mjs"), "linux")
    expect(first.every((r) => r.outcome !== "refused")).toBe(true)
    const shim = first[0]!.path
    await fs.chmod(shim, 0o644)
    // Same bytes, wrong mode: the second pass must fix the mode.
    const second = await ensureShims("self", path.join(dir, "launcher.mjs"), "linux")
    expect(second[0]!.outcome).toBe("updated")
    const mode = (await fs.stat(shim)).mode & 0o777
    expect(mode & 0o100).toBe(0o100)
    // And a third pass is a genuine no-op.
    const third = await ensureShims("self", path.join(dir, "launcher.mjs"), "linux")
    expect(third[0]!.outcome).toBe("unchanged")
  })

  test("pi shims are named pi, and only for the pi kind", () => {
    expect(shimBases("self")).toEqual(["github-router"])
    expect(shimBases("pi")).toEqual(["pi"])
    const pi = shimBodies("pi", "/app/m/pi/launcher.mjs", "linux")
    expect(path.basename(pi[0]!.path)).toBe("pi")
  })

  test("PS1 shim escapes single quotes in the launcher path", () => {
    const bodies = shimBodies("self", "C:\\it's\\launcher.mjs", "win32")
    const ps1 = bodies.find((b) => b.path.endsWith(".ps1"))!
    expect(ps1.content).toContain("C:\\it''s\\launcher.mjs")
  })
})

describe("ensureShims", () => {
  test("writes, then reports unchanged, then updates when the launcher moves", async () => {
    const root = await useTempAppDir()
    await writeFakePayload("hello\n")
    const { path: launcher } = await ensureLauncher("self")

    const first = await ensureShims("self", launcher, "linux")
    expect(first.map((r) => r.outcome)).toEqual(["written"])
    const shim = first[0]!.path
    expect(shim).toBe(path.join(root, "cli-bin", "github-router"))
    // POSIX only: Windows has no execute bit. This is the POSIX shim body
    // (`#!/bin/sh`), which only ever runs on a POSIX host, so its bit is part of
    // what "installed correctly" means there — and meaningless on Windows, where
    // `fs.stat().mode` reports the read-only attribute instead.
    if (process.platform !== "win32") {
      expect((await fs.stat(shim)).mode & 0o111).not.toBe(0)
    }

    // Same launcher, same bytes: nothing to do. This is the assertion that caught
    // the Windows bug — `writeShim` compared `stat().mode` against the shim's
    // requested 0o755, which on Windows can never match (no mode bits), so it
    // reported `updated` on EVERY call and an install could never settle. The mode
    // repair is keyed on the host platform now, so the outcome is stable.
    const second = await ensureShims("self", launcher, "linux")
    expect(second.map((r) => r.outcome)).toEqual(["unchanged"])

    // A future layout change must heal the shim, not leave it stale.
    const moved = await ensureShims("self", "/somewhere/else/launcher.mjs", "linux")
    expect(moved.map((r) => r.outcome)).toEqual(["updated"])
    expect(await fs.readFile(shim, "utf8")).toContain("/somewhere/else/launcher.mjs")
  })

  test("refuses to overwrite a file we did not write", async () => {
    const root = await useTempAppDir()
    await fs.mkdir(path.join(root, "cli-bin"), { recursive: true })
    const shim = path.join(root, "cli-bin", "github-router")
    await fs.writeFile(shim, "#!/bin/sh\necho mine\n")
    const { path: launcher } = await ensureLauncher("self")

    const results = await ensureShims("self", launcher, "linux")
    expect(results[0]!.outcome).toBe("refused")
    expect(await fs.readFile(shim, "utf8")).toBe("#!/bin/sh\necho mine\n")
  })

  test("refuses to replace a symlink at the shim path (confused deputy)", async () => {
    const root = await useTempAppDir()
    await fs.mkdir(path.join(root, "cli-bin"), { recursive: true })
    const victim = path.join(root, "victim.txt")
    await fs.writeFile(victim, "untouched")
    await fs.symlink(victim, path.join(root, "cli-bin", "github-router"))
    const { path: launcher } = await ensureLauncher("self")

    const results = await ensureShims("self", launcher, "linux")
    expect(results[0]!.outcome).toBe("refused")
    expect(await fs.readFile(victim, "utf8")).toBe("untouched")
  })

  test("shims live in cli-bin, never in the toolbelt bin dir", async () => {
    const root = await useTempAppDir()
    expect(shimDir()).toBe(path.join(root, "cli-bin"))
    expect(shimDir()).toBe(cliBinDir())
    expect(shimDir()).not.toContain(path.join("toolbelt", "bin"))
  })
})

describe.skipIf(process.platform === "win32")("the POSIX shim, executed for real", () => {
  test("forwards argv and the child's exit code through the launcher", async () => {
    await useTempAppDir()
    // Echo argv so the shim's "$@" forwarding is observable, then a chosen code.
    const entry = path.join(versionDir("self", "1.2.3"), "node_modules/github-router/dist/main.js")
    await fs.mkdir(path.dirname(entry), { recursive: true })
    await fs.writeFile(
      path.join(versionDir("self", "1.2.3"), "node_modules/github-router/package.json"),
      JSON.stringify({ name: "github-router", version: "1.2.3", dependencies: {} }),
    )
    await fs.writeFile(
      entry,
      `process.stdout.write(JSON.stringify(process.argv.slice(2)) + "\\n"); process.exit(42)\n`,
    )
    await writePointer({ kind: "self", version: "1.2.3" })
    const { path: launcher } = await ensureLauncher("self")
    await ensureShims("self", launcher, "linux")

    const proc = Bun.spawn([path.join(cliBinDir(), "github-router"), "pi", "-m", "local"], {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, PATH: `${path.dirname(process.execPath)}:${process.env.PATH}` },
    })
    const stdout = await new Response(proc.stdout).text()
    const code = await proc.exited
    expect(code).toBe(42)
    expect(JSON.parse(stdout.trim())).toEqual(["pi", "-m", "local"])
  })

  test("prints the reinstall hint (not a stack trace) when the launcher is gone", async () => {
    const root = await useTempAppDir()
    const { path: launcher } = await ensureLauncher("self")
    await ensureShims("self", launcher, "linux")
    await fs.rm(launcherPath("self"))

    const proc = Bun.spawn([path.join(root, "cli-bin", "github-router")], {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env },
    })
    const stderr = await new Response(proc.stderr).text()
    const code = await proc.exited
    expect(code).toBe(78)
    expect(stderr).toContain("managed launcher is missing")
    expect(stderr).toContain("npm install -g github-router")
  })
})

describe("isOnPath / pathHint", () => {
  test("matches an exact entry and ignores trailing separators", () => {
    // Per-platform fixtures, not one string reused for both: a Windows PATH is
    // `;`-separated and an entry there contains its own drive colon
    // (`C:\Users\…`), so dropping a Windows path into a `:`-joined string splits
    // it at the drive letter and the assertion tests nothing. Each platform is
    // exercised with the shapes it actually has.
    const posix = "/opt/ghr/cli-bin"
    expect(isOnPath(posix, { PATH: `/usr/bin:${posix}:/bin` }, "linux")).toBe(true)
    expect(isOnPath(posix, { PATH: `/usr/bin:${posix}/:/bin` }, "linux")).toBe(true)
    expect(isOnPath(posix, { PATH: "/usr/bin:/bin" }, "linux")).toBe(false)

    const win = "C:\\Apps\\ghr\\cli-bin"
    expect(isOnPath(win, { Path: `C:\\Windows;${win}` }, "win32")).toBe(true)
    expect(isOnPath(win, { Path: `C:\\Windows;${win}\\` }, "win32")).toBe(true)
    expect(isOnPath(win, { Path: "C:\\Windows" }, "win32")).toBe(false)

    // Case-insensitive on Windows only.
    expect(isOnPath("C:\\Tools", { PATH: "c:\\tools" }, "win32")).toBe(true)
    expect(isOnPath("/Tools", { PATH: "/tools" }, "linux")).toBe(false)
  })

  test("a directory NOT on PATH produces one copy-pasteable line", () => {
    const hint = pathHint("/custom/bin", { PATH: "/usr/bin" }, "linux")
    expect(hint).toContain("export PATH=\"/custom/bin:$PATH\"")
    expect(pathHint("/custom/bin", { PATH: `/custom/bin:/usr/bin` }, "linux")).toBeNull()
  })

  test("the Windows hint never suggests `setx PATH %PATH%`", () => {
    // `setx PATH "%PATH%;<dir>"` is the suggestion everyone writes and it is
    // destructive: the %PATH% there is MACHINE + USER, so pasting it folds the
    // machine entries into the user path permanently, and setx truncates at 1024
    // characters — silently dropping the tail of a developer's PATH. The hint must
    // send the user to the UI, which edits only the user scope.
    const hint = pathHint("C:\\Apps\\github-router\\cli-bin", { PATH: "C:\\Windows" }, "win32")
    expect(hint).not.toBeNull()
    expect(hint).not.toContain("setx")
    expect(hint).toContain("User variables")
    expect(hint).toContain("C:\\Apps\\github-router\\cli-bin")
    // ...and it disappears once the dir is on PATH, case-insensitively.
    expect(
      pathHint("C:\\Apps\\github-router\\cli-bin", {
        Path: "C:\\Windows;c:\\apps\\GITHUB-ROUTER\\cli-bin",
      }, "win32"),
    ).toBeNull()
  })
})

describe("isOurShim", () => {
  test("recognises a managed shim and disowns anything else", async () => {
    await useTempAppDir()
    const { path: launcher } = await ensureLauncher("self")
    const results = await ensureShims("self", launcher, "linux")
    expect(await isOurShim(results[0]!.path)).toBe(true)

    const foreign = path.join(os.tmpdir(), `foreign-shim-${process.pid}`)
    await fs.writeFile(foreign, "#!/bin/sh\npi --version\n")
    expect(await isOurShim(foreign)).toBe(false)
    await fs.rm(foreign, { force: true })
    expect(await isOurShim(foreign)).toBe(false)
  })
})
