/**
 * A refused deletion is a failure, not a quiet zero.
 *
 * `_sendWithData` resolves on a refusal (`{ok: false, error}`) rather than
 * rejecting, so a caller that reads only `data` cannot tell a deletion from a
 * refusal. This one did: the engine refused to delete a conversation it still
 * had an open session for, the refusal was read as "0 deleted", the tab was
 * removed anyway, and the transcript stayed on disk with nothing pointing at
 * it.
 */
import { describe, expect, it, vi } from 'vitest'
import { deleteStoredConversations } from '../engine-bridge-conversations'
import type { EngineBridge } from '../engine-bridge'

type SendWithData = (msg: Record<string, unknown>) => Promise<{ ok: boolean; error?: string; data?: unknown }>

function fakeBridge(sendWithData: SendWithData): EngineBridge {
  return { connect: vi.fn(() => Promise.resolve()), _sendWithData: sendWithData } as unknown as EngineBridge
}

describe('deleteStoredConversations', () => {
  it('throws the engine\'s reason when the deletion is refused', async () => {
    const bridge = fakeBridge(() => Promise.resolve({ ok: false, error: 'conversation "conv-1" is active' }))

    await expect(deleteStoredConversations(bridge, ['conv-1'])).rejects.toThrow('conversation "conv-1" is active')
  })

  it('throws even when a refusal carries no message', async () => {
    const bridge = fakeBridge(() => Promise.resolve({ ok: false }))

    await expect(deleteStoredConversations(bridge, ['conv-1'])).rejects.toThrow(/refused/)
  })

  it('reports what actually left disk on success', async () => {
    const bridge = fakeBridge(() => Promise.resolve({ ok: true, data: { deleted: 2 } }))

    await expect(deleteStoredConversations(bridge, ['conv-1', 'conv-2'])).resolves.toEqual({ deleted: 2 })
  })
})
