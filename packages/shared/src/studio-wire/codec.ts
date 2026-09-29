/**
 * The Studio wire codec (manifest contract C3).
 *
 * Text frames are JSON-encoded `StudioFrame`s. `decodeFrame` throws
 * `WireError` on an unknown `type` or a shape that doesn't match its type —
 * callers (the server's connection handler, the desktop's wire client) close
 * the socket with `protocol` on that error rather than propagating a
 * malformed frame into the rest of the system.
 *
 * Binary frames carry a 1-byte channel header, a 2-byte big-endian key
 * length, the UTF-8 key bytes, then the raw payload — never base64 (the
 * whole point of a binary frame is to avoid the ~33% base64 blow-up on
 * terminal output). The "key" is the terminal identity (`tabId:instanceId`)
 * for `TERMINAL_DATA`/`TERMINAL_RESIZE`; a file-transfer id for `FILE_CHUNK`.
 */
import { BinaryChannel, isBinaryChannel } from './channels'
import type { StudioFrame, StudioFrameType } from './types'

export class WireError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WireError'
  }
}

const FRAME_TYPES: ReadonlySet<StudioFrameType> = new Set([
  'studio_hello',
  'studio_welcome',
  'studio_refused',
  'studio_action',
  'studio_action_result',
  'studio_event',
  'studio_command',
  'studio_command_result',
  'studio_snapshot',
  'studio_reauth',
  'studio_environment_policy',
  'studio_snapshot_request',
  'studio_body_request',
  'studio_body',
  'studio_ping',
  'studio_pong',
  'studio_close',
])

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function isString(v: unknown): v is string {
  return typeof v === 'string'
}

function isNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every(isString)
}

/**
 * Per-type shape validation, one guard per `StudioFrame` member. Deliberately
 * hand-rolled rather than a schema library — `packages/shared` has no
 * runtime-validation dependency today (see the shared `package.json`), and a
 * flat set of field-presence/type checks is easy to keep in lockstep with
 * `types.ts` by hand for a union this size.
 */
const VALIDATORS: Record<StudioFrameType, (obj: Record<string, unknown>) => boolean> = {
  studio_hello: (o) =>
    isNumber(o.protocolVersion) &&
    isString(o.clientId) &&
    (o.clientKind === 'desktop' || o.clientKind === 'web' || o.clientKind === 'mobile-bridge' || o.clientKind === 'mobile') &&
    (o.view === undefined || o.view === 'mirror' || o.view === 'thin') &&
    isStringArray(o.capabilities) &&
    isPlainObject(o.credential) &&
    isString(o.credential.kind) &&
    ['local', 'paired', 'bearer', 'session'].includes(o.credential.kind as string),
  studio_welcome: (o) =>
    isNumber(o.protocolVersion) &&
    isString(o.environmentId) &&
    isString(o.label) &&
    isString(o.platform) &&
    isString(o.serverVersion) &&
    isString(o.engineVersion) &&
    isStringArray(o.capabilities) &&
    isPlainObject(o.principal) &&
    isString((o.principal as Record<string, unknown>).subject) &&
    isStringArray(o.scopes) &&
    (o.enterprisePolicy === null || isPlainObject(o.enterprisePolicy)) &&
    isStringArray(o.settingsHiddenGroups) &&
    isPlainObject(o.snapshot),
  studio_refused: (o) =>
    isString(o.reason) &&
    ['protocol_version', 'unauthorized', 'not_ready', 'engine_incompatible', 'duplicate_client', 'scope'].includes(
      o.reason as string,
    ),
  studio_action: (o) => isString(o.id) && isString(o.action) && Array.isArray(o.args),
  studio_action_result: (o) => isString(o.id) && typeof o.ok === 'boolean',
  studio_event: (o) => isString(o.channel) && 'payload' in o,
  studio_command: (o) => isString(o.id) && isString(o.command) && 'args' in o && isNumber(o.timeoutMs),
  studio_command_result: (o) => isString(o.id) && typeof o.ok === 'boolean',
  studio_snapshot: (o) => isPlainObject(o.snapshot),
  studio_reauth: (o) =>
    isPlainObject(o.credential) && o.credential.kind === 'bearer' && isString((o.credential as Record<string, unknown>).token),
  studio_environment_policy: (o) =>
    (o.enterprisePolicy === null || isPlainObject(o.enterprisePolicy)) &&
    isStringArray(o.settingsHiddenGroups) &&
    isString(o.policyHash),
  studio_snapshot_request: () => true,
  studio_body_request: (o) => isString(o.tabId) && (o.before === undefined || isString(o.before)) && (o.limit === undefined || (typeof o.limit === 'number' && Number.isFinite(o.limit))),
  studio_body: (o) => isString(o.tabId) && Array.isArray(o.rows),
  studio_ping: (o) => isString(o.nonce) && isNumber(o.t),
  studio_pong: (o) => isString(o.nonce) && isNumber(o.t),
  studio_close: (o) =>
    isString(o.reason) && ['slow_client', 'token_expired', 'revoked', 'shutdown', 'engine_lost', 'displaced'].includes(o.reason as string),
}

/** Parse and validate one text frame. Throws `WireError` on any malformed input. */
export function decodeFrame(text: string): StudioFrame {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (err) {
    throw new WireError(`studio wire frame is not valid JSON: ${String(err)}`)
  }
  if (!isPlainObject(parsed)) throw new WireError('studio wire frame must be a JSON object')
  const type = parsed.type
  if (!isString(type) || !FRAME_TYPES.has(type as StudioFrameType)) {
    throw new WireError(`studio wire frame has unknown type: ${String(type)}`)
  }
  const validate = VALIDATORS[type as StudioFrameType]
  if (!validate(parsed)) {
    throw new WireError(`studio wire frame of type ${type} failed shape validation`)
  }
  return parsed as StudioFrame
}

/** Serialize one frame to its wire text form. */
export function encodeFrame(frame: StudioFrame): string {
  return JSON.stringify(frame)
}

/** One decoded binary frame. */
export interface DecodedBinaryFrame {
  channel: BinaryChannel
  key: string
  payload: Uint8Array
}

/**
 * `[1 byte channel][2 bytes keyLen BE][keyLen bytes utf8 key][payload bytes]`
 */
export function encodeBinary(channel: BinaryChannel, key: string, payload: Uint8Array): Uint8Array {
  const keyBytes = new TextEncoder().encode(key)
  if (keyBytes.length > 0xffff) throw new WireError(`studio wire binary key too long: ${keyBytes.length} bytes`)
  const out = new Uint8Array(1 + 2 + keyBytes.length + payload.length)
  out[0] = channel
  out[1] = (keyBytes.length >> 8) & 0xff
  out[2] = keyBytes.length & 0xff
  out.set(keyBytes, 3)
  out.set(payload, 3 + keyBytes.length)
  return out
}

export function decodeBinary(buf: Uint8Array): DecodedBinaryFrame {
  if (buf.length < 3) throw new WireError('studio wire binary frame shorter than the 3-byte header')
  const channel = buf[0]
  if (!isBinaryChannel(channel)) throw new WireError(`studio wire binary frame has unknown channel: ${channel}`)
  const keyLen = (buf[1] << 8) | buf[2]
  if (buf.length < 3 + keyLen) throw new WireError('studio wire binary frame shorter than its declared key length')
  const key = new TextDecoder().decode(buf.subarray(3, 3 + keyLen))
  const payload = buf.subarray(3 + keyLen)
  return { channel, key, payload }
}
