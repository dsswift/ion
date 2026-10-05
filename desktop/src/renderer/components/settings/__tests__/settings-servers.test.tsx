// @vitest-environment jsdom
/**
 * settings-servers — removing a server: the server is told to revoke this
 * device first, then the entry leaves the catalog and the host deletes the
 * stored secret. A server that cannot be told is still removed here.
 */
import React, { act } from 'react'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import type { EnvironmentCatalogEntry } from '@ion/shared/types-environments'
import { createHarness, flush, type Harness } from '../pages/__tests__/page-harness'

const order = vi.hoisted(() => [] as string[])
const mocks = vi.hoisted(() => ({
  action: vi.fn(),
  removeFromCatalog: vi.fn(async () => { order.push('remove'); return [] }),
  forget: vi.fn(() => { order.push('forget') }),
  readCatalog: vi.fn(),
}))
vi.mock('../../../host/host-instance', () => ({ action: mocks.action, host: { deviceSettings: vi.fn(async () => ({})), setDeviceSetting: vi.fn() } }))
vi.mock('../../../rendererLogger', () => ({ rInfo: vi.fn(), rWarn: vi.fn(), rError: vi.fn(), rDebug: vi.fn() }))
vi.mock('../../../studio/connection/catalog', () => ({
  readCatalog: mocks.readCatalog, addToCatalog: vi.fn(), relabelCatalogEntry: vi.fn(), removeFromCatalog: mocks.removeFromCatalog,
  setCatalogEntryManageOnly: vi.fn(), onCatalogChange: () => () => {},
}))
vi.mock('../../../studio/connection/registry', () => ({ registry: { forget: mocks.forget, connectAll: vi.fn(async () => {}) } }))
vi.mock('../../../studio/connection/tab-environment', () => ({ useActiveTabEnvironmentId: () => 'local' }))
vi.mock('@ion/server/store/sessionStore', () => ({ useSessionStore: () => false }))
vi.mock('../../../studio/connection/local-label', () => ({ LOCAL_ENVIRONMENT_LABEL: 'This Mac' }))

const { useSettingsServersState } = await import('../settings-servers')
type Servers = ReturnType<typeof useSettingsServersState>

const local: EnvironmentCatalogEntry = { id: 'local', label: 'This Mac', target: { kind: 'local' } }
const paired: EnvironmentCatalogEntry = { id: 'env-g', label: 'devbox', target: { kind: 'paired', label: 'devbox', url: 'http://devbox.example:7331', credentialRef: 'c', via: 'lan' } }
const bearer: EnvironmentCatalogEntry = { id: 'env-b', label: 'team', target: { kind: 'bearer', label: 'team', url: 'https://team.example.org' } }

let h: Harness
let servers: Servers

async function mount(): Promise<void> {
  function Probe(): null { servers = useSettingsServersState(); return null }
  await h.render(<Probe />)
  await act(async () => { await flush() })
}

beforeEach(() => {
  h = createHarness()
  order.length = 0
  mocks.readCatalog.mockReset().mockResolvedValue([local, paired, bearer])
  mocks.removeFromCatalog.mockClear()
  mocks.forget.mockClear()
  mocks.action.mockReset().mockImplementation(async () => { order.push('revoke'); return { revoked: true, closed: 1 } })
})
afterEach(() => h.unmount())

describe('forget', () => {
  it('has the server revoke this device, then removes the entry and its stored secret', async () => {
    await mount()
    await act(async () => { await servers.forget(paired) })
    expect(mocks.action).toHaveBeenCalledWith('env-g', 'auth.forgetSelf', [])
    expect(mocks.removeFromCatalog).toHaveBeenCalledWith(0)
    expect(mocks.forget).toHaveBeenCalledWith('env-g', paired.target)
    expect(order).toEqual(['revoke', 'remove', 'forget'])
  })

  it('still removes a server that cannot be told', async () => {
    mocks.action.mockRejectedValue(new Error('not connected'))
    await mount()
    await act(async () => { await servers.forget(paired) })
    expect(order).toEqual(['remove', 'forget'])
    expect(mocks.forget).toHaveBeenCalledWith('env-g', paired.target)
  })

  it('has no pairing to revoke on a signed-in server, and still deletes its token', async () => {
    await mount()
    await act(async () => { await servers.forget(bearer) })
    expect(mocks.action).not.toHaveBeenCalled()
    expect(mocks.forget).toHaveBeenCalledWith('env-b', bearer.target)
  })
})
