/**
 * Character state machine. The pure core (`transition`, `advanceCharacter`)
 * is separated from sprite lookup and pathfinding so it tests headless: state
 * transitions and movement integrate over plain data.
 *
 * States: idle → walking → typing/reading (at desk), wandering pauses,
 * resting (break room), stretching (done celebration), slumped (error).
 */
import type { AtvDirection } from '../../../shared/types-atv'
import type { Point } from '../generation/types'

export type CharState =
  | 'idle'
  | 'walking'
  | 'typing'
  | 'reading'
  | 'resting'
  | 'stretching'
  | 'slumped'

/** What the character should do when the current walk completes. */
export type ArrivalGoal = 'typing' | 'reading' | 'resting' | 'idle' | 'stretching'

export interface CharacterSim {
  /** Tile-space position (fractional while walking). */
  x: number
  y: number
  dir: AtvDirection
  state: CharState
  /** Remaining path tiles (target last). Empty when not walking. */
  path: Point[]
  goal: ArrivalGoal
  /** Seconds accumulated in the current state (drives animation frames). */
  animTime: number
  /** Seconds left in a timed state (stretching); 0 = untimed. */
  stateTimer: number
}

export type CharEvent =
  | { kind: 'walk'; path: Point[]; goal: ArrivalGoal }
  | { kind: 'error' }
  | { kind: 'recover' }
  | { kind: 'sit'; goal: 'typing' | 'reading' | 'resting' }
  | { kind: 'stand' }

/** Tiles per second walk speed. */
export const WALK_SPEED = 3
/** Seconds the stretch celebration lasts before walking off. */
export const STRETCH_SECONDS = 1.2

export function makeCharacterSim(at: Point): CharacterSim {
  return { x: at.x, y: at.y, dir: 'down', state: 'idle', path: [], goal: 'idle', animTime: 0, stateTimer: 0 }
}

/**
 * Apply an event to a character. Errors interrupt anything (slump in place,
 * dropping the path); a new walk order interrupts anything except nothing —
 * a dispatched agent stands up from resting and heads to its desk.
 */
export function transition(sim: CharacterSim, event: CharEvent): void {
  switch (event.kind) {
    case 'walk':
      if (event.path.length === 0) {
        enterGoal(sim, event.goal)
        return
      }
      sim.state = 'walking'
      sim.path = event.path
      sim.goal = event.goal
      sim.animTime = 0
      sim.stateTimer = 0
      return
    case 'error':
      sim.state = 'slumped'
      sim.path = []
      sim.animTime = 0
      // Snap to the tile being crossed so the slump lands on the grid.
      sim.x = Math.round(sim.x)
      sim.y = Math.round(sim.y)
      return
    case 'recover':
      if (sim.state === 'slumped') {
        sim.state = 'idle'
        sim.animTime = 0
      }
      return
    case 'sit':
      enterGoal(sim, event.goal)
      return
    case 'stand':
      if (sim.state !== 'walking') {
        sim.state = 'idle'
        sim.animTime = 0
      }
      return
  }
}

function enterGoal(sim: CharacterSim, goal: ArrivalGoal): void {
  sim.animTime = 0
  sim.path = []
  // Timed states set their own timer below; everything else starts untimed
  // (a leftover timer from a previous state must never expire the new one).
  sim.stateTimer = 0
  switch (goal) {
    case 'typing':
      sim.state = 'typing'
      sim.dir = 'up'
      return
    case 'reading':
      sim.state = 'reading'
      sim.dir = 'up'
      return
    case 'resting':
      sim.state = 'resting'
      sim.dir = 'down'
      return
    case 'stretching':
      sim.state = 'stretching'
      sim.stateTimer = STRETCH_SECONDS
      return
    default:
      sim.state = 'idle'
  }
}

export interface AdvanceResult {
  /** True when a walk completed and the arrival goal was entered this tick. */
  arrived: boolean
  /** True when a timed state (stretching) expired this tick. */
  timerExpired: boolean
}

/** Integrate one tick. Pure over the sim struct — no I/O, no globals. */
export function advanceCharacter(sim: CharacterSim, dt: number): AdvanceResult {
  sim.animTime += dt
  const result: AdvanceResult = { arrived: false, timerExpired: false }

  if (sim.state === 'walking' && sim.path.length > 0) {
    let budget = WALK_SPEED * dt
    while (budget > 0 && sim.path.length > 0) {
      const next = sim.path[0]
      const dx = next.x - sim.x
      const dy = next.y - sim.y
      const dist = Math.abs(dx) + Math.abs(dy)
      sim.dir = Math.abs(dx) >= Math.abs(dy) ? (dx >= 0 ? 'right' : 'left') : dy >= 0 ? 'down' : 'up'
      if (dist <= budget) {
        sim.x = next.x
        sim.y = next.y
        sim.path.shift()
        budget -= dist
      } else {
        sim.x += (dx / dist) * budget
        sim.y += (dy / dist) * budget
        budget = 0
      }
    }
    if (sim.path.length === 0) {
      enterGoal(sim, sim.goal)
      result.arrived = true
    }
  }

  if (sim.stateTimer > 0) {
    sim.stateTimer -= dt
    if (sim.stateTimer <= 0) {
      sim.stateTimer = 0
      result.timerExpired = true
    }
  }
  return result
}

/** Animation name for the current state (sprite lookup is theme-side). */
export function animationFor(sim: CharacterSim): string {
  switch (sim.state) {
    case 'walking':
      return sim.dir === 'left' ? 'walk-right' : `walk-${sim.dir}`
    case 'typing':
      return 'typing'
    case 'reading':
      return 'reading'
    case 'stretching':
      return 'stretch'
    case 'slumped':
      return 'slump'
    default:
      return 'idle'
  }
}

/** Whether the current animation frame should be drawn mirrored. */
export function mirroredFor(sim: CharacterSim): boolean {
  return sim.state === 'walking' && sim.dir === 'left'
}
