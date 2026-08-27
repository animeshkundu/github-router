/**
 * Cleanup for a fast-profile launch that fails after setupAndServe.
 *
 * The normal launchChild path owns shutdown once the child is spawned. Before
 * that point, fast prerequisite failures must tear down the server and mirror
 * themselves because process.exit() does not await pending work. The returned
 * function is single-flight and idempotent so a fatal path and a signal cannot
 * duplicate teardown.
 */
export interface FastLaunchCleanupDeps {
  server?: { close(force?: boolean): Promise<unknown> }
  stopKeepAwake: () => Promise<void>
  removeMirror: () => Promise<void>
  runtimeCleanup?: () => Promise<void>
}

export function createFastLaunchCleanup(
  deps: FastLaunchCleanupDeps,
): () => Promise<void> {
  let cleanupPromise: Promise<void> | undefined
  return () => {
    if (cleanupPromise) return cleanupPromise
    cleanupPromise = (async () => {
      try {
        await deps.server?.close(true)
      } catch {
        /* already closed or unavailable */
      }
      try {
        await deps.stopKeepAwake()
      } catch {
        /* best-effort */
      }
      if (deps.runtimeCleanup) {
        try {
          await deps.runtimeCleanup()
        } catch {
          /* best-effort */
        }
      }
      try {
        await deps.removeMirror()
      } catch {
        /* best-effort */
      }
    })()
    return cleanupPromise
  }
}
