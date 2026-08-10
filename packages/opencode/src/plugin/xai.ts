import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import { OAUTH_DUMMY_KEY } from "../auth"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { OauthCallbackPage } from "@opencode-ai/core/oauth/page"
import { Global } from "@opencode-ai/core/global"
import { Flock } from "@opencode-ai/core/util/flock"

// Ensure Flock's process-shared lock root is initialized (side effect of Global).
void Global.Path.state

// Cross-process single-flight key. xAI rotates refresh tokens; concurrent
// opencode (or Grok CLI) processes sharing ~/.local/share/opencode/auth.json
// must not each call refresh_token with the same value.
const XAI_OAUTH_REFRESH_LOCK = "xai-oauth-refresh"

// Public Grok-CLI OAuth client.
const CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828"
const TOKEN_URL = "https://auth.x.ai/oauth2/token"
// RFC 8628 device authorization grant. Confirmed exposed by xAI's
// /.well-known/openid-configuration as `device_authorization_endpoint`
// with the matching `urn:ietf:params:oauth:grant-type:device_code` grant
// in `grant_types_supported`. This is the headless / VPS path: no
// loopback callback server, no SSH port forwarding, no inbound firewall
// holes — the user opens the URL on any device with a browser, types
// the short user_code, and the CLI long-polls the token endpoint.
const DEVICE_AUTHORIZATION_URL = "https://auth.x.ai/oauth2/device/code"
const DEVICE_CODE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code"
const SCOPE = "openid profile email offline_access grok-cli:access api:access"

// Bounds for the device-code poll loop. xAI returns `interval` (seconds)
// but we floor it to avoid hammering and we add the spec's slow_down
// increment when xAI explicitly asks us to back off.
const DEVICE_CODE_DEFAULT_INTERVAL_MS = 5_000
const DEVICE_CODE_MIN_INTERVAL_MS = 1_000
const DEVICE_CODE_SLOW_DOWN_INCREMENT_MS = 5_000
const DEVICE_CODE_DEFAULT_EXPIRES_MS = 5 * 60 * 1000
const OAUTH_POLLING_SAFETY_MARGIN_MS = 3_000

// Refresh the access token a little before it actually expires so a single
// long-running tool call doesn't have to recover from a mid-flight 401.
const ACCESS_TOKEN_REFRESH_SKEW_MS = 120_000

interface XaiAuthPluginOptions {
  tokenUrl?: string
  deviceAuthorizationUrl?: string
}

interface TokenResponse {
  access_token: string
  refresh_token: string
  id_token?: string
  token_type?: string
  expires_in?: number
  scope?: string
}

function authHeaders() {
  return {
    "Content-Type": "application/x-www-form-urlencoded",
    Accept: "application/json",
    "User-Agent": `opencode/${InstallationVersion}`,
  }
}

// Parse the `exp` claim out of a JWT access_token without verifying the
// signature. We only use this to decide whether to proactively refresh, never
// to make trust decisions, so unsigned decode is safe. Returns false for
// opaque tokens (no JWT shape), which conservatively skips the proactive
// refresh and lets the 401-on-call path drive the refresh instead.
export function accessTokenIsExpiring(
  token: string | undefined,
  skewMs: number = ACCESS_TOKEN_REFRESH_SKEW_MS,
): boolean {
  if (!token || typeof token !== "string") return false
  const parts = token.split(".")
  if (parts.length < 2) return false
  try {
    let payload = parts[1].replace(/-/g, "+").replace(/_/g, "/")
    while (payload.length % 4 !== 0) payload += "="
    const claims = JSON.parse(Buffer.from(payload, "base64").toString("utf8"))
    if (typeof claims?.exp !== "number") return false
    return claims.exp * 1000 <= Date.now() + Math.max(0, skewMs)
  } catch {
    return false
  }
}

async function refreshAccessToken(refreshToken: string, options: XaiAuthPluginOptions = {}): Promise<TokenResponse> {
  const response = await fetch(options.tokenUrl ?? TOKEN_URL, {
    method: "POST",
    headers: authHeaders(),
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: CLIENT_ID,
    }).toString(),
  })
  if (!response.ok) {
    const detail = await response.text().catch(() => "")
    throw new Error(`xAI token refresh failed (${response.status})${detail ? `: ${detail}` : ""}`)
  }
  return response.json() as Promise<TokenResponse>
}

export interface DeviceCodeResponse {
  device_code: string
  user_code: string
  verification_uri: string
  verification_uri_complete?: string
  expires_in?: number
  interval?: number
}

interface DeviceTokenErrorBody {
  error?: string
  error_description?: string
}

export async function requestDeviceCode(options: XaiAuthPluginOptions = {}): Promise<DeviceCodeResponse> {
  const response = await fetch(options.deviceAuthorizationUrl ?? DEVICE_AUTHORIZATION_URL, {
    method: "POST",
    headers: authHeaders(),
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      scope: SCOPE,
      referrer: "opencode",
    }).toString(),
  })
  if (!response.ok) {
    const detail = await response.text().catch(() => "")
    throw new Error(`xAI device code request failed (${response.status})${detail ? `: ${detail}` : ""}`)
  }
  const json = (await response.json()) as DeviceCodeResponse
  if (!json.device_code || !json.user_code || !json.verification_uri) {
    throw new Error("xAI device code response is missing device_code / user_code / verification_uri")
  }
  return json
}

// Default sleep used between device-code polls. Test-injectable so we can
// exercise authorization_pending / slow_down branches without real waits.
async function defaultSleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms))
}

// Normalize a server-supplied seconds value to milliseconds, falling back to
// the supplied default when the input is missing, non-positive, or not a
// finite number. Defends the polling loop against garbage like `NaN`, `"NaN"`,
// `null`, or `-5` from a misbehaving device-code endpoint — without this,
// a NaN interval would slip through `?? default` (NaN is typeof number),
// reach `setTimeout(_, NaN)` which is treated as 0, and busy-loop until the
// hard deadline. Matches the defensive normalization Codex uses for the same
// field (`parseInt(deviceData.interval) || 5`).
function positiveSecondsToMs(value: unknown, defaultMs: number): number {
  const seconds = Number(value)
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : defaultMs
}

export async function pollDeviceCodeToken(
  device: DeviceCodeResponse,
  options: XaiAuthPluginOptions & { sleep?: (ms: number) => Promise<void>; now?: () => number } = {},
): Promise<TokenResponse> {
  const sleep = options.sleep ?? defaultSleep
  const now = options.now ?? (() => Date.now())
  const expiresInMs = positiveSecondsToMs(device.expires_in, DEVICE_CODE_DEFAULT_EXPIRES_MS)
  const deadline = now() + expiresInMs
  let intervalMs = Math.max(
    positiveSecondsToMs(device.interval, DEVICE_CODE_DEFAULT_INTERVAL_MS),
    DEVICE_CODE_MIN_INTERVAL_MS,
  )

  while (now() < deadline) {
    const response = await fetch(options.tokenUrl ?? TOKEN_URL, {
      method: "POST",
      headers: authHeaders(),
      body: new URLSearchParams({
        grant_type: DEVICE_CODE_GRANT_TYPE,
        client_id: CLIENT_ID,
        device_code: device.device_code,
      }).toString(),
    })
    if (response.ok) return (await response.json()) as TokenResponse

    const body = (await response.json().catch(() => ({}))) as DeviceTokenErrorBody
    const remaining = Math.max(0, deadline - now())
    // RFC 8628 §3.5: authorization_pending = keep polling at the same
    // interval; slow_down = bump the interval by ≥5s and keep polling.
    // Anything else is terminal.
    if (body.error === "authorization_pending") {
      await sleep(Math.min(intervalMs + OAUTH_POLLING_SAFETY_MARGIN_MS, remaining))
      continue
    }
    if (body.error === "slow_down") {
      intervalMs += DEVICE_CODE_SLOW_DOWN_INCREMENT_MS
      await sleep(Math.min(intervalMs + OAUTH_POLLING_SAFETY_MARGIN_MS, remaining))
      continue
    }
    if (body.error === "access_denied" || body.error === "authorization_denied") {
      throw new Error("xAI device authorization was denied")
    }
    if (body.error === "expired_token") {
      throw new Error("xAI device code expired - please re-run login")
    }
    const detail = body.error_description ?? body.error ?? ""
    throw new Error(`xAI device token exchange failed (${response.status})${detail ? `: ${detail}` : ""}`)
  }
  throw new Error("xAI device authorization timed out")
}

interface RefreshResult {
  access: string
  refresh: string
  expires: number
}

type OauthAuth = {
  type: "oauth"
  access: string
  refresh: string
  expires: number
}

export function oauthAccessExpiresSoon(
  auth: { access?: string; expires?: number },
  now: number = Date.now(),
  skewMs: number = ACCESS_TOKEN_REFRESH_SKEW_MS,
): boolean {
  return !auth.expires || auth.expires - now <= skewMs || accessTokenIsExpiring(auth.access, skewMs)
}

async function refreshOauthUnderLock(
  getAuth: () => Promise<{ type: string; access?: string; refresh?: string; expires?: number }>,
  input: PluginInput,
  options: XaiAuthPluginOptions,
): Promise<RefreshResult> {
  return Flock.withLock(XAI_OAUTH_REFRESH_LOCK, async () => {
    const latest = await getAuth()
    if (latest.type !== "oauth" || !latest.refresh || !latest.access) {
      throw new Error("xAI OAuth credentials missing during refresh")
    }
    if (!oauthAccessExpiresSoon(latest)) {
      return {
        access: latest.access,
        refresh: latest.refresh,
        expires: latest.expires ?? Date.now() + 3600_000,
      }
    }

    const refreshToken = latest.refresh
    const tokens = await refreshAccessToken(refreshToken, options)
    const refreshedExpires = Date.now() + (tokens.expires_in ?? 3600) * 1000
    const refreshedRefresh = tokens.refresh_token || refreshToken
    await input.client.auth
      .set({
        path: { id: "xai" },
        body: {
          type: "oauth",
          access: tokens.access_token,
          refresh: refreshedRefresh,
          expires: refreshedExpires,
        },
      })
      .catch(() => {})
    return { access: tokens.access_token, refresh: refreshedRefresh, expires: refreshedExpires }
  })
}

export async function XaiAuthPlugin(input: PluginInput, options: XaiAuthPluginOptions = {}): Promise<Hooks> {
  return {
    auth: {
      provider: "xai",
      async loader(getAuth) {
        const auth = await getAuth()
        if (auth.type !== "oauth") return {}

        // In-process single-flight: collapse concurrent fetches from this
        // loaded provider onto one refresh path. Cross-process single-flight
        // is handled inside refreshOauthUnderLock via Flock.
        let refreshPromise: Promise<RefreshResult> | undefined

        return {
          // Dummy bearer keeps the AI SDK from bailing on "missing apiKey"; the
          // real OAuth token is injected by the fetch override below.
          // We intentionally do NOT set baseURL — @ai-sdk/xai already defaults
          // to https://api.x.ai/v1 and overriding here would silently route
          // around a user-configured gateway.
          apiKey: OAUTH_DUMMY_KEY,
          async fetch(requestInput: RequestInfo | URL, init?: RequestInit) {
            let currentAuth = await getAuth()
            // Auth can flip from oauth to api mid-session (user re-runs
            // /connect with a pasted key). When that happens, pass the
            // request through untouched so the AI SDK's own apiKey-based
            // Authorization header reaches xAI unmodified.
            if (currentAuth.type !== "oauth") return fetch(requestInput, init)

            // In-process single-flight: collapse concurrent fetches from this
            // loaded provider onto one refresh path. Cross-process single-flight
            // is handled inside refreshOauthUnderLock via Flock.
            if (oauthAccessExpiresSoon(currentAuth)) {
              if (!refreshPromise) {
                refreshPromise = refreshOauthUnderLock(getAuth, input, options).finally(() => {
                  refreshPromise = undefined
                })
              }
              const refreshed = await refreshPromise
              currentAuth = { ...currentAuth, ...refreshed } as OauthAuth
            }

            // Copy the caller's headers into a fresh Headers (case-insensitive)
            // so we never mutate the RequestInit the AI SDK may reuse on retry.
            // Headers.set overwrites case-insensitively, which kills the dummy
            // bearer the AI SDK injected from apiKey in a single line.
            const headers = new Headers(requestInput instanceof Request ? requestInput.headers : undefined)
            if (init?.headers) {
              const entries =
                init.headers instanceof Headers
                  ? init.headers.entries()
                  : Array.isArray(init.headers)
                    ? init.headers
                    : Object.entries(init.headers as Record<string, string | undefined>)
              for (const [key, value] of entries) {
                if (value !== undefined) headers.set(key, String(value))
              }
            }
            headers.set("authorization", `Bearer ${currentAuth.access}`)
            headers.set("User-Agent", `opencode/${InstallationVersion}`)

            return fetch(requestInput, { ...init, headers })
          },
        }
      },
      methods: [
        {
          // RFC 8628 device-code flow. The CLI prints a verification URL
          // and a short user_code that the user enters in a browser on
          // any device. No loopback callback server runs on the CLI host,
          // so this works on VPS / SSH / Docker / CI / WSL / any
          // environment where 127.0.0.1:56121 isn't reachable from the
          // user's browser. Defends the only attack surface (the polling
          // loop) with the standard authorization_pending / slow_down
          // backoff and a hard deadline from xAI's `expires_in`.
          label: "SuperGrok Subscription",
          type: "oauth",
          authorize: async () => {
            const device = await requestDeviceCode(options)
            const browserUrl = device.verification_uri_complete ?? device.verification_uri
            return {
              url: browserUrl,
              instructions: `Open ${device.verification_uri} on any device and enter code: ${device.user_code}`,
              method: "auto" as const,
              callback: async () => {
                try {
                  const tokens = await pollDeviceCodeToken(device, options)
                  return {
                    type: "success" as const,
                    refresh: tokens.refresh_token,
                    access: tokens.access_token,
                    expires: Date.now() + (tokens.expires_in ?? 3600) * 1000,
                  }
                } catch (err) {
                  return { type: "failed" as const }
                }
              },
            }
          },
        },
        {
          label: "Manually enter API Key",
          type: "api",
        },
      ],
    },
  }
}
