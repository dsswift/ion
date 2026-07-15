import { describe, it, expect } from 'vitest'
import {
  checkDims,
  expectedAnimationDims,
  expectedFurnitureDims,
  pngDimensions,
  validateBubblesManifest,
  validateCharacterManifest,
  validateDressingTemplate,
  validateFloorManifest,
  validateFurnitureManifest,
  validatePetManifest,
  validateThemeManifest,
  validateWallManifest,
} from '../schema'
import { minimalCharacterManifest, pngBytes, TILE } from './test-helpers'
import type { AtvFurnitureManifest } from '../../../../shared/types-atv'

describe('theme manifest validation', () => {
  const valid = {
    id: 'ion-works',
    name: 'Ion Works',
    version: '1.0.0',
    tileSize: 16,
    palette: ['#1a1d24'],
  }

  it('accepts a valid theme.json', () => {
    expect(validateThemeManifest(valid).ok).toBe(true)
  })

  it.each([
    ['bad id', { ...valid, id: 'Bad Id!' }],
    ['bad version', { ...valid, version: 'one' }],
    ['bad tileSize', { ...valid, tileSize: 3 }],
    ['bad palette entry', { ...valid, palette: ['red'] }],
    ['not an object', 'nope'],
  ])('rejects %s', (_label, json) => {
    const result = validateThemeManifest(json)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors.length).toBeGreaterThan(0)
  })
})

describe('character manifest validation', () => {
  it('accepts a valid character', () => {
    expect(validateCharacterManifest(minimalCharacterManifest()).ok).toBe(true)
  })

  it('rejects a character missing a required animation', () => {
    const m = minimalCharacterManifest()
    delete (m.animations as Record<string, unknown>).typing
    const result = validateCharacterManifest(m)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors.join(' ')).toContain('typing')
  })

  it('rejects bad roles and traversal-shaped files', () => {
    const m = minimalCharacterManifest()
    m.roles = ['boss']
    ;(m.animations as Record<string, { file: string; frames: number }>).idle.file = '../escape.png'
    const result = validateCharacterManifest(m)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.errors.join(' ')).toContain('roles')
      expect(result.errors.join(' ')).toContain('idle.file')
    }
  })
})

describe('pet manifest validation', () => {
  it('rejects unknown behavior classes', () => {
    const result = validatePetManifest({
      id: 'pet',
      name: 'Pet',
      behavior: 'attack',
      animations: {
        idle: { file: 'idle.png', frames: 1 },
        'walk-down': { file: 'd.png', frames: 2 },
        'walk-up': { file: 'u.png', frames: 2 },
        'walk-right': { file: 'r.png', frames: 2 },
      },
    })
    expect(result.ok).toBe(false)
  })
})

describe('furniture manifest validation', () => {
  const desk = {
    id: 'desk',
    name: 'Desk',
    category: 'work',
    footprintW: 2,
    footprintH: 1,
    width: 32,
    height: 16,
    rotationScheme: '2-way',
    images: { front: 'front.png', side: 'side.png' },
  }

  it('accepts a valid 2-way item', () => {
    expect(validateFurnitureManifest(desk).ok).toBe(true)
  })

  it('rejects wrong variant keys for the rotation scheme', () => {
    const result = validateFurnitureManifest({ ...desk, images: { front: 'front.png' } })
    expect(result.ok).toBe(false)
  })

  it('rejects both images and states populated', () => {
    const result = validateFurnitureManifest({
      ...desk,
      states: { on: 'on.png' },
    })
    expect(result.ok).toBe(false)
  })

  it('rejects neither images nor states', () => {
    const result = validateFurnitureManifest({ ...desk, images: null })
    expect(result.ok).toBe(false)
  })

  it('rejects malformed seatTiles', () => {
    const result = validateFurnitureManifest({
      ...desk,
      seatTiles: [{ x: 0, y: 0, dir: 'diagonal' }],
    })
    expect(result.ok).toBe(false)
  })
})

describe('floor/wall/bubbles/dressing validation', () => {
  it('validates floors and walls', () => {
    expect(validateFloorManifest({ id: 'f', name: 'F', file: 'f.png' }).ok).toBe(true)
    expect(validateFloorManifest({ id: 'f', name: 'F', file: '/abs.png' }).ok).toBe(false)
    expect(validateWallManifest({ id: 'w', name: 'W', file: 'tiles.png' }).ok).toBe(true)
  })

  it('requires all four bubble kinds', () => {
    expect(
      validateBubblesManifest({ waiting: 'w.png', permission: 'p.png', error: 'e.png', dispatch: 'd.png' }).ok,
    ).toBe(true)
    expect(validateBubblesManifest({ waiting: 'w.png' }).ok).toBe(false)
  })

  it('validates dressing templates against their filename zone', () => {
    const template = {
      zone: 'department',
      required: [{ id: 'desk', perSeat: true }],
      optional: [{ id: 'plant', weight: 2 }],
      density: 0.2,
    }
    expect(validateDressingTemplate(template, 'department').ok).toBe(true)
    expect(validateDressingTemplate(template, 'break').ok).toBe(false)
    expect(validateDressingTemplate({ ...template, optional: [{ id: 'plant', weight: 0 }] }, 'department').ok).toBe(false)
  })
})

describe('image geometry', () => {
  it('parses PNG dimensions from IHDR', () => {
    expect(pngDimensions(pngBytes(48, 16))).toEqual({ width: 48, height: 16 })
    expect(pngDimensions(new ArrayBuffer(10))).toBeNull()
  })

  it('computes expected animation strip dims', () => {
    expect(expectedAnimationDims({ file: 'w.png', frames: 4 }, TILE)).toEqual({ width: 64, height: 16 })
  })

  it('swaps footprint for rotated furniture variants', () => {
    const manifest = {
      id: 'desk',
      name: 'Desk',
      category: 'work',
      footprintW: 2,
      footprintH: 1,
      width: 32,
      height: 16,
      rotationScheme: '2-way',
      images: { front: 'front.png', side: 'side.png' },
    } as unknown as AtvFurnitureManifest
    expect(expectedFurnitureDims(manifest, 'front', TILE).width).toBe(32)
    expect(expectedFurnitureDims(manifest, 'side', TILE).width).toBe(16)
  })

  it('checkDims flags wrong widths and non-tile-multiple heights', () => {
    expect(checkDims({ width: 32, height: 16 }, { width: 32, minHeight: 16 }, TILE, 'x')).toBeNull()
    expect(checkDims({ width: 30, height: 16 }, { width: 32, minHeight: 16 }, TILE, 'x')).toContain('width')
    expect(checkDims({ width: 32, height: 20 }, { width: 32, minHeight: 16 }, TILE, 'x')).toContain('multiple')
  })
})
