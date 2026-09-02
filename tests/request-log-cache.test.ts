import { afterEach, describe, expect, mock, test } from "bun:test"
import consola from "consola"

import { logRequest } from "~/lib/request-log"

describe("request cache diagnostics", () => {
  const originalInfo = consola.info

  afterEach(() => {
    consola.info = originalInfo
  })

  test("includes a positive provider-reported cache TTL", () => {
    const lines: Array<string> = []
    consola.info = mock((message: unknown) => {
      lines.push(String(message))
    }) as unknown as typeof consola.info

    logRequest(
      {
        method: "POST",
        path: "/v1/responses",
        inputTokens: 100,
        outputTokens: 5,
        cacheReadTokens: 40,
        cacheWriteTokens: 25,
        cacheTtlSeconds: 1800,
        status: 200,
      },
      undefined,
      Date.now(),
    )

    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain("cache:r40/w25 ttl:1800s")
  })

  test("does not print a non-positive or non-finite TTL", () => {
    for (const cacheTtlSeconds of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const lines: Array<string> = []
      consola.info = mock((message: unknown) => {
        lines.push(String(message))
      }) as unknown as typeof consola.info

      logRequest(
        {
          method: "POST",
          path: "/v1/responses",
          inputTokens: 100,
          cacheReadTokens: 40,
          cacheTtlSeconds,
          status: 200,
        },
        undefined,
        Date.now(),
      )

      expect(lines).toHaveLength(1)
      expect(lines[0]).not.toContain("ttl:")
    }
  })
})
