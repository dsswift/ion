// @vitest-environment jsdom
/**
 * PresetsSection — Apply never changes settings on its own; it opens a
 * confirmation listing what changes, and only Confirm applies the preset.
 */
import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHarness, type Harness } from './page-harness'

vi.mock('../../../../rendererLogger', () => ({ rInfo: vi.fn(), rWarn: vi.fn(), rError: vi.fn(), rDebug: vi.fn() }))
vi.mock('../../settings-target', async () => {
  const { create } = await import('zustand')
  return { useSettingsPreferences: create<Record<string, unknown>>(() => ({})) }
})

const { useSettingsPreferences } = await import('../../settings-target')
const { PresetsSection } = await import('../PresetsSection')
const applyPreset = vi.fn()

let h: Harness
beforeEach(() => {
  applyPreset.mockReset()
  ;(useSettingsPreferences as unknown as { setState(s: object, replace: boolean): void }).setState({ applyPreset }, true)
  h = createHarness()
})
afterEach(() => h.unmount())

describe('PresetsSection', () => {
  it('asks before overwriting, then applies the preset values', async () => {
    await h.render(<PresetsSection />)
    const applyButtons = [...h.container.querySelectorAll('button')].filter((b) => b.textContent === 'Apply')
    expect(applyButtons).toHaveLength(2)
    await h.click('Apply')
    expect(applyPreset).not.toHaveBeenCalled()
    expect(h.container.textContent).toContain('Overwrite current settings?')
    expect(h.container.textContent).toContain('Permission mode: Auto')
    await h.click('Confirm')
    expect(applyPreset).toHaveBeenCalledWith({ defaultPermissionMode: 'auto', expandToolResults: false, bashCommandEntry: false, showTodoList: false })
    expect(h.container.textContent).not.toContain('Overwrite current settings?')
  })

  it('cancel closes the confirmation without applying', async () => {
    await h.render(<PresetsSection />)
    await h.click('Apply')
    await h.click('Cancel')
    expect(applyPreset).not.toHaveBeenCalled()
    expect(h.container.textContent).not.toContain('Overwrite current settings?')
  })
})
