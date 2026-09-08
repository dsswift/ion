/**
 * The eased emphasis: levels move toward their targets a fraction per step,
 * a change mid-fade continues from where it is, and a cleared target fades
 * every node back rather than snapping.
 */
import { describe, expect, it } from 'vitest'
import { createEmphasisFader, FADE_STEP } from './emphasis-fade'

function settle(fader: ReturnType<typeof createEmphasisFader>): number {
  let steps = 0
  while (fader.step()) steps++
  return steps
}

describe('createEmphasisFader', () => {
  it('is inactive with no target and reads every node as lit', () => {
    const fader = createEmphasisFader()
    expect(fader.active()).toBe(false)
    expect(fader.node('any')).toBe(1)
    expect(fader.seed('any')).toBe(0)
  })

  it('fades a node outside the emphasis toward 0 one step at a time, and lights the seed at once', () => {
    const fader = createEmphasisFader()
    const needsStep = fader.setTarget({ emphasis: new Set(['a', 'b']), seeds: new Set(['a']) })
    expect(needsStep).toBe(true)
    expect(fader.active()).toBe(true)
    expect(fader.node('a')).toBe(1)
    expect(fader.node('b')).toBe(1)
    // An untouched outsider starts fully lit and moves by FADE_STEP of the way.
    expect(fader.node('z')).toBe(1)
    fader.step()
    expect(fader.node('z')).toBeCloseTo(1 - FADE_STEP, 5)
    expect(fader.seed('a')).toBeCloseTo(FADE_STEP, 5)
    settle(fader)
    expect(fader.node('z')).toBe(0)
    expect(fader.seed('a')).toBe(1)
    expect(fader.seed('b')).toBe(0)
  })

  it('a hover that changes mid-fade continues from the current level rather than restarting', () => {
    const fader = createEmphasisFader()
    fader.setTarget({ emphasis: new Set(['a']), seeds: new Set(['a']) })
    fader.step()
    fader.step()
    const partway = fader.node('b')
    expect(partway).toBeGreaterThan(0)
    expect(partway).toBeLessThan(1)
    // Now b is emphasised: it climbs back from where it was, not from 0.
    fader.setTarget({ emphasis: new Set(['a', 'b']), seeds: new Set(['a']) })
    expect(fader.node('b')).toBeCloseTo(partway, 5)
    fader.step()
    expect(fader.node('b')).toBeGreaterThan(partway)
    settle(fader)
    expect(fader.node('b')).toBe(1)
  })

  it('clearing the target fades every dimmed node back to lit, then goes inactive', () => {
    const fader = createEmphasisFader()
    fader.setTarget({ emphasis: new Set(['a']), seeds: new Set(['a']) })
    settle(fader)
    expect(fader.node('z')).toBe(0)
    fader.setTarget({ emphasis: null, seeds: new Set() })
    expect(fader.active()).toBe(true)
    fader.step()
    expect(fader.node('z')).toBeCloseTo(FADE_STEP, 5)
    settle(fader)
    expect(fader.node('z')).toBe(1)
    expect(fader.active()).toBe(false)
  })

  it('settle jumps every level to its target', () => {
    const fader = createEmphasisFader()
    fader.setTarget({ emphasis: new Set(['a']), seeds: new Set(['a']) })
    fader.settle()
    expect(fader.node('z')).toBe(0)
    expect(fader.seed('a')).toBe(1)
    expect(fader.step()).toBe(false)
  })
})
