/**
 * End-to-end simulation smoke: generated office + OfficeState + mapping
 * intents, headless. Pins the full live-state table — dispatch delivery,
 * working/typing, done → stretch → break room, error → slump, permission
 * bubbles — over real generated geometry and real pathfinding.
 */
import { describe, it, expect } from 'vitest'
import { generateOffice } from '../../generation'
import { deriveRoster } from '../../generation/roster'
import { department, testTheme } from '../../generation/__tests__/gen-helpers'
import { OfficeState, MANAGER_ID } from '../office-state'
import { diffSnapshots, eventIntents } from '../mapping'
import type { AgentStateUpdate, NormalizedEvent } from '../../../../shared/types'
import type { CastableCharacter } from '../../theme/casting'

const POOL: CastableCharacter[] = [{ id: 'hero', roles: ['manager', 'lead', 'specialist'], tintable: true }]

function buildOffice(agents: AgentStateUpdate[]): { office: OfficeState; roster: ReturnType<typeof deriveRoster> } {
  const roster = deriveRoster(agents)
  const result = generateOffice('sim-seed', roster, testTheme())
  expect(result.errors).toEqual([])
  const office = new OfficeState(result.layout, result.blocked, POOL, ['volt-cat'], 'sim-seed')
  office.syncRoster(roster)
  return { office, roster }
}

/** Advance the simulation in fixed steps. */
function run(office: OfficeState, seconds: number): void {
  const step = 1 / 30
  for (let t = 0; t < seconds; t += step) office.tick(step)
}

function setStatus(agents: AgentStateUpdate[], name: string, status: string): AgentStateUpdate[] {
  return agents.map((a) => (a.name === name ? ({ ...a, status } as AgentStateUpdate) : a))
}

describe('office simulation end to end', () => {
  const agents = department('dev-lead', ['backend-dev', 'frontend-dev'])

  it('spawns the synthetic manager and the pet', () => {
    const { office } = buildOffice(agents)
    expect(office.entities.has(MANAGER_ID)).toBe(true)
    expect(office.entities.has('__pet__')).toBe(true)
    expect(office.entities.has('dev-lead')).toBe(true)
    expect(office.entities.has('backend-dev')).toBe(true)
  })

  it('snapshot transition to running: manager delivers with the envelope; recipient heads to work', () => {
    const idleAgents = agents.map((a) => ({ ...a, status: 'idle' }) as AgentStateUpdate)
    const { office } = buildOffice(idleAgents)
    office.applyIntents(diffSnapshots([], idleAgents, { initial: true }))
    // The lead's dispatch moment: idle → running in the next snapshot.
    const next = setStatus(idleAgents, 'dev-lead', 'running')
    office.applyIntents(diffSnapshots(idleAgents, next))
    const manager = office.entities.get(MANAGER_ID)!
    expect(manager.bubble?.kind).toBe('dispatch')
    expect(manager.sim.state).toBe('walking')
    const lead = office.entities.get('dev-lead')!
    expect(['walking', 'typing']).toContain(lead.sim.state)
    // After enough time everyone arrives: the lead is typing at its desk.
    run(office, 30)
    expect(lead.sim.state).toBe('typing')
  })

  it('working → done: waiting bubble, stretch, break-room rest, then back on their feet', () => {
    const { office } = buildOffice(agents)
    office.applyIntents(diffSnapshots([], agents, { initial: true })) // everyone running → desks
    run(office, 30)
    const dev = office.entities.get('backend-dev')!
    expect(dev.sim.state).toBe('typing')

    office.applyIntents(diffSnapshots(agents, setStatus(agents, 'backend-dev', 'done')))
    expect(dev.bubble?.kind).toBe('waiting')
    expect(dev.sim.state).toBe('stretching')
    // The done-agent reaches a break-room rest tile at some point...
    let restedOnTile = false
    for (let i = 0; i < 120 && !restedOnTile; i++) {
      run(office, 0.5)
      if (dev.sim.state === 'resting') {
        const at = { x: Math.round(dev.sim.x), y: Math.round(dev.sim.y) }
        restedOnTile = office.layout.restTiles.some((t) => t.x === at.x && t.y === at.y)
      }
    }
    expect(restedOnTile).toBe(true)
    // ...and the rest is a BREAK, not a trap: they stand back up afterwards.
    let stoodUp = false
    for (let i = 0; i < 120 && !stoodUp; i++) {
      run(office, 0.5)
      stoodUp = dev.sim.state !== 'resting'
    }
    expect(stoodUp).toBe(true)
  })

  it('manager mirrors the orchestrator status (working at his desk, then standing down)', () => {
    const { office } = buildOffice(agents)
    const running = { type: 'status', fields: { state: 'running' } } as unknown as NormalizedEvent
    const idle = { type: 'status', fields: { state: 'idle' } } as unknown as NormalizedEvent
    office.applyIntents(eventIntents([running], agents))
    const manager = office.entities.get(MANAGER_ID)!
    run(office, 20)
    expect(manager.sim.state).toBe('typing')
    office.applyIntents(eventIntents([idle], agents))
    expect(manager.sim.state).toBe('idle')
  })

  it('error: red bubble and slump; recovery on idle', () => {
    const { office } = buildOffice(agents)
    office.applyIntents(diffSnapshots([], agents))
    run(office, 30)
    const dev = office.entities.get('frontend-dev')!
    office.applyIntents(diffSnapshots(agents, setStatus(agents, 'frontend-dev', 'error')))
    expect(dev.bubble?.kind).toBe('error')
    expect(dev.sim.state).toBe('slumped')
    // Slump persists through ticks (no ambient wander out of it).
    run(office, 5)
    expect(dev.sim.state).toBe('slumped')
    office.applyIntents(diffSnapshots(setStatus(agents, 'frontend-dev', 'error'), setStatus(agents, 'frontend-dev', 'idle')))
    expect(dev.bubble).toBeNull()
    expect(dev.sim.state).toBe('idle')
  })

  it('permission wait raises the manager bubble; running status clears it', () => {
    const { office } = buildOffice(agents)
    office.applyIntents(eventIntents(
      [{ type: 'permission_request', questionId: 'q', toolName: 'Bash', options: [] } as unknown as NormalizedEvent],
      agents,
    ))
    const manager = office.entities.get(MANAGER_ID)!
    expect(manager.bubble?.kind).toBe('permission')
    run(office, 10)
    expect(manager.bubble?.kind).toBe('permission') // no ttl expiry
    office.applyIntents(eventIntents(
      [{ type: 'status', fields: { state: 'running' } } as unknown as NormalizedEvent],
      agents,
    ))
    expect(manager.bubble).toBeNull()
  })

  it('deduplicates a dispatch seen on both surfaces (telemetry + snapshot backstop)', () => {
    const idleAgents = agents.map((a) => ({ ...a, status: 'idle' }) as AgentStateUpdate)
    const { office } = buildOffice(idleAgents)
    office.applyIntents(diffSnapshots([], idleAgents, { initial: true }))
    const manager = office.entities.get(MANAGER_ID)!

    // Primary surface: dispatch_start telemetry.
    const telemetry = eventIntents(
      [{
        type: 'dispatch_start',
        dispatchAgent: 'dev-lead',
        dispatchTask: 't',
        dispatchModel: 'm',
        dispatchSessionId: 's',
        dispatchDepth: 1,
        dispatchParentId: '',
        dispatchId: 'd-dedup',
      } as NormalizedEvent],
      idleAgents,
    )
    office.applyIntents(telemetry)
    expect(manager.sim.state).toBe('walking')
    expect(manager.bubble?.kind).toBe('dispatch')
    // Let the envelope bubble tick down inside the dedup window.
    run(office, 2)
    const ttlBefore = manager.bubble?.ttl ?? 0
    expect(ttlBefore).toBeLessThan(3)

    // Backstop surface arrives moments later: the same dispatch as a
    // running transition in the next snapshot. Deduped — no second
    // delivery, so the envelope bubble is NOT re-shown (ttl not reset).
    office.applyIntents(diffSnapshots(idleAgents, setStatus(idleAgents, 'dev-lead', 'running')))
    expect(manager.bubble?.ttl ?? 0).toBeLessThanOrEqual(ttlBefore)
  })

  it('mid-run newcomer hot-desks into the break room without regeneration', () => {
    const { office } = buildOffice(agents)
    const grown = [...agents, { name: 'zeta-solo', status: 'running', metadata: { dispatchDepth: 1, dispatchParentId: '' } } as unknown as AgentStateUpdate]
    office.syncRoster(deriveRoster(grown))
    office.applyIntents(diffSnapshots(agents, grown))
    const newcomer = office.entities.get('zeta-solo')
    expect(newcomer).toBeDefined()
    expect(newcomer!.seat).toBeNull()
    run(office, 40)
    // A working guest claims a guest desk (or a couch with a laptop) and
    // WORKS there — never mills about while running.
    expect(newcomer!.working).toBe(true)
    expect(['typing', 'reading', 'walking']).toContain(newcomer!.sim.state)
  })

  it('idle characters never loiter in hallways: every stop is inside a room', () => {
    const idleAgents = agents.map((a) => ({ ...a, status: 'idle' }) as AgentStateUpdate)
    const { office } = buildOffice(idleAgents)
    office.applyIntents(diffSnapshots([], idleAgents, { initial: true }))
    const inRoom = (x: number, y: number) =>
      office.layout.rooms.some(
        (r) => x >= r.rect.x && x < r.rect.x + r.rect.w && y >= r.rect.y && y < r.rect.y + r.rect.h,
      )
    // Long ambient simulation: characters wander freely, but after each full
    // tick, anyone standing still must be standing inside a room — the tick
    // relocates a corridor-stander in the same step it comes to rest.
    for (let i = 0; i < 240; i++) {
      run(office, 0.5)
      for (const e of office.entities.values()) {
        if (e.role === 'pet') continue
        if (e.sim.state === 'idle' || e.sim.state === 'resting') {
          expect(
            inRoom(Math.round(e.sim.x), Math.round(e.sim.y)),
            `${e.name} loitering in a hallway`,
          ).toBe(true)
        }
      }
    }
  })

  it('an idle manager courier makes a round trip: drop at the door, then walk home', () => {
    const idleAgents = agents.map((a) => ({ ...a, status: 'idle' }) as AgentStateUpdate)
    const { office } = buildOffice(idleAgents)
    office.applyIntents(diffSnapshots([], idleAgents, { initial: true }))
    office.applyIntents(diffSnapshots(idleAgents, setStatus(idleAgents, 'dev-lead', 'running')))
    const manager = office.entities.get(MANAGER_ID)!
    expect(manager.sim.state).toBe('walking')
    run(office, 60)
    // After the delivery settles, the manager is back in its own office,
    // not idling at the recipient's door.
    const at = { x: Math.round(manager.sim.x), y: Math.round(manager.sim.y) }
    const room = office.layout.rooms.find(
      (r) => at.x >= r.rect.x && at.x < r.rect.x + r.rect.w && at.y >= r.rect.y && at.y < r.rect.y + r.rect.h,
    )
    expect(room?.id).toBe('manager')
  })

  it('working agents never wander: long idle simulation keeps them at their desks', () => {
    const { office } = buildOffice(agents)
    office.applyIntents(diffSnapshots([], agents, { initial: true }))
    run(office, 60)
    for (const name of ['dev-lead', 'backend-dev', 'frontend-dev']) {
      const entity = office.entities.get(name)!
      expect(entity.working, name).toBe(true)
      expect(['typing', 'reading', 'walking'], `${name} state`).toContain(entity.sim.state)
      // At their OWN seat (walking only transiently; after 60s they sit).
      if (entity.sim.state !== 'walking' && entity.seat) {
        expect({ x: Math.round(entity.sim.x), y: Math.round(entity.sim.y) }).toEqual(entity.seat.tile)
      }
    }
  })
})
