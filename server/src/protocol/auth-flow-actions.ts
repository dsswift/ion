/**
 * `oauth.*` / `entra.*` / `mcp.*` `studio_action`s — the interactive auth
 * flows on the wire.
 *
 * These were the last domain reachable only through Electron IPC, because
 * their implementations lived in `desktop/src/main/oauth/` and
 * `desktop/src/main/mcp-admin.ts` and called `shell.openExternal` directly.
 * They now live in `server/src/oauth/` and `server/src/mcp-admin.ts` and go
 * through `oauth/url-opener.ts`, so the FLOW is host-agnostic and only the
 * act of showing a page differs per host.
 *
 * ── Scope ───────────────────────────────────────────────────────────────
 * Identity and server-list reads are `conversations:read`. Everything that
 * stores or clears a credential is `admin`: these credentials belong to the
 * ENVIRONMENT's engine, so signing in changes what every other client of
 * that Environment can reach, exactly like `provider.storeCredential`.
 */
import type { Scope } from '@ion/shared/studio-wire/types'
import {
  loginGoogle,
  beginGoogleRemoteLogin,
  startGitHubDeviceFlow,
  pollGitHubAccessToken,
  exchangeGitHubForCopilotToken,
  storeTokens,
  clearTokens,
} from '../oauth'
import { signIn as entraSignIn, beginDeviceSignIn as entraBeginDeviceSignIn, signOut as entraSignOut, getSignedInIdentity, getOperatorIdentityState, getAccessToken } from '../oauth/entra-flow'
import { isLocalDesktop } from './lifecycle-actions'
import { addServer, listServers, loginServer, logoutServer, removeServer, updateServer } from '../mcp-admin'
import { registerPendingSignIn } from '../oauth/pending-sign-ins'
import { completeSignIn } from '../oauth/complete-sign-in'
import { connectionOnHost } from './hello'
import { log as _log, warn as _warn } from '../logger'
import type { Connection } from './connection'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('auth-flow-actions', msg, fields)
}
function warn(msg: string, fields?: Record<string, unknown>): void {
  _warn('auth-flow-actions', msg, fields)
}

export interface AuthFlowActionSpec {
  requiredScope: Scope
  /** Set when the handler refuses every caller but the local desktop (`local_only`). */
  localOnly?: true
  handler: (conn: Connection, args: unknown[]) => Promise<{ ok: true; value: unknown } | { ok: false; error: { code: string; message: string } }>
}

function wrap(name: string, requiredScope: Scope, run: (args: unknown[], conn: Connection) => unknown | Promise<unknown>): AuthFlowActionSpec {
  return {
    requiredScope,
    handler: async (conn, args) => {
      try {
        return { ok: true, value: (await run(args, conn)) ?? null }
      } catch (err) {
        warn('auth flow action threw', { connection_id: conn.id, action: name, error: String(err) })
        return { ok: false, error: { code: 'auth_flow_failed', message: String(err) } }
      }
    },
  }
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const num = (v: unknown, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback)

/**
 * In-flight redirect flows, so a second `oauth.start` for the same provider
 * cancels the first rather than racing it. Keyed by provider, matching the
 * IPC path's own map: one Environment has one credential per provider, so a
 * second attempt is always a replacement.
 */
const activeFlows = new Map<string, AbortController>()

export const AUTH_FLOW_ACTIONS: Record<string, AuthFlowActionSpec> = {
  'oauth.start': wrap('oauth.start', 'admin', async (a, conn) => {
    const provider = str((a[0] as { provider?: unknown })?.provider)
    log('oauth start', { provider, connection_id: conn.id, on_host: connectionOnHost(conn) })
    // Google's public client only redirects to its loopback address on this
    // host. A requester elsewhere opens the page itself and pastes the
    // address it lands on into `auth.completeSignIn`.
    if (provider === 'google' && !connectionOnHost(conn)) {
      const begun = beginGoogleRemoteLogin()
      const flowId = registerPendingSignIn({ kind: 'google', verifier: begun.verifier, state: begun.state })
      log('oauth start: google returned to an off-host requester to finish', { connection_id: conn.id, flow_id: flowId })
      return { ok: true, authorizationUrl: begun.authorizationUrl, flowId }
    }
    activeFlows.get(provider)?.abort()
    const controller = new AbortController()
    activeFlows.set(provider, controller)
    try {
      let tokens: { accessToken: string; refreshToken: string; expiresAt: number }
      let authorizationUrl: string | undefined
      switch (provider) {
        case 'google': {
          const result = await loginGoogle(conn)
          tokens = result
          authorizationUrl = result.authorizationUrl
          break
        }
        case 'github-copilot': {
          const device = await startGitHubDeviceFlow()
          const ghToken = await pollGitHubAccessToken(device.deviceCode, device.interval, device.expiresIn, controller.signal)
          tokens = await exchangeGitHubForCopilotToken(ghToken)
          break
        }
        default:
          return { ok: false, error: `Unknown OAuth provider: ${provider}` }
      }
      await storeTokens(provider, tokens.accessToken, tokens.refreshToken, tokens.expiresAt)
      return authorizationUrl ? { ok: true, authorizationUrl } : { ok: true }
    } catch (err) {
      log('oauth failed', { provider, error: (err as Error).message })
      return { ok: false, error: (err as Error).message }
    } finally {
      activeFlows.delete(provider)
    }
  }),
  'oauth.logout': wrap('oauth.logout', 'admin', async (a) => {
    const provider = str((a[0] as { provider?: unknown })?.provider)
    log('oauth logout', { provider })
    await clearTokens(provider)
    return { ok: true }
  }),
  'oauth.deviceCode': wrap('oauth.deviceCode', 'admin', async (a) => {
    const provider = str((a[0] as { provider?: unknown })?.provider)
    if (provider !== 'github-copilot') return { ok: false, error: 'Device code flow only for github-copilot' }
    const device = await startGitHubDeviceFlow()
    return { ok: true, ...device }
  }),
  'oauth.devicePoll': wrap('oauth.devicePoll', 'admin', async (a) => {
    const p = (a[0] ?? {}) as { deviceCode?: unknown; interval?: unknown; expiresIn?: unknown }
    const controller = new AbortController()
    try {
      const ghToken = await pollGitHubAccessToken(str(p.deviceCode), num(p.interval, 5), num(p.expiresIn, 900), controller.signal)
      const tokens = await exchangeGitHubForCopilotToken(ghToken)
      await storeTokens('github-copilot', tokens.accessToken, tokens.refreshToken, tokens.expiresAt)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  }),

  'entra.identity': wrap('entra.identity', 'conversations:read', async () => ({ identity: await getSignedInIdentity() })),
  // Whether the Environment requires a signed-in operator, and whether one is
  // signed in: the desktop's startup gate reads this before revealing Studio.
  'entra.operatorIdentityState': wrap('entra.operatorIdentityState', 'conversations:read', () => getOperatorIdentityState()),
  // An access token for the configured telemetry scope, minted by the
  // engine. Local desktop only: it authorises the desktop's own log egress,
  // and a visiting client has no business holding this Environment's token.
  'entra.accessToken': {
    requiredScope: 'admin',
    localOnly: true,
    handler: async (conn) => {
      if (!isLocalDesktop(conn)) {
        warn('entra.accessToken refused: local desktop only', { connection_id: conn.id, transport: conn.transport, client_kind: conn.clientKind })
        return { ok: false, error: { code: 'local_only', message: 'entra.accessToken is only available to the local desktop' } }
      }
      try {
        return { ok: true, value: { token: await getAccessToken() } }
      } catch (err) {
        warn('entra.accessToken failed', { connection_id: conn.id, error: String(err) })
        return { ok: false, error: { code: 'action_failed', message: String(err) } }
      }
    },
  },
  // [{ flow: 'device' }?]. The device flow answers at once with a code to
  // enter at the provider's page, for a person who is not at the host; the
  // default flow finishes on the engine's loopback listener here.
  'entra.signIn': wrap('entra.signIn', 'admin', async (a, conn) => {
    const flow = (a[0] as { flow?: unknown } | undefined)?.flow === 'device' ? 'device' : 'pkce'
    log('entra sign-in requested', { connection_id: conn.id, flow })
    try {
      if (flow === 'device') return { ok: true, ...(await entraBeginDeviceSignIn()) }
      const { identity, authorizationUrl } = await entraSignIn(conn)
      log('entra sign-in succeeded', { user: identity.user })
      return { ok: true, identity, authorizationUrl }
    } catch (err) {
      log('entra sign-in failed', { connection_id: conn.id, flow, error: (err as Error).message })
      return { ok: false, error: (err as Error).message }
    }
  }),
  'entra.signOut': wrap('entra.signOut', 'admin', async () => {
    log('entra sign-out requested')
    try {
      await entraSignOut()
      return { ok: true }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  }),

  'mcp.list': wrap('mcp.list', 'conversations:read', async () => {
    try {
      return { ok: true, servers: await listServers() }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  }),
  'mcp.add': wrap('mcp.add', 'admin', async (a) => {
    try {
      await addServer(a[0] as Parameters<typeof addServer>[0])
      return { ok: true }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  }),
  'mcp.update': wrap('mcp.update', 'admin', async (a) => {
    try {
      return { ok: true, ...(await updateServer(a[0] as Parameters<typeof updateServer>[0])) }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  }),
  'mcp.remove': wrap('mcp.remove', 'admin', async (a) => {
    try {
      await removeServer(str(a[0]))
      return { ok: true }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  }),
  // [name, scope?, { redirectUri }?]. With a redirectUri the requester
  // finishes the sign-in itself: the answer is `{ authorizationUrl, flowId }`
  // at once, and the landing address goes to `auth.completeSignIn`.
  'mcp.login': wrap('mcp.login', 'admin', async (a, conn) => {
    const redirectUri = str((a[2] as { redirectUri?: unknown } | null | undefined)?.redirectUri)
    try {
      return { ok: true, ...(await loginServer(str(a[0]), str(a[1]) || undefined, { requester: conn, redirectUri: redirectUri || undefined })) }
    } catch (err) {
      log('mcp login failed', { connection_id: conn.id, name: str(a[0]), error: (err as Error).message })
      return { ok: false, error: (err as Error).message }
    }
  }),
  // [{ flowId, callbackUrl }]: the address the browser landed on after a
  // sign-in this server handed back to its requester (`mcp.login` with a
  // redirectUri, `oauth.start` for Google off the host).
  'auth.completeSignIn': wrap('auth.completeSignIn', 'admin', async (a, conn) => {
    const p = (a[0] ?? {}) as { flowId?: unknown; callbackUrl?: unknown }
    try {
      await completeSignIn(str(p.flowId), str(p.callbackUrl))
      log('sign-in completed by requester', { connection_id: conn.id, flow_id: str(p.flowId) })
      return { ok: true }
    } catch (err) {
      log('sign-in completion failed', { connection_id: conn.id, flow_id: str(p.flowId), error: (err as Error).message })
      return { ok: false, error: (err as Error).message }
    }
  }),
  'mcp.logout': wrap('mcp.logout', 'admin', async (a) => {
    try {
      await logoutServer(str(a[0]))
      return { ok: true }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  }),
}
