/**
 * telemetry-frame.ts — expansion for compact telemetry frames.
 *
 * Telemetry v4 stores shared identity and context data in tables. The tailer
 * expands a frame before egress so existing telemetry consumers still receive
 * one complete event per record.
 */

import type { EgressRecord } from './log-egress'

export const TELEMETRY_FRAME_VERSION = 4
export const TELEMETRY_FRAME_RECORD = 'telemetry.frame'

type ValueMap = Record<string, unknown>

export interface TelemetryFrameIdentity {
  component: string
  install_id: string
  host: string
  version: string
  user?: string
}

export interface TelemetryFrameContext {
  context?: ValueMap
  trace_id?: string
}

export interface TelemetryFrameEvent {
  i: number
  c?: number
  name: string
  ts: string
  event_id?: string
  payload: ValueMap
}

export interface TelemetryFrame {
  record: typeof TELEMETRY_FRAME_RECORD
  /** The producer's schema, which may be below this decoder's version. */
  schema: number
  identities: TelemetryFrameIdentity[]
  contexts: TelemetryFrameContext[]
  events: TelemetryFrameEvent[]
}

/** Reports a malformed telemetry value with the field that caused it. */
export class TelemetryFrameValidationError extends Error {
  constructor(readonly field: string, readonly reason: string) {
    super(`telemetry frame: ${field}: ${reason}`)
    this.name = 'TelemetryFrameValidationError'
  }
}

/** Reports a record discriminator that is not the v4 telemetry frame type. */
export class TelemetryFrameRecordError extends Error {
  constructor(readonly record: unknown) {
    super(`telemetry frame: unsupported record ${String(record)}`)
    this.name = 'TelemetryFrameRecordError'
  }
}

/** Reports a telemetry schema that this frame expander cannot read. */
export class TelemetryFrameSchemaError extends Error {
  constructor(readonly schema: unknown) {
    super(`telemetry frame: unsupported schema ${String(schema)}`)
    this.name = 'TelemetryFrameSchemaError'
  }
}

/** Reports an event table reference outside the frame's interned table. */
export class TelemetryFrameTableReferenceError extends Error {
  constructor(readonly table: 'identities' | 'contexts', readonly index: number) {
    super(`telemetry frame: ${table} table index is out of range`)
    this.name = 'TelemetryFrameTableReferenceError'
  }
}

function isValueMap(value: unknown): value is ValueMap {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TelemetryFrameValidationError(field, 'is required')
  }
  return value
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string') {
    throw new TelemetryFrameValidationError(field, 'must be a string')
  }
  return value
}

function requiredMap(value: unknown, field: string): ValueMap {
  if (!isValueMap(value)) {
    throw new TelemetryFrameValidationError(field, 'is required')
  }
  return value
}

function requiredArray(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new TelemetryFrameValidationError(field, 'is required')
  }
  return value
}

function requiredIndex(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new TelemetryFrameValidationError(field, 'must be an integer')
  }
  return value
}

function parseIdentity(value: unknown, index: number): TelemetryFrameIdentity {
  const identity = requiredMap(value, `identities[${index}]`)
  return {
    component: requiredString(identity.component, `identities[${index}].component`),
    install_id: optionalString(identity.install_id, `identities[${index}].install_id`) ?? '',
    host: optionalString(identity.host, `identities[${index}].host`) ?? '',
    version: optionalString(identity.version, `identities[${index}].version`) ?? '',
    user: optionalString(identity.user, `identities[${index}].user`),
  }
}

function parseContext(value: unknown, index: number): TelemetryFrameContext {
  const context = requiredMap(value, `contexts[${index}]`)
  const contextValue = context.context
  if (contextValue !== undefined && !isValueMap(contextValue)) {
    throw new TelemetryFrameValidationError(`contexts[${index}].context`, 'must be an object')
  }
  return {
    context: contextValue,
    trace_id: optionalString(context.trace_id, `contexts[${index}].trace_id`),
  }
}

function parseEvent(value: unknown, index: number): TelemetryFrameEvent {
  const event = requiredMap(value, `events[${index}]`)
  const contextIndex = event.c === undefined ? undefined : requiredIndex(event.c, `events[${index}].c`)
  return {
    i: requiredIndex(event.i, `events[${index}].i`),
    c: contextIndex,
    name: requiredString(event.name, `events[${index}].name`),
    ts: requiredString(event.ts, `events[${index}].ts`),
    event_id: optionalString(event.event_id, `events[${index}].event_id`),
    payload: requiredMap(event.payload, `events[${index}].payload`),
  }
}

/**
 * Enforces the one version rule both decoders share.
 *
 * Tolerance is deliberately asymmetric. A frame numbered at or below this
 * decoder's version is readable: unknown keys are simply not read, so a frame
 * carrying fields this build predates yields the fields it does know. Only a
 * number ABOVE the local version is refused, because that is the reserved
 * signal for a structural framing change — adding a field never bumps it.
 *
 * Exact equality here used to reject both directions, which took whichever side
 * of a mixed fleet rolled out first off the telemetry stream. Mirrors
 * ValidateFrame in engine/internal/telemetryformat/codec.go; both are pinned by
 * assets/telemetry-frame-parity.json.
 */
function assertReadableSchema(schema: unknown): void {
  if (typeof schema !== 'number' || !Number.isInteger(schema) || schema < 1) {
    throw new TelemetryFrameSchemaError(schema)
  }
  if (schema > TELEMETRY_FRAME_VERSION) {
    throw new TelemetryFrameSchemaError(schema)
  }
}

/**
 * Parses and validates a compact frame. This accepts unknown input because JSONL
 * input is untrusted at the file boundary; all map values remain `unknown`.
 */
export function parseTelemetryFrame(value: unknown): TelemetryFrame {
  const frame = requiredMap(value, 'frame')
  if (frame.record !== TELEMETRY_FRAME_RECORD) {
    throw new TelemetryFrameRecordError(frame.record)
  }
  assertReadableSchema(frame.schema)

  const identities = requiredArray(frame.identities, 'identities').map(parseIdentity)
  const contexts = requiredArray(frame.contexts, 'contexts').map(parseContext)
  const events = requiredArray(frame.events, 'events').map(parseEvent)
  const parsed: TelemetryFrame = {
    record: TELEMETRY_FRAME_RECORD,
    schema: frame.schema as number,
    identities,
    contexts,
    events,
  }
  validateTelemetryFrame(parsed)
  return parsed
}

/** Validates references and required fields on a typed v4 telemetry frame. */
export function validateTelemetryFrame(frame: TelemetryFrame): void {
  if (frame.record !== TELEMETRY_FRAME_RECORD) {
    throw new TelemetryFrameRecordError(frame.record)
  }
  assertReadableSchema(frame.schema)
  for (const [index, identity] of frame.identities.entries()) {
    requiredString(identity.component, `identities[${index}].component`)
  }
  for (const [index, event] of frame.events.entries()) {
    if (!Number.isInteger(event.i) || event.i < 0 || event.i >= frame.identities.length) {
      throw new TelemetryFrameTableReferenceError('identities', event.i)
    }
    if (event.c !== undefined && (!Number.isInteger(event.c) || event.c < 0 || event.c >= frame.contexts.length)) {
      throw new TelemetryFrameTableReferenceError('contexts', event.c)
    }
    requiredString(event.name, `events[${index}].name`)
    requiredString(event.ts, `events[${index}].ts`)
    requiredMap(event.payload, `events[${index}].payload`)
  }
}

/**
 * Expands a validated v4 frame into the legacy per-event telemetry shape.
 *
 * EgressRecord has mandatory operational-log fields that telemetry events do
 * not carry. Its index signature intentionally permits these telemetry records
 * so they can pass through the existing egress pipeline unchanged.
 */
export function expandTelemetryFrame(frame: TelemetryFrame): EgressRecord[] {
  validateTelemetryFrame(frame)
  return frame.events.map((event) => {
    const identity = frame.identities[event.i]
    const context = event.c === undefined ? undefined : frame.contexts[event.c]
    const expanded: ValueMap = {
      name: event.name,
      ts: event.ts,
      // The producer's schema, not this decoder's. Stamping the local version
      // would relabel an older frame as current and erase the only evidence of
      // which engine build emitted it.
      schema: frame.schema,
      component: identity.component,
      install_id: identity.install_id,
      host: identity.host,
      version: identity.version,
      payload: event.payload,
      // Always present, never omitted, even when empty — a consumer relies on
      // the key existing rather than testing for its absence. parent_span_id is
      // legitimately empty until a per-turn span id is tracked. Matches the Go
      // decoder's Event, which declares both without omitempty.
      trace_id: context?.trace_id ?? '',
      parent_span_id: '',
    }
    if (identity.user !== undefined) expanded.user = identity.user
    if (event.event_id !== undefined) expanded.event_id = event.event_id
    if (context?.context !== undefined) expanded.context = context.context
    return expanded as EgressRecord
  })
}

/** Returns true only for objects that declare the compact telemetry frame record. */
export function isTelemetryFrame(value: unknown): boolean {
  return isValueMap(value) && Object.hasOwn(value, 'record')
}

/**
 * Expands a compact frame, or passes an expanded event through intact.
 *
 * A line without the frame discriminator IS an expanded event, whatever schema
 * number it declares. There is no upper bound on that path: the frame shape is
 * identified by its `record` key, not by its number, and rejecting a
 * high-numbered expanded event made the engine's own `ion telemetry expand`
 * output unreadable here.
 */
export function expandTelemetryRecord(record: EgressRecord): EgressRecord[] {
  const rawRecord: ValueMap = record
  if (isTelemetryFrame(rawRecord)) {
    return expandTelemetryFrame(parseTelemetryFrame(rawRecord))
  }
  return [record]
}

/** Parses one JSONL line then expands its v4 frame or passes a legacy event through. */
export function decodeTelemetryLine(line: string): EgressRecord[] {
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new TelemetryFrameValidationError('line', `is not valid JSON: ${reason}`)
  }
  if (!isValueMap(value)) {
    throw new TelemetryFrameValidationError('line', 'must be an object')
  }
  return expandTelemetryRecord(value as EgressRecord)
}
