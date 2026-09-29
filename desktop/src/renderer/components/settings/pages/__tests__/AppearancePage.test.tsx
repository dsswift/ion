// @vitest-environment jsdom
/**
 * AppearancePage — no overlay-era rows; theme-pack diagnostics follow the
 * live registry; an organization lock pins the displayed theme and disables
 * the picker; font steppers stay inside 8–24; the interface scale steps by
 * 10% and resets.
 */
import React, { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHarness, type Harness } from './page-harness'

vi.mock('../../../../rendererLogger', () => ({ rDebug: vi.fn(), rInfo: vi.fn(), rWarn: vi.fn(), rError: vi.fn() }))
vi.mock('../../../../host/host-instance', () => ({ host: { capabilities: () => ['nativeShell'], shell: { listFonts: async () => ['Menlo', 'Fira Code'] } } }))
vi.mock('../../settings-target', async () => {
  const { create } = await import('zustand')
  return { useSettingsPreferences: create<Record<string, unknown>>(() => ({})) }
})

const { useSettingsPreferences } = await import('../../settings-target')
const { registerCustomThemes } = await import('../../../../theme-tokens')
const { AppearancePage } = await import('../AppearancePage')

const setters = {
  setSelectedTheme: vi.fn(), setExpandToolResults: vi.fn(), setUnifiedTurnView: vi.fn(), setEditorWordWrap: vi.fn(), setEditorFontSize: vi.fn(),
  setDataViewFontSize: vi.fn(), setOpenMarkdownInPreview: vi.fn(), setTerminalFontFamily: vi.fn(), setTerminalFontSize: vi.fn(), setUiZoom: vi.fn(),
}

const pack = (id: string, d: { ios?: Array<{ message: string; fatal: boolean }>; desktop?: Array<{ message: string; fatal: boolean }> }) => ({
  id, name: id, version: '1', base: 'ion-dark' as const, tokens: {},
  iosDiagnostics: d.ios?.map((x) => ({ surface: 'ios' as const, ...x })),
  desktopDiagnostics: d.desktop?.map((x) => ({ surface: 'desktop' as const, ...x })),
})

let h: Harness
beforeEach(() => {
  for (const fn of Object.values(setters)) fn.mockReset()
  registerCustomThemes([])
  ;(useSettingsPreferences as unknown as { setState(s: object, replace: boolean): void }).setState({
    ...setters, selectedTheme: 'ion-dark', expandToolResults: false, unifiedTurnView: false, editorWordWrap: false, editorFontSize: 24,
    dataViewFontSize: 8, openMarkdownInPreview: false, terminalFontFamily: 'Menlo', terminalFontSize: 13, uiZoom: 1.2, enterprisePolicy: undefined,
  }, true)
  h = createHarness()
})
afterEach(() => { h.unmount(); registerCustomThemes([]) })

describe('AppearancePage', () => {
  it('omits the retired overlay toggles and carries every appearance row', async () => {
    await h.render(<AppearancePage />)
    for (const label of ['Full Width', 'Ultra Wide', 'Default Tall Mode', 'Close Explorer on File Open', 'Close Explorer on External Launch']) {
      expect(h.container.textContent, label).not.toContain(label)
    }
    expect(h.container.textContent).toContain('Theme')
    expect(h.container.textContent).toContain('Open Markdown in Preview')
    for (const anchor of ['theme', 'tool-output', 'unified-turn', 'markdown-preview', 'word-wrap', 'editor-font', 'data-font', 'ui-zoom', 'terminal-font']) {
      expect(h.container.querySelector(`[data-settings-anchor="${anchor}"]`), anchor).not.toBeNull()
    }
  })

  it('renders rejected, degraded, and desktop theme diagnostics', async () => {
    registerCustomThemes([
      pack('rejected-ios', { ios: [{ message: 'ios.base rejected', fatal: true }] }),
      pack('degraded-ios', { ios: [{ message: 'optional token fallback', fatal: false }] }),
      pack('rejected-desktop', { desktop: [{ message: 'desktop.base rejected', fatal: true }] }),
    ])
    await h.render(<AppearancePage />)
    expect(h.container.textContent).toContain('rejected-ios: iOS theme not loaded')
    expect(h.container.textContent).toContain('degraded-ios: iOS theme loaded with defaults')
    expect(h.container.textContent).toContain('rejected-desktop: Desktop theme not loaded')
    expect(h.container.textContent).toContain('ios.base rejected')
  })

  it('updates diagnostics when the live theme registry refreshes', async () => {
    await h.render(<AppearancePage />)
    expect(h.container.textContent).not.toContain('fresh diagnostic')
    await act(async () => { registerCustomThemes([pack('live-pack', { ios: [{ message: 'fresh diagnostic', fatal: false }] })]) })
    expect(h.container.textContent).toContain('fresh diagnostic')
  })

  it('shows the enforced theme and disables the picker under an organization lock', async () => {
    ;(useSettingsPreferences as unknown as { setState(s: object): void }).setState({ enterprisePolicy: { customFields: { 'ion-desktop': { themePolicy: { themeId: 'ion-light', locked: true } } } } })
    await h.render(<AppearancePage />)
    const select = h.control('Color theme') as HTMLSelectElement
    expect(h.container.textContent).toContain('Theme is managed by your organization.')
    expect(select.disabled).toBe(true)
    expect(select.value).toBe('ion-light')
  })

  it('clamps font steppers to 8–24 and steps the interface scale by 10%', async () => {
    await h.render(<AppearancePage />)
    await h.click('Increase Editor font size')
    expect(setters.setEditorFontSize).toHaveBeenCalledWith(24)
    await h.click('Decrease Data view font size')
    expect(setters.setDataViewFontSize).toHaveBeenCalledWith(8)
    await h.click('Increase Terminal font size')
    expect(setters.setTerminalFontSize).toHaveBeenCalledWith(14)
    expect(h.container.textContent).toContain('120%')
    await h.click('Decrease Interface scale')
    expect(setters.setUiZoom).toHaveBeenLastCalledWith(expect.closeTo(1.1, 5))
    await h.click('Reset')
    expect(setters.setUiZoom).toHaveBeenLastCalledWith(1)
  })

  it('lists OS fonts for the terminal when the shell is native', async () => {
    await h.render(<AppearancePage />)
    const options = [...(h.control('Terminal font') as HTMLSelectElement).options].map((o) => o.value)
    expect(options).toEqual(['Menlo', 'Fira Code'])
  })
})
