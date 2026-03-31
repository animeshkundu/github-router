const FALLBACK = "0.43.2026033101"

interface MarketplaceResult {
  results: Array<{
    extensions: Array<{
      versions: Array<{ version: string }>
    }>
  }>
}

export async function getCopilotChatVersion(): Promise<string> {
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

    if (!response.ok) return FALLBACK

    const data = (await response.json()) as MarketplaceResult
    const version =
      data?.results?.[0]?.extensions?.[0]?.versions?.[0]?.version

    return version ?? FALLBACK
  } catch {
    return FALLBACK
  } finally {
    clearTimeout(timeout)
  }
}
