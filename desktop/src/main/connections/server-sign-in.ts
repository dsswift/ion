/**
 * server-sign-in -- signs the person in to a server's own sign-in app, the
 * one its `/auth/config` names, and returns an access token for that server.
 *
 * The desktop's own identity (the local engine's) is for this machine's
 * tenant and app. A server elsewhere names its own issuer and app, and Entra
 * gives the person a different subject in every app, so the token has to be
 * minted by the app the server trusts, exactly as the phone and the server's
 * browser sign-in do. Authorization code with PKCE and no secret, returned to
 * a loopback listener (`http://localhost/callback`; Entra ignores the port).
 *
 * A pairing needs the person named once (the paired secret carries the
 * device after that), so `signInToServer` keeps nothing. A Sign in server is
 * reached with a fresh token on every connect, so `signInKeepingRefresh`
 * also asks for a refresh token and `refreshServerToken` redeems it.
 */
import { createServer, type Server } from 'http'
import type { AddressInfo } from 'net'
import { generatePKCE, generateState } from '@ion/shared/oauth-pkce'
import { composeOidcScope } from '@ion/shared/relay-auth-config'
import type { ServerSignIn } from './pairing'
import { log as _log, warn as _warn } from '../logger'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('server-sign-in', msg, fields)
}
function warn(msg: string, fields?: Record<string, unknown>): void {
  _warn('server-sign-in', msg, fields)
}

const SIGN_IN_TIMEOUT_MS = 5 * 60 * 1000

export interface ServerSignInDeps {
  /** Opens the authorization URL in the person's browser. */
  openUrl: (url: string) => Promise<void>
  fetch?: typeof fetch
  timeoutMs?: number
}

export interface ServerTokens {
  accessToken: string
  /** Absent when the provider issued none (the sign-in did not ask for `offline_access`). */
  refreshToken?: string
}

interface Endpoints {
  authorize: string
  token: string
}

async function discover(issuer: string, fetchFn: typeof fetch): Promise<Endpoints> {
  const url = `${issuer.replace(/\/+$/, '')}/.well-known/openid-configuration`
  const res = await fetchFn(url)
  if (!res.ok) throw new Error(`sign-in discovery failed: HTTP ${res.status} from ${url}`)
  const body = (await res.json()) as { authorization_endpoint?: unknown; token_endpoint?: unknown }
  if (typeof body.authorization_endpoint !== 'string' || typeof body.token_endpoint !== 'string') {
    throw new Error(`sign-in discovery at ${url} named no authorization or token endpoint`)
  }
  return { authorize: body.authorization_endpoint, token: body.token_endpoint }
}

/** Resolves with the `code` the browser returns to the loopback listener, checking `state`. */
function awaitCallback(server: Server, state: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('sign-in timed out; the browser never came back')), timeoutMs)
    timer.unref()
    server.on('request', (req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      if (url.pathname !== '/callback') {
        res.writeHead(404).end()
        return
      }
      const reply = (text: string): void => {
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' }).end(text)
      }
      clearTimeout(timer)
      const failure = url.searchParams.get('error')
      if (failure) {
        reply('Sign-in did not complete. You can close this tab.')
        reject(new Error(`sign-in refused: ${failure}${url.searchParams.get('error_description') ? ` (${url.searchParams.get('error_description')})` : ''}`))
        return
      }
      const code = url.searchParams.get('code')
      if (!code || url.searchParams.get('state') !== state) {
        reply('Sign-in did not complete. You can close this tab.')
        reject(new Error('sign-in callback carried no code or the wrong state'))
        return
      }
      reply('Signed in. You can close this tab and return to Ion.')
      resolve(code)
    })
  })
}

/** Posts `form` to the token endpoint and reads the tokens back. Throws with the provider's reason. */
async function redeem(server: ServerSignIn, tokenEndpoint: string, form: Record<string, string>, fetchFn: typeof fetch): Promise<ServerTokens> {
  const res = await fetchFn(tokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form).toString(),
  })
  const body = (await res.json()) as { access_token?: unknown; refresh_token?: unknown; error?: unknown; error_description?: unknown }
  if (!res.ok || typeof body.access_token !== 'string') {
    const reason = typeof body.error_description === 'string' ? body.error_description : typeof body.error === 'string' ? body.error : `HTTP ${res.status}`
    warn('token request failed', { issuer: server.issuer, grant_type: form.grant_type, status: res.status, reason })
    throw new Error(`sign-in token request failed: ${reason}`)
  }
  return { accessToken: body.access_token, ...(typeof body.refresh_token === 'string' ? { refreshToken: body.refresh_token } : {}) }
}

function clientIdFor(server: ServerSignIn): string {
  return server.clientId || server.audience
}

async function interactive(server: ServerSignIn, deps: ServerSignInDeps, keepRefresh: boolean): Promise<ServerTokens> {
  const fetchFn = deps.fetch ?? fetch
  const clientId = clientIdFor(server)
  const scope = `openid ${keepRefresh ? 'offline_access ' : ''}${composeOidcScope(server.audience, server.scope)}`
  const endpoints = await discover(server.issuer, fetchFn)

  const listener = createServer()
  await new Promise<void>((resolve, reject) => {
    listener.once('error', reject)
    listener.listen(0, '127.0.0.1', () => resolve())
  })
  try {
    const redirectUri = `http://localhost:${(listener.address() as AddressInfo).port}/callback`
    const { verifier, challenge } = generatePKCE()
    const state = generateState()
    const authorize = new URL(endpoints.authorize)
    authorize.search = new URLSearchParams({
      client_id: clientId,
      response_type: 'code',
      redirect_uri: redirectUri,
      response_mode: 'query',
      scope,
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      prompt: 'select_account',
    }).toString()
    log('opening the browser to sign in', { issuer: server.issuer, client_id: clientId, scope })
    // Together, so a failure to open the browser and a callback that never comes both reject here.
    const [code] = await Promise.all([
      awaitCallback(listener, state, deps.timeoutMs ?? SIGN_IN_TIMEOUT_MS),
      deps.openUrl(authorize.toString()),
    ])

    const tokens = await redeem(server, endpoints.token, {
      client_id: clientId,
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      code_verifier: verifier,
      scope,
    }, fetchFn)
    log('signed in', { issuer: server.issuer, client_id: clientId, has_refresh: !!tokens.refreshToken })
    return tokens
  } finally {
    listener.close()
  }
}

/** Signs in interactively and returns an access token for `server`, keeping nothing. Throws with a readable reason on every failure. */
export async function signInToServer(server: ServerSignIn, deps: ServerSignInDeps): Promise<string> {
  return (await interactive(server, deps, false)).accessToken
}

/** Signs in interactively and also asks for a refresh token, for a server reached with a token on every connect. */
export function signInKeepingRefresh(server: ServerSignIn, deps: ServerSignInDeps): Promise<ServerTokens> {
  return interactive(server, deps, true)
}

/** Redeems `refreshToken` for a new access token (and the rotated refresh token). No browser. */
export async function refreshServerToken(server: ServerSignIn, refreshToken: string, deps: Pick<ServerSignInDeps, 'fetch'> = {}): Promise<ServerTokens> {
  const fetchFn = deps.fetch ?? fetch
  const endpoints = await discover(server.issuer, fetchFn)
  const tokens = await redeem(server, endpoints.token, {
    client_id: clientIdFor(server),
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    scope: `openid offline_access ${composeOidcScope(server.audience, server.scope)}`,
  }, fetchFn)
  log('token refreshed', { issuer: server.issuer, client_id: clientIdFor(server) })
  return { accessToken: tokens.accessToken, refreshToken: tokens.refreshToken ?? refreshToken }
}
