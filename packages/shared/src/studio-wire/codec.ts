/**
 * The Studio wire codec (manifest contract C3).
 *
 * Text frames are JSON-encoded `StudioFrame`s. `decodeFrame` throws
 * `WireError` on an unknown `type` or a shape that doesn't match its type —
 * callers (the server's connection handler, the desktop's wire client) never
 * pass a malformed frame into the rest of the system. The error names the
 * frame type and the first field that failed, so a log line says what the
 * two sides disagree on.
 *
 * Binary frames carry a 1-byte channel header, a 2-byte big-endian key
 * length, the UTF-8 key bytes, then the raw payload — never base64 (the
 * whole point of a binary frame is to avoid the ~33% base64 blow-up on
 * terminal output). The "key" is the terminal identity (`tabId:instanceId`)
 * for `TERMINAL_DATA`/`TERMINAL_RESIZE`; a file-transfer id for `FILE_CHUNK`
 * and `FILE_END`; a Port Forward stream id for the `PORT_*` channels.
 */
import { BinaryChannel, isBinaryChannel } from './channels'
import type { StudioFrame, StudioFrameType } from './types'
import { isDeveloperSurfaceWire } from '../developer-surfaces'

export class WireError extends Error {
  /** The frame's `type`, when the text parsed far enough to have a known one. */
  readonly frameType?: StudioFrameType
  /** The first field that failed its type's shape check. */
  readonly field?: string

  constructor(message: string, at?: { frameType: StudioFrameType; field: string }) {
    super(message)
    this.name = 'WireError'
    this.frameType = at?.frameType
    this.field = at?.field
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

/** Checks one field. Gets the whole frame too, for a field that must be present whatever its value. */
type FieldCheck = (value: unknown, frame: Record<string, unknown>) => boolean

const optional = (check: FieldCheck): FieldCheck => (v, o) => v === undefined || check(v, o)
const oneOf = (...values: string[]): FieldCheck => (v) => isString(v) && values.includes(v)
const isBoolean: FieldCheck = (v) => typeof v === 'boolean'
const isNullOrPlainObject: FieldCheck = (v) => v === null || isPlainObject(v)

/**
 * Per-type shape validation: the fields each `StudioFrame` member must
 * carry, one check per field so a failure names the field. Deliberately
 * hand-rolled rather than a schema library — `packages/shared` has no
 * runtime-validation dependency today (see the shared `package.json`), and a
 * flat set of field-presence/type checks is easy to keep in lockstep with
 * `types.ts` by hand for a union this size.
 *
 * A field a newer peer adds is never checked here, and a field an older
 * peer does not send must be `optional`, so two builds that differ by an
 * additive field still decode each other's frames.
 */
const SHAPES: Record<StudioFrameType, Record<string, FieldCheck>> = {
  studio_hello: {
    protocolVersion: isNumber,
    clientId: isString,
    clientKind: oneOf('desktop', 'web', 'mobile-bridge', 'mobile'),
    view: optional(oneOf('mirror', 'thin')),
    capabilities: isStringArray,
    credential: (v) => isPlainObject(v) && oneOf('local', 'paired', 'bearer', 'session')(v.kind, v),
  },
  studio_welcome: {
    protocolVersion: isNumber,
    environmentId: isString,
    label: isString,
    platform: isString,
    serverVersion: isString,
    engineVersion: isString,
    capabilities: isStringArray,
    principal: (v) => isPlainObject(v) && isString(v.subject),
    scopes: isStringArray,
    enterprisePolicy: isNullOrPlainObject,
    settingsHiddenGroups: isStringArray,
    developerSurfaces: optional(isDeveloperSurfaceWire),
    policyHash: optional(isString),
    snapshot: isPlainObject,
  },
  studio_refused: {
    reason: oneOf('protocol_version', 'unauthorized', 'not_ready', 'engine_incompatible', 'duplicate_client', 'scope'),
  },
  studio_action: { id: isString, action: isString, args: Array.isArray },
  studio_action_result: { id: isString, ok: isBoolean },
  studio_event: { channel: isString, payload: (_v, o) => 'payload' in o },
  studio_command: { id: isString, command: isString, args: (_v, o) => 'args' in o, timeoutMs: isNumber },
  studio_command_result: { id: isString, ok: isBoolean },
  studio_snapshot: { snapshot: isPlainObject },
  studio_reauth: {
    credential: (v) => isPlainObject(v) && v.kind === 'bearer' && isString(v.token),
  },
  studio_environment_policy: {
    enterprisePolicy: isNullOrPlainObject,
    settingsHiddenGroups: isStringArray,
    developerSurfaces: optional(isDeveloperSurfaceWire),
    policyHash: isString,
  },
  studio_snapshot_request: {},
  studio_body_request: {
    tabId: isString,
    before: optional(isString),
    limit: optional(isNumber),
    held: optional((v) => isPlainObject(v) && isString(v.epoch) && isNumber(v.rev)),
  },
  studio_body: { tabId: isString, rows: Array.isArray },
  studio_ping: { nonce: isString, t: isNumber },
  studio_pong: { nonce: isString, t: isNumber },
  studio_close: {
    reason: oneOf('slow_client', 'token_expired', 'revoked', 'shutdown', 'engine_lost', 'displaced'),
  },
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
  const frameType = type as StudioFrameType
  for (const [field, check] of Object.entries(SHAPES[frameType])) {
    if (!check(parsed[field], parsed)) {
      throw new WireError(`studio wire frame of type ${frameType} failed shape validation at field ${field}`, { frameType, field })
    }
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
