/**
 * The mirror's conversation-body gate.
 *
 * Regression: a live event that lands before the tab sync leaves a mirror
 * pane holding a row or two with no hydration marker. The gate used to read
 * `needsHistoryHydration`, whose last clause needs a persisted `messageCount`
 * the welcome deliberately strips — so such a pane answered "nothing to
 * load" and the conversation rendered as only the turns that arrived after
 * the reload, while the phone showed the whole transcript.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const sent: Array<Record<string, unknown>> = []
const frameHandlers: Array<(env: string, frame: Record<string, unknown>) => void> = []

vi.mock('../../host/host-instance', () => ({
  host: {
    send: (_env: string, frame: Record<string, unknown>) => { sent.push(frame) },
    onFrame: (cb: (env: string, frame: Record<string, unknown>) => void) => {
      frameHandlers.push(cb)
      return () => { frameHandlers.splice(frameHandlers.indexOf(cb), 1) }
    },
  },
}))
vi.mock('../connection/tab-environment', () => ({ environmentOfTab: () => 'local' }))
vi.mock('../../rendererLogger', () => ({ rDebug: vi.fn(), rWarn: vi.fn() }))

import { useSessionStore } from '@ion/server/store/sessionStore'
import { initBodySyncFromWire } from './body-sync'

const TAB = 'tab-1'

/** A pane as a live event leaves it: rows, but no hydration marker. */
function livePane(messageCount: number, historyHydrated?: boolean): void {
  useSessionStore.setState({
    activeTabId: TAB,
    conversationPanes: new Map([[TAB, {
      activeInstanceId: 'main',
      instances: [{
        id: 'main',
        messages: Array.from({ length: messageCount }, (_, i) => ({ id: `m${i}`, role: 'user', content: 'x' })),
        messageCount,
        ...(historyHydrated === undefined ? {} : { historyHydrated }),
      }],
    }]]) as never,
  } as never)
}

let stop: (() => void) | null = null

beforeEach(() => { sent.length = 0; frameHandlers.length = 0 })
afterEach(() => { stop?.(); stop = null })

describe('body sync', () => {
  it('asks for the transcript of a pane a live event created before the tab sync', () => {
    livePane(2)
    stop = initBodySyncFromWire()
    expect(sent.filter((f) => f.type === 'studio_body_request').map((f) => f.tabId)).toEqual([TAB])
  })

  it('does not ask again once the server has answered, even with no rows', () => {
    livePane(0)
    stop = initBodySyncFromWire()
    expect(sent).toHaveLength(1)

    // The answer marks the pane hydrated, and that mark is what stops the
    // next pump -- so an empty conversation is asked for exactly once.
    for (const cb of [...frameHandlers]) cb('local', { type: 'studio_body', tabId: TAB, rows: [] })
    useSessionStore.setState({ activeTabId: TAB } as never)

    expect(sent.filter((f) => f.type === 'studio_body_request')).toHaveLength(1)
  })

  /**
   * The field failure: an Environment that drops has its panes deleted, and
   * the panes it gets back when it returns are empty skeletons. A memory of
   * "already answered" that outlived those rows left every conversation on
   * that server rendering empty, with no request in flight and nothing to
   * trigger one. Clicking the conversation did nothing at all.
   */
  it('asks again when the pane it filled was replaced by an empty skeleton', () => {
    livePane(0)
    stop = initBodySyncFromWire()
    for (const cb of [...frameHandlers]) cb('local', { type: 'studio_body', tabId: TAB, rows: [{ id: 'm1', role: 'user', content: 'x' }] })
    expect(sent.filter((f) => f.type === 'studio_body_request')).toHaveLength(1)

    // The environment dropped and came back: same tab, fresh empty pane.
    useSessionStore.setState({ conversationPanes: new Map() } as never)
    useSessionStore.setState({ activeTabId: TAB } as never)
    livePane(0)

    expect(sent.filter((f) => f.type === 'studio_body_request')).toHaveLength(2)
  })

  /**
   * The field failure behind a remote conversation that opened blank. The
   * operator was on ANOTHER conversation when the Environment dropped, so
   * the pane went away while this tab was not active. The skeleton that came
   * back picked up a live row before the operator reopened it, and a memory
   * read against that row said "already answered".
   */
  it('asks again for a rebuilt pane even when a live row landed in it first', () => {
    livePane(0)
    stop = initBodySyncFromWire()
    for (const cb of [...frameHandlers]) cb('local', { type: 'studio_body', tabId: TAB, rows: [{ id: 'm1', role: 'user', content: 'x' }] })

    // Operator moves away; the Environment drops and takes the pane with it.
    useSessionStore.setState({ activeTabId: 'other-tab' } as never)
    useSessionStore.setState({ conversationPanes: new Map() } as never)
    // It returns: a skeleton, which a live event gives one row.
    useSessionStore.setState({
      conversationPanes: new Map([[TAB, {
        activeInstanceId: 'main',
        instances: [{ id: 'main', messages: [{ id: 'live', role: 'assistant', content: 'x' }], messageCount: 0, historyHydrated: false }],
      }]]),
    } as never)
    // Operator reopens the conversation.
    useSessionStore.setState({ activeTabId: TAB } as never)

    expect(sent.filter((f) => f.type === 'studio_body_request')).toHaveLength(2)
  })

  /** A request the drop cut off must not block the next one forever. */
  it('asks again when the pane went away with its request still unanswered', () => {
    livePane(0)
    stop = initBodySyncFromWire()
    expect(sent.filter((f) => f.type === 'studio_body_request')).toHaveLength(1)

    useSessionStore.setState({ activeTabId: 'other-tab' } as never)
    useSessionStore.setState({ conversationPanes: new Map() } as never)
    livePane(0)

    expect(sent.filter((f) => f.type === 'studio_body_request')).toHaveLength(2)
  })

  /** A live event rewriting the instance is not a reason to re-fetch. */
  it('does not ask again for a pane that still holds its rows', () => {
    livePane(0)
    stop = initBodySyncFromWire()
    for (const cb of [...frameHandlers]) cb('local', { type: 'studio_body', tabId: TAB, rows: [{ id: 'm1', role: 'user', content: 'x' }] })
    livePane(3)

    expect(sent.filter((f) => f.type === 'studio_body_request')).toHaveLength(1)
  })

  it('asks for a bounded page, not the whole transcript', () => {
    livePane(2)
    stop = initBodySyncFromWire()
    const req = sent.find((f) => f.type === 'studio_body_request')!
    expect(req.limit).toBe(400)
    expect(req.before).toBeUndefined()
  })

  // Regression: an unpaged request answered with the whole transcript in one
  // frame. 2679 rows serialised to 8,390,207 bytes against an 8 MiB send cap,
  // so the server closed the socket mid-write; Studio reconnected, asked
  // again, and blew it again. The conversation flashed into view and vanished.
  it('walks back through older pages and keeps them in order', () => {
    livePane(0)
    stop = initBodySyncFromWire()

    const emit = (frame: Record<string, unknown>): void => {
      for (const cb of [...frameHandlers]) cb('local', frame)
    }
    const row = (id: string) => ({ id, role: 'user', content: id })

    // Newest page first: `before` is null, so it replaces.
    emit({ type: 'studio_body', tabId: TAB, rows: [row('m3')], hasMore: true, cursor: 'm3', before: null })
    // Which asks for the page behind it.
    const second = sent.filter((f) => f.type === 'studio_body_request')[1]
    expect(second.before).toBe('m3')

    // That older page goes in FRONT of what is held.
    emit({ type: 'studio_body', tabId: TAB, rows: [row('m1'), row('m2')], hasMore: false, before: 'm3' })

    const pane = useSessionStore.getState().conversationPanes.get(TAB)!
    const inst = pane.instances[0] as { messages: Array<{ id: string }> }
    expect(inst.messages.map((m) => m.id)).toEqual(['m1', 'm2', 'm3'])
    // Nothing further once the server says there is no more.
    expect(sent.filter((f) => f.type === 'studio_body_request')).toHaveLength(2)
  })

  it('leaves a pane the owner already hydrated alone', () => {
    livePane(5, true)
    stop = initBodySyncFromWire()
    expect(sent).toHaveLength(0)
  })
})
