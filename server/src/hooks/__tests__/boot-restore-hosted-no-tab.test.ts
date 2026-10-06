/**
 * A hosted personal instance (`server.json.homeProject`) creates no
 * conversation tab at boot. Nobody is signed in then, so the tab would belong
 * to no one: the engine refuses an unowned conversation to the person who
 * signs in, and the tab would be the only one they could see.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'

const setState = vi.fn()
const createTab = vi.fn(() => ({ tabId: 'boot-tab' }))
let homeProject: unknown = null

vi.mock('../../logger', () => ({ log: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }))
vi.mock('../../config/current', () => ({ currentServerConfig: () => ({ homeProject }) }))
vi.mock('../../store/sessionStore', () => ({
  useSessionStore: {
    getState: () => ({ initStaticInfo: async () => undefined, staticInfo: { homePath: '/data/home/jdoe' }, tabs: [{ id: 'placeholder' }] }),
    setState: (...a: unknown[]) => setState(...a),
  },
}))
vi.mock('../../store/host-api-engine', () => ({ createTab: () => createTab() }))
vi.mock('../../store/host-api-misc', () => ({ loadTabs: async () => ({ tabs: [] }) }))
vi.mock('../../store/host-api', () => ({ reportStartup: vi.fn() }))
vi.mock('../../persistence/preferences', () => ({ usePreferencesStore: { getState: () => ({ defaultBaseDirectory: '/data/home/jdoe/orion' }) } }))
vi.mock('../../ipc-validation', () => ({ isValidProjectPath: () => true }))
vi.mock('../../integration/bench-attribution-support', () => ({ benchForPath: () => null }))
vi.mock('../boot-restore-tab', () => ({ restoreOneTab: vi.fn() }))
vi.mock('../tab-inbox-restore', () => ({ restoreSettledHistoryRecord: (r: unknown) => r }))
vi.mock('../useTabRestoration-helpers', () => ({}))
vi.mock('../useTabRestoration-progress', () => ({}))
vi.mock('../useTabRestoration-geometry', () => ({}))
vi.mock('../useTabRestoration-history', () => ({}))
vi.mock('../useTabRestoration-activity', () => ({}))

import { bootRestoreTabs } from '../boot-restore-tabs'

beforeEach(() => {
  setState.mockClear()
  createTab.mockClear()
})

describe('boot with no saved tabs', () => {
  it('creates no conversation when a home project is configured, and the workspace is ready with none', async () => {
    homeProject = { directory: 'orion', gitRemote: 'git@example.com:team/ops.git', engineProfile: { name: 'orion', extensions: ['/x'] } }
    await bootRestoreTabs()

    expect(createTab).not.toHaveBeenCalled()
    expect(setState).toHaveBeenCalledWith(expect.objectContaining({ tabs: [], activeTabId: '', tabsReady: true }))
  })

  it('still registers the placeholder tab for an instance with no home project', async () => {
    homeProject = null
    await bootRestoreTabs()

    expect(createTab).toHaveBeenCalledTimes(1)
  })
})
