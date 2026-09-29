import { describe, expect, it, vi } from 'vitest'
import { forkSession } from '../engine-bridge-conversations'
import type { EngineBridge } from '../engine-bridge'

function bridgeWithResult(result: unknown): EngineBridge {
  return {
    connect: vi.fn(async () => undefined),
    _sendWithData: vi.fn(async () => result),
  } as unknown as EngineBridge
}

describe('engine bridge fork_session result', () => {
  it('returns the durable fork identity from the common data envelope', async () => {
    const bridge = bridgeWithResult({
      ok: true,
      data: { newKey: 'fork-tab', conversationId: 'fork-conversation' },
    })

    const result = await forkSession(bridge, 'source-tab', 'fork-tab', { messageIndex: 2 })

    expect(result).toEqual({
      ok: true,
      error: undefined,
      newKey: 'fork-tab',
      conversationId: 'fork-conversation',
    })
    expect(bridge._sendWithData).toHaveBeenCalledWith({
      cmd: 'fork_session', key: 'source-tab', newKey: 'fork-tab', messageIndex: 2,
    })
  })

  it('does not invent a durable identity when the engine omits it', async () => {
    const bridge = bridgeWithResult({ ok: true, data: { newKey: 'fork-tab' } })

    const result = await forkSession(bridge, 'source-tab', 'fork-tab', {
      messageIndex: 1, entryId: 'entry-2', userTurnIndex: 1,
    })

    expect(result.conversationId).toBeUndefined()
    expect(result.ok).toBe(true)
  })
})
