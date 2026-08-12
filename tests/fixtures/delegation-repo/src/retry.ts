export interface RetryOptions {
  attempts?: number
  delayMs?: number
}

export async function retry<T>(
  operation: (attempt: number) => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const attempts = options.attempts ?? 3
  const delayMs = options.delayMs ?? 10
  let lastError: unknown
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await operation(attempt)
    } catch (error) {
      lastError = error
      if (attempt < attempts) await Bun.sleep(delayMs * attempt)
    }
  }
  throw lastError
}
