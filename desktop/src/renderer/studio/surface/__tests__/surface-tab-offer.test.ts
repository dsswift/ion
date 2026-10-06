// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { LOCAL_ENVIRONMENT_ID } from '@ion/shared/types-environments'

vi.mock('../../../rendererLogger', () => ({ rWarn: vi.fn(), rInfo: vi.fn(), rDebug: vi.fn(), rError: vi.fn() }))
vi.mock('@ion/server/store/sessionStore', () => ({
  useSessionStore: { getState: () => ({ tabs: [{ id: 'tab-1', workingDirectory: '/repo' }], settledHistory: [], activeTabId: 'tab-1' }) },
}))

import { policyStore } from '../../connection/policy-store'
import { useEnvironmentSettingsStore } from '../../state/environment-settings-store'
import { gitPanelOffered, surfaceTabOffered, surfaceTabOfferedNow } from '../surface-tab-offer'

const ALL_ON = { sourceControl: true, commitGraph: true, repositoryStatus: true, worktrees: true }

beforeEach(() => {
  policyStore._resetForTest()
  useEnvironmentSettingsStore.setState({ byEnvironment: {} })
})

describe('surface tab offer', () => {
  it('keeps the Git panel while either the changes list or the graph is on', () => {
    expect(gitPanelOffered({ ...ALL_ON, sourceControl: false })).toBe(true)
    expect(gitPanelOffered({ ...ALL_ON, commitGraph: false })).toBe(true)
    expect(gitPanelOffered({ ...ALL_ON, sourceControl: false, commitGraph: false })).toBe(false)
  })

  it('ties the Diff tab to source control and leaves every other tab alone', () => {
    const off = { ...ALL_ON, sourceControl: false, commitGraph: false }
    expect(surfaceTabOffered('diff', off, true)).toBe(false)
    expect(surfaceTabOffered('gitpanel', off, true)).toBe(false)
    expect(surfaceTabOffered('plan', off, true)).toBe(true)
    expect(surfaceTabOffered('files', off, true)).toBe(true)
  })

  it('answers for the active conversation\'s machine', () => {
    expect(surfaceTabOfferedNow('gitpanel')).toBe(true)
    policyStore.setDeveloperSurfaces(LOCAL_ENVIRONMENT_ID, { ...ALL_ON, sourceControl: false, commitGraph: false })
    expect(surfaceTabOfferedNow('gitpanel')).toBe(false)
    expect(surfaceTabOfferedNow('diff')).toBe(false)
  })

  it('ties terminal tabs and the Ports tab to terminal access', () => {
    expect(surfaceTabOffered('terminal:abc', ALL_ON, false)).toBe(false)
    expect(surfaceTabOffered('ports', ALL_ON, false)).toBe(false)
    expect(surfaceTabOffered('terminal:abc', ALL_ON, true)).toBe(true)
    expect(surfaceTabOffered('ports', ALL_ON, true)).toBe(true)
    // Nothing else depends on it.
    expect(surfaceTabOffered('files', ALL_ON, false)).toBe(true)
    expect(surfaceTabOffered('plan', ALL_ON, false)).toBe(true)
    expect(surfaceTabOffered('file:/a/b.ts', ALL_ON, false)).toBe(true)
  })

  it('offers a terminal tab now only to a connection the server granted terminal:operate', () => {
    // No welcome yet: no scopes, no terminal.
    expect(surfaceTabOfferedNow('ports')).toBe(false)
    useEnvironmentSettingsStore.getState().hydrate(LOCAL_ENVIRONMENT_ID, {}, ['conversations:read', 'conversations:operate'])
    expect(surfaceTabOfferedNow('ports')).toBe(false)
    expect(surfaceTabOfferedNow('terminal:abc')).toBe(false)
    expect(surfaceTabOfferedNow('files')).toBe(true)
    useEnvironmentSettingsStore.getState().hydrate(LOCAL_ENVIRONMENT_ID, {}, ['conversations:read', 'conversations:operate', 'terminal:operate'])
    expect(surfaceTabOfferedNow('ports')).toBe(true)
    expect(surfaceTabOfferedNow('terminal:abc')).toBe(true)
  })
})
