/**
 * A fork and a rewind both seed a draft: the text of the turn the person went
 * back to, ready to edit. The `desktop_*` wire pushed it as an input-prefill
 * event. The Studio actions return it, so these pin that the value carries it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const deps = vi.hoisted(() => ({
  tabs: [] as Array<{ id: string; pendingInput?: string }>,
  forkFromMessage: vi.fn<(tabId: string, messageId: string) => Promise<string | null>>(),
  rewindEngineInstance: vi.fn<() => Promise<{ ok: boolean; error?: string }>>(),
  sendRemoteEvent: vi.fn(),
}))
vi.mock('../../../store/sessionStore', () => ({
  useSessionStore: { getState: () => ({ tabs: deps.tabs, forkFromMessage: deps.forkFromMessage, rewindEngineInstance: deps.rewindEngineInstance }) },
}))
vi.mock('../../../state', () => ({ state: {} }))
vi.mock('../../revoke', () => ({ revokeDeviceLocally: vi.fn() }))
vi.mock('../load-conversation-gate', () => ({ clearLoadGateForDevice: vi.fn() }))
vi.mock('../../../thin-view/remote-out', () => ({ sendRemoteEvent: deps.sendRemoteEvent }))
vi.mock('../../../logger', () => ({ log: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }))

import { forkConversationFromMessage, rewindConversationInstance } from '../history'

beforeEach(() => {
  deps.tabs.length = 0
  deps.forkFromMessage.mockReset()
  deps.rewindEngineInstance.mockReset()
  deps.sendRemoteEvent.mockReset()
})

describe('forkConversationFromMessage', () => {
  it('answers the new tab and the draft the fork seeded it with', async () => {
    deps.forkFromMessage.mockImplementation(async () => { deps.tabs.push({ id: 't-fork', pendingInput: 'try again' }); return 't-fork' })
    expect(await forkConversationFromMessage('t1', 'm3')).toEqual({ tabId: 't-fork', pendingInput: 'try again' })
    expect(deps.forkFromMessage).toHaveBeenCalledWith('t1', 'm3')
  })

  it('answers null when the store refuses the fork', async () => {
    deps.forkFromMessage.mockResolvedValue(null)
    expect(await forkConversationFromMessage('t1', 'gone')).toBeNull()
  })
})

describe('rewindConversationInstance', () => {
  it('reads the draft after the rewind has been applied, never before', async () => {
    deps.tabs.push({ id: 't1', pendingInput: '' })
    deps.rewindEngineInstance.mockImplementation(async () => { deps.tabs[0].pendingInput = 'earlier turn'; return { ok: true } })
    expect(await rewindConversationInstance('t1', 'i1', 'm2', 4)).toEqual({ ok: true, pendingInput: 'earlier turn' })
  })

  it('answers the refusal with its reason and no draft', async () => {
    deps.tabs.push({ id: 't1', pendingInput: 'stale' })
    deps.rewindEngineInstance.mockResolvedValue({ ok: false, error: 'turn not found' })
    expect(await rewindConversationInstance('t1', 'i1', 'm2', null)).toEqual({ ok: false, error: 'turn not found' })
  })
})
