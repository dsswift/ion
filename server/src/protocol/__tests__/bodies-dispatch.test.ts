/**
 * A body request that names a dispatch is answered from that dispatch's
 * transcript stream, for a thin connection whose tab owns the dispatch.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const dispatch = vi.hoisted(() => ({
  owned: true,
  rows: [] as Array<Record<string, unknown>>,
  calls: [] as Array<{ tabId: string; conversationId: string; dispatchId: string; subscribed: boolean }>,
}))
vi.mock('../../transcript/dispatch-transcript-publisher', () => ({
  openDispatchTranscript: vi.fn(async (tabId: string, conversationId: string, dispatchId: string, subscriber: unknown, answer: (s: unknown) => void) => {
    dispatch.calls.push({ tabId, conversationId, dispatchId, subscribed: subscriber !== null })
    if (!dispatch.owned) return false
    answer({ streamId: `dispatch:${conversationId}:${dispatchId}`, epoch: 'e1', rev: 4, rows: dispatch.rows })
    return true
  }),
  forgetDispatchSubscriber: vi.fn(),
}))
vi.mock('../../store/sessionStore', () => ({
  useSessionStore: { getState: () => ({ conversationPanes: new Map(), loadSkeletonMessages: async () => undefined }), subscribe: () => () => undefined },
}))
vi.mock('../../logger', () => ({ log: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }))
const thinkingSetting = vi.hoisted(() => ({ enabled: true, listeners: new Set<() => void>() }))
vi.mock('../../persistence/settings-store', () => ({
  shouldStreamThinkingToRemote: () => thinkingSetting.enabled,
  onStreamThinkingToRemoteChange: (fn: () => void) => { thinkingSetting.listeners.add(fn); return () => thinkingSetting.listeners.delete(fn) },
}))

import { handleBodyRequest, type StudioBodyRequestFrame } from '../bodies'
import { recordingConnection } from './recording-connection'

const request = (extra: Partial<StudioBodyRequestFrame> = {}): StudioBodyRequestFrame =>
  ({ type: 'studio_body_request', tabId: 'tab-1', conversationId: 'c1', dispatchId: 'd1', ...extra } as StudioBodyRequestFrame)

beforeEach(() => {
  dispatch.owned = true
  dispatch.rows = [
    { id: 'user-1', role: 'user', content: 'go', timestamp: 1 },
    { id: 'assistant-2', role: 'assistant', content: 'done', timestamp: 2 },
  ]
  dispatch.calls = []
})

describe('handleBodyRequest for a dispatch', () => {
  it('answers a thin connection from the dispatch stream and subscribes it', async () => {
    const { conn, sent } = recordingConnection({ view: 'thin' })
    await handleBodyRequest(conn, request())
    expect(dispatch.calls).toEqual([{ tabId: 'tab-1', conversationId: 'c1', dispatchId: 'd1', subscribed: true }])
    expect(sent[0]).toMatchObject({
      type: 'studio_body', tabId: 'tab-1', conversationId: 'c1', dispatchId: 'd1', before: null, hasMore: false,
      streamId: 'dispatch:c1:d1', epoch: 'e1', rev: 4, total: 2, startIndex: 0,
    })
    expect((sent[0] as { rows: unknown[] }).rows).toHaveLength(2)
  })

  it('an older page reads without subscribing', async () => {
    const { conn } = recordingConnection({ view: 'thin' })
    await handleBodyRequest(conn, request({ before: 'assistant-2' }))
    expect(dispatch.calls[0].subscribed).toBe(false)
  })

  it('answers empty when the tab does not own the dispatch', async () => {
    dispatch.owned = false
    const { conn, sent } = recordingConnection({ view: 'thin' })
    await handleBodyRequest(conn, request())
    expect(sent[0]).toMatchObject({ type: 'studio_body', tabId: 'tab-1', conversationId: 'c1', rows: [] })
    expect(sent[0]).not.toHaveProperty('streamId')
  })

  it('refuses a mirror connection, which reads dispatches its own way', async () => {
    const { conn, sent } = recordingConnection({ view: 'mirror' })
    await handleBodyRequest(conn, request())
    expect(dispatch.calls).toEqual([])
    expect(sent[0]).toMatchObject({ type: 'studio_body', rows: [] })
  })
})
