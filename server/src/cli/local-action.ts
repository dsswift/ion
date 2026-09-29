/**
 * One `studio_action` over this server's own local socket: dial it with the
 * `local` credential (trusted for same-machine processes, every scope), wait
 * for the welcome, send the action, and return its value. The server CLIs
 * (`pair.js`, `clients.js`) are callers for hosts with no Studio client.
 */
import { randomUUID } from 'crypto'
import { hostname } from 'os'
import { dialLocalStudio, type LocalStudioTarget } from '../local-studio-socket'
import { PROTOCOL_VERSION } from '@ion/shared/studio-wire/version'
import { encodeFrame, decodeFrame } from '@ion/shared/studio-wire/codec'
import type { StudioFrame } from '@ion/shared/studio-wire/types'
import { log as _log, warn as _warn } from '../logger'

export interface LocalActionRequest {
  action: string
  args: unknown[]
  timeoutMs: number
  /** Names the caller in the hello's clientId, e.g. `pair-cli`. */
  caller: string
}

export type LocalActionResult =
  | { ok: true; value: unknown; environmentId: string; environmentLabel: string }
  | { ok: false; error: string }

export function runLocalAction(target: LocalStudioTarget, request: LocalActionRequest): Promise<LocalActionResult> {
  const log = (msg: string, fields?: Record<string, unknown>): void => _log('cli-local-action', msg, { caller: request.caller, ...fields })
  const warn = (msg: string, fields?: Record<string, unknown>): void => _warn('cli-local-action', msg, { caller: request.caller, ...fields })
  return new Promise((resolve) => {
    const socketPath = target.path
    const actionId = randomUUID()
    let settled = false
    let environmentId = ''
    let environmentLabel = ''
    const finish = (result: LocalActionResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        ws.close()
      } catch (err) {
        warn('socket close after result failed', { error: String(err) })
      }
      resolve(result)
    }
    const timer = setTimeout(() => finish({ ok: false, error: `timed out after ${request.timeoutMs}ms waiting for the server at ${socketPath}` }), request.timeoutMs)

    log('dialing local studio socket', { socket_path: socketPath, kind: target.kind, action: request.action })
    const ws = dialLocalStudio(target)
    ws.on('error', (err) => finish({ ok: false, error: `cannot reach the server at ${socketPath}: ${err.message}` }))
    ws.on('close', () => finish({ ok: false, error: 'the server closed the connection before answering' }))
    ws.on('open', () => {
      const hello: StudioFrame = {
        type: 'studio_hello',
        protocolVersion: PROTOCOL_VERSION,
        clientId: `${request.caller}-${hostname()}-${process.pid}`,
        clientKind: 'desktop',
        capabilities: [],
        credential: { kind: 'local' },
      }
      ws.send(encodeFrame(hello))
    })
    ws.on('message', (data, isBinary) => {
      if (isBinary) return
      let frame: StudioFrame
      try {
        frame = decodeFrame(data.toString())
      } catch (err) {
        warn('undecodable frame from server', { error: String(err) })
        return
      }
      if (frame.type === 'studio_refused') {
        finish({ ok: false, error: `server refused the local connection: ${frame.reason}${frame.detail ? ` (${frame.detail})` : ''}` })
        return
      }
      if (frame.type === 'studio_welcome') {
        environmentId = frame.environmentId
        environmentLabel = frame.label
        log('welcomed; sending action', { environment_id: environmentId, action: request.action, scopes: frame.scopes })
        ws.send(encodeFrame({ type: 'studio_action', id: actionId, action: request.action, args: request.args }))
        return
      }
      if (frame.type === 'studio_action_result' && frame.id === actionId) {
        if (!frame.ok) {
          const detail = frame.refusal ? `${frame.refusal.code}: ${frame.refusal.message}` : frame.error ? `${frame.error.code}: ${frame.error.message}` : 'unknown'
          finish({ ok: false, error: `${request.action} refused: ${detail}` })
          return
        }
        log('action answered', { environment_id: environmentId, action: request.action })
        finish({ ok: true, value: frame.value, environmentId, environmentLabel })
      }
    })
  })
}
