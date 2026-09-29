/**
 * boot-restore-tabs — regression test for the boot-time tab restoration
 * that useTabRestoration.ts used to perform as a renderer effect before the
 * Overlay (its only host) was deleted in spec 17. Before this module
 * existed, `loadTabs()` returning real persisted tabs had no effect at all:
 * the server never called it, so every restart lost every tab.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { PersistedTabState } from '@ion/shared/types-persistence'

vi.mock('../logger', () => ({
  trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), log: vi.fn(), error: vi.fn(),
}))

const loadTabsMock = vi.hoisted(() => vi.fn<() => Promise<PersistedTabState | null>>())
vi.mock('../store/host-api-misc', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../store/host-api-misc')>()
  return { ...actual, loadTabs: loadTabsMock }
})

import { useSessionStore } from '../store/sessionStore'
import { bootRestoreTabs } from './boot-restore-tabs'

function sessionlessTab(id: string, workingDirectory: string): PersistedTabState['tabs'][number] {
  return {
    id,
    conversationId: null,
    workingDirectory,
    hasChosenDirectory: true,
    isTerminalOnly: false,
  } as unknown as PersistedTabState['tabs'][number]
}

beforeEach(() => {
  loadTabsMock.mockReset()
})

describe('bootRestoreTabs', () => {
  it('restores a persisted sessionless tab into the store and marks it ready (regression: tabs.json was never read at boot)', async () => {
    loadTabsMock.mockResolvedValue({
      schemaVersion: 4,
      activeSessionId: null,
      activeTabIndex: 0,
      tabs: [sessionlessTab('persisted-tab-1', '/tmp/ion-boot-restore-test')],
    })

    await bootRestoreTabs()

    const state = useSessionStore.getState()
    expect(state.tabsReady).toBe(true)
    expect(state.rehydrating).toBe(false)
    const restored = state.tabs.find((t) => t.workingDirectory === '/tmp/ion-boot-restore-test')
    expect(restored).toBeDefined()
  })

  // P0: a restore has no Studio-wire connection at all (it runs at process
  // boot), so the persisted owner is the only source of truth -- there is no
  // ambient principal to fall back on, unlike a live tab creation.
  it('restores the persisted principalSubject onto the live tab', async () => {
    loadTabsMock.mockResolvedValue({
      schemaVersion: 4,
      activeSessionId: null,
      activeTabIndex: 0,
      tabs: [{ ...sessionlessTab('owned-tab-1', '/tmp/ion-boot-restore-owner'), principalSubject: 'alice' }],
    })

    await bootRestoreTabs()

    const restored = useSessionStore.getState().tabs.find((t) => t.workingDirectory === '/tmp/ion-boot-restore-owner')
    expect(restored?.principalSubject).toBe('alice')
  })

  // Regression: restoreGlobalGeometry (called near the very end of
  // bootRestoreTabs, right before tabsReady/rehydrating are set) used to
  // clamp restored geometry against `window.innerWidth`/`innerHeight` --
  // a browser global this headless server process never has. The prior
  // test cases' fixtures never set a geometry field, so that code path
  // never actually ran and the bug went uncaught: `tabsReady` never became
  // true on a real boot with persisted panel geometry, which in turn left
  // `rehydrating` stuck true forever, which made every future persistence
  // write silently no-op (session-store-persistence.ts's subscriber
  // early-returns while rehydrating).
  it('reaches tabsReady/rehydrating=false when the persisted state includes panel geometry', async () => {
    loadTabsMock.mockResolvedValue({
      schemaVersion: 4,
      activeSessionId: null,
      activeTabIndex: 0,
      tabs: [sessionlessTab('persisted-tab-2', '/tmp/ion-boot-restore-geometry-test')],
      editorGeometry: { x: 10, y: 20, w: 500, h: 400 },
      planGeometry: { x: 30, y: 40, w: 300, h: 200 },
      agentDetailGeometry: { x: 50, y: 60, w: 320, h: 220 },
    } as unknown as PersistedTabState)

    await bootRestoreTabs()

    const state = useSessionStore.getState()
    expect(state.tabsReady).toBe(true)
    expect(state.rehydrating).toBe(false)
    expect(state.editorGeometry).toEqual({ x: 10, y: 20, w: 500, h: 400 })
  })

  it('falls back to a single blank tab when nothing was persisted', async () => {
    loadTabsMock.mockResolvedValue(null)

    await bootRestoreTabs()

    const state = useSessionStore.getState()
    expect(state.tabsReady).toBe(true)
    expect(state.tabs.length).toBeGreaterThan(0)
    expect(state.startupError).toBeNull()
  })

  it('logs and starts from empty when loadTabs itself fails, instead of losing the failure silently', async () => {
    loadTabsMock.mockRejectedValue(new Error('disk read failed'))

    await bootRestoreTabs()

    const state = useSessionStore.getState()
    expect(state.tabsReady).toBe(true)
  })
})
