// @vitest-environment jsdom
/**
 * mod-key.ts is a module-scope singleton (IS_MAC computed once at import
 * time from window.ion.platform / navigator.platform), so each scenario
 * runs in its own vi.resetModules() + dynamic re-import rather than
 * mutating global state and re-reading a cached export.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

const originalIon = (globalThis as { window?: { ion?: unknown } }).window?.ion

beforeEach(() => {
  vi.resetModules()
})

afterEach(() => {
  if (typeof window !== 'undefined') {
    ;(window as unknown as { ion?: unknown }).ion = originalIon
  }
})

describe('isModKey / IS_MAC / MOD_KEY_LABEL', () => {
  it('darwin (via window.ion.platform): metaKey is the mod key', async () => {
    ;(window as unknown as { ion: { platform: string } }).ion = { platform: 'darwin' }
    const { isModKey, IS_MAC, MOD_KEY_LABEL } = await import('./mod-key')
    expect(IS_MAC).toBe(true)
    expect(MOD_KEY_LABEL).toBe('⌘')
    expect(isModKey({ metaKey: true, ctrlKey: false })).toBe(true)
    expect(isModKey({ metaKey: false, ctrlKey: true })).toBe(false)
  })

  it('win32 (via window.ion.platform): ctrlKey is the mod key', async () => {
    ;(window as unknown as { ion: { platform: string } }).ion = { platform: 'win32' }
    const { isModKey, IS_MAC, MOD_KEY_LABEL } = await import('./mod-key')
    expect(IS_MAC).toBe(false)
    expect(MOD_KEY_LABEL).toBe('Ctrl')
    expect(isModKey({ metaKey: true, ctrlKey: false })).toBe(false)
    expect(isModKey({ metaKey: false, ctrlKey: true })).toBe(true)
  })

  it('no bridge, Mac navigator.platform: falls back to metaKey', async () => {
    ;(window as unknown as { ion?: unknown }).ion = undefined
    vi.stubGlobal('navigator', { platform: 'MacIntel' })
    const { isModKey, IS_MAC } = await import('./mod-key')
    expect(IS_MAC).toBe(true)
    expect(isModKey({ metaKey: true, ctrlKey: false })).toBe(true)
    vi.unstubAllGlobals()
  })

  it('no bridge, non-Mac navigator.platform: falls back to ctrlKey', async () => {
    ;(window as unknown as { ion?: unknown }).ion = undefined
    vi.stubGlobal('navigator', { platform: 'Win32' })
    const { isModKey, IS_MAC } = await import('./mod-key')
    expect(IS_MAC).toBe(false)
    expect(isModKey({ metaKey: false, ctrlKey: true })).toBe(true)
    vi.unstubAllGlobals()
  })

  it('isModHeld is the same predicate as isModKey', async () => {
    ;(window as unknown as { ion: { platform: string } }).ion = { platform: 'win32' }
    const { isModKey, isModHeld } = await import('./mod-key')
    const event = { metaKey: false, ctrlKey: true }
    expect(isModHeld(event)).toBe(isModKey(event))
  })
})
