/**
 * A thin connection's body is the store's own transcript, projected for the
 * wire: the rows Studio renders, not a second mapping of the engine history.
 * The reply opens the conversation's transcript stream and names its
 * revision, so the patches that follow can be applied in order.
 *
 * Regression context: thin bodies used to be the engine's history re-mapped
 * (`conversation-history-page.ts`), which dropped harness and thinking rows
 * and disagreed with the store's row ids. The phone then rebuilt the live
 * transcript itself, and the two builders drifted.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const store = vi.hoisted(() => {
  const listeners = new Set<() => void>()
  const state = {
    loadSkeletonMessages: vi.fn(async (_tabId: string) => undefined),
    conversationPanes: new Map<string, { activeInstanceId: string; instances: Array<{ id: string; messages: unknown[] }> }>(),
  }
  return {
    state,
    listeners,
    api: {
      getState: () => state,
      subscribe: (fn: () => void) => { listeners.add(fn); return () => listeners.delete(fn) },
    },
  }
})
vi.mock('../../store/sessionStore', () => ({ useSessionStore: store.api }))
vi.mock('../../logger', () => ({ log: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }))
const thinkingSetting = vi.hoisted(() => ({ enabled: true, listeners: new Set<() => void>() }))
vi.mock('../../persistence/settings-store', () => ({
  shouldStreamThinkingToRemote: () => thinkingSetting.enabled,
  onStreamThinkingToRemoteChange: (fn: () => void) => { thinkingSetting.listeners.add(fn); return () => thinkingSetting.listeners.delete(fn) },
}))

import { handleBodyRequest, type StudioBodyRequestFrame } from '../bodies'
import { _resetTranscriptPublisherForTest } from '../../transcript/transcript-publisher'
import { recordingConnection } from './recording-connection'

const request = (extra: Partial<StudioBodyRequestFrame> = {}): StudioBodyRequestFrame => ({ type: 'studio_body_request', tabId: 'tab-1', ...extra } as StudioBodyRequestFrame)

function seed(tabId: string, messages: unknown[]): void {
  store.state.conversationPanes.set(tabId, { activeInstanceId: 'main', instances: [{ id: 'main', messages }] })
}

beforeEach(() => {
  _resetTranscriptPublisherForTest()
  store.state.conversationPanes.clear()
  store.state.loadSkeletonMessages.mockReset()
  store.state.loadSkeletonMessages.mockImplementation(async () => undefined)
})

describe('handleBodyRequest for a thin connection', () => {
  it('answers with the store rows, every role kept, and the stream it opened', async () => {
    seed('tab-1', [
      { id: 'u1', role: 'user', content: 'hi', timestamp: 1, clientMsgId: 'c1' },
      { id: 'h1', role: 'harness', content: 'note', timestamp: 2, dedupKey: 'ext:k' },
      { id: 'k1', role: 'thinking', content: 'hmm', timestamp: 3, sealed: true },
    ])
    const { conn, sent } = recordingConnection({ view: 'thin' })
    await handleBodyRequest(conn, request())
    expect(store.state.loadSkeletonMessages).toHaveBeenCalledWith('tab-1')
    expect(sent[0]).toMatchObject({
      type: 'studio_body', tabId: 'tab-1', instanceId: 'main', before: null, hasMore: false,
      streamId: 'tab:tab-1:main', rev: 0, total: 3, startIndex: 0,
    })
    const frame = sent[0] as { rows: Array<Record<string, unknown>>; epoch: string }
    expect(frame.epoch).toMatch(/.+/)
    expect(frame.rows.map((r) => r.role)).toEqual(['user', 'harness', 'thinking'])
    expect(frame.rows[0].clientMsgId).toBe('c1')
    // Owner-only reducer state never ships.
    expect(frame.rows[1]).not.toHaveProperty('dedupKey')
    expect(frame.rows[2]).not.toHaveProperty('sealed')
  })

  it('pages from the cursor and places the page in the whole transcript', async () => {
    const rows = Array.from({ length: 30 }, (_, i) => ({ id: `m${i}`, role: i % 2 === 0 ? 'user' : 'assistant', content: 'x', timestamp: i }))
    seed('tab-1', rows)
    const { conn, sent } = recordingConnection({ view: 'thin' })
    await handleBodyRequest(conn, request({ before: 'm20', limit: 10 }))
    expect(sent[0]).toMatchObject({ before: 'm20', startIndex: 10, total: 30, hasMore: true, cursor: 'm10' })
    expect((sent[0] as { rows: unknown[] }).rows).toHaveLength(10)
  })

  it('answers empty, never hangs, when the tab has no conversation or hydration throws', async () => {
    const first = recordingConnection({ view: 'thin' })
    await handleBodyRequest(first.conn, request({ tabId: 'nope' }))
    expect(first.sent[0]).toMatchObject({ type: 'studio_body', rows: [], hasMore: false })

    seed('tab-1', [{ id: 'u1', role: 'user', content: 'cached', timestamp: 1 }])
    store.state.loadSkeletonMessages.mockRejectedValueOnce(new Error('engine gone'))
    const second = recordingConnection({ view: 'thin' })
    await handleBodyRequest(second.conn, request())
    expect((second.sent[0] as { rows: unknown[] }).rows).toHaveLength(1)
  })

  it('leaves a mirror connection on the store rows, unprojected', async () => {
    seed('tab-1', [{ id: 'raw-1', role: 'user', content: 'raw', timestamp: 1, sealed: true }])
    const { conn, sent } = recordingConnection({ view: 'mirror' })
    await handleBodyRequest(conn, request())
    expect((sent[0] as { rows: Array<{ id: string; sealed?: boolean }> }).rows).toEqual([{ id: 'raw-1', role: 'user', content: 'raw', timestamp: 1, sealed: true }])
    expect(sent[0]).not.toHaveProperty('streamId')
  })

  // A phone that just connected asks for every unloaded conversation at once.
  // Built and sent together, those pages overflowed the send buffer and the
  // server closed the phone as slow_client. Each page is now built only after
  // the previous one has left the socket.
  it('builds the next requested page only after the previous one left the socket', async () => {
    for (const tab of ['tab-a', 'tab-b', 'tab-c']) seed(tab, [{ id: `${tab}-m`, role: 'user', content: 'x', timestamp: 1 }])
    const { conn, sent, pending, flushNext } = recordingConnection({ view: 'thin', holdWrites: true })

    const answers = [
      handleBodyRequest(conn, request({ tabId: 'tab-a' })),
      handleBodyRequest(conn, request({ tabId: 'tab-b' })),
      handleBodyRequest(conn, request({ tabId: 'tab-c' })),
    ]
    await vi.waitFor(() => expect(pending()).toBe(1))
    expect(store.state.loadSkeletonMessages).toHaveBeenCalledTimes(1)
    expect(sent.map((f) => (f as { tabId: string }).tabId)).toEqual(['tab-a'])

    flushNext()
    await vi.waitFor(() => expect(store.state.loadSkeletonMessages).toHaveBeenCalledTimes(2))
    await vi.waitFor(() => expect(pending()).toBe(1))
    flushNext()
    await vi.waitFor(() => expect(pending()).toBe(1))
    flushNext()
    await Promise.all(answers)

    expect(sent.map((f) => (f as { tabId: string }).tabId)).toEqual(['tab-a', 'tab-b', 'tab-c'])
    expect(conn.isClosed).toBe(false)
  })

  it('a closed connection releases the answers waiting behind it', async () => {
    seed('tab-a', [])
    seed('tab-b', [])
    const { conn, pending } = recordingConnection({ view: 'thin', holdWrites: true })
    const first = handleBodyRequest(conn, request({ tabId: 'tab-a' }))
    const second = handleBodyRequest(conn, request({ tabId: 'tab-b' }))
    await vi.waitFor(() => expect(pending()).toBe(1))
    conn.markClosed()
    await Promise.all([first, second])
    expect(store.state.loadSkeletonMessages).toHaveBeenCalledTimes(1)
  })
})
