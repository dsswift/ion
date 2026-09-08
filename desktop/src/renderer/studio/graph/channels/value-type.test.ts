/**
 * Tests for value-type.ts (child 06): auto-detection and manual override.
 */
import { describe, expect, it } from 'vitest'
import { detectValueType, resolveValueType } from './value-type'

describe('detectValueType', () => {
  it('every value numeric detects numeric', () => {
    expect(detectValueType([1, 2, 3.5])).toBe('numeric')
  })
  it('every value parses as a date detects temporal', () => {
    expect(detectValueType(['2024-01-01', '2024-06-15'])).toBe('temporal')
  })
  it('mixed strings detect categorical', () => {
    expect(detectValueType(['ops', 'infra'])).toBe('categorical')
  })
  it('a numeric-looking string with a non-numeric peer is categorical', () => {
    expect(detectValueType(['42', 'ops'])).toBe('categorical')
  })
  it('every value numeric-looking string but genuinely numbers as numbers detects numeric', () => {
    expect(detectValueType([1, 2, 3])).toBe('numeric')
  })
  it('an empty considered set (all missing) detects categorical', () => {
    expect(detectValueType([null, undefined, ''])).toBe('categorical')
  })
  it('date-shaped strings mixed with a non-date value detect categorical', () => {
    expect(detectValueType(['2024-01-01', 'TBD'])).toBe('categorical')
  })
  it('missing values are excluded from consideration, not counted against the type', () => {
    expect(detectValueType([1, 2, null, undefined, ''])).toBe('numeric')
  })
})

describe('resolveValueType', () => {
  it('with no override, uses the detected type', () => {
    const result = resolveValueType({ dimension: null, valueType: 'categorical' }, [1, 2, 3], false)
    expect(result.valueType).toBe('numeric')
    expect(result.detected).toBe('numeric')
    expect(result.overridden).toBe(false)
  })
  it('with an override, uses the binding stored type regardless of detection', () => {
    const result = resolveValueType({ dimension: null, valueType: 'categorical' }, [1, 2, 3], true)
    expect(result.valueType).toBe('categorical')
    expect(result.detected).toBe('numeric')
    expect(result.overridden).toBe(true)
  })
})
