import { describe, it, expect } from 'vitest'
import {
  advanceCharacter,
  animationFor,
  makeCharacterSim,
  mirroredFor,
  transition,
  STRETCH_SECONDS,
  WALK_SPEED,
} from '../character'

describe('character state machine', () => {
  it('walks a path and enters the arrival goal', () => {
    const sim = makeCharacterSim({ x: 0, y: 0 })
    transition(sim, { kind: 'walk', path: [{ x: 1, y: 0 }, { x: 2, y: 0 }], goal: 'typing' })
    expect(sim.state).toBe('walking')
    // Two tiles at WALK_SPEED tiles/s: arrival after 2/WALK_SPEED seconds.
    const result = advanceCharacter(sim, 2 / WALK_SPEED + 0.001)
    expect(result.arrived).toBe(true)
    expect(sim.state).toBe('typing')
    expect(sim.x).toBe(2)
    expect(sim.dir).toBe('up')
  })

  it('an empty-path walk enters the goal immediately', () => {
    const sim = makeCharacterSim({ x: 3, y: 3 })
    transition(sim, { kind: 'walk', path: [], goal: 'resting' })
    expect(sim.state).toBe('resting')
  })

  it('error interrupts a walk: slump on the grid, path dropped', () => {
    const sim = makeCharacterSim({ x: 0, y: 0 })
    transition(sim, { kind: 'walk', path: [{ x: 1, y: 0 }, { x: 2, y: 0 }], goal: 'typing' })
    advanceCharacter(sim, 0.5 / WALK_SPEED) // mid-tile
    transition(sim, { kind: 'error' })
    expect(sim.state).toBe('slumped')
    expect(sim.path).toEqual([])
    expect(Number.isInteger(sim.x)).toBe(true)
    expect(animationFor(sim)).toBe('slump')
  })

  it('recover only leaves the slumped state', () => {
    const sim = makeCharacterSim({ x: 0, y: 0 })
    transition(sim, { kind: 'error' })
    transition(sim, { kind: 'recover' })
    expect(sim.state).toBe('idle')
    transition(sim, { kind: 'sit', goal: 'typing' })
    transition(sim, { kind: 'recover' })
    expect(sim.state).toBe('typing')
  })

  it('a dispatch while resting stands the character up into a new walk', () => {
    const sim = makeCharacterSim({ x: 5, y: 5 })
    transition(sim, { kind: 'sit', goal: 'resting' })
    expect(sim.state).toBe('resting')
    transition(sim, { kind: 'walk', path: [{ x: 5, y: 4 }], goal: 'typing' })
    expect(sim.state).toBe('walking')
  })

  it('stretch expires after its timer', () => {
    const sim = makeCharacterSim({ x: 0, y: 0 })
    transition(sim, { kind: 'walk', path: [], goal: 'stretching' })
    expect(sim.state).toBe('stretching')
    const result = advanceCharacter(sim, STRETCH_SECONDS + 0.01)
    expect(result.timerExpired).toBe(true)
  })

  it('walking left uses the mirrored right strip', () => {
    const sim = makeCharacterSim({ x: 2, y: 0 })
    transition(sim, { kind: 'walk', path: [{ x: 1, y: 0 }], goal: 'idle' })
    advanceCharacter(sim, 0.01)
    expect(sim.dir).toBe('left')
    expect(animationFor(sim)).toBe('walk-right')
    expect(mirroredFor(sim)).toBe(true)
  })
})
