/**
 * Last-resort floor when the lookup fails. A fallback must never become the
 * cached steady state, or a transient outage would freeze the version we
 * impersonate. See `src/lib/editor-version-cache.ts`.
 */
export const VSCODE_VERSION_FALLBACK = "1.104.3"
const FALLBACK = VSCODE_VERSION_FALLBACK

/**
 * The lookup, reporting failure as `undefined` rather than as the fallback.
 *
 * The distinction is load-bearing for the cache: it must not infer "the fetch
 * failed" from `value === FALLBACK`, because the live version legitimately
 * equals the constant right after someone bumps `VSCODE_VERSION_FALLBACK` to
 * the then-current release — and that reading would refuse to cache a perfectly
 * good result, making every launch re-pay the ~1.5s network call forever.
 */
export async function getVSCodeVersionOrUndefined(): Promise<string | undefined> {
  const controller = new AbortController()
  const timeout = setTimeout(() => {
    controller.abort()
  }, 5000)

  try {
    const response = await fetch(
      "https://aur.archlinux.org/cgit/aur.git/plain/PKGBUILD?h=visual-studio-code-bin",
      {
        signal: controller.signal,
      },
    )

    const pkgbuild = await response.text()
    const pkgverRegex = /pkgver=([0-9.]+)/
    const match = pkgbuild.match(pkgverRegex)

    return match ? match[1] : undefined
  } catch {
    return undefined
  } finally {
    clearTimeout(timeout)
  }
}

/** Fallback-substituting wrapper, for callers that just want a version. */
export async function getVSCodeVersion(): Promise<string> {
  return (await getVSCodeVersionOrUndefined()) ?? FALLBACK
}

