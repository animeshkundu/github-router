import { test, expect } from "bun:test"
import consola from "consola"

import { awaitApproval } from "../src/lib/approval"
import { HTTPError } from "../src/lib/error"

test("awaitApproval resolves when approved", async () => {
  const originalPrompt = consola.prompt
  consola.prompt = (async () => true) as typeof consola.prompt
  await expect(awaitApproval()).resolves.toBeUndefined()
  consola.prompt = originalPrompt
})

test("awaitApproval throws HTTPError when rejected", async () => {
  const originalPrompt = consola.prompt
  consola.prompt = (async () => false) as typeof consola.prompt
  await expect(awaitApproval()).rejects.toBeInstanceOf(HTTPError)
  consola.prompt = originalPrompt
})
