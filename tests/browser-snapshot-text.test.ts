/**
 * Visible-text extraction: the shared `collectVisibleText` walk (separator /
 * cap / visibility) and snapshot-cdp's PER-FRAME text merge.
 *
 * Two layers, both dependency-free (the repo has no jsdom/happy-dom — we mock
 * at the boundary like the rest of the suite):
 *   1. `collectVisibleText` against a hand-rolled fake DOM, plus an `eval()` of
 *      the REAL `buildVisibleTextExpr` output so the toString-injected
 *      expression that ships in the primary CDP path is proven valid + correct
 *      in-process (the mocked-CDP test below stubs Runtime.evaluate's RESULT,
 *      so only this eval actually executes the injected source).
 *   2. `extractSnapshotCDP` with a fully mocked CDP: top + child frame text is
 *      merged under the cap, and a child-frame failure is non-fatal (counted
 *      in diag, not thrown).
 */

import { afterEach, describe, expect, test } from "bun:test"

import { extractSnapshotCDP } from "~/browser-ext/snapshot-cdp.js"
import { buildVisibleTextExpr, collectVisibleText } from "~/browser-ext/visible-text.js"

// ---- fake DOM ---------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

function fakeText(text: string, parentTag = "SPAN", parentExtra: Any = {}): Any {
  return { textContent: text, parentElement: { tagName: parentTag, ...parentExtra } }
}

function fakeRoot(nodes: Any[]): Any {
  const doc = {
    createTreeWalker() {
      let i = 0
      return { nextNode: () => (i < nodes.length ? nodes[i++] : null) }
    },
  }
  return { ownerDocument: doc }
}

const savedWindow = (globalThis as Any).window
const savedDocument = (globalThis as Any).document
const savedChrome = (globalThis as Any).chrome

afterEach(() => {
  ;(globalThis as Any).window = savedWindow
  ;(globalThis as Any).document = savedDocument
  ;(globalThis as Any).chrome = savedChrome
})

// ---- collectVisibleText -----------------------------------------------------

describe("collectVisibleText", () => {
  test("adjacent inline text nodes are SEPARATED, never glued", () => {
    // The exact innerText-glue failure: two inline spans with no whitespace
    // text node between them. Walking text nodes + "\n" keeps them distinct.
    const root = fakeRoot([fakeText("Item-757"), fakeText("ITM_a209f4")])
    expect(collectVisibleText(root, 1000, "none")).toBe("Item-757\nITM_a209f4")
  })

  test("script / style / noscript text is dropped", () => {
    const root = fakeRoot([
      fakeText("real text", "P"),
      fakeText("var x = 1", "SCRIPT"),
      fakeText("body{}", "STYLE"),
      fakeText("hidden", "NOSCRIPT"),
    ])
    expect(collectVisibleText(root, 1000, "none")).toBe("real text")
  })

  test("the cap truncates at the boundary mid-node", () => {
    const root = fakeRoot([fakeText("aaaa"), fakeText("bbbb")])
    // "aaaa"(4)+1=5 fits cap=6; "bbbb" would make 10>6 → take 6-5=1 char.
    expect(collectVisibleText(root, 6, "none")).toBe("aaaa\nb")
  })

  test("viewport mode keeps in-viewport text and drops off-screen", () => {
    ;(globalThis as Any).window = { innerWidth: 100, innerHeight: 100 }
    const inView = { getBoundingClientRect: () => ({ bottom: 50, right: 50, top: 0, left: 0 }) }
    const offView = { getBoundingClientRect: () => ({ bottom: -5, right: -5, top: -10, left: -10 }) }
    const root = fakeRoot([fakeText("visible", "P", inView), fakeText("offscreen", "P", offView)])
    expect(collectVisibleText(root, 1000, "viewport")).toBe("visible")
  })

  test("rendered mode drops display:none (zero client rects), keeps off-screen", () => {
    const shown = { getClientRects: () => [{}] }
    const hidden = { getClientRects: () => [] as Any[] }
    const root = fakeRoot([fakeText("shown", "P", shown), fakeText("hidden", "P", hidden)])
    expect(collectVisibleText(root, 1000, "rendered")).toBe("shown")
  })

  test("missing root / document degrades to empty string", () => {
    expect(collectVisibleText(null, 1000, "none")).toBe("")
    expect(collectVisibleText({} as Any, 1000, "none")).toBe("")
  })
})

// ---- the real injected expression -------------------------------------------

describe("buildVisibleTextExpr — the shipped CDP expression", () => {
  test("eval() of the generated source runs and separates text", () => {
    const nodes = [fakeText("Frame-A"), fakeText("Frame-B")]
    const body: Any = {}
    const doc = {
      body,
      documentElement: body,
      createTreeWalker() {
        let i = 0
        return { nextNode: () => (i < nodes.length ? nodes[i++] : null) }
      },
    }
    body.ownerDocument = doc
    ;(globalThis as Any).document = doc
    const expr = buildVisibleTextExpr("none", 1000)
    const result = eval(expr)
    expect(result).toBe("Frame-A\nFrame-B")
  })
})

// ---- per-frame CDP merge ----------------------------------------------------

interface MockOpts {
  childWorld?: number | null
  childThrows?: boolean
  topText?: string
  childText?: string
}

function makeSendCommand(opts: MockOpts) {
  return async (_tabId: number, method: string, params: Any) => {
    switch (method) {
      case "DOM.getDocument":
        return {}
      case "Page.getLayoutMetrics":
        return { cssVisualViewport: { clientWidth: 1200, clientHeight: 800, pageX: 0, pageY: 0, scale: 1 } }
      case "Page.getFrameTree":
        return {
          frameTree: {
            frame: { id: "TOP", url: "http://test/" },
            childFrames: [{ frame: { id: "CH", url: "http://test/child", parentId: "TOP" } }],
          },
        }
      case "Accessibility.getFullAXTree":
        return { nodes: [] } // no elements — keeps the test focused on text
      case "Page.createIsolatedWorld":
        if (opts.childThrows) throw new Error("No frame with given id")
        return { executionContextId: opts.childWorld === undefined ? 99 : opts.childWorld }
      case "Runtime.evaluate": {
        const expr = String(params?.expression || "")
        if (expr.includes("querySelectorAll")) return { result: { value: [] } } // visualSurfaces
        if (params?.contextId === 99) return { result: { value: opts.childText ?? "CHILD-FRAME-TEXT" } }
        return { result: { value: opts.topText ?? "TOP-FRAME-TEXT" } }
      }
      default:
        return {}
    }
  }
}

function deps(opts: MockOpts) {
  ;(globalThis as Any).chrome = { tabs: { get: async () => ({ url: "http://test/", title: "T" }) } }
  return { attachDebugger: async () => {}, sendCommand: makeSendCommand(opts) }
}

describe("extractSnapshotCDP — per-frame visible text", () => {
  test("top + child frame text are both extracted and merged", async () => {
    const r = await extractSnapshotCDP(1, { mode: "summary" }, deps({}))
    expect(r.text).toContain("TOP-FRAME-TEXT")
    expect(r.text).toContain("CHILD-FRAME-TEXT")
    expect(r.truncated.diag.textFramesSkipped).toBe(0)
  })

  test("a child frame that refuses createIsolatedWorld is non-fatal (counted, not thrown)", async () => {
    const r = await extractSnapshotCDP(1, { mode: "summary" }, deps({ childThrows: true }))
    expect(r.text).toContain("TOP-FRAME-TEXT")
    expect(r.text).not.toContain("CHILD-FRAME-TEXT")
    expect(r.truncated.diag.textFramesSkipped).toBe(1)
  })

  test("a child frame with no execution context degrades quietly (no skip count)", async () => {
    const r = await extractSnapshotCDP(1, { mode: "summary" }, deps({ childWorld: null }))
    expect(r.text).toBe("TOP-FRAME-TEXT")
    expect(r.truncated.diag.textFramesSkipped).toBe(0)
  })
})
