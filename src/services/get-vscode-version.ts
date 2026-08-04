/**
 * Last-resort floor when the lookup fails. Exported so the version cache can
 * recognize it and refuse to PERSIST it — a fallback must never become the
 * cached steady state, or a transient outage would freeze the version we
 * impersonate for the whole TTL. See `src/lib/editor-version-cache.ts`.
 */
export const VSCODE_VERSION_FALLBACK = "1.104.3"
const FALLBACK = VSCODE_VERSION_FALLBACK

export async function getVSCodeVersion() {
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

    if (match) {
      return match[1]
    }

    return FALLBACK
  } catch {
    return FALLBACK
  } finally {
    clearTimeout(timeout)
  }
}

