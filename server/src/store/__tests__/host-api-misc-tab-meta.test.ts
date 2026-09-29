/**
 * `tabMetaChanged` pushes the `desktop_tab_meta` delta to every connected
 * client: pillColor rides the event-driven path (not only the
 * snapshot poll), null clears explicitly, and absent fields stay absent so a
 * rename never wipes a pill.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const deps = vi.hoisted(() => ({ send: vi.fn() }))
vi.mock('../../thin-view/remote-out', () => ({ sendRemoteEvent: deps.send, remoteClientsPresent: () => true }))
vi.mock('../../logger', () => ({ log: vi.fn(), trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }))

import { tabMetaChanged } from '../host-api-misc'

beforeEach(() => deps.send.mockReset())

describe('tabMetaChanged', () => {
  it('forwards pillColor onto the desktop_tab_meta delta', () => {
    tabMetaChanged({ tabId: 'tab-1', pillColor: '#f08c4a' })
    expect(deps.send).toHaveBeenCalledWith(expect.objectContaining({ type: 'desktop_tab_meta', tabId: 'tab-1', pillColor: '#f08c4a' }))
    tabMetaChanged({ tabId: 'tab-1' })
    expect(deps.send).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'desktop_tab_meta', tabId: 'tab-1' }))
  })

  it('forwards a null pill value as an explicit clear, not an omission', () => {
    tabMetaChanged({ tabId: 'tab-1', pillColor: null })
    const sent = deps.send.mock.calls[0][0] as Record<string, unknown>
    expect('pillColor' in sent).toBe(true)
    expect(sent.pillColor).toBeNull()
  })

  it('omits pill fields from a title-only change and mirrors runCostUsd onto totalCostUsd', () => {
    tabMetaChanged({ tabId: 'tab-1', title: 'Renamed', runCostUsd: 0.5 })
    const sent = deps.send.mock.calls[0][0] as Record<string, unknown>
    expect(sent).toEqual({ type: 'desktop_tab_meta', tabId: 'tab-1', title: 'Renamed', runCostUsd: 0.5, totalCostUsd: 0.5 })
  })
})
