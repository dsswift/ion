import { describe, it, expect } from 'vitest'
import { loadTheme } from '../loader'
import { memorySource, minimalPack, minimalCharacterManifest, pngBytes, nullDecode, TILE } from './test-helpers'

function characterAssets(dir: string): Record<string, ArrayBuffer> {
  return {
    [`${dir}/idle.png`]: pngBytes(TILE, TILE),
    [`${dir}/walk-down.png`]: pngBytes(4 * TILE, TILE),
    [`${dir}/walk-up.png`]: pngBytes(4 * TILE, TILE),
    [`${dir}/walk-right.png`]: pngBytes(4 * TILE, TILE),
    [`${dir}/typing.png`]: pngBytes(2 * TILE, TILE),
    [`${dir}/reading.png`]: pngBytes(2 * TILE, TILE),
  }
}

describe('theme pack extend/replace semantics', () => {
  it('replace mode: standalone pack loads on its own', async () => {
    const base = minimalPack('base-pack')
    const theme = await loadTheme(memorySource([base]), 'base-pack', { decode: nullDecode })
    expect(theme.theme.id).toBe('base-pack')
    expect(theme.characters.has('hero')).toBe(true)
  })

  it('extend mode: new ids merge into the base pool', async () => {
    const base = minimalPack('base-pack')
    const ext = minimalPack('ext-pack', 'base-pack')
    // The extension ships one NEW character and nothing else.
    ext.bundle.characters = { sidekick: minimalCharacterManifest('sidekick') }
    ext.bundle.furniture = {}
    ext.bundle.floors = {}
    ext.bundle.walls = {}
    ext.bundle.bubbles = null
    ext.bundle.dressing = {}
    ext.assets = characterAssets('characters/sidekick')

    const theme = await loadTheme(memorySource([base, ext]), 'ext-pack', { decode: nullDecode })
    expect(theme.characters.has('hero')).toBe(true)
    expect(theme.characters.has('sidekick')).toBe(true)
    // Base assets still load (bubbles come from the base pack).
    expect(theme.theme.extends).toBe('base-pack')
  })

  it('extend mode: id collision overrides the base entry', async () => {
    const base = minimalPack('base-pack')
    const ext = minimalPack('ext-pack', 'base-pack')
    const override = minimalCharacterManifest('hero')
    override.name = 'Override Hero'
    override.tintable = false
    ext.bundle.characters = { hero: override }
    ext.bundle.furniture = {}
    ext.bundle.floors = {}
    ext.bundle.walls = {}
    ext.bundle.bubbles = null
    ext.bundle.dressing = {}
    ext.assets = characterAssets('characters/hero')

    const theme = await loadTheme(memorySource([base, ext]), 'ext-pack', { decode: nullDecode })
    expect(theme.characters.get('hero')?.manifest.name).toBe('Override Hero')
    expect(theme.characters.get('hero')?.manifest.tintable).toBe(false)
  })

  it('rejects an extension whose tileSize mismatches the base', async () => {
    const base = minimalPack('base-pack')
    const ext = minimalPack('ext-pack', 'base-pack')
    ;(ext.bundle.theme as Record<string, unknown>).tileSize = 32
    await expect(loadTheme(memorySource([base, ext]), 'ext-pack', { decode: nullDecode })).rejects.toThrow(/tileSize/)
  })

  it('rejects a chain of extensions (one level only)', async () => {
    const base = minimalPack('base-pack')
    const mid = minimalPack('mid-pack', 'base-pack')
    const top = minimalPack('top-pack', 'mid-pack')
    await expect(loadTheme(memorySource([base, mid, top]), 'top-pack', { decode: nullDecode })).rejects.toThrow(
      /one level only/,
    )
  })

  it('skips invalid assets but fails when minimums are not met', async () => {
    const broken = minimalPack('broken-pack')
    // Corrupt the only manager character's walk strip (wrong width).
    broken.assets['characters/hero/walk-down.png'] = pngBytes(3 * TILE, TILE)
    await expect(loadTheme(memorySource([broken]), 'broken-pack', { decode: nullDecode })).rejects.toThrow(
      /manager role/,
    )
  })

  it('skips an invalid furniture manifest without failing the pack', async () => {
    const pack = minimalPack('mostly-good')
    pack.bundle.furniture.badchair = { id: 'badchair', name: 'Bad' }
    const theme = await loadTheme(memorySource([pack]), 'mostly-good', { decode: nullDecode })
    expect(theme.furniture.has('chair')).toBe(true)
    expect(theme.furniture.has('badchair')).toBe(false)
    expect(theme.skipped.join(' ')).toContain('badchair')
  })
})
