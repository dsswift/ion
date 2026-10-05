// @vitest-environment jsdom
/**
 * TransferDialog — a running transfer can always be abandoned.
 *
 * While a step was in flight the dialog offered no Cancel and disabled its
 * Close, so a transfer that stalled left the operator with a modal they
 * could not dismiss and a stream they could not stop. Escape did close the
 * menu underneath, which unmounted the dialog and left the stream running
 * with nothing watching it — so Escape must cancel on its way out too.
 */
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const cancel = vi.fn()
const transferState = { status: 'exporting', progress: { tabId: 'tab-1', direction: 'export', bytesTransferred: 53043, totalBytes: 135662 }, failure: null, targetEnvironmentId: null, targetTabId: null, movedCount: 0, totalCount: 1, start: vi.fn(), retry: vi.fn(), reset: vi.fn(), cancel }

vi.mock('../../../theme', () => ({
  useColors: () => new Proxy({}, { get: () => '#000000' }),
}))
vi.mock('../../connection/tab-environment', () => ({ useTabEnvironmentId: () => 'env-source' }))
vi.mock('../../connection/catalog', () => ({ readConversationCatalog: async () => [{ id: 'env-target', label: 'This Mac' }] }))
vi.mock('../../connection/view-filter', () => ({ useEnvironmentViewFilter: () => ['all', vi.fn()] }))
vi.mock('../../../host/host-instance', () => ({
  host: { connections: async () => [{ environmentId: 'env-target', phase: { phase: 'connected' } }] },
  action: vi.fn(async () => ({ worktrees: [], branches: [], currentBranch: null })),
}))
vi.mock('../useTransfer', () => ({ useTransfer: () => transferState }))
vi.mock('../useTransferPreflight', () => ({
  useTransferPreflight: () => ({
    loading: false, error: null, description: null, preflight: null, checks: [], ready: true,
    exportOptions: {}, siblingTabIds: [], activeJob: null, refresh: vi.fn(),
    destinationDirectory: '/Users/josh/src/ion', destinationMatches: [], destinationOthers: [], setDestinationDirectory: vi.fn(),
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
const onClose = vi.fn()

function button(label: string): HTMLButtonElement | undefined {
  return Array.from(host.querySelectorAll('button')).find((b) => b.textContent === label)
}

beforeEach(async () => {
  vi.clearAllMocks()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => { root.render(<TransferDialog tabId="tab-1" onClose={onClose} />) })
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

describe('TransferDialog while a step is running', () => {
  it('offers Cancel', () => {
    act(() => { button('Cancel')!.click() })
    expect(cancel).toHaveBeenCalled()
  })

  it('leaves Close usable, and cancels the stream on the way out', () => {
    const close = button('Close')
    expect(close).toBeDefined()
    expect(close!.disabled).toBe(false)

    act(() => { close!.click() })
    expect(cancel).toHaveBeenCalled()
    expect(onClose).toHaveBeenCalled()
  })

  it('cancels when Escape dismisses the dialog', () => {
    act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    expect(cancel).toHaveBeenCalled()
    expect(onClose).toHaveBeenCalled()
  })
})
