import consola from "consola"

import type { State } from "./state"

import { HTTPError } from "./error"
import { sleep } from "./utils"

// Cap on how long a single request will wait in the rate-limit serialization
// queue. Prevents an unbounded backlog from holding the proxy if the head of
// the queue is in a long sleep. 5s is generous enough that normal queueing
// (microseconds) never trips it.
const RATE_LIMIT_QUEUE_TIMEOUT_MS = 5000

// Single-flight chain that serializes all rate-limit checks across the
// proxy. Without this, two concurrent requests can both read the timestamp
// before either writes — both proceed when only one should wait. The chain
// adds microseconds of latency per request in the no-rate-limit case and
// correctly serializes the wait when the limit fires.
let rateLimitChain: Promise<void> = Promise.resolve()

export async function checkRateLimit(state: State) {
  if (state.rateLimitSeconds === undefined) return

  const myTurn = rateLimitChain.then(() => doCheck(state))
  rateLimitChain = myTurn.catch(() => {
    // Errors don't break the chain — the next caller starts fresh.
  })

  return Promise.race([
    myTurn,
    sleep(RATE_LIMIT_QUEUE_TIMEOUT_MS).then(() => {
      throw new HTTPError(
        "Rate limit queue wait exceeded",
        Response.json(
          {
            type: "error",
            error: {
              type: "rate_limit_error",
              message: `Rate limit queue exceeded ${RATE_LIMIT_QUEUE_TIMEOUT_MS}ms; try again`,
            },
          },
          { status: 429 },
        ),
      )
    }),
  ])
}

async function doCheck(state: State): Promise<void> {
  if (state.rateLimitSeconds === undefined) return

  const now = Date.now()

  if (!state.lastRequestTimestamp) {
    state.lastRequestTimestamp = now
    return
  }

  const elapsedSeconds = (now - state.lastRequestTimestamp) / 1000

  if (elapsedSeconds > state.rateLimitSeconds) {
    state.lastRequestTimestamp = now
    return
  }

  const waitTimeSeconds = Math.ceil(state.rateLimitSeconds - elapsedSeconds)

  if (!state.rateLimitWait) {
    consola.warn(
      `Rate limit exceeded. Need to wait ${waitTimeSeconds} more seconds.`,
    )
    throw new HTTPError(
      "Rate limit exceeded",
      Response.json({ message: "Rate limit exceeded" }, { status: 429 }),
    )
  }

  const waitTimeMs = waitTimeSeconds * 1000
  consola.warn(
    `Rate limit reached. Waiting ${waitTimeSeconds} seconds before proceeding...`,
  )
  await sleep(waitTimeMs)
  state.lastRequestTimestamp = Date.now()
  consola.info("Rate limit wait completed, proceeding with request")
}
