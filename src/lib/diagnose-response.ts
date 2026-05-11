import consola from "consola"

const PREVIEW_LIMIT = 200

export async function parseJsonOrDiagnose<T = unknown>(
  response: Response,
  routePath: string,
): Promise<T> {
  const cloned = response.clone()
  try {
    return (await response.json()) as T
  } catch (error) {
    const contentType = response.headers.get("content-type") ?? "(none)"
    const bodyText = await cloned.text().catch(() => "(unreadable)")
    const preview =
      bodyText.length > PREVIEW_LIMIT
        ? bodyText.slice(0, PREVIEW_LIMIT) + "...(truncated)"
        : bodyText
    consola.error(
      `Upstream JSON parse failed at ${routePath}: status=${response.status} content-type="${contentType}" body[0..${PREVIEW_LIMIT}]=${JSON.stringify(preview)}`,
    )
    throw error
  }
}
