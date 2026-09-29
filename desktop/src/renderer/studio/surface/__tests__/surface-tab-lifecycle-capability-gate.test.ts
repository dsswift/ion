// @vitest-environment jsdom
/**
 * Capability gate (spec 18): a browser-kind surface tab's record can arrive
 * from another connected client on the same environment (Studio state syncs
 * per environment, not per device). `teardownSurfaceTab` used to call
 * `host.shell.studioBrowserViewClose` unconditionally, which throws
 * synchronously on a client lacking `browser` even though it never created
 * the view. Terminal teardown has no such gate: `terminalDestroy` is bridged
 * on every host.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SurfaceTab } from '@ion/shared/studio-surface-types'

const studioBrowserViewClose = vi.hoisted(() => vi.fn(async () => undefined))
const terminalDestroy = vi.hoisted(() => vi.fn(async () => undefined))
let caps: string[] = []

vi.mock('../../../host/host-instance', () => ({
  host: {
    shell: { studioBrowserViewClose, terminalDestroy },
    capabilities: () => caps,
  },
}))
vi.mock('../../../rendererLogger', () => ({ rInfo: vi.fn(), rDebug: vi.fn(), rWarn: vi.fn(), rError: vi.fn(), rTrace: vi.fn() }))
vi.mock('@ion/server/store/sessionStore', () => ({ useSessionStore: { getState: () => ({ tabs: [] }) } }))
vi.mock('@ion/server/store/session-store-helpers', () => ({ editorDirForTab: (t: unknown) => t }))
vi.mock('../surface-store', () => ({ useSurfaceStore: { getState: () => ({ tabs: [], conversations: {} }) } }))
vi.mock('../../graph/graph-store', () => ({ useGraphStore: { getState: () => ({ closeSession: vi.fn() }) } }))
vi.mock('../runtime-panel-registry', () => ({ runtimePanel: vi.fn(), unregisterRuntimePanel: vi.fn() }))
vi.mock('../editor-anchor', () => ({ forgetAnchorIfGone: vi.fn() }))

import { teardownSurfaceTab } from '../surface-tab-lifecycle'

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('teardownSurfaceTab capability gates', () => {
  it('skips studioBrowserViewClose on a client lacking browser', () => {
    caps = ['terminal', 'git', 'files', 'questions', 'graph']
    const tab = { kind: 'browser', id: 't1', instanceId: 'i1' } as unknown as SurfaceTab
    expect(() => teardownSurfaceTab(tab, 'conv-1')).not.toThrow()
    expect(studioBrowserViewClose).not.toHaveBeenCalled()
  })

  it('calls studioBrowserViewClose when browser is present', () => {
    caps = ['browser']
    const tab = { kind: 'browser', id: 't1', instanceId: 'i1' } as unknown as SurfaceTab
    teardownSurfaceTab(tab, 'conv-1')
    expect(studioBrowserViewClose).toHaveBeenCalledWith('conv-1', 'i1')
  })

  it('calls terminalDestroy on every host', () => {
    caps = []
    const tab = { kind: 'terminal', id: 't2', instanceId: 'i2' } as unknown as SurfaceTab
    teardownSurfaceTab(tab, 'conv-1')
    expect(terminalDestroy).toHaveBeenCalledWith('conv-1:surface:i2')
  })
})
