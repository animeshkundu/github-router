import {
  GITHUB_APP_SCOPES,
  GITHUB_BASE_URL,
  GITHUB_CLIENT_ID,
  standardHeaders,
} from "~/lib/api-config"
import { HTTPError } from "~/lib/error"
import { fetchWithTransientRetry } from "~/lib/upstream-retry"

export interface DeviceApp {
  clientId: string
  scope: string
}

const DEFAULT_DEVICE_APP: DeviceApp = {
  clientId: GITHUB_CLIENT_ID,
  scope: GITHUB_APP_SCOPES,
}

export async function getDeviceCode(
  app: DeviceApp = DEFAULT_DEVICE_APP,
): Promise<DeviceCodeResponse> {
  // Idempotent device-code bootstrap POST (just requests a fresh code) — a
  // transient 429/5xx/network blip here aborts the whole login flow, so
  // retry the transient class. No auth on this call, so no 401 concern.
  //
  // `app` is parameterized so a SECOND identity (the first-mate write
  // token via the GitHub CLI OAuth client) can reuse this exact flow
  // without a copy-paste fork; defaults preserve the original Copilot
  // App device login.
  const response = await fetchWithTransientRetry(
    () =>
      fetch(`${GITHUB_BASE_URL}/login/device/code`, {
        method: "POST",
        headers: standardHeaders(),
        body: JSON.stringify({
          client_id: app.clientId,
          scope: app.scope,
        }),
      }),
    { label: "/login/device/code" },
  )

  if (!response.ok) throw new HTTPError("Failed to get device code", response)

  return (await response.json()) as DeviceCodeResponse
}

export interface DeviceCodeResponse {
  device_code: string
  user_code: string
  verification_uri: string
  expires_in: number
  interval: number
}
