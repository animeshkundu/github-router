import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { canonicalDir, resolveWorkspace } from "../src/lib/octocode/workspace-detector";
import { octocodeToolDefs, handleOctocodeCall } from "../src/routes/mcp/octocode-proxy";

let dir: string;
const OLD_ENV = { ...process.env };

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "octo-ws-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  process.env.GH_ROUTER_WORKSPACE = OLD_ENV.GH_ROUTER_WORKSPACE;
});

describe("workspace detector", () => {
  test("explicit absolute dir wins", async () => {
    const ws = await resolveWorkspace(dir);
    // macOS /tmp is a symlink (/var -> /private/var); canonicalDir
    // realpaths, so compare against the realpath.
    const { realpathSync } = await import("node:fs");
    expect(ws).toBe(realpathSync(dir));
  });

  test("GH_ROUTER_WORKSPACE env is honored", async () => {
    process.env.GH_ROUTER_WORKSPACE = dir;
    const ws = await resolveWorkspace(undefined);
    const { realpathSync } = await import("node:fs");
    expect(ws).toBe(realpathSync(dir));
  });

  test("relative path throws", () => {
    expect(() => canonicalDir("relative/path")).toThrow();
  });

  test("missing path throws", () => {
    expect(() => canonicalDir(path.join(dir, "missing"))).toThrow();
  });
});

describe("octocode proxy defs", () => {
  test("tool defs all have schemas", () => {
    const defs = octocodeToolDefs();
    expect(defs.length).toBeGreaterThanOrEqual(10);
    for (const d of defs) {
      expect(d.name.length).toBeGreaterThan(0);
      expect(typeof d.inputSchema).toBe("object");
    }
  });

  test("unknown tool returns null", async () => {
    const r = await handleOctocodeCall("code", { query: "x" });
    expect(r).toBeNull();
  });

  test("bad workspace yields isError", async () => {
    const r = await handleOctocodeCall("semantic_search", {
      query: "test",
      workspace: "/definitely/not/here-12345",
    });
    expect(r?.isError).toBe(true);
  });
});
