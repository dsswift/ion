// @vitest-environment jsdom
/**
 * Engine profiles on Agent rules: the list, the edit and add panels (name,
 * extension files through the picker, default mode), and Delete, which asks
 * first. A remote server's profiles load from and save to its settings.json.
 */
import React, { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EngineProfile } from '@ion/shared/types'
import { createHarness, flush, type Harness } from './page-harness'

const prefs = vi.hoisted(() => ({
  state: {
    engineProfiles: [] as EngineProfile[],
    addEngineProfile: vi.fn(),
    updateEngineProfile: vi.fn(),
    removeEngineProfile: vi.fn(),
  },
}))
vi.mock('../../../../preferences', () => ({ usePreferencesStore: (sel: (s: typeof prefs.state) => unknown) => sel(prefs.state) }))
const env = vi.hoisted(() => ({ id: 'local', label: 'This Mac', isLocal: true }))
vi.mock('../../settings-servers', () => ({ useSettingsEnvironment: () => ({ ...env, justAdded: false }) }))
const shell = vi.hoisted(() => ({
  capabilities: ['pickFile'] as string[],
  selectExtensionFiles: vi.fn(async (): Promise<string[]> => ['/ext/review.ts']),
  loadSettings: vi.fn(async (): Promise<Record<string, unknown>> => ({})),
  saveSettings: vi.fn(async () => undefined),
}))
vi.mock('../../../../host/host-instance', () => ({ host: { capabilities: () => shell.capabilities, shell } }))
vi.mock('../../../../studio/connection/tab-environment', () => ({ withTargetEnvironment: (_env: string, fn: () => unknown) => fn() }))
vi.mock('../../../../theme', () => ({ useColors: () => new Proxy({}, { get: () => '#000' }) }))
vi.mock('../../../PopoverLayer', () => ({ usePopoverLayer: () => document.body }))
vi.mock('../../../../rendererLogger', () => ({ rInfo: vi.fn(), rWarn: vi.fn(), rDebug: vi.fn(), rError: vi.fn() }))

const { EngineProfilesSection } = await import('../agent/EngineProfilesSection')

const COS: EngineProfile = { id: 'p1', name: 'cos', extensions: ['/ext/a.ts', '/ext/b.ts'], defaultMode: 'plan' }

function type(el: HTMLInputElement, value: string): void {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, value)
  el.dispatchEvent(new Event('input', { bubbles: true }))
}

describe('EngineProfilesSection', () => {
  let h: Harness
  beforeEach(() => {
    vi.clearAllMocks()
    Object.assign(env, { id: 'local', label: 'This Mac', isLocal: true })
    shell.capabilities = ['pickFile']
    prefs.state.engineProfiles = [COS]
    h = createHarness()
  })
  afterEach(() => { h.unmount(); document.body.querySelectorAll('[role="menu"]').forEach((m) => m.remove()) })

  it('lists each profile with its extension count and default mode', async () => {
    await h.render(<EngineProfilesSection />)
    const row = h.container.querySelector('[role="listitem"]')!
    expect(row.textContent).toContain('cos')
    expect(row.textContent).toContain('2 extensions')
    expect(row.textContent).toContain('Plan')
  })

  it('edits a profile: removes an extension, adds one from the picker, changes the mode, and saves', async () => {
    await h.render(<EngineProfilesSection />)
    await act(async () => { (h.container.querySelector('[role="listitem"]') as HTMLElement).click(); await flush() })
    await h.click('Remove extension')
    await h.click('Add extension')
    await h.click('Auto')
    await h.click('Save')
    expect(prefs.state.updateEngineProfile).toHaveBeenCalledWith('p1', { id: 'p1', name: 'cos', extensions: ['/ext/b.ts', '/ext/review.ts'], defaultMode: 'auto' })
    expect(h.container.querySelector('[role="dialog"]')).toBeNull()
  })

  it('adds a profile only once it has a name and an extension, and hides the picker without the capability', async () => {
    await h.render(<EngineProfilesSection />)
    await h.click('Add profile')
    expect((h.control('Save') as HTMLButtonElement).disabled).toBe(true)
    act(() => type(h.container.querySelector<HTMLInputElement>('input[aria-label="Profile name"]')!, 'review'))
    expect((h.control('Save') as HTMLButtonElement).disabled).toBe(true)
    await h.click('Add extension')
    await h.click('Save')
    expect(prefs.state.addEngineProfile).toHaveBeenCalledWith(expect.objectContaining({ name: 'review', extensions: ['/ext/review.ts'], defaultMode: 'auto' }))

    shell.capabilities = []
    await h.click('Add profile')
    expect(h.maybeControl('Add extension')).toBeUndefined()
  })

  it('deletes only after the confirmation', async () => {
    await h.render(<EngineProfilesSection />)
    await h.click('More actions')
    const del = [...document.body.querySelectorAll<HTMLButtonElement>('[role="menu"] button')].find((b) => b.textContent === 'Delete')!
    await act(async () => { del.click(); await flush() })
    expect(prefs.state.removeEngineProfile).not.toHaveBeenCalled()
    expect(h.container.querySelector('[role="dialog"]')?.getAttribute('aria-label')).toBe('Delete cos?')
    const confirm = [...h.container.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find((b) => b.textContent === 'Delete')!
    await act(async () => { confirm.click(); await flush() })
    expect(prefs.state.removeEngineProfile).toHaveBeenCalledWith('p1')
  })

  it('loads and saves a remote server’s profiles through its settings', async () => {
    Object.assign(env, { id: 'oscar', label: 'Oscar', isLocal: false })
    shell.loadSettings.mockResolvedValue({ engineProfiles: [COS] })
    await h.render(<EngineProfilesSection />)
    expect(h.container.querySelector('[role="listitem"]')?.textContent).toContain('cos')
    await h.click('More actions')
    const del = [...document.body.querySelectorAll<HTMLButtonElement>('[role="menu"] button')].find((b) => b.textContent === 'Delete')!
    await act(async () => { del.click(); await flush() })
    const confirm = [...h.container.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find((b) => b.textContent === 'Delete')!
    await act(async () => { confirm.click(); await flush() })
    expect(shell.saveSettings).toHaveBeenCalledWith({ engineProfiles: [] })
    expect(prefs.state.removeEngineProfile).not.toHaveBeenCalled()
  })
})
