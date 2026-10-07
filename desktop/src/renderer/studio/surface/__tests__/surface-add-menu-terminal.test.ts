// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../rendererLogger', () => ({ rWarn: vi.fn(), rInfo: vi.fn(), rDebug: vi.fn(), rError: vi.fn() }))
vi.mock('@ion/server/store/sessionStore', () => ({ useSessionStore: { getState: () => ({ tabs: [], settledHistory: [], activeTabId: '' }) } }))

import { SURFACE_ADD_ENTRIES, type AddEntryContext } from '../SurfaceAddMenu'

const ALL_ON = { sourceControl: true, commitGraph: true, repositoryStatus: true, worktrees: true, profiling: true }
const ctx = (over: Partial<AddEntryContext>): AddEntryContext => ({
  graphViewAvailable: true,
  browserTabAvailable: true,
  portForwardAvailable: true,
  developerSurfaces: ALL_ON,
  terminalAccess: true,
  ...over,
})
const offered = (c: AddEntryContext): string[] => SURFACE_ADD_ENTRIES.filter((e) => e.available?.(c) !== false).map((e) => e.id)

describe('the canvas "add tab" menu', () => {
  it('lists Terminal and Ports for a connection with terminal:operate', () => {
    expect(offered(ctx({}))).toEqual(expect.arrayContaining(['terminal', 'ports']))
  })

  it('lists neither for a connection without it, and still lists everything else', () => {
    const without = offered(ctx({ terminalAccess: false }))
    expect(without).not.toContain('terminal')
    expect(without).not.toContain('ports')
    expect(without).toEqual(expect.arrayContaining(['files', 'gitpanel', 'diff', 'browser']))
  })
})
