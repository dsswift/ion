// @vitest-environment jsdom
/**
 * KeyboardPage — one row per shortcut under its group; clicking a chord
 * captures the next key combination; Escape cancels the capture without
 * reaching the dialog; a click elsewhere cancels; custom and conflicting
 * bindings are marked; Restore all defaults appears only when something is
 * customized.
 */
import React, { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHarness, type Harness } from './page-harness'

vi.mock('../../../../preferences-shortcuts', async (importOriginal) => {
  const entries = [
    { id: 'tab.next', group: 'Navigation', description: 'Next tab', defaultBinding: 'Mod+l' },
    { id: 'tab.close', group: 'Navigation', description: 'Close tab', defaultBinding: 'Mod+w' },
    { id: 'panel.inbox', group: 'Panels', description: 'Toggle inbox', defaultBinding: 'Mod+1' },
  ]
  return {
    ...(await importOriginal<object>()),
    getCatalogForView: () => entries,
    getGroupsForView: () => ['Navigation', 'Panels', 'Empty'],
    resolveViewBindings: (_view: string, overrides: Record<string, string>) => {
      const shortcuts = entries.map((entry) => ({ entry, binding: overrides[entry.id] ?? entry.defaultBinding, conflictsWith: undefined as string | undefined }))
      for (const a of shortcuts) {
        const other = shortcuts.find((b) => b !== a && b.binding === a.binding)
        if (other) a.conflictsWith = other.entry.description
      }
      return { shortcuts, activeBindings: new Map() }
    },
  }
})
vi.mock('../../settings-target', async () => {
  const { create } = await import('zustand')
  return { useSettingsPreferences: create<Record<string, unknown>>(() => ({})) }
})

const { useSettingsPreferences } = await import('../../settings-target')
const { KeyboardPage } = await import('../KeyboardPage')

const setKeyboardShortcut = vi.fn()
const resetKeyboardShortcut = vi.fn()
const resetAllKeyboardShortcuts = vi.fn()
const setOverrides = (studio: Record<string, string>): void => {
  ;(useSettingsPreferences as unknown as { setState(s: object, replace: boolean): void }).setState({
    keyboardShortcuts: { overlay: {}, studio }, setKeyboardShortcut, resetKeyboardShortcut, resetAllKeyboardShortcuts,
  }, true)
}

let h: Harness
beforeEach(() => { setKeyboardShortcut.mockReset(); resetKeyboardShortcut.mockReset(); resetAllKeyboardShortcuts.mockReset(); setOverrides({}); h = createHarness() })
afterEach(() => h.unmount())

const press = async (init: KeyboardEventInit): Promise<void> => {
  await act(async () => { document.body.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })) })
}

describe('KeyboardPage', () => {
  it('renders one group per non-empty shortcut group, no overlay column, and the persistence note', async () => {
    await h.render(<KeyboardPage />)
    const groups = [...h.container.querySelectorAll('section[aria-label]')].map((s) => s.getAttribute('aria-label'))
    expect(groups).toEqual(['Customizations', 'Navigation', 'Panels'])
    expect(h.container.textContent).not.toContain('Overlay')
    expect(h.container.textContent).toContain('~/.ion/settings.json')
    expect(h.container.querySelector('[data-settings-anchor="shortcuts"]')).not.toBeNull()
    expect(h.maybeControl('Restore all defaults')).toBeUndefined()
  })

  it('captures the next chord and saves it for the studio view', async () => {
    await h.render(<KeyboardPage />)
    await h.click('Shortcut for Next tab')
    expect(h.container.textContent).toContain('Press keys…')
    await press({ key: 'Shift' })
    expect(setKeyboardShortcut).not.toHaveBeenCalled()
    await press({ key: 'k', metaKey: true, shiftKey: true })
    expect(setKeyboardShortcut).toHaveBeenCalledWith('studio', 'tab.next', 'Mod+Shift+k')
    expect(h.container.textContent).not.toContain('Press keys…')
  })

  it('cancels on Escape without letting the key reach the dialog', async () => {
    const dialogEscape = vi.fn()
    document.addEventListener('keydown', dialogEscape)
    try {
      await h.render(<KeyboardPage />)
      await h.click('Shortcut for Close tab')
      await press({ key: 'Escape' })
      expect(h.container.textContent).not.toContain('Press keys…')
      expect(dialogEscape).not.toHaveBeenCalled()
      expect(setKeyboardShortcut).not.toHaveBeenCalled()
    } finally {
      document.removeEventListener('keydown', dialogEscape)
    }
  })

  it('cancels on a click elsewhere', async () => {
    await h.render(<KeyboardPage />)
    await h.click('Shortcut for Close tab')
    await act(async () => { document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })) })
    expect(h.container.textContent).not.toContain('Press keys…')
  })

  it('marks custom and conflicting bindings, resets one, and restores all', async () => {
    setOverrides({ 'tab.next': 'Mod+w', 'panel.inbox': 'Mod+9' })
    await h.render(<KeyboardPage />)
    expect(h.container.textContent).toContain('conflict')
    expect(h.container.textContent).toContain('custom')
    expect(h.container.textContent).toContain('2 shortcuts differ from the default.')
    const resets = [...h.container.querySelectorAll('button[aria-label="Reset to default"]')]
    expect(resets).toHaveLength(2)
    await act(async () => { (resets[0] as HTMLButtonElement).click() })
    expect(resetKeyboardShortcut).toHaveBeenCalledWith('studio', 'tab.next')
    await h.click('Restore all defaults')
    expect(resetAllKeyboardShortcuts).toHaveBeenCalledTimes(1)
  })
})
