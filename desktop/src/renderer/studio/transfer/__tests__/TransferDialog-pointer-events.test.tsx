// @vitest-environment jsdom
/**
 * TransferDialog — the dialog opts back into pointer events.
 *
 * TransferDialogHost renders this dialog into PopoverLayer, whose root is
 * `pointerEvents: 'none'`
 * so it never swallows clicks meant for the app beneath it. Pointer-events is
 * inherited, so a child that does not opt back in paints normally and is
 * completely inert — which is exactly how this shipped: the target picker and
 * both buttons behaved like text.
 *
 * jsdom dispatches a click regardless of pointer-events, so a simulated click
 * cannot distinguish the broken build from the fixed one. What it can pin is
 * the opt-in itself, on the backdrop that PopoverLayer's `none` would
 * otherwise reach.
 */
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../../../theme', () => ({
  useColors: () => new Proxy({}, { get: () => '#000000' }),
}))
vi.mock('../../connection/tab-environment', () => ({
  useTabEnvironmentId: () => 'env-source',
}))
vi.mock('../../connection/catalog', () => ({
  readConversationCatalog: async () => [{ id: 'env-target', label: 'This Mac' }],
}))
vi.mock('../../connection/view-filter', () => ({
  useEnvironmentViewFilter: () => ['all', vi.fn()],
}))
vi.mock('../../../host/host-instance', () => ({
  host: { connections: async () => [{ environmentId: 'env-target', phase: { phase: 'connected' } }] },
  action: vi.fn(async () => ({ worktrees: [], branches: [], currentBranch: null })),
}))
vi.mock('../useTransfer', () => ({
  useTransfer: () => ({ status: 'idle', step: null, error: null, targetEnvironmentId: null, start: vi.fn(), retry: vi.fn(), reset: vi.fn() }),
}))
vi.mock('../useTransferPreflight', () => ({
  useTransferPreflight: () => ({
    loading: false, error: null, description: null, preflight: null, checks: [], ready: true,
    exportOptions: {}, siblingTabIds: [], activeJob: null, refresh: vi.fn(),
    destinationDirectory: '/Users/josh/src/ion', destinationMatches: [], destinationOthers: [], setDestinationDirectory: vi.fn(),
  }),
}))
vi.mock('../TransferPreflightPanel', () => ({
  TransferPreflightPanel: () => <div />,
}))

vi.mock('../../connection/environment-projects', () => ({
  useProjectsByEnvironment: () => ({}),
}))
vi.mock('@ion/server/store/sessionStore', () => ({
  useSessionStore: (selector: (s: { tabs: unknown[] }) => unknown) => selector({ tabs: [] }),
}))

import { TransferDialog } from '../TransferDialog'

let host: HTMLDivElement
let root: ReturnType<typeof createRoot>

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

describe('TransferDialog inside PopoverLayer', () => {
  it('sets pointerEvents auto on its backdrop so its controls are clickable', async () => {
    await act(async () => {
      root.render(<TransferDialog tabId="tab-1" onClose={vi.fn()} />)
    })

    const backdrop = host.querySelector<HTMLDivElement>('[data-ion-confirm]')
    expect(backdrop).not.toBeNull()
    expect(backdrop!.style.pointerEvents).toBe('auto')
  })
})
