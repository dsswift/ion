/**
 * Pins that every node `type` string the app can ever assign — the
 * shape-channel cycle (channels/scales.ts) and the overview LOD's `point`
 * override (graph-reducers.ts) — has a Sigma node program registered in
 * GraphCanvas's `NODE_PROGRAM_CLASSES`. `circle` is registered as well: it
 * replaces Sigma's default with the outlined disc.
 *
 * This is a regression test for a real crash: `point` was used by both the
 * LOD override and the shape cycle from the start, but no program was ever
 * registered for it, so Sigma threw "could not find a suitable program for
 * node type \"point\"!" the moment a node actually rendered as a point
 * (zooming out, or binding the shape channel to a dimension whose cycle
 * reached `point`).
 */
import { describe, expect, it } from 'vitest'
import { NODE_PROGRAM_CLASSES } from './graph-node-programs'
import { CATEGORICAL_SHAPE_CYCLE } from './channels/scales'

describe('NODE_PROGRAM_CLASSES', () => {
  it('registers a program for every shape-cycle value, including the outlined circle', () => {
    expect(CATEGORICAL_SHAPE_CYCLE.length).toBeGreaterThan(0)
    for (const shape of CATEGORICAL_SHAPE_CYCLE) {
      expect(NODE_PROGRAM_CLASSES).toHaveProperty(shape)
    }
  })

  it('registers a program for the overview LOD override ("point")', () => {
    expect(NODE_PROGRAM_CLASSES).toHaveProperty('point')
  })
})
