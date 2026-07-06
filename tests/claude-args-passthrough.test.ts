// Unit guard for the `claude` subcommand's child-argv passthrough
// (src/claude.ts `collectChildPassthroughArgs`). citty is non-strict, so an
// unknown flag like `--print` is absorbed into the parsed `args` object with
// its value swallowed rather than landing in `args._`. The launcher therefore
// forwards the child argv by walking citty's rawArgs and dropping only
// github-router's OWN declared flags — this test pins that behavior against
// the REAL `claudeArgs` definition (so a future -m/-p alias change is caught).

import { describe, expect, test } from "bun:test"

import { claudeArgs, collectChildPassthroughArgs } from "../src/claude"

const collect = (raw: Array<string>) => collectChildPassthroughArgs(raw, claudeArgs)

describe("collectChildPassthroughArgs", () => {
  test("forwards --print + prompt when mixed with github-router's own -m flag", () => {
    // The bug: `github-router claude -m gpt-5.5 --print "2+2"` launched
    // interactively because --print + its value were swallowed by citty and
    // never reached the child. github-router's own `-m gpt-5.5` is consumed.
    expect(collect(["-m", "gpt-5.5", "--print", "2+2"])).toEqual(["--print", "2+2"])
  })

  test("interactive launch (no flags) forwards nothing", () => {
    expect(collect([])).toEqual([])
  })

  test("github-router-only invocation forwards nothing to the child", () => {
    expect(collect(["-m", "gpt-5.5", "--no-auto-update", "--stealth"])).toEqual([])
  })

  test("--output-format and other unknown claude flags flow through", () => {
    expect(
      collect(["--output-format", "stream-json", "--print", "hi"]),
    ).toEqual(["--output-format", "stream-json", "--print", "hi"])
  })

  test("everything after a literal -- is forwarded verbatim (prior behavior preserved)", () => {
    expect(collect(["-m", "gpt-5.5", "--", "--print", "2+2"])).toEqual(["--print", "2+2"])
  })

  test("--flag=value form for an unknown flag is forwarded as one token", () => {
    expect(collect(["--print=2+2"])).toEqual(["--print=2+2"])
  })

  test("a string-typed own flag written as --name=value consumes no extra token", () => {
    // `--model=gpt-5.5` is inline; the following child flag must survive.
    expect(collect(["--model=gpt-5.5", "--print", "hi"])).toEqual(["--print", "hi"])
  })

  test("positional args (not consumed by an own flag) are forwarded", () => {
    expect(collect(["chat", "--print"])).toEqual(["chat", "--print"])
  })

  test("--no-<bool> negation of an own flag consumes no following token", () => {
    expect(collect(["--no-codex-mcp", "--print", "hi"])).toEqual(["--print", "hi"])
  })

  test("colliding flag names are owned by github-router (use -- to force to child)", () => {
    // `-p`/`--port` and `-v`/`--verbose` are github-router flags; without `--`
    // they are consumed, not forwarded (documented limitation).
    expect(collect(["-p", "8080", "--print"])).toEqual(["--print"])
    expect(collect(["--verbose", "--print"])).toEqual(["--print"])
    expect(collect(["--", "-p", "--print"])).toEqual(["-p", "--print"])
  })
})
