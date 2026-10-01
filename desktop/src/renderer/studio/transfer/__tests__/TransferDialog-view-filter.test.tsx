// @vitest-environment jsdom
/**
 * A finished transfer may widen the Inbox's environment filter so the
 * conversation it just moved is visible. It may never narrow it.
 *
 * The regression: this used to pin the filter to the transfer's target, so
 * one transfer to this Mac wrote `local` into a persisted device setting
 * and hid every other host's conversations from the Inbox — permanently, on
 * a build where no control could set it back.
 */
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const setViewFilter = vi.fn()
const filter = { current: 'all' as string }
const transferState = {
  status: 'succeeded', progress: null, failure: null, targetEnvironmentId: 'local', targetTabId: 'tab-1',
  movedCount: 1, totalCount: 1, start: vi.fn(), retry: vi.fn(), reset: vi.fn(), cancel: vi.fn(),
}

vi.mock('../../../theme', () => ({ useColors: () => new Proxy({}, { get: () => '#000000' }) }))
vi.mock('../../connection/tab-environment', () => ({ useTabEnvironmentId: () => 'env-source' }))
vi.mock('../../connection/catalog', () => ({ readCatalog: async () => [{ id: 'local', label: 'This Mac' }] }))
vi.mock('../../connection/view-filter', () => ({ useEnvironmentViewFilter: () => [filter.current, setViewFilter] }))
vi.mock('../../../host/host-instance', () => ({
  host: { connections: async () => [{ environmentId: 'local', phase: { phase: 'connected' } }] },
  action: vi.fn(async () => ({ worktrees: [], branches: [], currentBranch: null })),
}))
vi.mock('../useTransfer', () => ({ useTransfer: () => transferState }))
vi.mock('../useTransferPreflight', () => ({
  useTransferPreflight: () => ({
    loading: false, error: null, description: null, preflight: null, checks: [], ready: true,
    exportOptions: {}, siblingTabIds: [], activeJob: null, refresh: vi.fn(),
  }),
}))
vi.mock('../TransferPreflightPanel', () => ({ TransferPreflightPanel: () => <div /> }))

vi.mock('../../connection/environment-projects', () => ({
  useProjectsByEnvironment: () => ({}),
}))
vi.mock('@ion/server/store/sessionStore', () => ({
  useSessionStore: (selector: (s: { tabs: unknown[] }) => unknown) => selector({ tabs: [] }),
}))

import { TransferDialog } from '../TransferDialog'

let host: HTMLDivElement
let root: ReturnType<typeof createRoot>

async function renderDialog(): Promise<void> {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => { root.render(<TransferDialog tabId="tab-1" onClose={vi.fn()} />) })
}

beforeEach(() => { vi.clearAllMocks() })
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

describe('TransferDialog and the inbox environment filter', () => {
  it('leaves a filter that already shows everything alone', async () => {
    filter.current = 'all'
    await renderDialog()
    expect(setViewFilter).not.toHaveBeenCalled()
  })

  it('widens to all — never pins to the target — when the current filter would hide the moved conversation', async () => {
    filter.current = 'oscar-environment-id'
    await renderDialog()
    expect(setViewFilter).toHaveBeenCalledWith('all')
  })

  it('leaves the filter alone when it already shows the target', async () => {
    filter.current = 'local'
    await renderDialog()
    expect(setViewFilter).not.toHaveBeenCalled()
  })
})
