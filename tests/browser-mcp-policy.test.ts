import { describe, expect, test } from "bun:test"

import { checkUrlPolicy, preflightUrlPolicy } from "../src/lib/browser-mcp/policy"

describe("browser-mcp URL policy", () => {
  test.each([
    "chrome://settings",
    "chrome://settings/",
    "chrome://settings/passwords",
    "edge://settings",
    "brave://settings",
    "chrome://extensions",
    "chrome://flags",
    "chrome://policy",
    "chrome://password-manager",
    "view-source:chrome://settings",
    "view-source:edge://extensions",
  ])("blocks %s", (url) => {
    const v = checkUrlPolicy(url)
    expect(v.blocked).toBe(true)
    expect(v.reason).toBeDefined()
  })

  test.each([
    "https://example.com",
    "https://example.com/settings",
    "http://example.com/extensions",
    "devtools://devtools/bundled/inspector.html",
    "chrome://newtab/",
    "about:blank",
    "data:text/html,<h1>hi</h1>",
  ])("allows %s", (url) => {
    expect(checkUrlPolicy(url).blocked).toBe(false)
  })

  test("blocks chrome-extension://*/options.html", () => {
    expect(
      checkUrlPolicy("chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/options.html").blocked,
    ).toBe(true)
    expect(
      checkUrlPolicy("chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/popup.html").blocked,
    ).toBe(true)
  })

  test("file:// blocked by default", () => {
    const prev = process.env.GH_ROUTER_BROWSER_ALLOW_FILE_URLS
    delete process.env.GH_ROUTER_BROWSER_ALLOW_FILE_URLS
    try {
      expect(checkUrlPolicy("file:///etc/passwd").blocked).toBe(true)
    } finally {
      if (prev !== undefined) process.env.GH_ROUTER_BROWSER_ALLOW_FILE_URLS = prev
    }
  })

  test("file:// allowed when GH_ROUTER_BROWSER_ALLOW_FILE_URLS=1", () => {
    const prev = process.env.GH_ROUTER_BROWSER_ALLOW_FILE_URLS
    process.env.GH_ROUTER_BROWSER_ALLOW_FILE_URLS = "1"
    try {
      expect(checkUrlPolicy("file:///etc/passwd").blocked).toBe(false)
    } finally {
      if (prev === undefined) delete process.env.GH_ROUTER_BROWSER_ALLOW_FILE_URLS
      else process.env.GH_ROUTER_BROWSER_ALLOW_FILE_URLS = prev
    }
  })

  test("undefined / non-string url passes (not our concern)", () => {
    expect(checkUrlPolicy(undefined).blocked).toBe(false)
    expect(checkUrlPolicy(null).blocked).toBe(false)
    expect(checkUrlPolicy(42).blocked).toBe(false)
  })

  test("preflightUrlPolicy only checks browser_open_tab and browser_navigate", () => {
    expect(preflightUrlPolicy("browser_screenshot", { url: "chrome://settings" }).blocked).toBe(false)
    expect(preflightUrlPolicy("browser_open_tab", { url: "chrome://settings" }).blocked).toBe(true)
    expect(preflightUrlPolicy("browser_navigate", { url: "chrome://settings" }).blocked).toBe(true)
  })
})
