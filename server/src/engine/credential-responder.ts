/**
 * Answers the engine's `engine_credential_request` (FR-05 child 09,
 * SC-1/SC-8/SC-9): the engine-asks/client-answers bridge that lets the
 * unified per-principal credential source (principal-source.ts) resolve a
 * credential for a subject the server, not the engine, knows how to
 * authenticate.
 *
 * Unlike the early-stop responder (which must reply within the engine's
 * ~100ms window and therefore cannot do async I/O), a credential request
 * gives the client credentialAskTimeout (5s on the engine side) to answer,
 * which is ample for resolvePrincipalCredential's own resolution (a
 * config-backed lookup plus a `secretstore:` dereference -- no network I/O
 * in the shipped `admin` source).
 */
import type { EngineEvent } from '@ion/shared/types-engine'
import type { EngineBridge } from './engine-bridge'
import { resolvePrincipalCredential } from '../credentials/principal-source'
import { log as _log, warn as _warn } from '../logger'

const TAG = 'credential-responder'
function log(msg: string, fields?: Record<string, unknown>): void { _log(TAG, msg, fields) }
function warn(msg: string, fields?: Record<string, unknown>): void { _warn(TAG, msg, fields) }

type CredentialRequestEvent = Extract<EngineEvent, { type: 'engine_credential_request' }>

/**
 * wireCredentialResponder attaches the responder to the session-plane event
 * stream. Call once at engine-control-plane construction (state.ts),
 * mirroring wireEarlyStopPolicy's registration shape exactly. The returned
 * function detaches the handler (useful for tests).
 */
export function wireCredentialResponder(
  sessionPlane: {
    on(event: 'engine_credential_request', handler: (tabId: string, event: CredentialRequestEvent) => void): void
    off(event: 'engine_credential_request', handler: (tabId: string, event: CredentialRequestEvent) => void): void
  },
  bridge: EngineBridge,
): () => void {
  const handler = (tabId: string, event: CredentialRequestEvent): void => {
    void respond(bridge, tabId, event)
  }
  sessionPlane.on('engine_credential_request', handler)
  return () => sessionPlane.off('engine_credential_request', handler)
}

async function respond(bridge: EngineBridge, tabId: string, event: CredentialRequestEvent): Promise<void> {
  const subject = event.credentialSubject ?? ''
  const axis = event.credentialAxis === 'git'
    ? ({ kind: 'git', host: event.credentialHost ?? '' } as const)
    : ({ kind: 'provider', provider: event.credentialProvider ?? '' } as const)

  try {
    const resolved = await resolvePrincipalCredential({ subject, axis })
    if (!resolved || resolved.value.kind !== 'provider') {
      // No match, or (defensively) a git-axis answer to a provider-axis
      // question (should never happen -- resolvePrincipalCredential only
      // consults sources for the axis it was asked about). Either way,
      // Found:false is the honest answer: "I have nothing", not an error.
      bridge.sendCredentialResponse(tabId, event.credentialRequestId, false)
      return
    }
    log('answering credential_request', { tabId, requestId: event.credentialRequestId, subject, source: resolved.source })
    bridge.sendCredentialResponse(tabId, event.credentialRequestId, true, resolved.value.token, resolved.value.header)
  } catch (err) {
    warn('credential resolution failed; answering not-found', {
      tabId,
      requestId: event.credentialRequestId,
      subject,
      error: String(err),
    })
    bridge.sendCredentialResponse(tabId, event.credentialRequestId, false)
  }
}
