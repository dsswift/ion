/**
 * `deepEqual` — the guard that makes a refresh action safe to call from a
 * render-driven effect.
 *
 * The cases below are the ones that decide whether the guard holds: key order
 * must not matter (that is why this is not `JSON.stringify` equality), and a
 * non-plain object must never be reported equal by structure, because a cache
 * that skips a write on a false "equal" verdict silently serves stale state.
 */
import { describe, it, expect } from 'vitest'
import { deepEqual } from '../deep-equal'

describe('deepEqual', () => {
  it('accepts primitives and identical references', () => {
    expect(deepEqual(1, 1)).toBe(true)
    expect(deepEqual('a', 'a')).toBe(true)
    expect(deepEqual(null, null)).toBe(true)
    expect(deepEqual(undefined, undefined)).toBe(true)
    const shared = { a: 1 }
    expect(deepEqual(shared, shared)).toBe(true)
  })

  it('rejects mismatched primitives and null-vs-object', () => {
    expect(deepEqual(1, 2)).toBe(false)
    expect(deepEqual('1', 1)).toBe(false)
    expect(deepEqual(null, {})).toBe(false)
    expect(deepEqual({}, null)).toBe(false)
  })

  it('compares nested objects and arrays structurally', () => {
    const inventory = [{ worktreePath: '/a', isDirty: false, meta: { head: 'abc' } }]
    const identical = [{ worktreePath: '/a', isDirty: false, meta: { head: 'abc' } }]
    const changed = [{ worktreePath: '/a', isDirty: true, meta: { head: 'abc' } }]

    expect(deepEqual(inventory, identical)).toBe(true)
    expect(deepEqual(inventory, changed)).toBe(false)
  })

  it('ignores key order', () => {
    expect(deepEqual({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true)
  })

  it('distinguishes arrays from objects and length differences', () => {
    expect(deepEqual([1, 2], [1, 2, 3])).toBe(false)
    expect(deepEqual([], {})).toBe(false)
    expect(deepEqual({ 0: 1 }, [1])).toBe(false)
  })

  it('treats a missing key and an undefined value as different shapes', () => {
    // Same key count is not the same shape; `{a:1}` has no `b` at all.
    expect(deepEqual({ a: 1, b: undefined }, { a: 1, c: undefined })).toBe(false)
  })

  it('compares non-plain objects by reference only', () => {
    // Two Maps with equal entries are NOT equal here. Reporting them equal
    // would let a cache skip a write that genuinely changed.
    expect(deepEqual(new Map([['a', 1]]), new Map([['a', 1]]))).toBe(false)
    const map = new Map([['a', 1]])
    expect(deepEqual(map, map)).toBe(true)
  })
})
