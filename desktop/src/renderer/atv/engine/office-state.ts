/**
 * OfficeState — the imperative simulation heart of ATV. Lives outside React
 * (the shell holds a ref; the canvas loop ticks it at a fixed timestep).
 *
 * Owns the entity registry (characters, pet, bubbles), consumes mapping
 * intents, and schedules movement through the pathfinder. Rendering reads it;
 * nothing here touches the canvas.
 */
import type { AtvRole } from '../../../shared/types-atv'
import { createRng, deriveSeed, type AtvRng } from '../generation/prng'
import { buildWalkability } from '../generation/validate'
import { managerSeat, seatOf } from '../generation/seating'
import type { OfficeLayout, Point, Roster, Seat } from '../generation/types'
import { castCharacter, type CastableCharacter } from '../theme/casting'
import { Pathfinder } from './pathfind'
import {
  advanceCharacter,
  makeCharacterSim,
  transition,
  type ArrivalGoal,
  type CharacterSim,
} from './character'
import { leaveHallway, maybeWander, pairChatters, petWander, roomAt } from './ambient'
import { showBubble, tickBubble, type BubbleState } from './bubbles'
import { getDispatches, meta } from '../../lib/agent-helpers'
import type { Intent } from './mapping'

export const MANAGER_ID = '__manager__'

/** Seconds within which repeat deliveries to the same recipient coalesce. */
export const DELIVERY_DEDUP_SECONDS = 10

export interface OfficeEntity {
  name: string
  displayName: string
  role: AtvRole | 'pet'
  characterId: string
  tint: string | null
  sim: CharacterSim
  bubble: BubbleState | null
  seat: Seat | null
  /** Current tool activity (from dispatch_activity), for tooltips/flavor. */
  activity: string | null
  /**
   * True while the backing agent is running. Working characters never
   * wander: the only travel allowed is to their workstation (optionally via
   * the mail room for the memo) and, for guests, to a claimed guest spot.
   */
  working: boolean
  /** Meeting id while convened in a meeting room (atv-meeting metadata). */
  inMeeting: string | null
  /** Finished at least one task this scene (green status dot). */
  completed: boolean
  /** Idle but waiting on dispatched children still running (yellow dot). */
  waiting: boolean
}

export class OfficeState {
  readonly entities = new Map<string, OfficeEntity>()
  readonly pathfinder: Pathfinder
  private ambientRng: AtvRng
  private managerHome: Point | null
  /**
   * Delivery dedup: dispatch moments arrive on two surfaces (dispatch_start
   * telemetry — primary — and the agent-state running transition — backstop).
   * One walk per recipient per window; keyed by recipient name.
   */
  private recentDeliveries = new Map<string, number>()
  private clock = 0
  /** False until the first tick: the initial roster spawns seated; later
   *  arrivals walk in through the front door. */
  private sceneSettled = false

  constructor(
    public readonly layout: OfficeLayout,
    blocked: ReadonlySet<string>,
    private characterPool: CastableCharacter[],
    private petPool: string[],
    private seed: string,
  ) {
    this.pathfinder = new Pathfinder(layout, buildWalkability(layout, blocked))
    this.ambientRng = createRng(deriveSeed(seed, 'ambient'))
    const mSeat = managerSeat(layout)
    this.managerHome = mSeat?.tile ?? null
    // The manager is always present, cast from the manager role pool.
    const cast = castCharacter(characterPool, 'manager', MANAGER_ID, seed, null)
    if (cast && mSeat) {
      this.entities.set(MANAGER_ID, {
        name: MANAGER_ID,
        displayName: 'Manager',
        role: 'manager',
        characterId: cast.characterId,
        tint: cast.tint,
        sim: makeCharacterSim(mSeat.tile),
        bubble: null,
        seat: mSeat ?? null,
        activity: null,
        working: false,
        inMeeting: null,
        completed: false,
        waiting: false,
      })
    }
    // Pet spawns in the break room when the pack ships one.
    if (petPool.length > 0 && layout.petSpawn) {
      this.entities.set('__pet__', {
        name: '__pet__',
        displayName: [...petPool].sort()[0],
        role: 'pet',
        characterId: [...petPool].sort()[0],
        tint: null,
        sim: makeCharacterSim(layout.petSpawn),
        bubble: null,
        seat: null,
        activity: null,
        working: false,
        inMeeting: null,
        completed: false,
        waiting: false,
      })
    }
  }

  /**
   * Reconcile roster changes without regenerating: new agents get their
   * assigned seat, or hot-desk into the break room when unseated (mid-run
   * growth). Agents gone from the roster stay in the office until the next
   * regeneration (tab switch / seed change) — people don't vanish mid-scene.
   */
  syncRoster(roster: Roster): void {
    const seen: Array<{ name: string; displayName: string; role: AtvRole; color: string; characterId: string | null }> = []
    for (const dept of roster.departments) {
      seen.push({ ...dept.lead, role: 'lead' })
      for (const s of dept.specialists) seen.push({ ...s, role: 'specialist' })
    }
    for (const e of roster.executives) seen.push({ ...e, role: 'lead' })
    for (const s of roster.solo) seen.push({ ...s, role: 'specialist' })

    for (const agent of seen) {
      if (this.entities.has(agent.name)) continue
      // `atv-character` frontmatter pins a specific sheet when the pack has
      // it; otherwise seeded role-based casting.
      const pinned = agent.characterId && this.characterPool.some((c) => c.id === agent.characterId)
        ? { characterId: agent.characterId, tint: this.characterPool.find((c) => c.id === agent.characterId)!.tintable ? agent.color : null }
        : castCharacter(this.characterPool, agent.role, agent.name, this.seed, agent.color)
      const cast = pinned
      if (!cast) continue
      const seat = seatOf(this.layout, agent.name) ?? null
      // New faces enter through arrivals (the front door) and walk to
      // wherever they belong, instead of materializing mid-office. Agents
      // present from the first snapshot spawn seated (initial scene build).
      const arrivals = this.layout.rooms.find((r) => r.id === 'arrivals')
      const spawn = this.sceneSettled
        ? (arrivals ? { x: arrivals.interior.x + 1, y: arrivals.interior.y + 1 } : this.layout.petSpawn)
        : (seat?.tile ?? this.layout.petSpawn)
      if (!spawn) continue
      this.entities.set(agent.name, {
        name: agent.name,
        displayName: agent.displayName,
        role: agent.role,
        characterId: cast.characterId,
        tint: cast.tint,
        sim: makeCharacterSim(spawn),
        bubble: null,
        seat,
        activity: null,
        working: false,
        inMeeting: null,
        completed: false,
        waiting: false,
      })
    }
  }

  /** A landing tile for unseated agents: a free cushion, else the pet spawn. */
  private hotSpot(entity: OfficeEntity): Point | null {
    return this.claimRestTile(entity) ?? this.layout.petSpawn
  }

  applyIntents(intents: Intent[]): void {
    for (const intent of intents) {
      switch (intent.kind) {
        case 'agent-working': {
          const entity = this.entities.get(intent.agent)
          if (entity) entity.working = true
          this.sendToWork(intent.agent, false)
          break
        }
        case 'agent-done': {
          const entity = this.entities.get(intent.agent)
          if (!entity) break
          entity.completed = true
          entity.bubble = showBubble('waiting')
          entity.activity = null
          this.stopWorking(entity)
          // Stretch in place; the stretch timer then sends them to the
          // break room to rest (see tick()).
          transition(entity.sim, { kind: 'walk', path: [], goal: 'stretching' })
          break
        }
        case 'agent-error': {
          const entity = this.entities.get(intent.agent)
          if (!entity) break
          entity.bubble = showBubble('error')
          this.stopWorking(entity)
          transition(entity.sim, { kind: 'error' })
          break
        }
        case 'agent-idle': {
          const entity = this.entities.get(intent.agent)
          if (!entity) break
          if (entity.bubble?.kind === 'error') entity.bubble = null
          entity.activity = null
          this.stopWorking(entity)
          transition(entity.sim, { kind: 'recover' })
          transition(entity.sim, { kind: 'stand' })
          break
        }
        case 'agent-activity': {
          const entity = this.entities.get(intent.agent)
          if (!entity) break
          entity.activity = intent.toolName
          // Flavor at the desk: read-shaped tools show the reading animation.
          if (entity.sim.state === 'typing' || entity.sim.state === 'reading') {
            const reading = intent.toolName != null && /^(read|grep|glob|webfetch|websearch)$/i.test(intent.toolName)
            transition(entity.sim, { kind: 'sit', goal: reading ? 'reading' : 'typing' })
          }
          break
        }
        case 'deliver': {
          // Same dispatch seen on both surfaces (telemetry + snapshot
          // backstop): one courier walk per recipient per window.
          const last = this.recentDeliveries.get(intent.toAgent)
          if (last != null && this.clock - last < DELIVERY_DEDUP_SECONDS) break
          this.recentDeliveries.set(intent.toAgent, this.clock)
          const courierName = intent.from === 'manager' ? MANAGER_ID : intent.from
          this.deliver(courierName, intent.toAgent)
          break
        }
        case 'manager-working': {
          const manager = this.entities.get(MANAGER_ID)
          if (!manager || !this.managerHome) break
          // The orchestrator is thinking: the manager works at his desk.
          manager.working = true
          if (manager.sim.state !== 'typing') this.walkTo(manager, this.managerHome, 'typing')
          break
        }
        case 'manager-idle': {
          const manager = this.entities.get(MANAGER_ID)
          if (!manager) break
          this.stopWorking(manager)
          if (manager.sim.state === 'typing' || manager.sim.state === 'reading') {
            transition(manager.sim, { kind: 'stand' })
          }
          break
        }
        case 'permission-wait': {
          const manager = this.entities.get(MANAGER_ID)
          if (manager) manager.bubble = showBubble(intent.bubble)
          break
        }
        case 'permission-clear': {
          const manager = this.entities.get(MANAGER_ID)
          if (
            manager &&
            (manager.bubble?.kind === 'permission' ||
              manager.bubble?.kind === 'plan' ||
              manager.bubble?.kind === 'question')
          ) {
            manager.bubble = null
          }
          break
        }
      }
    }
  }

  /** Guest hot desks (kind 'hot') claimed by working visitors. */
  private claimedHotSeats = new Map<string, string>() // seatId -> agent name

  /**
   * Rest-tile occupancy (couch/bench seats): one body per cushion. An agent
   * heading to rest claims a specific free tile; everyone else stands or
   * finds other seating — nobody ever sits on top of anybody.
   */
  private claimedRestTiles = new Map<string, string>() // "x,y" -> agent name

  /** A free rest tile claimed for the entity, or null when all are taken. */
  private claimRestTile(entity: OfficeEntity): Point | null {
    // Already holding one? Keep it.
    for (const [key, owner] of this.claimedRestTiles) {
      if (owner === entity.name) {
        const [x, y] = key.split(',').map(Number)
        return { x, y }
      }
    }
    const free = this.layout.restTiles.filter((t) => !this.claimedRestTiles.has(`${t.x},${t.y}`))
    if (free.length === 0) return null
    const tile = free[this.ambientRng.nextInt(free.length)]
    this.claimedRestTiles.set(`${tile.x},${tile.y}`, entity.name)
    return tile
  }

  /** Release any rest tile the entity holds (stood up / went to work). */
  private releaseRestTile(entity: OfficeEntity): void {
    for (const [key, owner] of this.claimedRestTiles) {
      if (owner === entity.name) this.claimedRestTiles.delete(key)
    }
  }

  /**
   * The work spot for an agent: its dedicated desk, else a claimed guest
   * desk (remote-work office / spare cluster desks), else a couch where the
   * guest sits and works from a laptop. Null only in a degenerate layout.
   */
  private workSpot(entity: OfficeEntity): Point | null {
    if (entity.seat) return entity.seat.tile
    // Already claimed a hot desk?
    for (const [seatId, owner] of this.claimedHotSeats) {
      if (owner === entity.name) {
        const seat = this.layout.seats.find((s) => s.id === seatId)
        if (seat) return seat.tile
      }
    }
    const free = this.layout.seats.find(
      (s) => s.kind === 'hot' && s.agent == null && !this.claimedHotSeats.has(s.id),
    )
    if (free) {
      this.claimedHotSeats.set(free.id, entity.name)
      return free.tile
    }
    return this.hotSpot(entity)
  }

  /** Release a guest's claimed hot desk when they stop working. */
  private stopWorking(entity: OfficeEntity): void {
    entity.working = false
    for (const [seatId, owner] of this.claimedHotSeats) {
      if (owner === entity.name) this.claimedHotSeats.delete(seatId)
    }
  }

  /** Walk to a FREE cushion and rest; stand in place when the couches are full. */
  private goRest(entity: OfficeEntity): void {
    const tile = this.claimRestTile(entity)
    if (tile) this.walkTo(entity, tile, 'resting')
    else transition(entity.sim, { kind: 'stand' })
  }

  /**
   * Walk an agent to its work spot and start typing. Guests without a desk
   * claim a hot desk or work from a couch — still typing (laptop), never
   * "resting": working characters read as working wherever they sit.
   * `viaMail` routes the trip through the mail room first (memo pickup).
   */
  private sendToWork(agentName: string, viaMail: boolean): void {
    const entity = this.entities.get(agentName)
    if (!entity) return
    transition(entity.sim, { kind: 'recover' })
    const target = this.workSpot(entity)
    if (!target) return
    const from = { x: Math.round(entity.sim.x), y: Math.round(entity.sim.y) }
    let path = this.pathfinder.find(from, target)
    if (viaMail) {
      const mailRoom = this.layout.rooms.find((r) => r.zone === 'mail')
      const memo = mailRoom?.doorTiles[0]
      if (memo) {
        const leg1 = this.pathfinder.find(from, memo)
        const leg2 = this.pathfinder.find(memo, target)
        if (leg1 && leg2) path = [...leg1, ...leg2]
      }
    }
    if (path) transition(entity.sim, { kind: 'walk', path, goal: 'typing' })
  }

  /** Courier (manager or lead) walks to the recipient's room door with mail. */
  private deliver(courierName: string, toAgent: string): void {
    const courier = this.entities.get(courierName) ?? this.entities.get(MANAGER_ID)
    if (!courier) return
    const seat = seatOf(this.layout, toAgent)
    const room = seat ? this.layout.rooms.find((r) => r.id === seat.roomId) : this.layout.rooms.find((r) => r.zone === 'break')
    const door = room?.doorTiles[0]
    if (!door) return
    courier.bubble = showBubble('dispatch')
    // A working courier (a lead mid-task fanning out specialists) returns to
    // its own desk after the drop; an idle one makes a round trip — drop at
    // the door, then walk home. Nobody loiters at somebody else's door.
    if (!courier.working) {
      const from = { x: Math.round(courier.sim.x), y: Math.round(courier.sim.y) }
      const home = courier.name === MANAGER_ID ? this.managerHome : courier.seat?.tile ?? null
      const leg1 = this.pathfinder.find(from, door)
      const leg2 = home ? this.pathfinder.find(door, home) : null
      if (leg1 && leg2) transition(courier.sim, { kind: 'walk', path: [...leg1, ...leg2], goal: 'idle' })
      else this.walkTo(courier, door, 'idle')
    }
    // The recipient swings by the mail room for the memo, then works.
    const recipient = this.entities.get(toAgent)
    if (recipient) recipient.working = true
    this.sendToWork(toAgent, true)
  }

  private walkTo(entity: OfficeEntity, target: Point, goal: ArrivalGoal): void {
    const from = { x: Math.round(entity.sim.x), y: Math.round(entity.sim.y) }
    const path = this.pathfinder.find(from, target)
    if (path) transition(entity.sim, { kind: 'walk', path, goal })
  }

  /**
   * Refresh per-entity presence from a snapshot: `waiting` marks agents that
   * are not running themselves but have running dispatched children (a lead
   * idle while its specialists work), and the manager mirrors that whenever
   * anyone in the office is working while the orchestrator is not.
   */
  updatePresence(agents: import('../../../shared/types').AgentStateUpdate[]): void {
    const byName = new Map(agents.map((a) => [a.name, a]))
    for (const entity of this.entities.values()) {
      if (entity.role === 'pet' || entity.name === MANAGER_ID) continue
      const agent = byName.get(entity.name)
      if (!agent) continue
      if (agent.status === 'done') entity.completed = true
      const childRunning = getDispatches(agent).some((d) =>
        agents.some((o) => o.status === 'running' && meta<string>(o, 'dispatchParentId', '') === d.id),
      )
      entity.waiting = agent.status !== 'running' && childRunning
    }
    const manager = this.entities.get(MANAGER_ID)
    if (manager) {
      manager.waiting =
        !manager.working &&
        [...this.entities.values()].some((e) => e.working && e.name !== MANAGER_ID && e.role !== 'pet')
    }

    // Meetings convene declaratively: rows sharing a non-empty `atv-meeting`
    // metadata id gather in a meeting room while the id is set (published by
    // the harness; no engine or contract surface involved). Clearing the id
    // releases them back to work/idle via the normal status intents.
    const meetings = new Map<string, OfficeEntity[]>()
    for (const agent of agents) {
      const meetingId = meta<string>(agent, 'atv-meeting', '')
      if (!meetingId) continue
      const entity = this.entities.get(agent.name)
      if (entity) {
        const list = meetings.get(meetingId) ?? []
        list.push(entity)
        meetings.set(meetingId, list)
      }
    }
    const meetingRooms = this.layout.rooms.filter((r) => r.zone === 'meeting')
    let roomIdx = 0
    for (const [meetingId, attendees] of [...meetings.entries()].sort()) {
      const room = meetingRooms[roomIdx % Math.max(1, meetingRooms.length)]
      roomIdx++
      if (!room) break
      attendees.forEach((entity, i) => {
        if (entity.inMeeting === meetingId) return
        entity.inMeeting = meetingId
        const tx = room.interior.x + 1 + (i % Math.max(1, room.interior.w - 2))
        const ty = room.interior.y + 1 + Math.floor(i / Math.max(1, room.interior.w - 2))
        this.walkTo(entity, { x: tx, y: ty }, 'idle')
      })
    }
    for (const entity of this.entities.values()) {
      if (entity.inMeeting && ![...meetings.values()].some((l) => l.includes(entity))) {
        entity.inMeeting = null
        if (entity.working) this.sendToWork(entity.name, false)
      }
    }
  }

  /** Fixed-timestep tick: movement, timed states, bubbles, ambience. */
  tick(dt: number): void {
    this.clock += dt
    this.sceneSettled = true
    for (const entity of this.entities.values()) {
      const result = advanceCharacter(entity.sim, dt)
      // Stretch finished → wander to the break room and rest for a while.
      if (result.timerExpired && entity.sim.state === 'stretching') {
        this.goRest(entity)
      }
      // Resting is a break, not a trap: sit for a stretch of seconds, then
      // stand back up and mill about the office like everyone else.
      if (entity.sim.state === 'resting' && entity.sim.stateTimer === 0) {
        entity.sim.stateTimer = 6 + this.ambientRng.next() * 14
      }
      if (result.timerExpired && entity.sim.state === 'resting') {
        this.releaseRestTile(entity)
        transition(entity.sim, { kind: 'stand' })
      }
      entity.bubble = tickBubble(entity.bubble, dt)
      if (entity.role === 'pet') {
        petWander(entity.sim, this.layout, this.pathfinder, this.ambientRng, dt)
      } else if (entity.working) {
        // Working discipline: no wandering. A working character caught idle
        // (failed walk, freed seat, scene rebuild) is re-sent to its
        // workstation until it is seated and typing — unless it is convened
        // in a meeting, which parks it in the meeting room instead.
        if (!entity.inMeeting && (entity.sim.state === 'idle' || entity.sim.state === 'resting')) {
          this.sendToWork(entity.name, false)
        }
      } else {
        // Wander etiquette: own room + common rooms; never other offices,
        // and never loitering in a hallway — a character that comes to a
        // stop on a corridor tile immediately heads somewhere it belongs.
        const allowed = new Set<string>()
        if (entity.seat) allowed.add(entity.seat.roomId)
        const here = { x: Math.round(entity.sim.x), y: Math.round(entity.sim.y) }
        if (entity.sim.state === 'idle' && !roomAt(this.layout, here)) {
          leaveHallway(entity.sim, this.layout, this.pathfinder, this.ambientRng, allowed)
        } else {
          maybeWander(entity.sim, this.layout, this.pathfinder, this.ambientRng, dt, allowed)
        }
      }
    }
    pairChatters(
      [...this.entities.values()].filter((e) => e.role !== 'pet').map((e) => ({ name: e.name, sim: e.sim })),
      this.layout,
    )
  }
}
