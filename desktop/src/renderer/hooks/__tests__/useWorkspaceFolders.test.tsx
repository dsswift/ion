// @vitest-environment jsdom
/**
 * A Project's extra folders are read from, and saved to, the server of the
 * conversation on screen. The bug: a conversation on another server mounted
 * this machine's folders, and adding one wrote that server's path into this
 * machine's settings.
 */
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const env = vi.hoisted(() => ({ active: 'env-remote', action: vi.fn(async () => ({ ok: true })), localAdd: vi.fn(), localRemove: vi.fn(), pickNative: vi.fn(async () => '/native') }))
vi.mock('../../host/host-instance', () => ({ host: { onFrame: () => () => undefined, pickDirectory: env.pickNative }, action: env.action }))
vi.mock('../../host/save-path-prompt-state', () => ({ promptForDirectory: vi.fn(async () => ({ filePath: '/typed/on/server' })) }))
vi.mock('../../rendererLogger', () => ({ rInfo: vi.fn(), rWarn: vi.fn(), rDebug: vi.fn(), rError: vi.fn() }))
vi.mock('../../studio/connection/tab-environment', () => ({ useActiveTabEnvironmentId: () => env.active }))
const prefs = vi.hoisted(() => ({ state: {} as Record<string, unknown> }))
vi.mock('../../preferences', () => ({
  usePreferencesStore: Object.assign((sel: (s: Record<string, unknown>) => unknown) => sel(prefs.state), { getState: () => prefs.state }),
}))
vi.mock('../../preferences-persist', () => ({ persist: vi.fn() }))

import { useEnvironmentSettingsStore } from '../../studio/state/environment-settings-store'
import { useWorkspaceFolders, type WorkspaceFoldersHandle } from '../useWorkspaceFolders'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function renderHook(): { result: { current: WorkspaceFoldersHandle } } {
  const result = { current: null as unknown as WorkspaceFoldersHandle }
  function Probe(): null { result.current = useWorkspaceFolders(); return null }
  const root = createRoot(document.createElement('div'))
  act(() => root.render(<Probe />))
  return { result }
}

beforeEach(() => {
  env.active = 'env-remote'
  env.action.mockClear(); env.localAdd.mockClear(); env.localRemove.mockClear(); env.pickNative.mockClear()
  prefs.state = { workspaceFolders: { '/local/project': ['/local/lib'] }, addWorkspaceFolder: env.localAdd, removeWorkspaceFolder: env.localRemove }
  useEnvironmentSettingsStore.setState({ byEnvironment: {} })
  useEnvironmentSettingsStore.getState().hydrate('env-remote', { workspaceFolders: { '/srv/project': ['/srv/lib'] } }, [])
})

describe('useWorkspaceFolders', () => {
  it('reads the conversation server\'s folders, not this machine\'s', () => {
    const { result } = renderHook()
    expect(result.current.folders).toEqual({ '/srv/project': ['/srv/lib'] })
  })

  it('saves an added folder to the conversation server and leaves this machine alone', async () => {
    const { result } = renderHook()
    await act(async () => { result.current.add('/srv/project', '/srv/other') })
    expect(env.action).toHaveBeenCalledWith('env-remote', 'settings.save', [{ workspaceFolders: { '/srv/project': ['/srv/lib', '/srv/other'] } }])
    expect(env.localAdd).not.toHaveBeenCalled()
  })

  it('saves a removed folder to the conversation server', async () => {
    const { result } = renderHook()
    await act(async () => { result.current.remove('/srv/project', '/srv/lib') })
    expect(env.action).toHaveBeenCalledWith('env-remote', 'settings.save', [{ workspaceFolders: {} }])
    expect(env.localRemove).not.toHaveBeenCalled()
  })

  it('asks for a typed path on another server, never the native dialog', async () => {
    const { result } = renderHook()
    await expect(result.current.pick('/srv/project')).resolves.toBe('/typed/on/server')
    expect(env.pickNative).not.toHaveBeenCalled()
  })

  it('uses this machine\'s store and dialog for a local conversation', async () => {
    env.active = 'local'
    const { result } = renderHook()
    expect(result.current.folders).toEqual({ '/local/project': ['/local/lib'] })
    result.current.add('/local/project', '/local/x')
    expect(env.localAdd).toHaveBeenCalledWith('/local/project', '/local/x')
    expect(env.action).not.toHaveBeenCalled()
    await expect(result.current.pick()).resolves.toBe('/native')
  })
})
