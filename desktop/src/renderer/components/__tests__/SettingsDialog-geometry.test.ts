// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'

vi.mock('react', async () => ({ ...(await vi.importActual<typeof import('react')>('react')), useState: vi.fn(), useEffect: vi.fn(), useRef: vi.fn(), useCallback: vi.fn(), useMemo: vi.fn() }))
vi.mock('../../theme', () => ({ useColors: () => ({}) }))
vi.mock('../PopoverLayer', () => ({ usePopoverLayer: () => null }))
vi.mock('../../preferences', () => ({
  usePreferencesStore: (selector: (state: { uiZoom: number }) => unknown) => selector({ uiZoom: 1 }),
}))
vi.mock('../../stores/sessionStore', () => ({ useSessionStore: () => null }))
vi.mock('../settings/GeneralCategory', () => ({ GeneralCategory: () => null }))
vi.mock('../settings/AIModelsCategory', () => ({ AIModelsCategory: () => null }))
vi.mock('../settings/AIAssistWorkflowsCategory', () => ({ AIAssistWorkflowsCategory: () => null }))
vi.mock('../settings/GitCategory', () => ({ GitCategory: () => null }))
vi.mock('../settings/TabsPanelsCategory', () => ({ TabsPanelsCategory: () => null }))
vi.mock('../settings/AppearanceCategory', () => ({ AppearanceCategory: () => null }))
vi.mock('../settings/QuickToolsCategory', () => ({ QuickToolsCategory: () => null }))
vi.mock('../settings/NotificationsCategory', () => ({ NotificationsCategory: () => null }))
vi.mock('../settings/RemoteCategory', () => ({ RemoteCategory: () => null }))
vi.mock('../settings/AdvancedCategory', () => ({ AdvancedCategory: () => null }))
vi.mock('../settings/KeyboardShortcutsCategory', () => ({ KeyboardShortcutsCategory: () => null }))
vi.mock('../settings/EntraCategory', () => ({ EntraCategory: () => null }))
vi.mock('../settings/McpCategory', () => ({ McpCategory: () => null }))
vi.mock('../settings/settings-search-index', () => ({ searchSettings: () => new Set() }))
vi.mock('../../viewport-zoom', () => ({
  zoomDelta: (delta: { x: number; y: number }) => delta,
  zoomViewport: () => ({ width: 1200, height: 900 }),
}))

import { resolveSettingsDialogGeometry } from '../SettingsDialog'

describe('SettingsDialog geometry', () => {
  it('centers in CSS viewport coordinates', () => {
    expect(resolveSettingsDialogGeometry({ width: 1200, height: 900 })).toEqual({
      x: 145,
      y: 60,
      width: 910,
      height: 780,
    })
  })

  it('fits and centers in a reduced zoom viewport', () => {
    expect(resolveSettingsDialogGeometry({ width: 700, height: 500 })).toEqual({
      x: 8,
      y: 8,
      width: 684,
      height: 484,
    })
  })
})
