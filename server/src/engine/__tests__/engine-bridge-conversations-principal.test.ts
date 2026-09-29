/**
 * A4: every conversation-data RPC identifies its acting principal from the
 * ambient request principal, never from a client-supplied argument -- there
 * is no argument to supply it from in the first place. Pins `list_stored_sessions`
 * (the FR named explicitly) and one representative mutation (`delete_stored_conversations`).
 */
import { describe, expect, it, vi } from 'vitest'
import { listStoredSessions, deleteStoredConversations } from '../engine-bridge-conversations'
import type { EngineBridge } from '../engine-bridge'
import { runAsPrincipal } from '../../identity/request-principal'

type SendWithData = (msg: Record<string, unknown>) => Promise<{ ok: boolean; data?: unknown }>

function fakeBridge(sendWithData: SendWithData): EngineBridge {
  return { connect: vi.fn(() => Promise.resolve()), _sendWithData: sendWithData } as unknown as EngineBridge
}

describe('engine-bridge-conversations: principal on every data RPC', () => {
  it('list_stored_sessions omits principal with no ambient caller', async () => {
    const sendWithData = vi.fn((_msg: Record<string, unknown>) => Promise.resolve({ ok: true, data: [] }))
    await listStoredSessions(fakeBridge(sendWithData))
    const [payload] = sendWithData.mock.calls[0]
    expect(payload.principal).toBeUndefined()
  })

  it('list_stored_sessions carries the ambient caller\'s principal, never a client-supplied one', async () => {
    const sendWithData = vi.fn((_msg: Record<string, unknown>) => Promise.resolve({ ok: true, data: [] }))
    await runAsPrincipal({ principal: { subject: 'alice', displayName: 'Alice', provider: 'entra', kind: 'operator' } }, () =>
      listStoredSessions(fakeBridge(sendWithData)),
    )
    const [payload] = sendWithData.mock.calls[0]
    expect(payload.principal).toEqual({ subject: 'alice', provider: 'entra', kind: 'operator', username: undefined, displayName: 'Alice', multiTenant: true })
  })

  it('delete_stored_conversations carries the ambient caller\'s principal', async () => {
    const sendWithData = vi.fn((_msg: Record<string, unknown>) => Promise.resolve({ ok: true, data: { deleted: 1 } }))
    await runAsPrincipal({ principal: { subject: 'bob', displayName: 'Bob' } }, () =>
      deleteStoredConversations(fakeBridge(sendWithData), ['sess-1']),
    )
    const [payload] = sendWithData.mock.calls[0]
    expect(payload.principal).toMatchObject({ subject: 'bob' })
  })
})
