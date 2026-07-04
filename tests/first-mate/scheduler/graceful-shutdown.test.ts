import { describe, expect, test } from "bun:test"

import { installGracefulShutdown } from "~/lib/first-mate/scheduler/graceful-shutdown"

/**
 * Fake emitter/stdin so we can drive each trigger deterministically WITHOUT
 * touching the real process signals — and prove the production wiring shuts
 * down on stdin EOF alone, independent of any POSIX signal (the whole point on
 * Windows, where an external SIGTERM never runs the handler).
 */
function makeFakes() {
  const handlers = new Map<string, Array<() => void>>()
  let resumed = false
  const on = (event: string, listener: () => void) => {
    const list = handlers.get(event) ?? []
    list.push(listener)
    handlers.set(event, list)
  }
  const emit = (event: string) => {
    for (const fn of handlers.get(event) ?? []) fn()
  }
  const proc = { on }
  const stdin = {
    on,
    resume: () => {
      resumed = true
    },
  }
  return { proc, stdin, emit, wasResumed: () => resumed, listenerCount: (e: string) => (handlers.get(e) ?? []).length }
}

describe("installGracefulShutdown", () => {
  test("stdin 'end' (EOF) triggers shutdown WITHOUT any signal", () => {
    const { proc, stdin, emit } = makeFakes()
    let count = 0
    const h = installGracefulShutdown({ onShutdown: () => (count += 1), proc, stdin })
    expect(h.triggered()).toBe(false)
    emit("end")
    expect(count).toBe(1)
    expect(h.triggered()).toBe(true)
  })

  test("stdin 'close' (EOF) also triggers shutdown", () => {
    const { proc, stdin, emit } = makeFakes()
    let count = 0
    installGracefulShutdown({ onShutdown: () => (count += 1), proc, stdin })
    emit("close")
    expect(count).toBe(1)
  })

  test("SIGINT and SIGTERM each trigger shutdown (POSIX path)", () => {
    for (const sig of ["SIGINT", "SIGTERM"]) {
      const { proc, stdin, emit } = makeFakes()
      let count = 0
      installGracefulShutdown({ onShutdown: () => (count += 1), proc, stdin })
      emit(sig)
      expect(count).toBe(1)
    }
  })

  test("once-guard: shutdown runs AT MOST once across every trigger", () => {
    const { proc, stdin, emit } = makeFakes()
    let count = 0
    installGracefulShutdown({ onShutdown: () => (count += 1), proc, stdin })
    emit("SIGTERM")
    emit("SIGINT")
    emit("end")
    emit("close")
    expect(count).toBe(1)
  })

  test("resumes stdin so 'end' can fire, and wires all four triggers", () => {
    const { proc, stdin, wasResumed, listenerCount } = makeFakes()
    installGracefulShutdown({ onShutdown: () => {}, proc, stdin })
    expect(wasResumed()).toBe(true)
    expect(listenerCount("SIGINT")).toBe(1)
    expect(listenerCount("SIGTERM")).toBe(1)
    // 'end' + 'close' both wired on the stdin fake.
    expect(listenerCount("end")).toBe(1)
    expect(listenerCount("close")).toBe(1)
  })

  test("a throwing stdin.resume() does not defeat the signal/EOF wiring", () => {
    const { proc, emit } = makeFakes()
    // Same emitter for on() so emit() drives the stdin events too, but resume throws.
    const throwingStdin = {
      on: proc.on,
      resume: () => {
        throw new Error("no stdin")
      },
    }
    let count = 0
    installGracefulShutdown({ onShutdown: () => (count += 1), proc, stdin: throwingStdin })
    emit("end")
    expect(count).toBe(1)
  })
})
