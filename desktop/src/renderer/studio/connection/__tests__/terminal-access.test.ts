// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { LOCAL_ENVIRONMENT_ID } from '@ion/shared/types-environments'

vi.mock('../../../rendererLogger', () => ({ rWarn: vi.fn(), rInfo: vi.fn(), rDebug: vi.fn(), rError: vi.fn() }))
const sessionState = {
  tabs: [
    { id: 'local-tab', workingDirectory: '/repo' },
    { id: 'remote-tab', workingDirectory: '/srv', environmentId: 'env-remote' },
  ],
  settledHistory: [] as unknown[],
  activeTabId: 'local-tab',
}
vi.mock('@ion/server/store/sessionStore', () => ({ useSessionStore: { getState: () => sessionState } }))

import { useEnvironmentSettingsStore, canOperateTerminal } from '../../state/environment-settings-store'
import { activeTerminalAccess, terminalAccessFor, terminalAccessForTab } from '../terminal-access'

const CHAT_ONLY = ['conversations:read', 'conversations:operate'] as const
const FULL = ['conversations:read', 'conversations:operate', 'terminal:operate', 'git:write'] as const

beforeEach(() => {
  useEnvironmentSettingsStore.setState({ byEnvironment: {} })
  sessionState.activeTabId = 'local-tab'
})

describe('terminal access', () => {
  it('is withheld until the server has said what this connection may do', () => {
    expect(terminalAccessFor(LOCAL_ENVIRONMENT_ID)).toBe(false)
    expect(activeTerminalAccess()).toBe(false)
  })

  it('is withheld from a connection granted only the chat scopes', () => {
    useEnvironmentSettingsStore.getState().hydrate(LOCAL_ENVIRONMENT_ID, {}, CHAT_ONLY)
    expect(terminalAccessFor(LOCAL_ENVIRONMENT_ID)).toBe(false)
    expect(canOperateTerminal(useEnvironmentSettingsStore.getState(), LOCAL_ENVIRONMENT_ID)).toBe(false)
  })

  it('is granted by terminal:operate, and by admin, as the server grants it', () => {
    useEnvironmentSettingsStore.getState().hydrate(LOCAL_ENVIRONMENT_ID, {}, FULL)
    expect(terminalAccessFor(LOCAL_ENVIRONMENT_ID)).toBe(true)
    useEnvironmentSettingsStore.getState().hydrate(LOCAL_ENVIRONMENT_ID, {}, ['admin'])
    expect(terminalAccessFor(LOCAL_ENVIRONMENT_ID)).toBe(true)
  })

  it('is decided per server, so a conversation answers for the server it lives on', () => {
    useEnvironmentSettingsStore.getState().hydrate(LOCAL_ENVIRONMENT_ID, {}, FULL)
    useEnvironmentSettingsStore.getState().hydrate('env-remote', {}, CHAT_ONLY)
    expect(terminalAccessForTab('local-tab')).toBe(true)
    expect(terminalAccessForTab('remote-tab')).toBe(false)
    sessionState.activeTabId = 'remote-tab'
    expect(activeTerminalAccess()).toBe(false)
  })

  it('is lost when the server stops reporting the scope', () => {
    useEnvironmentSettingsStore.getState().hydrate(LOCAL_ENVIRONMENT_ID, {}, FULL)
    useEnvironmentSettingsStore.getState().clear(LOCAL_ENVIRONMENT_ID)
    expect(terminalAccessFor(LOCAL_ENVIRONMENT_ID)).toBe(false)
  })
})
