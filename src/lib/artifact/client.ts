export type ArtifactErrorCode =
  | "UNREACHABLE"
  | "AUTH_FAILED"
  | "NOT_FOUND"
  | "TIMEOUT"
  | "UPSTREAM_ERROR"
  | "INVALID_RESPONSE"

export class ArtifactError extends Error {
  code: ArtifactErrorCode
  retryable: boolean
  status?: number
  detail?: unknown

  constructor(args: {
    code: ArtifactErrorCode
    message: string
    retryable: boolean
    status?: number
    detail?: unknown
  }) {
    super(args.message)
    this.name = "ArtifactError"
    this.code = args.code
    this.retryable = args.retryable
    this.status = args.status
    this.detail = args.detail
  }
}

export interface ArtifactClientOptions {
  baseUrl: string
  token: string
  sessionId: string
  fetchFn?: typeof fetch
}

export interface ArtifactOpenResponse {
  sessionId: string
  key: string
  viewUrl: string
}

export interface ArtifactPollResponse {
  status: string
  prompts?: unknown
  layout_warnings?: unknown
  dom_snapshot?: unknown
  next_step?: string
  [key: string]: unknown
}

export interface ArtifactAgentReplyResponse {
  [key: string]: unknown
}

export class ArtifactClient {
  private readonly baseUrl: string
  private readonly token: string
  private readonly sessionId: string
  private readonly fetchFn: typeof fetch

  constructor(options: ArtifactClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "")
    this.token = options.token
    this.sessionId = options.sessionId
    this.fetchFn = options.fetchFn ?? globalThis.fetch.bind(globalThis)
  }

  open(file: string, signal?: AbortSignal): Promise<ArtifactOpenResponse> {
    return this.request(
      "POST",
      `/api/artifact/${encodeURIComponent(this.sessionId)}/open`,
      { file },
      signal,
    )
  }

  poll(timeoutMsHint?: number, signal?: AbortSignal): Promise<ArtifactPollResponse> {
    return this.request(
      "GET",
      `/api/artifact/${encodeURIComponent(this.sessionId)}/poll`,
      undefined,
      signal,
      timeoutMsHint,
    )
  }

  agentReply(text: string, signal?: AbortSignal): Promise<ArtifactAgentReplyResponse> {
    return this.request(
      "POST",
      `/api/artifact/${encodeURIComponent(this.sessionId)}/agent-reply`,
      { text },
      signal,
      undefined,
      true,
    )
  }

  private async request<T>(
    method: "GET" | "POST",
    pathname: string,
    body?: unknown,
    signal?: AbortSignal,
    timeoutMsHint?: number,
    allowEmptyJson = false,
  ): Promise<T> {
    let url: URL
    try {
      url = new URL(pathname, `${this.baseUrl}/`)
    } catch (err) {
      throw new ArtifactError({
        code: "UNREACHABLE",
        message: "artifact API base URL is invalid",
        retryable: false,
        detail: err,
      })
    }
    const timeout = combineSignalAndTimeout(signal, timeoutMsHint)

    let response: Response
    try {
      response = await this.fetchFn(url.toString(), {
        method,
        headers: {
          Authorization: `Bearer ${this.token}`,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: "error",
        signal: timeout.signal,
      })
    } catch (err) {
      throw mapNetworkError(err)
    } finally {
      timeout.cleanup()
    }

    if (!response.ok) {
      throw await mapHttpError(response)
    }

    const text = await response.text().catch((err: unknown) => {
      throw new ArtifactError({
        code: "INVALID_RESPONSE",
        message: "artifact API response body could not be read",
        retryable: false,
        detail: err,
      })
    })
    if (!text && allowEmptyJson) return {} as T
    try {
      return JSON.parse(text) as T
    } catch (err) {
      throw new ArtifactError({
        code: "INVALID_RESPONSE",
        message: "artifact API returned a non-JSON response",
        retryable: false,
        detail: err,
      })
    }
  }
}

function combineSignalAndTimeout(
  signal: AbortSignal | undefined,
  timeoutMsHint: number | undefined,
): { signal?: AbortSignal; cleanup: () => void } {
  const timeoutMs =
    typeof timeoutMsHint === "number" && Number.isFinite(timeoutMsHint) && timeoutMsHint > 0
      ? timeoutMsHint
      : undefined
  if (timeoutMs === undefined) return { signal, cleanup: () => {} }

  const controller = new AbortController()
  const abortFromCaller = (): void => {
    try {
      controller.abort(signal?.reason)
    } catch {
      controller.abort()
    }
  }
  if (signal?.aborted) abortFromCaller()
  signal?.addEventListener("abort", abortFromCaller, { once: true })
  const timer = setTimeout(() => {
    try {
      controller.abort(new DOMException("artifact API request timed out", "TimeoutError"))
    } catch {
      controller.abort()
    }
  }, timeoutMs)

  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer)
      signal?.removeEventListener("abort", abortFromCaller)
    },
  }
}

async function mapHttpError(response: Response): Promise<ArtifactError> {
  const detail = await readErrorDetail(response)
  const upstreamMessage = detailToMessage(detail)
  const suffix = upstreamMessage ? `: ${upstreamMessage}` : ""
  if (response.status === 401 || response.status === 403) {
    return new ArtifactError({
      code: "AUTH_FAILED",
      message: `artifact API authentication failed (${response.status})${suffix}`,
      retryable: false,
      status: response.status,
      detail,
    })
  }
  if (response.status === 404) {
    return new ArtifactError({
      code: "NOT_FOUND",
      message: `artifact session or resource not found (404)${suffix}`,
      retryable: false,
      status: response.status,
      detail,
    })
  }
  if (response.status === 408 || response.status === 504) {
    return new ArtifactError({
      code: "TIMEOUT",
      message: `artifact API request timed out (${response.status})${suffix}`,
      retryable: true,
      status: response.status,
      detail,
    })
  }
  return new ArtifactError({
    code: "UPSTREAM_ERROR",
    message: `artifact API returned HTTP ${response.status}${suffix}`,
    retryable: response.status === 429 || response.status >= 500,
    status: response.status,
    detail,
  })
}

function mapNetworkError(err: unknown): ArtifactError {
  if (isAbortLike(err)) {
    return new ArtifactError({
      code: "TIMEOUT",
      message: "artifact API request timed out or was aborted",
      retryable: true,
      detail: err,
    })
  }
  const message = err instanceof Error ? err.message : String(err)
  return new ArtifactError({
    code: "UNREACHABLE",
    message: `artifact API unreachable: ${message}`,
    retryable: true,
    detail: err,
  })
}

async function readErrorDetail(response: Response): Promise<unknown> {
  const text = await response.text().catch(() => "")
  if (!text) return undefined
  try {
    return JSON.parse(text) as unknown
  } catch {
    return text
  }
}

function detailToMessage(detail: unknown): string | undefined {
  if (typeof detail === "string") return detail
  if (typeof detail !== "object" || detail === null) return undefined
  const record = detail as Record<string, unknown>
  const error = record.error
  if (typeof error === "string") return error
  if (typeof error === "object" && error !== null) {
    const errorRecord = error as Record<string, unknown>
    if (typeof errorRecord.message === "string") return errorRecord.message
    if (typeof errorRecord.code === "string") return errorRecord.code
  }
  if (typeof record.message === "string") return record.message
  return undefined
}

function isAbortLike(err: unknown): boolean {
  return err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError")
}
