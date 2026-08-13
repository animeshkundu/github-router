// Regression cover for the worker "workspace pin" defect.
//
// The proxy is a long-lived process started ONCE, from wherever the operator
// happened to be. The agent calling a worker tool is not pinned to that
// directory: a Claude Code session can move into a git worktree, and a
// sub-agent can be launched already inside one. `process.cwd()` is therefore
// unrelated to the caller's location, and the boundary used to fall back to it
// SILENTLY — so a worker asked to review the change in worktree W ran against
// the proxy's own checkout instead, reading pre-change content or finding
// nothing at all, and said nothing about it.
//
// Three properties are pinned here:
//   1. no workspace on the wire ⇒ the call is REFUSED, not guessed;
//   2. the operator escape hatch restores the old launch-cwd default;
//   3. the workspace the caller names is the one the engine is handed, even
//      when it is a linked git worktree whose contents differ from cwd.
//
// (3) uses a REAL scratch repo with a real linked worktree, because the whole
// bug is about two directories that share a repo but not a tree — a mocked
// path string cannot demonstrate that the wrong one lacks the files.
//
// Isolated because it mock.module()s the worker-agent index to stub
// runWorkerAgent (capture opts, no live model).

import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test"

import { execFileSync } from "node:child_process"
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import { state } from "../../src/lib/state"

import {
  BROWSE_DEFAULT_MODEL,
  DEFAULT_MODEL_CHAIN,
} from "../../src/lib/worker-agent/engine"

interface Captured {
  mode: string
  prompt: string
  workspace?: string
  worktree?: boolean
}
const calls: Array<Captured> = []

mock.module("~/lib/worker-agent", () => ({
  DEFAULT_MODEL_CHAIN,
  BROWSE_DEFAULT_MODEL,
  runWorkerAgent: async (opts: Captured) => {
    calls.push(opts)
    return { text: "worker-done" }
  },
}))

const { NON_PERSONA_MCP_TOOLS } = await import("../../src/lib/peer-mcp-personas")

type WorkspaceSource = "argument" | "session" | "absent"
type ToolEntry = {
  group: string
  toolNameHttp: string
  handler: (
    args: Record<string, unknown>,
    signal?: AbortSignal,
    ctx?: { workspaceSource: WorkspaceSource },
  ) => Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }>
}

function toolFor(mode: string): ToolEntry {
  const tool = NON_PERSONA_MCP_TOOLS.find(
    (t) => t.group === "workers" && t.toolNameHttp === mode,
  )
  if (!tool?.handler) throw new Error(`workers/${mode} tool (or handler) missing`)
  return tool as unknown as ToolEntry
}

/** Windows hands back drive letters and separators inconsistently between
 *  `git rev-parse` and Node, so compare canonical, case-folded paths. */
function samePath(a: string, b: string): boolean {
  return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()
}

const scratchDirs: Array<string> = []

/**
 * A real repo with a linked worktree on another branch, where a marker file
 * exists ONLY in the worktree. Returns both roots so a test can assert that
 * running in the wrong one genuinely cannot see the file.
 */
function makeRepoWithLinkedWorktree(): { main: string; linked: string; marker: string } {
  const root = realpathSync.native(
    mkdtempSync(path.join(tmpdir(), "gh-router-ws-pin-")),
  )
  scratchDirs.push(root)
  const main = path.join(root, "main")
  const linked = path.join(root, "linked")
  const git = (cwd: string, ...args: Array<string>): void => {
    execFileSync("git", args, { cwd, stdio: "pipe" })
  }
  execFileSync("git", ["init", "-q", "-b", "master", main], { stdio: "pipe" })
  git(main, "config", "user.email", "test@example.com")
  git(main, "config", "user.name", "test")
  writeFileSync(path.join(main, "shared.txt"), "on-master\n")
  git(main, "add", "-A")
  git(main, "commit", "-qm", "init")
  git(main, "branch", "feature")
  git(main, "worktree", "add", "-q", linked, "feature")
  // Present only in the linked worktree, and never committed — the shape of
  // an in-progress change a reviewer would be asked about.
  const marker = path.join(linked, "only-here.txt")
  writeFileSync(marker, "visible-only-in-the-linked-worktree\n")
  return { main, linked, marker }
}

afterAll(() => {
  for (const dir of scratchDirs) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // best effort; the OS temp reaper gets the rest
    }
  }
})

beforeEach(() => {
  calls.length = 0
  delete process.env.GH_ROUTER_ALLOW_PROXY_CWD_WORKSPACE
  state.serveMode = false
})

describe("worker workspace resolution refuses to guess", () => {
  for (const mode of ["explore", "review", "plan", "implement", "test"] as const) {
    test(`${mode}: no workspace argument and no session header ⇒ refused, engine never invoked`, async () => {
      const res = await toolFor(mode).handler({ prompt: "do it" }, undefined, {
        workspaceSource: "absent",
      })
      expect(res.isError).toBe(true)
      expect(res.content[0]!.text).toContain("a workspace is required")
      // The message has to be actionable, not just a refusal.
      expect(res.content[0]!.text).toContain("current working directory")
      // The load-bearing half: before this fix the engine ran here, against
      // the proxy's own cwd.
      expect(calls).toHaveLength(0)
    })
  }

  test("the operator escape hatch restores the old launch-cwd default", async () => {
    process.env.GH_ROUTER_ALLOW_PROXY_CWD_WORKSPACE = "1"
    const res = await toolFor("explore").handler({ prompt: "look" }, undefined, {
      workspaceSource: "absent",
    })
    expect(res.isError).toBeFalsy()
    expect(calls).toHaveLength(1)
    expect(samePath(calls[0]!.workspace!, process.cwd())).toBe(true)
    // Still not silent: a guessed workspace is always named in the result.
    expect(res.content[0]!.text).toContain("[workspace:")
    expect(res.content[0]!.text).toContain("the proxy's launch directory")
  })

  test("serve mode still refuses WITH the escape hatch set", async () => {
    // The serve branch deliberately outranks the hatch, so this asserts the
    // refusal SURVIVES it rather than asserting the hatch works here. A serve
    // is one daemon fronting many projects, so its launch cwd belongs to no
    // client: honouring the hatch would run a worker against an unrelated
    // repository, a worse form of the bug this resolution closes.
    //
    // Testing only the non-serve default would leave this branch unexercised,
    // which is exactly how a "fix" that reorders the two could land green.
    process.env.GH_ROUTER_ALLOW_PROXY_CWD_WORKSPACE = "1"
    state.serveMode = true
    try {
      const res = await toolFor("implement").handler({ prompt: "do it" }, undefined, {
        workspaceSource: "absent",
      })
      expect(res.isError).toBe(true)
      expect(res.content[0]!.text).toContain("machine-wide github-router serve")
      // The message must NOT dangle a hatch that cannot work here.
      expect(res.content[0]!.text).not.toContain("GH_ROUTER_ALLOW_PROXY_CWD_WORKSPACE")
      expect(calls).toHaveLength(0)
    } finally {
      state.serveMode = false
    }
  })

  test("serve mode accepts an explicit workspace as it always did", async () => {
    state.serveMode = true
    try {
      const res = await toolFor("explore").handler(
        { prompt: "look", workspace: process.cwd() },
        undefined,
        { workspaceSource: "argument" },
      )
      expect(res.isError).toBeFalsy()
      expect(samePath(calls[0]!.workspace!, process.cwd())).toBe(true)
    } finally {
      state.serveMode = false
    }
  })
})

describe("worker workspace provenance is reported to the caller", () => {
  test("a caller-supplied workspace produces no note (it already knows)", async () => {
    const res = await toolFor("explore").handler(
      { prompt: "look", workspace: process.cwd() },
      undefined,
      { workspaceSource: "argument" },
    )
    expect(res.content[0]!.text).toBe("worker-done")
  })

  test("a session-header workspace is named, and says to override it", async () => {
    // The header is a per-CONNECTION value: it tracks the session, so it
    // cannot distinguish one sub-agent from another. Saying which tree ran is
    // what turns a wrong-tree result from silent into visible.
    const res = await toolFor("explore").handler(
      { prompt: "look", workspace: process.cwd() },
      undefined,
      { workspaceSource: "session" },
    )
    expect(res.content[0]!.text).toContain("worker-done")
    expect(res.content[0]!.text).toContain(`[workspace: ${process.cwd()}`)
    expect(res.content[0]!.text).toContain("git worktree")
  })

  test("without a boundary ctx, an explicit workspace is still not mislabelled", async () => {
    // A direct handler call (a test, or a future in-process caller) carries no
    // provenance. Defaulting the label to "the proxy's launch directory" would
    // then report a wrong source for a path the caller had actually named, so
    // the argument itself is the fallback signal.
    const res = await toolFor("explore").handler({
      prompt: "look",
      workspace: process.cwd(),
    })
    expect(res.content[0]!.text).toBe("worker-done")
  })
})

describe("a linked git worktree is a genuinely different tree", () => {
  test("the named worktree reaches the engine, and the sibling checkout lacks its files", () => {
    const { main, linked, marker } = makeRepoWithLinkedWorktree()

    // The premise of the bug: these two directories share a repository but
    // not a working tree, so resolving to the wrong one loses the files.
    expect(Bun.file(marker).size).toBeGreaterThan(0)
    expect(
      execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
        cwd: linked,
        encoding: "utf8",
      }).trim(),
    ).toBe("feature")
    expect(
      execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
        cwd: main,
        encoding: "utf8",
      }).trim(),
    ).toBe("master")
    // The file the reviewer would be asked about does NOT exist in the other
    // checkout — a worker pinned there has no legitimate path to it.
    expect(
      Bun.file(path.join(main, path.basename(marker))).size,
    ).toBe(0)
  })

  test("the workspace argument wins over the proxy's cwd", async () => {
    const { linked } = makeRepoWithLinkedWorktree()
    const res = await toolFor("review").handler(
      { prompt: "review the in-progress change", workspace: linked },
      undefined,
      { workspaceSource: "argument" },
    )
    expect(res.isError).toBeFalsy()
    expect(calls).toHaveLength(1)
    expect(samePath(calls[0]!.workspace!, linked)).toBe(true)
    expect(samePath(calls[0]!.workspace!, process.cwd())).toBe(false)
  })
})
