/**
 * `auth.completeSignIn`: finish a sign-in whose browser half ran on the
 * requesting client. The flow id says what is waiting (`pending-sign-ins.ts`);
 * the callback URL is the address the browser landed on.
 */
import { completeMcpLogin } from '../mcp-admin'
import { completeGoogleRemoteLogin } from './providers'
import { storeTokens } from './token-store'
import { lookupPendingSignIn, releasePendingSignIn } from './pending-sign-ins'
import { log as _log } from '../logger'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('oauth.complete-sign-in', msg, fields)
}

/** Resolves once the credential is stored; throws a message the person can act on. */
export async function completeSignIn(flowId: string, callbackUrl: string): Promise<void> {
  if (!flowId || !callbackUrl) {
    log('completion refused: missing flowId or callbackUrl', { has_flow_id: flowId !== '', has_callback_url: callbackUrl !== '' })
    throw new Error('flowId and callbackUrl are required')
  }
  const found = lookupPendingSignIn(flowId)
  if (!found.ok) {
    log('completion refused: no pending sign-in', { flow_id: flowId, reason: found.reason })
    throw new Error(found.reason === 'expired'
      ? 'That sign-in expired. Start it again.'
      : 'No sign-in is waiting for that flow. Start it again.')
  }
  const flow = found.flow
  switch (flow.kind) {
    case 'mcp':
      await completeMcpLogin(flow.mcpName, callbackUrl)
      break
    case 'google': {
      const tokens = await completeGoogleRemoteLogin(callbackUrl, flow.verifier, flow.state)
      await storeTokens('google', tokens.accessToken, tokens.refreshToken, tokens.expiresAt)
      break
    }
  }
  releasePendingSignIn(flowId)
  log('sign-in completed', { flow_id: flowId, kind: flow.kind })
}
