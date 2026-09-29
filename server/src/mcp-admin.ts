/**
 * mcp-admin.ts — main-process client for the engine's MCP administration
 * commands.
 *
 * Thin by design. The engine owns every piece of the mechanism (engine.json
 * CRUD, OAuth metadata discovery, dynamic client registration, the PKCE
 * exchange, token storage), so this module only forwards commands and, for
 * login, does the two things the engine deliberately does not: open the
 * operator's browser and wait for the flow to finish.
 *
 * The login shape mirrors oauth/entra-auth.ts `signIn`: ask the engine to begin,
 * open the URL it returns, then poll until the engine reports success. The
 * desktop never sees the authorization code or any token.
 */

import { openAuthUrl, type AuthUrlRequester } from './oauth/url-opener'
import { registerPendingSignIn } from './oauth/pending-sign-ins'
import { engineBridge } from './state'
import { log as _log, warn as _warn } from './logger'
import type { McpServerStatus } from '@ion/shared/types-engine-event'
import type { McpAddRequest, McpUpdateOutcome, McpUpdateRequest } from '@ion/shared/mcp-admin-requests'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('mcp_admin', msg, fields)
}

function warn(msg: string, fields?: Record<string, unknown>): void {
  _warn('mcp_admin', msg, fields)
}

/** Poll cadence and ceiling for the post-browser wait. */
const LOGIN_POLL_MS = 1000
/**
 * Slightly longer than the engine's own 5-minute PKCE deadline, so the engine's
 * more specific timeout is what fires first.
 */
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000 + 15_000

/** List configured servers with their connection and authorization state. */
export async function listServers(): Promise<McpServerStatus[]> {
  const result = await engineBridge.request<{ servers?: McpServerStatus[] }>('mcp_list', {})
  if (!result.ok) {
    throw new Error(result.error ?? 'engine could not list MCP servers')
  }
  const servers = result.data?.servers ?? []
  log('list_servers', { count: servers.length })
  return servers
}

/**
 * Add a server. The engine validates the transport/endpoint combination and
 * enforces enterprise policy, so a refusal here carries its reason.
 */
export async function addServer(request: McpAddRequest): Promise<void> {
  const payload: Record<string, unknown> = { mcpName: request.name }
  if (request.transport) payload.mcpTransport = request.transport
  if (request.url) payload.mcpUrl = request.url
  if (request.command) payload.mcpCommand = request.command
  if (request.args?.length) payload.mcpArgs = request.args
  if (request.headers && Object.keys(request.headers).length > 0) payload.mcpHeaders = request.headers
  if (request.env && Object.keys(request.env).length > 0) payload.mcpEnv = request.env
  if (request.oauth) payload.mcpOAuth = request.oauth

  const result = await engineBridge.request('mcp_add', payload)
  if (!result.ok) {
    throw new Error(result.error ?? `engine could not add MCP server "${request.name}"`)
  }
  log('add_server', { name: request.name, transport: request.transport ?? '(inferred)', oauth_configured: request.oauth !== undefined })
}

/**
 * Change one server, keeping every setting the request does not name. When the
 * url or OAuth client changes, the engine drops the stored sign-in and reports
 * `credentialsCleared`.
 */
export async function updateServer(request: McpUpdateRequest): Promise<McpUpdateOutcome> {
  const payload: Record<string, unknown> = { mcpName: request.name }
  if (request.url) payload.mcpUrl = request.url
  if (request.command) payload.mcpCommand = request.command
  if (request.args) payload.mcpArgs = request.args
  if (request.oauth) payload.mcpOAuth = request.oauth

  const result = await engineBridge.request<{ changed?: boolean; credentialsCleared?: boolean }>('mcp_update', payload)
  if (!result.ok) {
    throw new Error(result.error ?? `engine could not update MCP server "${request.name}"`)
  }
  const outcome: McpUpdateOutcome = { changed: result.data?.changed === true, credentialsCleared: result.data?.credentialsCleared === true }
  log('update_server', { name: request.name, changed: outcome.changed, credentials_cleared: outcome.credentialsCleared })
  return outcome
}

/** Remove a server and its stored credentials. */
export async function removeServer(name: string): Promise<void> {
  const result = await engineBridge.request('mcp_remove', { mcpName: name })
  if (!result.ok) {
    throw new Error(result.error ?? `engine could not remove MCP server "${name}"`)
  }
  log('remove_server', { name })
}

/** Drop a server's stored credentials, leaving its configuration in place. */
export async function logoutServer(name: string): Promise<void> {
  const result = await engineBridge.request('mcp_logout', { mcpName: name })
  if (!result.ok) {
    throw new Error(result.error ?? `engine could not log out of MCP server "${name}"`)
  }
  log('logout_server', { name })
}

export interface McpLoginOptions {
  /** The connection that asked, so a phone gets the URL back instead of a broadcast to every desktop. */
  requester?: AuthUrlRequester
  /**
   * Where the provider sends the browser back to, for a client that finishes
   * the sign-in itself. The engine then starts no loopback listener and waits
   * for `completeMcpLogin` with the address the browser landed on.
   */
  redirectUri?: string
}

/**
 * Authorize a server: ask the engine to begin its PKCE flow, open the returned
 * URL in the system browser, then poll the engine until it reports the server
 * authenticated (or the flow times out).
 *
 * Returns the authorization URL alongside the outcome so a caller can surface it
 * — the browser may open in an unexpected profile, and showing the URL is the
 * difference between a stuck operator and one who can finish by hand.
 *
 * With `redirectUri` it returns at once with the URL and a `flowId`: the
 * requester opens the page itself and hands the final address to
 * `auth.completeSignIn`.
 */
export async function loginServer(name: string, scope?: string, options: McpLoginOptions = {}): Promise<{ authorizationUrl: string; flowId?: string }> {
  const payload: Record<string, unknown> = { mcpName: name }
  if (scope) payload.mcpScope = scope
  if (options.redirectUri) payload.mcpRedirectUri = options.redirectUri

  const begin = await engineBridge.request<{ authorizationUrl?: string }>('mcp_login', payload)
  if (!begin.ok || !begin.data?.authorizationUrl) {
    throw new Error(begin.error ?? `engine did not return an authorization URL for "${name}"`)
  }
  const authorizationUrl = begin.data.authorizationUrl

  if (options.redirectUri) {
    const flowId = registerPendingSignIn({ kind: 'mcp', mcpName: name })
    log('login_begin: returned to the requester to finish', { name, flow_id: flowId, connection_id: options.requester?.id ?? '' })
    return { authorizationUrl, flowId }
  }

  log('login_begin: opening browser', { name })
  try {
    await openAuthUrl(authorizationUrl, options.requester)
  } catch (err) {
    // Not fatal: the caller shows the URL, so the operator can still finish.
    warn('login_begin: could not open browser', {
      name,
      error: err instanceof Error ? err.message : String(err),
    })
  }

  const deadline = Date.now() + LOGIN_TIMEOUT_MS
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, LOGIN_POLL_MS))
    let servers: McpServerStatus[]
    try {
      servers = await listServers()
    } catch (err) {
      // A transient failure mid-poll is "not yet", not fatal; the enclosing
      // deadline bounds the wait.
      log('login_poll: list failed, retrying', {
        name,
        error: err instanceof Error ? err.message : String(err),
      })
      continue
    }
    if (servers.some((s) => s.name === name && s.authenticated)) {
      log('login_complete', { name })
      return { authorizationUrl }
    }
  }

  throw new Error(`Timed out waiting for "${name}" to be authorized`)
}

/**
 * Finish a login begun with a `redirectUri`: the engine checks the address
 * against its pending login, exchanges the code, stores the tokens and
 * reconnects the server.
 */
export async function completeMcpLogin(name: string, callbackUrl: string): Promise<void> {
  const result = await engineBridge.request('mcp_login_complete', { mcpName: name, mcpCallbackUrl: callbackUrl })
  if (!result.ok) {
    warn('login_complete refused by engine', { name, error: result.error ?? '' })
    throw new Error(result.error ?? `engine could not finish the sign-in for "${name}"`)
  }
  log('login_complete: finished by the requester', { name })
}
