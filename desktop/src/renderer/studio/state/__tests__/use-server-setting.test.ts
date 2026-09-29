// @vitest-environment jsdom
/**
 * A surface acting on a conversation reads that conversation's server's
 * setting. The bug: every surface read the app-wide preference store, which is
 * the LOCAL server's, so a conversation on another server got this machine's
 * commit command, quick tools, and land strategy.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../host/host-instance', () => ({ host: { onFrame: () => () => undefined }, action: vi.fn() }))
vi.mock('../../../rendererLogger', () => ({ rInfo: vi.fn(), rWarn: vi.fn(), rDebug: vi.fn(), rError: vi.fn() }))
vi.mock('../../connection/tab-environment', () => ({ useActiveTabEnvironmentId: () => 'env-remote' }))
const prefs = vi.hoisted(() => ({ state: { commitCommand: '/local-commit', worktreeCompletionStrategy: 'merge-ff', quickTools: [{ id: 'local-tool' }] } as Record<string, unknown> }))
vi.mock('../../../preferences', () => ({
  usePreferencesStore: Object.assign((sel: (s: Record<string, unknown>) => unknown) => sel(prefs.state), { getState: () => prefs.state }),
}))

import { useEnvironmentSettingsStore } from '../environment-settings-store'
import { isCompletionStrategy, isQuickToolList, isString, serverSettingOf } from '../use-server-setting'

beforeEach(() => {
  useEnvironmentSettingsStore.setState({ byEnvironment: {} })
})

describe('serverSettingOf', () => {
  it('reads the local server from the app-wide store', () => {
    expect(serverSettingOf('local', 'commitCommand', isString, '')).toBe('/local-commit')
  })

  it('reads another server from what that server sent, never the local value', () => {
    useEnvironmentSettingsStore.getState().hydrate('env-remote', { commitCommand: '/remote-commit', worktreeCompletionStrategy: 'pr', quickTools: [{ id: 'remote-tool' }] }, [])
    expect(serverSettingOf('env-remote', 'commitCommand', isString, '')).toBe('/remote-commit')
    expect(serverSettingOf('env-remote', 'worktreeCompletionStrategy', isCompletionStrategy, 'merge-ff')).toBe('pr')
    expect(serverSettingOf('env-remote', 'quickTools', isQuickToolList, [])).toEqual([{ id: 'remote-tool' }])
  })

  it('falls back, not to the local value, when that server has not said', () => {
    expect(serverSettingOf('env-remote', 'commitCommand', isString, '')).toBe('')
    expect(serverSettingOf('env-remote', 'quickTools', isQuickToolList, [])).toEqual([])
  })

  it('falls back when that server sent a malformed value', () => {
    useEnvironmentSettingsStore.getState().hydrate('env-remote', { worktreeCompletionStrategy: 'yolo' }, [])
    expect(serverSettingOf('env-remote', 'worktreeCompletionStrategy', isCompletionStrategy, 'merge-ff')).toBe('merge-ff')
  })
})
