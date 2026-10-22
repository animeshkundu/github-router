/**
 * The generated Pi extension is a STRING, so nothing in the import graph
 * typechecks it. A typo in an emitted line is invisible to `tsc`, to lint, and
 * to every string-containment assertion that only greps for a substring that
 * still happens to be there. This suite therefore EXECUTES the generated
 * module: it writes the emitted source to disk, imports it, hands the default
 * export a stubbed `pi`, and drives the registered `before_agent_start` handler
 * directly.
 *
 * What that buys, in order of how easily it would otherwise be missed:
 *   - the emitted JavaScript parses and its registration body runs (a syntax
 *     error or a reference to an undefined helper fails here and nowhere else);
 *   - the handler is registered for cheapest and NOT for balanced;
 *   - every stand-down guard actually stands down (custom-triggered run, no
 *     session id, a pi-subagents child process);
 *   - a successful call is re-emitted as a `custom` message and NOT as a
 *     replacement `systemPrompt`;
 *   - every failure shape (empty reply, JSON-RPC error, non-OK HTTP, a
 *     rejected fetch) fails OPEN: handler returns undefined, nothing throws.
 *
 * The module is imported once per emitted variant from a unique filename. Bun
 * caches modules by resolved path, so reusing one name would make the second
 * import return the first variant's module and quietly test the wrong source.
 */

import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { buildPiExtensionSource } from "~/lib/pi-extension"
import type { PiProfileId } from "~/lib/pi-models-settings"

/**
 * Inside `node_modules` so the generated file's `import { Type } from
 * "typebox"` resolves by walking up to the repo's own install, and so nothing
 * in lint or the test glob ever sees the artifact.
 */
const SANDBOX = join(process.cwd(), "node_modules", ".cache", "gh-router-pi-ext")

afterAll(() => {
  rmSync(SANDBOX, { recursive: true, force: true })
  delete process.env.GH_ROUTER_HOOK_MCP_URL
  delete process.env.GH_ROUTER_HOOK_NONCE
  delete process.env.GH_ROUTER_WORKSPACE
})

interface Registered {
  /** `on` handlers, keyed by event name. */
  handlers: Map<string, (event: unknown, ctx: unknown) => unknown>
}

/**
 * Minimal `pi` stub. `on` records handlers so the test can invoke one; every
 * other member answers with a no-op function, which is what the tool and
 * command registration calls in the emitted source need and nothing more.
 */
function stubPi(): { pi: unknown; registered: Registered } {
  const registered: Registered = { handlers: new Map() }
  const pi = {
    on(event: string, handler: (event: unknown, ctx: unknown) => unknown) {
      registered.handlers.set(event, handler)
      return () => {}
    },
    registerTool() {},
    registerCommand() {},
    registerProvider() {},
    sendMessage() {},
    sendUserMessage() {},
    setActiveTools() {},
  }
  return { pi, registered }
}

/** Emit one variant and import the freshly-written module. */
async function loadExtension(
  opts: { profileId: PiProfileId; name: string },
): Promise<Registered> {
  const source = buildPiExtensionSource({
    profileId: opts.profileId,
    searchEnabled: false,
    browseEnabled: false,
  })
  mkdirSync(SANDBOX, { recursive: true })
  // `.ts`, because that is what the launcher writes: `src/pi.ts` persists this
  // string as `extensions/gh-router-pi/index.ts` and Pi loads extensions
  // through its jiti loader, which transpiles TypeScript. The emitted source
  // genuinely IS TypeScript (the statusline section annotates locals), so a
  // `.mjs` parse check here would fail on pre-existing, working code.
  const file = join(SANDBOX, `${opts.name}.ts`)
  writeFileSync(file, source, "utf8")
  const mod = (await import(file)) as { default: (pi: unknown) => void }
  const { pi, registered } = stubPi()
  // Throws on a syntax error, on a bad import, and on anything the module does
  // at registration time that the stub cannot satisfy. That is the point.
  mod.default(pi)
  return registered
}

/** Context shape the emitted handler reads: `sessionManager.getSessionId()`. */
const ctxWith = (sessionId: string | undefined, notify?: (m: string, t?: string) => void) => ({
  sessionManager:
    sessionId === undefined ? {} : { getSessionId: () => sessionId },
  ui: { notify: notify ?? (() => {}) },
})

const USER_EVENT = { messageType: "user", prompt: "implement the widget cache" }

/**
 * Stub the generated module's only network call. The extension calls
 * `fetch(MCP_URL + "/mcp/search", ...)` and reads `body.result.content[].text`,
 * so a Responses-shaped JSON-RPC envelope is enough.
 */
async function withFetch<T>(
  impl: (url: string, init: RequestInit) => Response | Promise<Response>,
  fn: (calls: Array<{ url: string; init: RequestInit }>) => Promise<T>,
): Promise<T> {
  const calls: Array<{ url: string; init: RequestInit }> = []
  const original = globalThis.fetch
  // `string | URL | Request` rather than `RequestInfo`: the root tsconfig does
  // not pull in the DOM lib, so `RequestInfo` is not a global here. This is the
  // same parameter type the other fetch-stubbing suites in this repo use.
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    calls.push({ url, init: init ?? {} })
    return impl(url, init ?? {})
  }) as unknown as typeof fetch
  try {
    return await fn(calls)
  } finally {
    globalThis.fetch = original
  }
}

const mcpOk = (text: string) =>
  new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      result: { content: [{ type: "text", text }] },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  )

const mcpError = (message: string) =>
  new Response(
    JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32000, message } }),
    { status: 200, headers: { "content-type": "application/json" } },
  )

const EMPTY_BRIEF = 'EXECUTION BRIEF (advisory): Try the cache first.'

describe("pi prompt brief: emission gate", () => {
  test("cheapest family emits the handler, balanced family does not", () => {
    const emit = (profileId: PiProfileId): string =>
      buildPiExtensionSource({ profileId, searchEnabled: false, browseEnabled: false })
    for (const profileId of ["cheapest", "cheapest2"] as const) {
      expect(emit(profileId)).toContain('pi.on("before_agent_start"')
      expect(emit(profileId)).toContain('callMcp("search", "prompt_brief"')
    }
    // The balanced family is floor-free by design, exactly like the advisor:
    // the digest and the front-end brief are the same surface and gate
    // together, so balanced2 derives the omission rather than re-declaring it.
    for (const profileId of ["balanced", "balanced2"] as const) {
      expect(emit(profileId)).not.toContain("before_agent_start")
      expect(emit(profileId)).not.toContain("prompt_brief")
    }
  })
})

describe("pi prompt brief: generated module runs", () => {
  test("the emitted source imports and registers the handler", async () => {
    process.env.GH_ROUTER_HOOK_MCP_URL = "http://127.0.0.1:9/hook"
    process.env.GH_ROUTER_HOOK_NONCE = "0".repeat(64)
    process.env.GH_ROUTER_WORKSPACE = "C:/work/scratch"
    const registered = await loadExtension({ profileId: "cheapest", name: "cheapest-registers" })
    expect(registered.handlers.has("before_agent_start")).toBe(true)
    expect(registered.handlers.has("session_before_compact")).toBe(true)
    // The derived alias must execute too, not merely string-match.
    const derived = await loadExtension({ profileId: "cheapest2", name: "cheapest2-registers" })
    expect(derived.handlers.has("before_agent_start")).toBe(true)
    expect(derived.handlers.has("session_before_compact")).toBe(true)
  })

  test("a successful call returns the brief as a custom message above the turn", async () => {
    process.env.GH_ROUTER_HOOK_MCP_URL = "http://127.0.0.1:9/hook"
    process.env.GH_ROUTER_HOOK_NONCE = "0".repeat(64)
    process.env.GH_ROUTER_WORKSPACE = "C:/work/scratch"
    const registered = await loadExtension({ profileId: "cheapest", name: "cheapest-happy" })
    const handler = registered.handlers.get("before_agent_start")!

    const result = await withFetch(
      () => mcpOk(EMPTY_BRIEF),
      async (calls) => {
        const r = await handler(USER_EVENT, ctxWith("sess-1"))
        expect(calls).toHaveLength(1)
        expect(calls[0]!.url).toBe("http://127.0.0.1:9/hook/mcp/search")
        const body = JSON.parse(String(calls[0]!.init.body)) as {
          params: { name: string; arguments: Record<string, unknown> }
        }
        expect(body.params.name).toBe("prompt_brief")
        expect(body.params.arguments.prompt).toBe("implement the widget cache")
        expect(body.params.arguments.session_id).toBe("sess-1")
        expect(body.params.arguments.workspace).toBe("C:/work/scratch")
        return r
      },
    )

    expect(result).toEqual({
      message: {
        customType: "gh-router-prompt-brief",
        content: EMPTY_BRIEF,
        display: false,
      },
    })
    // The brief is ADDITIVE. Returning systemPrompt would replace the whole
    // prompt for the run and fight Pi's structured-section accounting.
    expect(result).not.toHaveProperty("systemPrompt")
  })
})

describe("pi prompt brief: stand-down guards", () => {
  const setup = async (name: string) => {
    process.env.GH_ROUTER_HOOK_MCP_URL = "http://127.0.0.1:9/hook"
    process.env.GH_ROUTER_HOOK_NONCE = "0".repeat(64)
    process.env.GH_ROUTER_WORKSPACE = "C:/work/scratch"
    const registered = await loadExtension({ profileId: "cheapest", name })
    return registered.handlers.get("before_agent_start")!
  }

  test("a custom-triggered run is skipped without a call", async () => {
    const handler = await setup("cheapest-custom")
    await withFetch(
      () => mcpOk(EMPTY_BRIEF),
      async (calls) => {
        const r = await handler(
          { messageType: "custom", message: { customType: "x", content: "y" } },
          ctxWith("sess-1"),
        )
        expect(r).toBeUndefined()
        expect(calls).toHaveLength(0)
      },
    )
  })

  test("a pi-subagents async runner stands down: its child sessions load this extension too", async () => {
    const handler = await setup("cheapest-child")
    process.env.PI_SUBAGENT_CHILD = "1"
    try {
      await withFetch(
        () => mcpOk(EMPTY_BRIEF),
        async (calls) => {
          expect(await handler(USER_EVENT, ctxWith("sess-child"))).toBeUndefined()
          expect(calls).toHaveLength(0)
        },
      )
    } finally {
      delete process.env.PI_SUBAGENT_CHILD
    }
  })

  test("no session id means no one-shot flag, so no call", async () => {
    const handler = await setup("cheapest-nosid")
    await withFetch(
      () => mcpOk(EMPTY_BRIEF),
      async (calls) => {
        expect(await handler(USER_EVENT, ctxWith(undefined))).toBeUndefined()
        // A manager whose getSessionId returns "" is the same refusal.
        expect(await handler(USER_EVENT, ctxWith(""))).toBeUndefined()
        expect(calls).toHaveLength(0)
      },
    )
  })

  test("an empty prompt is skipped without a call", async () => {
    const handler = await setup("cheapest-noprompt")
    await withFetch(
      () => mcpOk(EMPTY_BRIEF),
      async (calls) => {
        expect(await handler({ messageType: "user", prompt: "   " }, ctxWith("s"))).toBeUndefined()
        expect(calls).toHaveLength(0)
      },
    )
  })
})

describe("pi prompt brief: fail open", () => {
  const setup = async (name: string) => {
    process.env.GH_ROUTER_HOOK_MCP_URL = "http://127.0.0.1:9/hook"
    process.env.GH_ROUTER_HOOK_NONCE = "0".repeat(64)
    process.env.GH_ROUTER_WORKSPACE = "C:/work/scratch"
    const registered = await loadExtension({ profileId: "cheapest", name })
    return registered.handlers.get("before_agent_start")!
  }

  test("an empty text block (a decline) injects nothing", async () => {
    const handler = await setup("cheapest-decline")
    await withFetch(
      () => mcpOk(""),
      async () => {
        expect(await handler(USER_EVENT, ctxWith("sess-1"))).toBeUndefined()
      },
    )
  })

  test("a JSON-RPC error text injects nothing", async () => {
    const handler = await setup("cheapest-rpcerr")
    await withFetch(
      () => mcpError("prompt_brief: arguments.prompt is required"),
      async () => {
        expect(await handler(USER_EVENT, ctxWith("sess-1"))).toBeUndefined()
      },
    )
  })

  test("a non-OK HTTP status injects nothing and does not throw", async () => {
    const handler = await setup("cheapest-httpfail")
    await withFetch(
      () => new Response("nope", { status: 500 }),
      async () => {
        expect(await handler(USER_EVENT, ctxWith("sess-1"))).toBeUndefined()
      },
    )
  })

  test("a rejected fetch injects nothing and does not throw", async () => {
    const handler = await setup("cheapest-reject")
    const original = globalThis.fetch
    globalThis.fetch = (() => Promise.reject(new Error("ECONNREFUSED"))) as unknown as typeof fetch
    try {
      expect(await handler(USER_EVENT, ctxWith("sess-1"))).toBeUndefined()
    } finally {
      globalThis.fetch = original
    }
  })
})
