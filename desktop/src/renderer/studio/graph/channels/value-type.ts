/**
 * Value-type auto-detection and manual-override resolution.
 *
 * Detection runs once at bind time; the resolved type is stored on the
 * binding and never re-inferred per render. Re-inferring would let one
 * added document silently flip a categorical palette into a gradient
 * mid-session, which is exactly the instability the design forbids.
 */

import type { ChannelBinding, ChannelValueType } from '../../../../shared/graph-view-types'

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

/** A value parses as a date only when it is a string or Date that yields a real timestamp. */
function parsesAsDate(v: unknown): boolean {
  if (v instanceof Date) return !Number.isNaN(v.getTime())
  if (typeof v !== 'string' || v.trim().length === 0) return false
  const parsed = Date.parse(v)
  return !Number.isNaN(parsed)
}

/**
 * Detect a channel's value type from a sample of raw values. Considered
 * values exclude null/undefined/empty-string (those are "missing", not a
 * type signal). A numeric-looking STRING is `categorical` unless every
 * considered value is a genuine number — that asymmetry is exactly what
 * the manual override exists to correct.
 */
export function detectValueType(values: unknown[]): ChannelValueType {
  const considered = values.filter((v) => v !== null && v !== undefined && v !== '')
  if (considered.length === 0) return 'categorical'
  if (considered.every(isFiniteNumber)) return 'numeric'
  if (considered.every(parsesAsDate)) return 'temporal'
  return 'categorical'
}

export interface ResolvedValueType {
  valueType: ChannelValueType
  detected: ChannelValueType
  overridden: boolean
}

/**
 * Resolve a binding's effective value type: the stored `valueType` on the
 * binding wins when the caller has set one explicitly (an override); the
 * caller passes `null` for `binding.valueType` there is no meaningful
 * "unset" sentinel on `ChannelValueType` itself, so the override intent is
 * carried by a separate flag rather than a magic value.
 */
export function resolveValueType(binding: ChannelBinding, values: unknown[], isOverridden: boolean): ResolvedValueType {
  const detected = detectValueType(values)
  return {
    valueType: isOverridden ? binding.valueType : detected,
    detected,
    overridden: isOverridden,
  }
}
