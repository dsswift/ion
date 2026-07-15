/**
 * Shared fixtures for generator tests: a minimal GenTheme (capability-
 * complete furniture set + dressing templates) and agent-state builders that
 * produce the dispatch attribution shapes the roster derivation consumes.
 */
import type { AgentStateUpdate } from '../../../../shared/types'
import type { AtvDressingTemplate, AtvFurnitureManifest } from '../../../../shared/types-atv'
import type { GenTheme } from '../types'

function furniture(partial: Partial<AtvFurnitureManifest> & { id: string }): AtvFurnitureManifest {
  return {
    name: partial.id,
    category: 'work',
    footprintW: 1,
    footprintH: 1,
    width: 16,
    height: 16,
    rotationScheme: 'none',
    images: { default: 'default.png' },
    ...partial,
  } as AtvFurnitureManifest
}

export function testTheme(): GenTheme {
  const items: AtvFurnitureManifest[] = [
    furniture({ id: 'desk', footprintW: 2, width: 32, rotationScheme: '2-way', images: { front: 'f.png', side: 's.png' }, isSurface: true }),
    furniture({ id: 'chair', rotationScheme: '3-way-mirror', images: { down: 'd.png', up: 'u.png', right: 'r.png' }, seatTiles: [{ x: 0, y: 0, dir: 'down' }] }),
    furniture({ id: 'pc', images: undefined, states: { on: 'on.png', off: 'off.png' }, canPlaceOnSurfaces: true }),
    furniture({ id: 'plant', category: 'decor' }),
    furniture({ id: 'board', footprintW: 2, width: 32, canPlaceOnWalls: true }),
    furniture({ id: 'sofa', category: 'relax', footprintW: 2, width: 32, seatTiles: [{ x: 0, y: 0, dir: 'down' }, { x: 1, y: 0, dir: 'down' }] }),
    furniture({ id: 'mail-station', category: 'mail', footprintW: 2, width: 32, height: 32 }),
    furniture({ id: 'exec-desk', category: 'manager', footprintW: 3, width: 48, rotationScheme: '2-way', images: { front: 'f.png', side: 's.png' }, isSurface: true }),
  ]
  const dressing = new Map<string, AtvDressingTemplate>([
    ['department', {
      zone: 'department',
      floor: 'carpet',
      required: [
        { id: 'desk', perSeat: true },
        { id: 'chair', perSeat: true },
        { id: 'pc', perSeat: true },
        { id: 'board', wallItem: true, count: 1 },
      ],
      optional: [{ id: 'plant', weight: 2, max: 2 }],
      density: 0.1,
    }],
    ['manager', {
      zone: 'manager',
      floor: 'plank',
      required: [
        { id: 'exec-desk', count: 1 },
        { id: 'chair', count: 1 },
        { id: 'pc', count: 1 },
      ],
      optional: [{ id: 'plant', weight: 1, max: 1 }],
      density: 0.1,
    }],
    ['mail', { zone: 'mail', floor: 'plank', required: [{ id: 'mail-station', count: 1 }], optional: [], density: 0 }],
    ['break', { zone: 'break', floor: 'plank', required: [{ id: 'sofa', count: 1 }], optional: [{ id: 'plant', weight: 1, max: 2 }], density: 0.1 }],
    ['corridor', { zone: 'corridor', floor: 'plank', required: [], optional: [], density: 0 }],
  ])
  return {
    tileSize: 16,
    furniture: new Map(items.map((m) => [m.id, m])),
    floors: ['plank', 'carpet'],
    walls: ['panel'],
    dressing,
  }
}

let dispatchCounter = 0

export function rootAgent(name: string, dispatchIds: string[] = []): AgentStateUpdate {
  return {
    name,
    status: 'running',
    metadata: {
      dispatchDepth: 1,
      dispatchParentId: '',
      dispatches: dispatchIds.map((id) => ({ id, task: 't', model: 'm', conversationId: 'c', status: 'running' })),
    },
  } as unknown as AgentStateUpdate
}

export function childAgent(name: string, parentDispatchId: string, dispatchIds: string[] = []): AgentStateUpdate {
  return {
    name,
    status: 'running',
    metadata: {
      dispatchDepth: 2,
      dispatchParentId: parentDispatchId,
      dispatches: dispatchIds.map((id) => ({ id, task: 't', model: 'm', conversationId: 'c', status: 'running' })),
    },
  } as unknown as AgentStateUpdate
}

export function freshDispatchId(): string {
  return `d${++dispatchCounter}`
}

/** A lead with `n` specialists plus the lead's own dispatch attribution. */
export function department(leadName: string, specialistNames: string[]): AgentStateUpdate[] {
  const dispatchIds = specialistNames.map(() => freshDispatchId())
  const lead = rootAgent(leadName, dispatchIds)
  const specialists = specialistNames.map((name, i) => childAgent(name, dispatchIds[i]))
  return [lead, ...specialists]
}
