// @vitest-environment jsdom
import React from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../../../theme', () => ({ useColors: () => new Proxy({}, { get: () => '#000000' }) }))
vi.mock('../../../rendererLogger', () => ({ rDebug: vi.fn() }))
vi.mock('../../../preferences', () => ({
  usePreferencesStore: (selector: (state: Record<string, unknown>) => unknown) => selector({
    expandedUI: false, setExpandedUI: vi.fn(), ultraWide: false, setUltraWide: vi.fn(),
    selectedTheme: 'ion-dark', setSelectedTheme: vi.fn(), expandToolResults: false, setExpandToolResults: vi.fn(),
    unifiedTurnView: false, setUnifiedTurnView: vi.fn(), defaultTallConversation: false, setDefaultTallConversation: vi.fn(),
    defaultTallTerminal: false, setDefaultTallTerminal: vi.fn(), editorWordWrap: false, setEditorWordWrap: vi.fn(),
    editorFontSize: 14, setEditorFontSize: vi.fn(), dataViewFontSize: 14, setDataViewFontSize: vi.fn(),
    closeExplorerOnFileOpen: false, setCloseExplorerOnFileOpen: vi.fn(),
    hideOnExternalLaunch: false, setHideOnExternalLaunch: vi.fn(), openMarkdownInPreview: false, setOpenMarkdownInPreview: vi.fn(),
    terminalFontFamily: '', setTerminalFontFamily: vi.fn(), terminalFontSize: 14, setTerminalFontSize: vi.fn(), enterprisePolicy: undefined,
  }),
}))

import { registerCustomThemes } from '../../../theme-tokens'

let AppearanceCategory: typeof import('../AppearanceCategory').AppearanceCategory

const pack = (id: string, diagnostics: { ios?: Array<{ message: string; fatal: boolean }>; desktop?: Array<{ message: string; fatal: boolean }> }) => ({
  id, name: id, version: '1', base: 'ion-dark' as const, tokens: {},
  iosDiagnostics: diagnostics.ios?.map((d) => ({ surface: 'ios' as const, ...d })),
  desktopDiagnostics: diagnostics.desktop?.map((d) => ({ surface: 'desktop' as const, ...d })),
})

let container: HTMLDivElement
let root: Root

beforeAll(async () => {
  ;(window as unknown as { ion: { listFonts: () => Promise<string[]> } }).ion = { listFonts: async () => [] }
  AppearanceCategory = (await import('../AppearanceCategory')).AppearanceCategory
})

beforeEach(() => {
  registerCustomThemes([])
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => { act(() => root.unmount()); container.remove(); registerCustomThemes([]) })

async function render(): Promise<void> { await act(async () => { root.render(<AppearanceCategory />) }) }

describe('AppearanceCategory theme-pack diagnostics', () => {
  it('renders rejected, degraded, and desktop diagnostic cards', async () => {
    registerCustomThemes([
      pack('rejected-ios', { ios: [{ message: 'ios.base rejected', fatal: true }] }),
      pack('degraded-ios', { ios: [{ message: 'optional token fallback', fatal: false }] }),
      pack('rejected-desktop', { desktop: [{ message: 'desktop.base rejected', fatal: true }] }),
    ])
    await render()
    expect(container.textContent).toContain('rejected-ios: iOS theme not loaded')
    expect(container.textContent).toContain('degraded-ios: iOS theme loaded with defaults')
    expect(container.textContent).toContain('rejected-desktop: Desktop theme not loaded')
  })

  it('updates diagnostic cards when live theme registry refreshes', async () => {
    await render()
    expect(container.textContent).not.toContain('fresh diagnostic')
    await act(async () => { registerCustomThemes([pack('live-pack', { ios: [{ message: 'fresh diagnostic', fatal: false }] })]) })
    expect(container.textContent).toContain('fresh diagnostic')
  })
})
