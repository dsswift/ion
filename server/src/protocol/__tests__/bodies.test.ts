/**
 * Pins the conversation-body channel's answer contract.
 *
 * Regression context: the server implemented `studio_body_request` by
 * re-deriving rows itself — engine `loadSessionHistory(tabId)` plus the raw
 * content file — which keyed the engine read on the TAB id instead of the
 * conversation chain and duplicated the store's mapping. It now delegates to
 * the store's own `loadSkeletonMessages` and answers with the resulting pane
 * rows, so there is exactly one hydration path.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'

import { useSessionStore } from '../../store/sessionStore'
import { handleBodyRequest, type StudioBodyRequestFrame } from '../bodies'
import type { Scope, StudioFrame } from '@ion/shared/studio-wire/types'
import { recordingConnection } from './recording-connection'

// Ownership is decided by the one shared predicate; each test sets who may
// see the tab rather than building a tabs file.
const visibility = vi.hoisted(() => ({ allow: (_tabId: string, _subject: string | null): boolean => true }))
vi.mock('../tabs-index', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../tabs-index')>()),
  tabIdVisibleToSubject: (tabId: string, subject: string | null) => visibility.allow(tabId, subject),
}))

const fakeConn = (scopes: Scope[]) => recordingConnection({ scopes })

const TAB = 'tab-1'

function seedPane(messages: Array<{ id: string; role: string; content: string }>): void {
  useSessionStore.setState({
    conversationPanes: new Map([
      [TAB, { activeInstanceId: 'inst-1', instances: [{ id: 'inst-1', messages, messageCount: messages.length }] }],
    ]) as never,
  })
}

beforeEach(() => {
  useSessionStore.setState({ conversationPanes: new Map() as never })
  visibility.allow = () => true
})

describe('handleBodyRequest', () => {
  it('hydrates through the store and answers with the pane rows', async () => {
    const rows = [
      { id: 'm1', role: 'user', content: 'hello' },
      { id: 'm2', role: 'assistant', content: 'hi' },
    ]
    const loadSkeletonMessages = vi.fn(async () => { seedPane(rows) })
    useSessionStore.setState({ loadSkeletonMessages } as never)

    const { conn, sent } = fakeConn(['conversations:read'])
    await handleBodyRequest(conn, { type: 'studio_body_request', tabId: TAB } as StudioBodyRequestFrame)

    expect(loadSkeletonMessages).toHaveBeenCalledWith(TAB)
    expect(sent).toHaveLength(1)
    const frame = sent[0] as Extract<StudioFrame, { type: 'studio_body' }>
    expect(frame.type).toBe('studio_body')
    expect(frame.tabId).toBe(TAB)
    expect(frame.rows).toEqual(rows)
  })

  it('still answers (with what the pane holds) when hydration throws', async () => {
    seedPane([{ id: 'm1', role: 'user', content: 'cached' }])
    useSessionStore.setState({
      loadSkeletonMessages: vi.fn(async () => { throw new Error('engine down') }),
    } as never)

    const { conn, sent } = fakeConn(['conversations:read'])
    await handleBodyRequest(conn, { type: 'studio_body_request', tabId: TAB } as StudioBodyRequestFrame)

    const frame = sent[0] as Extract<StudioFrame, { type: 'studio_body' }>
    expect(frame.rows).toHaveLength(1)
  })

  it('refuses a tab another principal owns, for both views, and never hydrates', async () => {
    const loadSkeletonMessages = vi.fn(async () => { seedPane([{ id: 'm1', role: 'user', content: 'private' }]) })
    useSessionStore.setState({ loadSkeletonMessages } as never)
    visibility.allow = (_tabId, subject) => subject === 'owner'

    for (const view of ['mirror', 'thin'] as const) {
      const { conn, sent } = recordingConnection({ view, scopes: ['conversations:read'] })
      conn.principal = { subject: 'intruder' } as never
      await handleBodyRequest(conn, { type: 'studio_body_request', tabId: TAB } as StudioBodyRequestFrame)
      const frame = sent[0] as Extract<StudioFrame, { type: 'studio_body' }>
      expect(frame.rows).toEqual([])
    }
    expect(loadSkeletonMessages).not.toHaveBeenCalled()

    const { conn, sent } = fakeConn(['conversations:read'])
    conn.principal = { subject: 'owner' } as never
    await handleBodyRequest(conn, { type: 'studio_body_request', tabId: TAB } as StudioBodyRequestFrame)
    const frame = sent[0] as Extract<StudioFrame, { type: 'studio_body' }>
    expect(frame.rows).toHaveLength(1)
  })

  it('refuses without conversations:read and never hydrates', async () => {
    const loadSkeletonMessages = vi.fn(async () => {})
    useSessionStore.setState({ loadSkeletonMessages } as never)

    const { conn, sent } = fakeConn([])
    await handleBodyRequest(conn, { type: 'studio_body_request', tabId: TAB } as StudioBodyRequestFrame)

    expect(loadSkeletonMessages).not.toHaveBeenCalled()
    const frame = sent[0] as Extract<StudioFrame, { type: 'studio_body' }>
    expect(frame.rows).toEqual([])
  })
})

/** `turns` user+assistant pairs: u0 a0 u1 a1 ... -- ids a cursor can name. */
function transcript(turns: number): Array<{ id: string; role: string; content: string }> {
  const rows: Array<{ id: string; role: string; content: string }> = []
  for (let i = 0; i < turns; i++) {
    rows.push({ id: `u${i}`, role: 'user', content: `q${i}` }, { id: `a${i}`, role: 'assistant', content: `r${i}` })
  }
  return rows
}

describe('handleBodyRequest: paging', () => {
  type Body = Extract<StudioFrame, { type: 'studio_body' }>
  async function request(extra: Partial<StudioBodyRequestFrame>): Promise<Body> {
    useSessionStore.setState({ loadSkeletonMessages: vi.fn(async () => undefined) } as never)
    const { conn, sent } = fakeConn(['conversations:read'])
    await handleBodyRequest(conn, { type: 'studio_body_request', tabId: TAB, ...extra } as StudioBodyRequestFrame)
    return sent[0] as Body
  }

  // The desktop never pages. Its reply must not change by a single field, or
  // a client built against the unpaged frame reads a shape it never asked for.
  it('an unpaged request is answered exactly as before: every row, no paging field', async () => {
    const rows = transcript(40)
    seedPane(rows)
    const frame = await request({})
    expect(frame).toEqual({ type: 'studio_body', tabId: TAB, instanceId: undefined, rows })
    expect(Object.keys(frame)).not.toContain('hasMore')
  })

  it('the newest page: echoes before as null, says more exists, and hands back a cursor', async () => {
    seedPane(transcript(40))
    const frame = await request({ limit: 10 })
    const ids = (frame.rows as Array<{ id: string }>).map((r) => r.id)
    expect(ids[ids.length - 1]).toBe('a39')
    // Snapped to a turn boundary: a page never opens mid-turn.
    expect(ids[0]).toMatch(/^u/)
    expect(frame.hasMore).toBe(true)
    expect(frame.before).toBeNull()
    expect(frame.cursor).toBe(ids[0])
  })

  // `before` is what tells a client to PREPEND. Branching on `cursor` instead
  // replaces the transcript with every older page, since cursor is set on
  // every page that has more behind it.
  it('an older page ends just before the cursor and echoes it', async () => {
    seedPane(transcript(40))
    const first = await request({ limit: 10 })
    const older = await request({ limit: 10, before: first.cursor })
    const firstIds = (first.rows as Array<{ id: string }>).map((r) => r.id)
    const olderIds = (older.rows as Array<{ id: string }>).map((r) => r.id)
    expect(older.before).toBe(first.cursor)
    expect(olderIds.filter((id) => firstIds.includes(id))).toEqual([])
    const all = transcript(40).map((r) => r.id)
    expect(all.indexOf(olderIds[olderIds.length - 1]) + 1).toBe(all.indexOf(firstIds[0]))
  })

  it('the oldest page says nothing is behind it and carries no cursor', async () => {
    seedPane(transcript(3))
    const frame = await request({ limit: 10 })
    expect((frame.rows as unknown[]).length).toBe(6)
    expect(frame.hasMore).toBe(false)
    expect(frame.cursor).toBeUndefined()
  })
})
