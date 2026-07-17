/**
 * The shipped ion-works pack must load through the same public loader path a
 * user pack uses — zero special-casing. This test reads the real committed
 * pack bytes from desktop/resources with a filesystem asset source, so it
 * guards the placeholder pack today and every future art drop identically:
 * if a sprite's dimensions drift from its manifest, this fails.
 */
import { describe, it, expect } from 'vitest'
import { existsSync, readdirSync, readFileSync } from 'fs'
import { join, resolve } from 'path'
import { loadTheme, type AtvAssetSource } from '../loader'
import { nullDecode } from './test-helpers'
import type { AtvRawPackBundle } from '../../../../shared/types-atv'

const THEMES_ROOT = resolve(__dirname, '../../../../../resources/atv/themes')

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf-8'))
}

/** Filesystem asset source over desktop/resources/atv/themes. */
function fsSource(): AtvAssetSource {
  return {
    listThemes: async () =>
      readdirSync(THEMES_ROOT).map((id) => ({ id, name: id, version: '0.0.0', builtin: true })),
    readBundle: async (packId) => {
      const root = join(THEMES_ROOT, packId)
      if (!existsSync(join(root, 'theme.json'))) return null
      const bundle: AtvRawPackBundle = {
        packId,
        builtin: true,
        theme: readJson(join(root, 'theme.json')),
        characters: {},
        pets: {},
        furniture: {},
        floors: {},
        walls: {},
        bubbles: null,
        dressing: {},
      }
      for (const kind of ['characters', 'pets', 'furniture', 'floors', 'walls'] as const) {
        const kindDir = join(root, kind)
        if (!existsSync(kindDir)) continue
        for (const id of readdirSync(kindDir)) {
          const manifest = join(kindDir, id, 'manifest.json')
          if (existsSync(manifest)) bundle[kind][id] = readJson(manifest)
        }
      }
      const bubbles = join(root, 'bubbles', 'manifest.json')
      if (existsSync(bubbles)) bundle.bubbles = readJson(bubbles)
      const dressingDir = join(root, 'dressing')
      if (existsSync(dressingDir)) {
        for (const file of readdirSync(dressingDir)) {
          if (file.endsWith('.json')) bundle.dressing[file.slice(0, -5)] = readJson(join(dressingDir, file))
        }
      }
      return bundle
    },
    readAsset: async (packId, relPath) => {
      const path = join(THEMES_ROOT, packId, relPath)
      if (!existsSync(path)) return null
      const buf = readFileSync(path)
      return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
    },
  }
}

describe('shipped ion-works pack', () => {
  it('loads through the public loader with zero skipped assets', async () => {
    const theme = await loadTheme(fsSource(), 'ion-works', { decode: nullDecode })
    expect(theme.skipped).toEqual([])
    expect(theme.theme.id).toBe('ion-works')
    expect(theme.tileSize).toBe(16)
  })

  it('carries the full inventory with every role castable', async () => {
    const theme = await loadTheme(fsSource(), 'ion-works', { decode: nullDecode })
    // The manager silhouette is exclusive; leads and specialists cast from
    // the wider roster. Every role must be castable from the pool.
    const character = theme.characters.get('mgr-blazer')
    expect(character).toBeDefined()
    expect(character?.manifest.roles).toContain('manager')
    expect(character?.manifest.tintable).toBe(true)
    const pool = [...theme.characters.values()].map((c) => c.manifest)
    for (const role of ['manager', 'lead', 'specialist'] as const) {
      expect(pool.some((c) => c.roles.includes(role)), role).toBe(true)
    }
    // Specialist variety: several distinct sheets, so a full lead roster
    // casts distinct looks rather than tint-only differentiation.
    expect(pool.filter((c) => c.roles.includes('specialist')).length).toBeGreaterThanOrEqual(6)
    expect(theme.pets.size).toBeGreaterThanOrEqual(2)
    // Every capability class is represented.
    expect(theme.furniture.get('desk')?.manifest.rotationScheme).toBe('2-way')
    expect(theme.furniture.get('chair-ergo')?.manifest.rotationScheme).toBe('3-way-mirror')
    expect(Object.keys(theme.furniture.get('pc')?.images ?? {})).toEqual(expect.arrayContaining(['on', 'off']))
    expect(theme.furniture.get('server-rack')?.manifest.frames).toBe(2)
    expect(theme.furniture.get('whiteboard')?.manifest.canPlaceOnWalls).toBe(true)
    expect(theme.furniture.get('sofa')?.manifest.seatTiles?.length).toBe(2)
    expect(theme.furniture.has('mail-station')).toBe(true)
    expect(theme.furniture.has('exec-desk')).toBe(true)
    expect(theme.furniture.has('plant-small')).toBe(true)
    // Floors (one tintable), walls, all four bubbles, pet, dressing.
    expect(theme.floors.get('carpet-neutral')?.manifest.tintable).toBe(true)
    expect(theme.floors.has('plank-birch')).toBe(true)
    expect(theme.walls.has('graphite-panel')).toBe(true)
    expect(theme.pets.has('volt-cat')).toBe(true)
    for (const zone of ['department', 'manager', 'mail', 'break', 'meeting', 'lobby', 'corridor']) {
      expect(theme.dressing.has(zone), zone).toBe(true)
    }
  })

  it('the corridor floor is exclusive: no room template shares the hallway flooring', async () => {
    const theme = await loadTheme(fsSource(), 'ion-works', { decode: nullDecode })
    const corridor = theme.dressing.get('corridor')
    expect(corridor?.floor).toBeTruthy()
    for (const [zone, template] of theme.dressing) {
      if (zone === 'corridor') continue
      expect(template.floor, `${zone} shares the corridor floor`).not.toBe(corridor!.floor)
    }
  })
})
