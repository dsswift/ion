// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { LOCAL_ENVIRONMENT_ID } from '@ion/shared/types-environments'

vi.mock('../../../rendererLogger', () => ({ rWarn: vi.fn(), rInfo: vi.fn(), rDebug: vi.fn(), rError: vi.fn() }))
vi.mock('@ion/server/store/sessionStore', () => ({
  useSessionStore: { getState: () => ({ tabs: [{ id: 'tab-1', workingDirectory: '/repo' }], settledHistory: [], activeTabId: 'tab-1' }) },
}))

import { policyStore } from '../../connection/policy-store'
import { gitPanelOffered, surfaceTabOffered, surfaceTabOfferedNow } from '../surface-tab-offer'

const ALL_ON = { sourceControl: true, commitGraph: true, repositoryStatus: true, worktrees: true }

beforeEach(() => { policyStore._resetForTest() })

describe('surface tab offer', () => {
  it('keeps the Git panel while either the changes list or the graph is on', () => {
    expect(gitPanelOffered({ ...ALL_ON, sourceControl: false })).toBe(true)
    expect(gitPanelOffered({ ...ALL_ON, commitGraph: false })).toBe(true)
    expect(gitPanelOffered({ ...ALL_ON, sourceControl: false, commitGraph: false })).toBe(false)
  })

  it('ties the Diff tab to source control and leaves every other tab alone', () => {
    const off = { ...ALL_ON, sourceControl: false, commitGraph: false }
    expect(surfaceTabOffered('diff', off)).toBe(false)
    expect(surfaceTabOffered('gitpanel', off)).toBe(false)
    expect(surfaceTabOffered('plan', off)).toBe(true)
    expect(surfaceTabOffered('files', off)).toBe(true)
  })

  it('answers for the active conversation\'s machine', () => {
    expect(surfaceTabOfferedNow('gitpanel')).toBe(true)
    policyStore.setDeveloperSurfaces(LOCAL_ENVIRONMENT_ID, { ...ALL_ON, sourceControl: false, commitGraph: false })
    expect(surfaceTabOfferedNow('gitpanel')).toBe(false)
    expect(surfaceTabOfferedNow('diff')).toBe(false)
  })
})
