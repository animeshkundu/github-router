/**
 * Last-resort floor when the lookup fails. A fallback must never become the
 * cached steady state — see the note on `VSCODE_VERSION_FALLBACK` in
 * `./get-vscode-version`.
 */
export const COPILOT_CHAT_VERSION_FALLBACK = "0.43.2026033101"
const FALLBACK = COPILOT_CHAT_VERSION_FALLBACK

interface MarketplaceResult {
  results: Array<{
    extensions: Array<{
      versions: Array<{ version: string }>
    }>
  }>
}

/**
 * The lookup, reporting failure as `undefined` rather than as the fallback.
 * See `getVSCodeVersionOrUndefined` for why the distinction matters to the
 * version cache.
 */
export async function getCopilotChatVersionOrUndefined(): Promise<
  string | undefined
> {
  const controller = new AbortController()
  const timeout = setTimeout(() => {
    controller.abort()
  }, 5000)

  try {
    const response = await fetch(
      "https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json;api-version=7.1-preview.1",
        },
        body: JSON.stringify({
          filters: [
            {
              criteria: [{ filterType: 7, value: "GitHub.copilot-chat" }],
            },
          ],
          flags: 914,
        }),
        signal: controller.signal,
      },
    )

    if (!response.ok) return undefined

    const data = (await response.json()) as MarketplaceResult
    const version =
      data?.results?.[0]?.extensions?.[0]?.versions?.[0]?.version

    return version
  } catch {
    return undefined
  } finally {
    clearTimeout(timeout)
  }
}

/** Fallback-substituting wrapper, for callers that just want a version. */
export async function getCopilotChatVersion(): Promise<string> {
  return (await getCopilotChatVersionOrUndefined()) ?? FALLBACK
}
