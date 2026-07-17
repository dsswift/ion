/**
 * createAtvEngine — wires generation, simulation, and rendering behind a
 * small imperative API the React shell drives. The shell owns retargeting
 * policy (regenerate only on tab switch or seed change); the engine owns
 * everything below that line.
 */
import type { AgentStateUpdate, NormalizedEvent } from '../../../shared/types'
import { generateOffice } from '../generation'
import { deriveRoster } from '../generation/roster'
import type { LoadedTheme } from '../theme/loader'
import type { CastableCharacter } from '../theme/casting'
import type { GenTheme } from '../generation/types'
import { OfficeState } from './office-state'
import { diffSnapshots, eventIntents, type Intent } from './mapping'
import { createGameLoop, type GameLoop } from './loop'
import { SceneFx } from './scene-fx'
import { advanceReplay, makeReplayState, seekReplay } from './replay'
import { dispatchChainOf } from './chain'
import { centeredCamera, clampCamera, fitCamera, renderOffice, type Camera } from './render'
import type { OfficeEntity } from './office-state'

export interface AtvEngine {
  /** Rebuild the office (tab switch or seed change) and place the roster. */
  setScene(seed: string, agents: AgentStateUpdate[], events: NormalizedEvent[]): void
  /** Apply a fresh agent-state snapshot. Returns the intents it produced (for logging). */
  pushSnapshot(agents: AgentStateUpdate[]): Intent[]
  /** Apply newly arrived cross-cutting events. Returns the intents produced. */
  pushEvents(events: NormalizedEvent[]): Intent[]
  /** Manual integer zoom (leaves fit mode). */
  setZoom(zoom: number): void
  /** Fit-to-window mode: the whole office stays visible, rescaling on resize. */
  zoomToFit(): void
  /** Pan the manual-zoom view by canvas pixels (leaves fit mode). */
  panBy(dx: number, dy: number): void
  /** Scroll-wheel zoom step centered on the cursor (leaves fit mode). */
  wheelZoom(canvasX: number, canvasY: number, direction: 1 | -1): void
  /** Current view state for the toolbar ('fit' or the manual zoom factor). */
  getView(): { mode: 'fit' | 'manual' | 'follow'; zoom: number }
  /** Hit-test a canvas coordinate against the characters (tooltips). */
  getEntityAt(canvasX: number, canvasY: number): OfficeEntity | null
  /** Hit-test rooms and desks for hover labels (whose room, whose desk). */
  getSpotAt(canvasX: number, canvasY: number): { title: string; lines: string[] } | null
  /** Toggle the footstep-heat overlay. */
  setHeatOverlay(on: boolean): void
  /** Feed live dashboard data (dispatch statuses, cost sparkline). */
  setDashboardData(data: { dispatchStatuses: string[]; sparkline: number[]; conversationCostUsd: number }): void
  /** Enter replay over recorded frames (freezes live feeds). */
  startReplay(frames: import('../state/recorder').ReplayFrame[]): void
  /** Replay transport controls. */
  setReplayPlaying(playing: boolean): void
  setReplaySpeed(speed: import('./replay').ReplaySpeed): void
  replaySeek(tMs: number): void
  /** Return to live (re-applies the latest live snapshot on the next push). */
  stopReplay(): void
  /** Replay transport state (null when live). */
  getReplay(): { clockMs: number; startMs: number; endMs: number; playing: boolean; speed: number } | null
  /**
   * Follow-cam / focus-mode cycle for an agent: 1st call follows (camera
   * tracks the entity), 2nd call highlights its dispatch chain (others dim),
   * 3rd (or null) clears. Pan/zoom input also exits follow.
   */
  cycleFollow(agentName: string | null): 'follow' | 'focus' | 'off'
  /** Generation problems for the toolbar to surface (empty when healthy). */
  getSceneErrors(): string[]
  destroy(): void
}

function genThemeOf(theme: LoadedTheme): GenTheme {
  return {
    tileSize: theme.tileSize,
    furniture: new Map([...theme.furniture].map(([id, f]) => [id, f.manifest])),
    floors: [...theme.floors.keys()],
    walls: [...theme.walls.keys()],
    dressing: theme.dressing,
  }
}

function castPoolOf(theme: LoadedTheme): CastableCharacter[] {
  return [...theme.characters.values()].map((c) => ({
    id: c.manifest.id,
    roles: c.manifest.roles,
    tintable: c.manifest.tintable,
  }))
}

/** Structural identity of a roster: same structure ⇒ same office layout. */
function rosterSignature(roster: ReturnType<typeof deriveRoster>): string {
  const depts = roster.departments
    .map((d) => `${d.lead.name}(${d.specialists.map((s) => s.name).join(',')})`)
    .sort()
  return `${depts.join(';')}|${roster.executives.map((e) => e.name).join(',')}|${roster.solo.map((s) => s.name).join(',')}`
}

export function createAtvEngine(canvas: HTMLCanvasElement, theme: LoadedTheme): AtvEngine {
  let office: OfficeState | null = null
  let fx: SceneFx | null = null
  let heatOn = false
  let prevAgents: AgentStateUpdate[] = []
  // Replay mode: when set, live pushes are ignored and the loop advances
  // the replay clock, feeding due frames through the same intent pipeline.
  let replay: { frames: import('../state/recorder').ReplayFrame[]; state: import('./replay').ReplayState; endMs: number } | null = null
  let sceneErrors: string[] = []
  let loop: GameLoop | null = null
  // View state: fit mode keeps the whole office visible (rescaling with the
  // window); manual mode is user zoom + pan.
  let viewMode: 'fit' | 'manual' | 'follow' = 'fit'
  let followName: string | null = null
  let followFocused = false
  let manualZoom = 2
  let manualCamera: Camera | null = null
  let lastCamera: Camera | null = null

  function currentCamera(): Camera | null {
    if (!office) return null
    if (viewMode === 'follow' && followName) {
      const entity = office.entities.get(followName)
      if (entity) {
        const zoom = Math.max(3, manualZoom)
        const goalX = canvas.width / 2 - (entity.sim.x + 0.5) * theme.tileSize * zoom
        const goalY = canvas.height / 2 - (entity.sim.y + 0.5) * theme.tileSize * zoom
        // Exponential lerp toward the target for a smooth chase.
        const prev = lastCamera && lastCamera.zoom === zoom ? lastCamera : { zoom, offsetX: goalX, offsetY: goalY }
        return {
          zoom,
          offsetX: prev.offsetX + (goalX - prev.offsetX) * 0.12,
          offsetY: prev.offsetY + (goalY - prev.offsetY) * 0.12,
        }
      }
    }
    if (viewMode === 'fit' || viewMode === 'follow') {
      return fitCamera(office.layout, theme.tileSize, canvas.width, canvas.height)
    }
    if (!manualCamera || manualCamera.zoom !== manualZoom) {
      manualCamera = centeredCamera(office.layout, theme.tileSize, canvas.width, canvas.height, manualZoom)
    }
    return clampCamera(manualCamera, office.layout, theme.tileSize, canvas.width, canvas.height)
  }

  function render(animClock: number): void {
    const ctx = canvas.getContext('2d')
    if (!ctx || !office) return
    const camera = currentCamera()
    if (!camera) return
    lastCamera = camera
    renderOffice(ctx, office, theme, camera, animClock, fx)
  }

  function ensureLoop(): void {
    if (loop) return
    loop = createGameLoop((dt) => {
      if (replay && office) {
        const due = advanceReplay(replay.state, replay.frames, dt, replay.endMs)
        for (const frame of due) applyReplayFrame(frame)
      }
      office?.tick(dt)
      if (office && fx) fx.tick(dt, office)
    }, render)
    loop.start()
  }

  let sceneKey = ''

  /** Feed one recorded frame through the live intent pipeline. */
  function applyReplayFrame(frame: import('../state/recorder').ReplayFrame): void {
    if (!office) return
    if (frame.kind === 'snapshot') {
      office.syncRoster(deriveRoster(frame.agents))
      office.applyIntents(diffSnapshots(prevAgents, frame.agents))
      office.updatePresence(frame.agents)
      prevAgents = frame.agents
    } else {
      office.applyIntents(eventIntents([frame.event], prevAgents))
    }
  }

  /** Rebuild office state at a replay position (seek / start). */
  function rebuildAtReplayPosition(tMs: number): void {
    if (!replay || !office) return
    const idx = (t: number): number => {
      let best = -1
      for (let i = 0; i < replay!.frames.length; i++) {
        const f = replay!.frames[i]
        if (f.atMs > t) break
        if (f.kind === 'snapshot') best = i
      }
      return best
    }
    const { snapshotIndex, catchup } = seekReplay(replay.state, replay.frames, tMs, idx)
    const base = snapshotIndex >= 0 ? (replay.frames[snapshotIndex] as { agents: AgentStateUpdate[] }).agents : []
    office.syncRoster(deriveRoster(base))
    office.applyIntents(diffSnapshots([], base, { initial: true }))
    office.updatePresence(base)
    prevAgents = base
    for (const frame of catchup) applyReplayFrame(frame)
  }

  return {
    setScene(seed, agents, events) {
      const roster = deriveRoster(agents)
      const key = `${seed}|${rosterSignature(roster)}`
      if (office && key === sceneKey) {
        // Same office (one global seed, same team structure): keep the
        // layout and the characters' continuity — just re-place everyone
        // according to this conversation's snapshot, with no delivery
        // replays and no camera reset.
        office.syncRoster(roster)
        office.applyIntents(diffSnapshots(prevAgents, agents, { initial: true }))
        office.applyIntents(
          eventIntents(events.filter((e) => e.type === 'permission_request' || e.type === 'status'), agents),
        )
        prevAgents = agents
        return
      }
      sceneKey = key
      const result = generateOffice(seed, roster, genThemeOf(theme))
      sceneErrors = result.errors
      office = new OfficeState(result.layout, result.blocked, castPoolOf(theme), [...theme.pets.keys()], seed)
      fx = new SceneFx(result.layout)
      fx.heatEnabled = heatOn
      office.syncRoster(roster)
      // First paint: place everyone according to the snapshot rather than
      // replaying history — running agents are already at their desks, and
      // no delivery animations replay for dispatches that already happened.
      office.applyIntents(diffSnapshots([], agents, { initial: true }))
      office.updatePresence(agents)
      // Permission bubbles and the manager's working state survive a rebuild
      // via the cached events.
      office.applyIntents(eventIntents(events.filter((e) => e.type === 'permission_request' || e.type === 'status'), agents))
      prevAgents = agents
      // A rebuilt office invalidates any manual pan (different geometry).
      manualCamera = null
      ensureLoop()
    },
    startReplay(frames) {
      if (!office || frames.length === 0) return
      replay = {
        frames,
        state: makeReplayState(frames[0].atMs),
        endMs: frames[frames.length - 1].atMs,
      }
      rebuildAtReplayPosition(frames[0].atMs)
    },
    setReplayPlaying(playing) {
      if (replay) replay.state.playing = playing
    },
    setReplaySpeed(speed) {
      if (replay) replay.state.speed = speed
    },
    replaySeek(tMs) {
      rebuildAtReplayPosition(tMs)
    },
    stopReplay() {
      replay = null
      // Live truth returns on the next snapshot push; forget replay agents so
      // the next diff treats the live snapshot as authoritative placement.
      prevAgents = []
    },
    getReplay() {
      if (!replay) return null
      return {
        clockMs: replay.state.clockMs,
        startMs: replay.frames[0].atMs,
        endMs: replay.endMs,
        playing: replay.state.playing,
        speed: replay.state.speed,
      }
    },
    pushSnapshot(agents) {
      if (!office) return []
      if (replay) return [] // replaying: live feed frozen (cache keeps recording)
      office.syncRoster(deriveRoster(agents))
      const intents = diffSnapshots(prevAgents, agents)
      office.applyIntents(intents)
      office.updatePresence(agents)
      prevAgents = agents
      return intents
    },
    pushEvents(events) {
      if (!office) return []
      if (replay) return [] // replaying: live feed frozen
      const intents = eventIntents(events, prevAgents)
      office.applyIntents(intents)
      return intents
    },
    wheelZoom(canvasX, canvasY, direction) {
      const before = lastCamera
      if (!office || !before) return
      const newZoom = Math.max(1, Math.min(6, Math.round((viewMode === 'fit' ? Math.max(1, Math.round(before.zoom)) : manualZoom) + direction)))
      // Keep the tile under the cursor stationary through the zoom change.
      const tx = (canvasX - before.offsetX) / before.zoom
      const ty = (canvasY - before.offsetY) / before.zoom
      manualCamera = {
        zoom: newZoom,
        offsetX: Math.round(canvasX - tx * newZoom),
        offsetY: Math.round(canvasY - ty * newZoom),
      }
      manualZoom = newZoom
      viewMode = 'manual'
      followName = null
      if (fx) fx.focusChain = null
    },
    setZoom(z) {
      // Preserve the current view center across the zoom change so zooming
      // in/out does not snap back to the office center.
      const before = lastCamera
      const newZoom = Math.max(1, Math.min(6, Math.round(z)))
      if (viewMode === 'manual' && before && office) {
        const cx = (canvas.width / 2 - before.offsetX) / before.zoom
        const cy = (canvas.height / 2 - before.offsetY) / before.zoom
        manualCamera = {
          zoom: newZoom,
          offsetX: Math.round(canvas.width / 2 - cx * newZoom),
          offsetY: Math.round(canvas.height / 2 - cy * newZoom),
        }
      } else {
        manualCamera = null
      }
      manualZoom = newZoom
      viewMode = 'manual'
    },
    zoomToFit() {
      viewMode = 'fit'
      manualCamera = null
    },
    panBy(dx, dy) {
      if (viewMode === 'follow') {
        viewMode = 'manual'
        followName = null
        if (fx) fx.focusChain = null
      }
      if (!office) return
      if (viewMode === 'fit') {
        // Panning implies the user wants manual control at the fit zoom.
        const cam = currentCamera()
        if (!cam) return
        viewMode = 'manual'
        manualZoom = Math.max(1, Math.round(cam.zoom))
        manualCamera = { ...cam, zoom: manualZoom }
      }
      if (manualCamera) {
        manualCamera = { ...manualCamera, offsetX: manualCamera.offsetX + dx, offsetY: manualCamera.offsetY + dy }
      }
    },
    getView() {
      return { mode: viewMode, zoom: viewMode === 'fit' ? (lastCamera?.zoom ?? 1) : manualZoom }
    },
    getEntityAt(canvasX, canvasY) {
      if (!office || !lastCamera) return null
      const tile = theme.tileSize
      const tx = (canvasX - lastCamera.offsetX) / (lastCamera.zoom * tile)
      const ty = (canvasY - lastCamera.offsetY) / (lastCamera.zoom * tile)
      let best: OfficeEntity | null = null
      let bestDist = 0.9
      for (const entity of office.entities.values()) {
        // Character sprites anchor at their tile; the body is roughly the
        // tile above the anchor row's bottom, so test against tile centers.
        const dx = tx - (entity.sim.x + 0.5)
        const dy = ty - (entity.sim.y + 0.5)
        const dist = Math.sqrt(dx * dx + dy * dy)
        if (dist < bestDist) {
          best = entity
          bestDist = dist
        }
      }
      return best
    },
    getSpotAt(canvasX, canvasY) {
      if (!office || !lastCamera) return null
      const tile = theme.tileSize
      const tx = Math.floor((canvasX - lastCamera.offsetX) / (lastCamera.zoom * tile))
      const ty = Math.floor((canvasY - lastCamera.offsetY) / (lastCamera.zoom * tile))
      const displayName = (name: string | null): string => {
        if (!name) return ''
        return office?.entities.get(name)?.displayName ?? name
      }
      // Desk first (more specific than the room around it).
      const seat = office.layout.seats.find(
        (s) => Math.abs(s.tile.x - tx) <= 1 && s.tile.y === ty && s.kind !== 'manager',
      )
      if (seat) {
        const owner = seat.agent ? displayName(seat.agent) : seat.kind === 'hot' ? 'guest desk' : 'unassigned desk'
        return { title: owner, lines: [seat.agent ? 'workstation' : 'free workstation'] }
      }
      const room = office.layout.rooms.find(
        (r) => tx >= r.rect.x && tx < r.rect.x + r.rect.w && ty >= r.rect.y && ty < r.rect.y + r.rect.h,
      )
      if (!room) return null
      if (room.zone === 'manager') {
        if (!room.leadAgent) return { title: "Manager's office", lines: ['orchestrator'] }
        // exec-<name> = executive wing (chiefs over leads); office-<name> =
        // a teamless top-level staff member's private office.
        return {
          title: `${displayName(room.leadAgent)}'s office`,
          lines: [room.id.startsWith('exec-') ? 'executive wing' : 'staff office'],
        }
      }
      if (room.zone === 'mail') return { title: 'Mail room', lines: [] }
      if (room.zone === 'break') return { title: 'Break room', lines: [] }
      if (room.zone === 'meeting') return { title: 'Meeting room', lines: [] }
      if (room.zone === 'lobby') return { title: 'Arrivals', lines: ['front door'] }
      if (room.id === 'remote-office') return { title: 'Remote-work office', lines: ['guest desks'] }
      if (room.id === 'bullpen') return { title: 'Bullpen', lines: [] }
      if (room.leadAgent) {
        const inner = room.innerOffice
        const inInner =
          inner && tx >= inner.rect.x && tx < inner.rect.x + inner.rect.w && ty >= inner.rect.y && ty < inner.rect.y + inner.rect.h
        return inInner
          ? { title: `${displayName(room.leadAgent)}'s office`, lines: ['department lead'] }
          : { title: `${displayName(room.leadAgent)}'s department`, lines: [] }
      }
      return null
    },
    cycleFollow(agentName) {
      if (!agentName || (viewMode === 'follow' && followFocused && followName === agentName)) {
        // Clear.
        followName = null
        followFocused = false
        if (fx) fx.focusChain = null
        if (viewMode === 'follow') viewMode = 'fit'
        return 'off'
      }
      if (viewMode === 'follow' && followName === agentName) {
        // Second activation: chain highlight.
        followFocused = true
        if (fx) fx.focusChain = dispatchChainOf(prevAgents, agentName)
        return 'focus'
      }
      followName = agentName
      followFocused = false
      if (fx) fx.focusChain = null
      viewMode = 'follow'
      return 'follow'
    },
    setDashboardData(data) {
      if (fx) fx.dashboardData = data
    },
    setHeatOverlay(on) {
      heatOn = on
      if (fx) fx.heatEnabled = on
    },
    getSceneErrors() {
      return sceneErrors
    },
    destroy() {
      loop?.stop()
      loop = null
      office = null
    },
  }
}
