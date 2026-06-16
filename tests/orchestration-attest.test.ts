/**
 * Tests for `attest_step` (`attestRun`) — the code-driven attestation that every
 * producer in a run was checked by a DIFFERENT lab on its FINAL artifact hash.
 * Pure logic; fail-closed to baseline on anything short of a valid cross-lab
 * check.
 */

import { describe, expect, test } from "bun:test"

import { attestRun, type AttestNode } from "../src/lib/orchestration/attest"

const node = (over: Partial<AttestNode> = {}): AttestNode => ({
  id: "n1",
  producerLab: "openai",
  artifactHash: "sha:abc",
  checks: [{ checkerLab: "google", verifiedArtifactHash: "sha:abc" }],
  ...over,
})

describe("attestRun", () => {
  test("a different-lab check on the final hash attests the node (accept)", () => {
    const r = attestRun({ nodes: [node()] })
    expect(r.attested).toBe(true)
    expect(r.recommendation).toBe("accept")
    expect(r.nodes[0]!.attested).toBe(true)
  })

  test("only a same-lab check -> not attested, ship_baseline", () => {
    const r = attestRun({ nodes: [node({ checks: [{ checkerLab: "openai", verifiedArtifactHash: "sha:abc" }] })] })
    expect(r.attested).toBe(false)
    expect(r.recommendation).toBe("ship_baseline")
    expect(r.nodes[0]!.reason).toMatch(/cross a different lab/)
  })

  test("a different-lab check on a STALE hash -> not attested (stale check)", () => {
    const r = attestRun({ nodes: [node({ checks: [{ checkerLab: "google", verifiedArtifactHash: "sha:OLD" }] })] })
    expect(r.attested).toBe(false)
    expect(r.nodes[0]!.reason).toMatch(/stale check/)
  })

  test("no checks -> not attested (a producer cannot bless itself)", () => {
    const r = attestRun({ nodes: [node({ checks: [] })] })
    expect(r.attested).toBe(false)
    expect(r.nodes[0]!.reason).toMatch(/no independent check/)
  })

  test("empty nodes -> fail closed (ship_baseline)", () => {
    const r = attestRun({ nodes: [] })
    expect(r.attested).toBe(false)
    expect(r.recommendation).toBe("ship_baseline")
  })

  test("all nodes must attest: one bad node fails the whole run", () => {
    const good = node({ id: "good" })
    const bad = node({ id: "bad", checks: [{ checkerLab: "openai", verifiedArtifactHash: "sha:abc" }] })
    const r = attestRun({ nodes: [good, bad] })
    expect(r.attested).toBe(false)
    expect(r.nodes.find((n) => n.id === "good")!.attested).toBe(true)
    expect(r.nodes.find((n) => n.id === "bad")!.attested).toBe(false)
  })

  test("a malformed node (missing producerLab/artifactHash) is not attested, never throws", () => {
    const r = attestRun({ nodes: [{ id: "x", checks: [] } as unknown as AttestNode] })
    expect(r.attested).toBe(false)
    expect(r.nodes[0]!.attested).toBe(false)
  })

  test("a node accepts if ANY of several checks is a valid cross-lab match", () => {
    const r = attestRun({
      nodes: [
        node({
          checks: [
            { checkerLab: "openai", verifiedArtifactHash: "sha:abc" }, // same lab
            { checkerLab: "google", verifiedArtifactHash: "sha:OLD" }, // stale
            { checkerLab: "anthropic", verifiedArtifactHash: "sha:abc" }, // valid
          ],
        }),
      ],
    })
    expect(r.attested).toBe(true)
  })

  test("normalizes lab names: a casing/whitespace variant of the producer lab is NOT a different lab", () => {
    const r = attestRun({
      nodes: [node({ producerLab: "openai", checks: [{ checkerLab: "OpenAI ", verifiedArtifactHash: "sha:abc" }] })],
    })
    expect(r.attested).toBe(false)
    expect(r.nodes[0]!.reason).toMatch(/cross a different lab/)
  })

  test("a genuinely different lab attests regardless of casing", () => {
    const r = attestRun({
      nodes: [node({ producerLab: "openai", checks: [{ checkerLab: "GOOGLE", verifiedArtifactHash: "sha:abc" }] })],
    })
    expect(r.attested).toBe(true)
  })
})
