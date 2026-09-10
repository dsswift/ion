import { describe, it, expect, vi, beforeEach } from 'vitest'
import { DEFAULT_MONO_FONT } from '../typography'

// Correcting SETTINGS_DEFAULTS fixes nothing for an existing install: the old
// macOS-only stack was written to settings.json on every profile that ever
// saved a setting, and a persisted value beats a default. Measured on the
// Windows endpoint -- settings.json held "Menlo, Monaco, monospace" after the
// default was already corrected, so the terminal would still have wrapped.
const LEGACY_MONO_FONT = 'Menlo, Monaco, monospace'

interface LoadResult {
  font: string
  /** True when the load wrote settings back to disk. */
  saved: boolean
}

async function load(disk: Record<string, unknown>): Promise<LoadResult> {
  vi.resetModules()
  const applied: Record<string, unknown> = {}
  let saved = false
  ;(globalThis as { window?: unknown }).window = {
    ion: {
      loadSettings: () => Promise.resolve(disk),
      saveSettings: () => {
        saved = true
        return Promise.resolve()
      },
    },
  }
  const { loadPersistedSettings } = await import('../preferences-persist')
  await loadPersistedSettings(
    (patch) => Object.assign(applied, patch),
    () => applied as never,
    () => {},
  )
  return { font: applied.terminalFontFamily as string, saved }
}

async function loadWithDisk(disk: Record<string, unknown>): Promise<string> {
  return (await load(disk)).font
}

beforeEach(() => {
  vi.resetModules()
})

describe('terminal font migration', () => {
  it('replaces the legacy macOS-only stack', async () => {
    expect(await loadWithDisk({ terminalFontFamily: LEGACY_MONO_FONT })).toBe(DEFAULT_MONO_FONT)
  })

  it('uses the current stack when nothing is persisted', async () => {
    expect(await loadWithDisk({})).toBe(DEFAULT_MONO_FONT)
  })

  // A font the operator actually chose must survive. The migration matches the
  // legacy string byte-for-byte precisely so a real choice is never clobbered.
  it.each([
    'Fira Code',
    'JetBrains Mono, monospace',
    'Menlo',
    'Monaco, Menlo, monospace',
  ])('keeps the operator-chosen %s', async (font) => {
    expect(await loadWithDisk({ terminalFontFamily: font })).toBe(font)
  })
})

// Applying the migration in memory is not enough. Without a write-back the
// terminal rendered correctly while settings.json still held the legacy stack,
// so the fix was unverifiable from disk and was reported as not working.
describe('terminal font migration persistence', () => {
  it('writes the migrated value back to disk', async () => {
    const { font, saved } = await load({ terminalFontFamily: LEGACY_MONO_FONT })
    expect(font).toBe(DEFAULT_MONO_FONT)
    expect(saved).toBe(true)
  })

  it('does not rewrite settings when nothing migrated', async () => {
    expect((await load({ terminalFontFamily: 'Fira Code' })).saved).toBe(false)
  })

  it('does not rewrite settings for a profile with no saved font', async () => {
    expect((await load({})).saved).toBe(false)
  })
})
