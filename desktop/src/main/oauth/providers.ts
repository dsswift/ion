import { readFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { shell } from 'electron'
import { generatePKCE, generateState } from './pkce'
import { startCallbackServer } from './callback-server'
import { log as _log } from '../logger'

function log(msg: string): void { _log('oauth', msg) }

/**
 * Resolve a public OAuth credential from (in priority order):
 *   1. Environment variable (e.g. ION_GOOGLE_CLIENT_ID)
 *   2. ~/.ion/oauth.json  (e.g. { "google": { "clientId": "..." } })
 *
 * These are well-known public client credentials that must ship with the app
 * but cannot be committed as string literals due to GitHub push protection.
 */
function resolveOAuthVar(envKey: string, provider: string, field: string): string {
  const envVal = process.env[envKey]
  if (envVal) return envVal

  try {
    const raw = readFileSync(join(homedir(), '.ion', 'oauth.json'), 'utf-8')
    const parsed = JSON.parse(raw) as Record<string, Record<string, string>>
    const val = parsed?.[provider]?.[field]
    if (val) return val
  } catch {
    // File missing or malformed — fall through
  }

  log(`WARNING: OAuth credential ${envKey} not found in env or ~/.ion/oauth.json`)
  return ''
}

export interface OAuthTokens {
  accessToken: string
  refreshToken: string
  expiresAt: number
}

// ─── OpenAI Codex (ChatGPT subscription) ─────────────────────────

const OPENAI_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
const OPENAI_AUTH_URL = 'https://auth.openai.com/oauth/authorize'
const OPENAI_TOKEN_URL = 'https://auth.openai.com/oauth/token'
const OPENAI_REDIRECT_URI = 'http://localhost:1455/auth/callback'
const OPENAI_SCOPE = 'openid profile email offline_access'

export async function loginOpenAI(): Promise<OAuthTokens> {
  const { verifier, challenge } = generatePKCE()
  const state = generateState()
  const url = new URL(OPENAI_AUTH_URL)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('client_id', OPENAI_CLIENT_ID)
  url.searchParams.set('redirect_uri', OPENAI_REDIRECT_URI)
  url.searchParams.set('scope', OPENAI_SCOPE)
  url.searchParams.set('code_challenge', challenge)
  url.searchParams.set('code_challenge_method', 'S256')
  url.searchParams.set('state', state)
  const server = await startCallbackServer(1455, state)
  try {
    await shell.openExternal(url.toString())
    const result = await server.waitForCode()
    if (!result) throw new Error('OAuth flow cancelled or timed out')
    return exchangeOpenAICode(result.code, verifier)
  } finally {
    server.close()
  }
}

async function exchangeOpenAICode(code: string, verifier: string): Promise<OAuthTokens> {
  const resp = await fetch(OPENAI_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code', client_id: OPENAI_CLIENT_ID,
      code, code_verifier: verifier, redirect_uri: OPENAI_REDIRECT_URI,
    }),
  })
  if (!resp.ok) throw new Error(`OpenAI token exchange failed: ${resp.status}`)
  const json = (await resp.json()) as { access_token?: string; refresh_token?: string; expires_in?: number }
  if (!json.access_token || !json.refresh_token) throw new Error('OpenAI token response missing fields')
  return { accessToken: json.access_token, refreshToken: json.refresh_token, expiresAt: Date.now() + (json.expires_in || 3600) * 1000 }
}

export async function refreshOpenAI(refreshToken: string): Promise<OAuthTokens> {
  const resp = await fetch(OPENAI_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', client_id: OPENAI_CLIENT_ID, refresh_token: refreshToken }),
  })
  if (!resp.ok) throw new Error(`OpenAI token refresh failed: ${resp.status}`)
  const json = (await resp.json()) as { access_token?: string; refresh_token?: string; expires_in?: number }
  if (!json.access_token) throw new Error('OpenAI refresh response missing access_token')
  return { accessToken: json.access_token, refreshToken: json.refresh_token || refreshToken, expiresAt: Date.now() + (json.expires_in || 3600) * 1000 }
}

// ─── Google Gemini CLI (Cloud Code Assist) ────────────────────────
// These are well-known public OAuth credentials from the Gemini CLI project.
// They are safe to ship in a desktop app (public client) but must not be
// committed as string literals because GitHub push protection flags them.
// Set ION_GOOGLE_CLIENT_ID / ION_GOOGLE_CLIENT_SECRET in the environment,
// or they will be read from ~/.ion/oauth.json at runtime.

const GOOGLE_CLIENT_ID = resolveOAuthVar('ION_GOOGLE_CLIENT_ID', 'google', 'clientId')
const GOOGLE_CLIENT_SECRET = resolveOAuthVar('ION_GOOGLE_CLIENT_SECRET', 'google', 'clientSecret')
const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'
const GOOGLE_REDIRECT_URI = 'http://localhost:8085/oauth2callback'
const GOOGLE_SCOPES = 'https://www.googleapis.com/auth/cloud-platform https://www.googleapis.com/auth/userinfo.email'

export async function loginGoogle(): Promise<OAuthTokens> {
  const { verifier, challenge } = generatePKCE()
  const state = generateState()
  const url = new URL(GOOGLE_AUTH_URL)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('client_id', GOOGLE_CLIENT_ID)
  url.searchParams.set('redirect_uri', GOOGLE_REDIRECT_URI)
  url.searchParams.set('scope', GOOGLE_SCOPES)
  url.searchParams.set('code_challenge', challenge)
  url.searchParams.set('code_challenge_method', 'S256')
  url.searchParams.set('state', state)
  url.searchParams.set('access_type', 'offline')
  url.searchParams.set('prompt', 'consent')
  const server = await startCallbackServer(8085, state)
  try {
    await shell.openExternal(url.toString())
    const result = await server.waitForCode()
    if (!result) throw new Error('Google OAuth flow cancelled or timed out')
    return exchangeGoogleCode(result.code, verifier)
  } finally {
    server.close()
  }
}

async function exchangeGoogleCode(code: string, verifier: string): Promise<OAuthTokens> {
  const resp = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code', client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET, code,
      code_verifier: verifier, redirect_uri: GOOGLE_REDIRECT_URI,
    }),
  })
  if (!resp.ok) throw new Error(`Google token exchange failed: ${resp.status}`)
  const json = (await resp.json()) as { access_token?: string; refresh_token?: string; expires_in?: number }
  if (!json.access_token) throw new Error('Google token response missing access_token')
  return { accessToken: json.access_token, refreshToken: json.refresh_token || '', expiresAt: Date.now() + (json.expires_in || 3600) * 1000 }
}

export async function refreshGoogle(refreshToken: string): Promise<OAuthTokens> {
  const resp = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', client_id: GOOGLE_CLIENT_ID, client_secret: GOOGLE_CLIENT_SECRET, refresh_token: refreshToken }),
  })
  if (!resp.ok) throw new Error(`Google token refresh failed: ${resp.status}`)
  const json = (await resp.json()) as { access_token?: string; expires_in?: number }
  if (!json.access_token) throw new Error('Google refresh response missing access_token')
  return { accessToken: json.access_token, refreshToken, expiresAt: Date.now() + (json.expires_in || 3600) * 1000 }
}

// ─── GitHub Copilot (Device Code Flow) ────────────────────────────

const GITHUB_CLIENT_ID = 'Iv1.b507a08c87ecfe98'
const COPILOT_HEADERS = {
  'User-Agent': 'GitHubCopilotChat/0.35.0',
  'Editor-Version': 'vscode/1.107.0',
  'Editor-Plugin-Version': 'copilot-chat/0.35.0',
  'Copilot-Integration-Id': 'vscode-chat',
} as const

export interface DeviceCodeInfo {
  userCode: string
  verificationUri: string
  deviceCode: string
  interval: number
  expiresIn: number
}

export async function startGitHubDeviceFlow(): Promise<DeviceCodeInfo> {
  const resp = await fetch('https://github.com/login/device/code', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'GitHubCopilotChat/0.35.0' },
    body: new URLSearchParams({ client_id: GITHUB_CLIENT_ID, scope: 'read:user' }),
  })
  if (!resp.ok) throw new Error(`GitHub device code request failed: ${resp.status}`)
  const data = (await resp.json()) as { device_code: string; user_code: string; verification_uri: string; interval: number; expires_in: number }
  return { deviceCode: data.device_code, userCode: data.user_code, verificationUri: data.verification_uri, interval: data.interval, expiresIn: data.expires_in }
}

export async function pollGitHubAccessToken(deviceCode: string, interval: number, expiresIn: number, signal?: AbortSignal): Promise<string> {
  const deadline = Date.now() + expiresIn * 1000
  let pollMs = Math.max(1000, interval * 1000)
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new Error('Login cancelled')
    await new Promise((resolve) => setTimeout(resolve, pollMs))
    const resp = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'GitHubCopilotChat/0.35.0' },
      body: new URLSearchParams({ client_id: GITHUB_CLIENT_ID, device_code: deviceCode, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' }),
    })
    const data = (await resp.json()) as { access_token?: string; error?: string; interval?: number }
    if (data.access_token) return data.access_token
    if (data.error === 'authorization_pending') continue
    if (data.error === 'slow_down') { pollMs = data.interval ? data.interval * 1000 : pollMs + 5000; continue }
    if (data.error) throw new Error(`GitHub device flow error: ${data.error}`)
  }
  throw new Error('GitHub device flow timed out')
}

export async function exchangeGitHubForCopilotToken(githubAccessToken: string): Promise<OAuthTokens> {
  const resp = await fetch('https://api.github.com/copilot_internal/v2/token', {
    headers: { Accept: 'application/json', Authorization: `Bearer ${githubAccessToken}`, ...COPILOT_HEADERS },
  })
  if (!resp.ok) throw new Error(`Copilot token exchange failed: ${resp.status}`)
  const data = (await resp.json()) as { token?: string; expires_at?: number }
  if (!data.token || !data.expires_at) throw new Error('Invalid Copilot token response')
  return { accessToken: data.token, refreshToken: githubAccessToken, expiresAt: data.expires_at * 1000 - 5 * 60 * 1000 }
}

export async function refreshGitHubCopilot(refreshToken: string): Promise<OAuthTokens> {
  return exchangeGitHubForCopilotToken(refreshToken)
}
