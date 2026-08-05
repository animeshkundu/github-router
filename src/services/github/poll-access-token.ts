import consola from "consola"

import {
  GITHUB_BASE_URL,
  GITHUB_CLIENT_ID,
  standardHeaders,
} from "~/lib/api-config"
import { sleep } from "~/lib/utils"

import type { DeviceCodeResponse } from "./get-device-code"

/**
 * Per-attempt cap for a single device-code poll.
 *
 * Deliberately NOT the shared transient-retry layer: a non-OK response here is
 * the EXPECTED steady state (`authorization_pending` until the user finishes in
 * their browser), so retrying it as a transient fault would just hammer GitHub
 * inside a loop that is already a retry loop with its own interval.
 *
 * What was genuinely missing is a bound on a single attempt. Without a signal a
 * hung socket blocks the loop forever: the `expiresAt` check only runs between
 * attempts, so it can never fire while one attempt is stuck. This caps each
 * attempt so the loop keeps ticking and the expiry bound stays real.
 */
const POLL_ATTEMPT_TIMEOUT_MS = 30_000

export async function pollAccessToken(
  deviceCode: DeviceCodeResponse,
  clientId: string = GITHUB_CLIENT_ID,
): Promise<string> {
  // Interval is in seconds, we need to multiply by 1000 to get milliseconds
  // I'm also adding another second, just to be safe
  const sleepDuration = (deviceCode.interval + 1) * 1000
  consola.debug(`Polling access token with interval of ${sleepDuration}ms`)
  const expiresAt = Date.now() + deviceCode.expires_in * 1000
  // Remembered so a permanent misconfiguration (bad DNS, TLS interception, a
  // blocking proxy) is reported as itself rather than surfacing as a bare
  // "device code expired" after the full window has silently burned.
  let lastFetchError: unknown

  while (Date.now() < expiresAt) {
    let response: Response
    try {
      response = await fetch(`${GITHUB_BASE_URL}/login/oauth/access_token`, {
        method: "POST",
        headers: standardHeaders(),
        body: JSON.stringify({
          client_id: clientId,
          device_code: deviceCode.device_code,
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        }),
        signal: AbortSignal.timeout(POLL_ATTEMPT_TIMEOUT_MS),
      })
    } catch (err) {
      // A timed-out or failed attempt is not fatal — the device code may still
      // be authorized before it expires, so keep polling until it does.
      lastFetchError = err
      consola.debug("Access-token poll attempt failed; retrying:", err)
      if (Date.now() >= expiresAt) break
      await sleep(sleepDuration)
      continue
    }

    // Reaching here means the transport worked, whatever the HTTP status. Clear
    // any earlier transport failure so a transient blip mid-flow cannot make
    // the final message blame the network for a genuine expiry.
    lastFetchError = undefined

    if (!response.ok) {
      consola.error("Failed to poll access token:", await response.text())
      if (Date.now() >= expiresAt) break
      await sleep(sleepDuration)
      continue
    }

    const json = await response.json()
    consola.debug("Polling access token response:", json)

    const { access_token } = json as AccessTokenResponse

    if (access_token) {
      return access_token
    }

    if (Date.now() >= expiresAt) break
    await sleep(sleepDuration)
  }

  // If every attempt failed at the transport layer, the device code almost
  // certainly did NOT expire — the network did. Report that, with the real
  // error as `cause`, so a misconfigured proxy or TLS setup is diagnosable
  // instead of masquerading as a timing problem.
  if (lastFetchError !== undefined) {
    throw new Error(
      "Could not reach GitHub to complete device-code authorization. Check network/proxy/TLS settings and run auth again.",
      { cause: lastFetchError },
    )
  }
  throw new Error("Device code expired. Please run auth again.")
}

interface AccessTokenResponse {
  access_token: string
  token_type: string
  scope: string
}
