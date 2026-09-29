import type { EngineBridge } from './engine-bridge'
import { log as _log } from '../logger'

function log(msg: string, fields?: Record<string, unknown>): void { _log('engine-bridge', msg, fields) }

/**
 * Replies to an `engine_elicitation_request` event. Extracted from
 * engine-bridge.ts (alongside sendCredentialResponse below) to keep the
 * primary class file under the 600-line cap, mirroring
 * engine-bridge-state-sync.ts's extraction pattern.
 */
export function sendElicitationResponse(
  bridge: EngineBridge,
  key: string,
  requestId: string,
  response: Record<string, unknown> | undefined,
  cancelled: boolean,
  declined = false,
): void {
  log('send_elicitation_response', { key, request_id: requestId, cancelled, declined })
  bridge._send({
    cmd: 'elicitation_response',
    key,
    elicitRequestId: requestId,
    elicitResponse: response,
    elicitCancelled: cancelled,
    elicitDeclined: declined,
  })
}

/**
 * Replies to an `engine_credential_request` (FR-05 child 09, SC-9): the
 * engine asking whether a connected client has a credential for one
 * principal's (subject, provider) or (subject, host) scope.
 *
 * Fire-and-forget, like sendElicitationResponse: no RPC result, the engine
 * resolves its own pending wait on receipt. `found: false` (the default
 * when the caller has nothing) is a valid, non-error answer -- distinct
 * from never answering at all, which the engine treats as a timeout.
 */
export function sendCredentialResponse(
  bridge: EngineBridge,
  key: string,
  requestId: string,
  found: boolean,
  token?: string,
  header?: string,
): void {
  log('send_credential_response', { key, request_id: requestId, found })
  bridge._send({
    cmd: 'credential_response',
    key,
    credentialRequestId: requestId,
    credentialFound: found,
    credentialToken: token,
    credentialHeader: header,
  })
}

