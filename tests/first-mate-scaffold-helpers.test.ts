import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import process from "node:process"

import {
  assertScaffoldRepoAllowed,
  normalizeBranchRef,
  parseRepoSlug,
  ScaffoldHelperError,
} from "~/lib/first-mate/scaffold-helpers"

/**
 * These guard the inputs to `scaffold_repo`, which creates branches, commits
 * files, and opens pull requests against a real GitHub repository.
 *
 * The gap they close: `parseRepoSlug` validates SHAPE only, so before
 * `assertScaffoldRepoAllowed` existed, any `owner/name` the agent token could
 * reach was writable. The tool's description said it "is not for arbitrary
 * third-party repositories" — prose in a model-facing string, not enforcement.
 * That matters because `--browse` ingests arbitrary web content and that
 * content reaches a model holding this tool.
 */
describe("assertScaffoldRepoAllowed", () => {
  const ENV = "GH_ROUTER_FM_SCAFFOLD_REPOS"
  let original: string | undefined

  beforeEach(() => {
    original = process.env[ENV]
  })
  afterEach(() => {
    if (original === undefined) delete process.env[ENV]
    else process.env[ENV] = original
  })

  test("denies everything when the allowlist is unset", () => {
    delete process.env[ENV]
    // Deny-all, not allow-all: a default-open gate is not a gate. This is the
    // single most important assertion in the file — it is what makes the
    // feature secure for an operator who never configures it.
    expect(() => assertScaffoldRepoAllowed({ owner: "someone", repo: "anything" }))
      .toThrow(ScaffoldHelperError)
  })

  test("denies everything when the allowlist is empty or whitespace", () => {
    for (const value of ["", "   ", ",", " , ,, "]) {
      process.env[ENV] = value
      expect(() => assertScaffoldRepoAllowed({ owner: "o", repo: "r" })).toThrow()
    }
  })

  test("permits an exactly-listed repository", () => {
    process.env[ENV] = "acme/widgets"
    expect(() => assertScaffoldRepoAllowed({ owner: "acme", repo: "widgets" }))
      .not.toThrow()
  })

  test("does NOT permit a sibling repo under a listed owner", () => {
    // The failure that would make the allowlist decorative: listing one repo
    // must not hand over the whole account.
    process.env[ENV] = "acme/widgets"
    expect(() => assertScaffoldRepoAllowed({ owner: "acme", repo: "secrets" }))
      .toThrow(ScaffoldHelperError)
  })

  test("owner/* permits any repo under that owner, and only that owner", () => {
    process.env[ENV] = "acme/*"
    expect(() => assertScaffoldRepoAllowed({ owner: "acme", repo: "widgets" }))
      .not.toThrow()
    expect(() => assertScaffoldRepoAllowed({ owner: "acme", repo: "anything" }))
      .not.toThrow()
    expect(() => assertScaffoldRepoAllowed({ owner: "evil", repo: "widgets" }))
      .toThrow(ScaffoldHelperError)
  })

  test("matches case-insensitively, because GitHub logins are", () => {
    process.env[ENV] = "Acme/Widgets"
    expect(() => assertScaffoldRepoAllowed({ owner: "acme", repo: "widgets" }))
      .not.toThrow()
    expect(() => assertScaffoldRepoAllowed({ owner: "ACME", repo: "WIDGETS" }))
      .not.toThrow()
  })

  test("a listed entry does not leak across the separator", () => {
    // Guards against a naive `raw.includes(slug)` implementation, which would
    // wrongly accept "acme/widgets-staging" for a listed "acme/widgets".
    process.env[ENV] = "acme/widgets,other/thing"
    expect(() => assertScaffoldRepoAllowed({ owner: "acme", repo: "widgets-staging" }))
      .toThrow(ScaffoldHelperError)
    expect(() => assertScaffoldRepoAllowed({ owner: "other", repo: "thing" }))
      .not.toThrow()
  })

  test("tolerates spacing around entries", () => {
    process.env[ENV] = " acme/widgets ,  other/thing "
    expect(() => assertScaffoldRepoAllowed({ owner: "acme", repo: "widgets" }))
      .not.toThrow()
    expect(() => assertScaffoldRepoAllowed({ owner: "other", repo: "thing" }))
      .not.toThrow()
  })

  test("the refusal names the env var so the honest path is discoverable", () => {
    delete process.env[ENV]
    // A refusal an operator cannot act on just gets worked around.
    expect(() => assertScaffoldRepoAllowed({ owner: "acme", repo: "widgets" }))
      .toThrow(/GH_ROUTER_FM_SCAFFOLD_REPOS/)
  })

  test("the refusal does NOT echo the configured allowlist", () => {
    // This message is a tool result that goes back to the model, and under
    // `--browse` that model may be acting on untrusted web content. Listing the
    // allowed repositories would turn a denied call into an oracle for the
    // operator's private repository names — the denial would leak more than a
    // success would.
    process.env[ENV] = "acme/secret-infra,acme/unreleased-product"
    try {
      assertScaffoldRepoAllowed({ owner: "probe", repo: "anything" })
      throw new Error("expected a refusal")
    } catch (err) {
      const message = (err as Error).message
      expect(message).not.toContain("secret-infra")
      expect(message).not.toContain("unreleased-product")
      // Still actionable: it names the denied slug and the lever.
      expect(message).toContain("probe/anything")
      expect(message).toContain("GH_ROUTER_FM_SCAFFOLD_REPOS")
    }
  })

  test("carries the repo-not-allowed code, distinct from a malformed slug", () => {
    delete process.env[ENV]
    try {
      assertScaffoldRepoAllowed({ owner: "acme", repo: "widgets" })
      throw new Error("expected a refusal")
    } catch (err) {
      expect(err).toBeInstanceOf(ScaffoldHelperError)
      // A caller must be able to tell "you typed it wrong" from "you may not
      // write there" — they need different responses.
      expect((err as ScaffoldHelperError).code).toBe("repo-not-allowed")
    }
  })
})

describe("parseRepoSlug", () => {
  test("splits and trims a well-formed slug", () => {
    expect(parseRepoSlug("acme/widgets")).toEqual({ owner: "acme", repo: "widgets" })
    expect(parseRepoSlug("  acme / widgets  ")).toEqual({ owner: "acme", repo: "widgets" })
  })

  test("rejects anything that is not exactly owner/name", () => {
    for (const bad of ["", "   ", "acme", "acme/", "/widgets", "a/b/c", "/", "//"]) {
      expect(() => parseRepoSlug(bad)).toThrow(ScaffoldHelperError)
    }
  })

  test("reports the invalid-repo code", () => {
    try {
      parseRepoSlug("nope")
      throw new Error("expected a throw")
    } catch (err) {
      expect((err as ScaffoldHelperError).code).toBe("invalid-repo")
    }
  })
})

describe("normalizeBranchRef", () => {
  test("strips refs/heads/ and heads/ prefixes", () => {
    expect(normalizeBranchRef("refs/heads/main")).toBe("main")
    expect(normalizeBranchRef("heads/main")).toBe("main")
    expect(normalizeBranchRef("main")).toBe("main")
  })

  test("trims surrounding whitespace", () => {
    expect(normalizeBranchRef("  main  ")).toBe("main")
  })
})
