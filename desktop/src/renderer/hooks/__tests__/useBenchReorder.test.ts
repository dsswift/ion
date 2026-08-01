/**
 * useBenchReorder — the drag that changes the bench's merge order.
 *
 * ── The safety property under test ──────────────────────────────────────────
 * A reorder gesture must never be able to change MEMBERSHIP. Only enrolled rows
 * have a position in the merge array, but they share a list with unenrolled rows
 * below them, so a drag can physically travel past the group. Clamping means
 * that reads as "put it last"; without the clamp it would either unenroll the
 * row or write an index the rebuild cannot honour, and both are destructive and
 * un-obvious.
 */
import { describe, it, expect } from 'vitest'
import { resolveDropIndex } from '../useBenchReorder'

describe('resolveDropIndex — the index arithmetic', () => {
  it('moves a row up to the dropped position', () => {
    expect(resolveDropIndex(2, 0, 4)).toBe(0)
  })

  it('moves a row down to the dropped position', () => {
    expect(resolveDropIndex(0, 2, 4)).toBe(2)
  })

  it('clamps a drop past the enrolled group to LAST, never out of the bench', () => {
    // Index 7 is an unenrolled row. The honest reading is "last in the bench",
    // which is what the operator saw when they let go.
    expect(resolveDropIndex(0, 7, 3)).toBe(2)
  })

  it('clamps a negative target to first', () => {
    expect(resolveDropIndex(2, -3, 4)).toBe(0)
  })

  it('reports a no-op when the row is dropped on itself', () => {
    // Returning null rather than the same index lets the caller skip a store
    // write and the rebuild it would trigger.
    expect(resolveDropIndex(1, 1, 4)).toBeNull()
  })

  it('reports a no-op when a clamped drop lands where it started', () => {
    // Dragging the LAST enrolled row past the group clamps back to itself.
    expect(resolveDropIndex(2, 9, 3)).toBeNull()
  })

  it('refuses to reorder a bench with one member or none', () => {
    expect(resolveDropIndex(0, 0, 1)).toBeNull()
    expect(resolveDropIndex(0, 0, 0)).toBeNull()
  })

  it('refuses a drag that did not start on an enrolled row', () => {
    expect(resolveDropIndex(-1, 2, 4)).toBeNull()
  })
})

describe('resolveDropIndex — every target stays inside the bench', () => {
  it('never returns an index outside the enrolled range, for any input', () => {
    // The property, checked exhaustively over a small space rather than asserted
    // once: this is the invariant that keeps a drag from changing membership.
    const enrolledCount = 4
    for (let from = 0; from < enrolledCount; from++) {
      for (let over = -5; over < 20; over++) {
        const to = resolveDropIndex(from, over, enrolledCount)
        if (to === null) continue
        expect(to).toBeGreaterThanOrEqual(0)
        expect(to).toBeLessThan(enrolledCount)
      }
    }
  })
})
