// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { LOCAL_ENVIRONMENT_ID } from '@ion/shared/types-environments'

vi.mock('../../rendererLogger', () => ({ rWarn: vi.fn(), rInfo: vi.fn(), rDebug: vi.fn(), rError: vi.fn() }))

const toggleTerminal = vi.fn(() => Promise.resolve())
const addTerminalInstance = vi.fn(() => Promise.resolve('instance-1'))
const sessionState = {
  tabs: [{ id: 'tab-1', workingDirectory: '/repo' }],
  settledHistory: [] as unknown[],
  activeTabId: 'tab-1',
  terminalOpenTabIds: new Set<string>(),
  toggleTerminal,
  addTerminalInstance,
}
vi.mock('@ion/server/store/sessionStore', () => ({ useSessionStore: { getState: () => sessionState } }))

import { useEnvironmentSettingsStore } from '../state/environment-settings-store'
import { addActiveConversationShell, toggleActiveConversationTerminal } from '../studio-conversation-terminal-commands'

beforeEach(() => {
  vi.clearAllMocks()
  useEnvironmentSettingsStore.setState({ byEnvironment: {} })
})

describe('conversation terminal commands', () => {
  it('toggle the terminal and add a shell for a connection with terminal:operate', () => {
    useEnvironmentSettingsStore.getState().hydrate(LOCAL_ENVIRONMENT_ID, {}, ['conversations:read', 'conversations:operate', 'terminal:operate'])
    toggleActiveConversationTerminal()
    addActiveConversationShell()
    expect(toggleTerminal).toHaveBeenCalledWith('tab-1')
    expect(addTerminalInstance).toHaveBeenCalledWith('tab-1', 'user', '/repo')
  })

  it('do nothing for a connection without it, so a shortcut cannot reach a terminal the server would refuse', () => {
    useEnvironmentSettingsStore.getState().hydrate(LOCAL_ENVIRONMENT_ID, {}, ['conversations:read', 'conversations:operate'])
    toggleActiveConversationTerminal()
    addActiveConversationShell()
    expect(toggleTerminal).not.toHaveBeenCalled()
    expect(addTerminalInstance).not.toHaveBeenCalled()
  })
})
