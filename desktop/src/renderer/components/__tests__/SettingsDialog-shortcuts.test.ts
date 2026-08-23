import { describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

vi.mock('@phosphor-icons/react', () => ({ Keyboard: () => null }))
vi.mock('../../theme', () => ({ useColors: () => ({ textPrimary: '', textSecondary: '', textTertiary: '', inputBorder: '' }) }))
vi.mock('../../preferences', () => ({
  usePreferencesStore: (selector: any) => selector({
    keyboardShortcuts: { overlay: {}, studio: {} },
    setKeyboardShortcut: () => {},
    resetKeyboardShortcut: () => {},
    resetKeyboardShortcuts: () => {},
  }),
}))
vi.mock('../../preferences-shortcuts', () => ({
  getCatalogForView: () => [],
  getGroupsForView: () => [],
  resolveViewBindings: () => ({ shortcuts: [] }),
}))
vi.mock('../settings/ShortcutRow', () => ({ ShortcutRow: () => null }))
vi.mock('../settings/SettingHeading', () => ({ SettingHeading: (props: any) => props.children }))

describe('SettingsDialog keyboard shortcuts', () => {
  it('search indexes keyboard shortcut settings', async () => {
    const { searchSettings } = await import('../settings/settings-search-index')
    for (const query of ['keyboard', 'shortcut', 'keybinding', 'hotkey']) {
      expect(searchSettings(query).has('shortcuts')).toBe(true)
    }
  })

  it('renders independent Overlay and Studio shortcut columns', async () => {
    const { KeyboardShortcutsCategory } = await import('../settings/KeyboardShortcutsCategory')
    const html = renderToStaticMarkup(createElement(KeyboardShortcutsCategory))
    expect(html).toContain('Overlay')
    expect(html).toContain('Studio')
    expect(html).toContain('data-testid="shortcut-columns"')
    expect(html).not.toContain('overflow-x:auto')
  })
})
