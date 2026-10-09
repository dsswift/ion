/**
 * Pins the browser Studio client's conversation-body channel.
 *
 * Regression context: the server implemented and documented
 * `studio_body_request` -> `studio_body`, but no client ever sent the
 * request. Tabs and the inbox populated normally while every conversation
 * rendered empty, because the forwarded `loadSkeletonMessages` hydrates the
 * SERVER's pane and returns void — the rows never crossed back.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'

const sent: Array<{ environmentId: string; frame: any }> = []
let frameHandler: ((environmentId: string, frame: any) => void) | null = null

const hostMock = {
  send: vi.fn((environmentId: string, frame: any) => { sent.push({ environmentId, frame }) }),
  onFrame: vi.fn((cb: (environmentId: string, frame: any) => void) => {
    frameHandler = cb
    return () => { frameHandler = null }
  }),
}

vi.mock('../../../host/host-instance', () => ({
  get host() { return hostMock },
}))
vi.mock('../../../rendererLogger', () => ({ rDebug: vi.fn(), rInfo: vi.fn(), rWarn: vi.fn() }))

import { useSessionStore } from '@ion/server/store/sessionStore'
import { applyStudioBody, initBodySyncFromWire } from '../body-sync'

const TAB = 'tab-1'

function seedSkeletonPane(): void {
  useSessionStore.setState({
    activeTabId: TAB,
    conversationPanes: new Map([
      [TAB, {
        activeInstanceId: 'inst-1',
        instances: [{ id: 'inst-1', messages: [], messageCount: 3, historyHydrated: false }],
      }],
    ]) as never,
  })
}

beforeEach(() => {
  sent.length = 0
  frameHandler = null
  hostMock.send.mockClear()
  useSessionStore.setState({ activeTabId: undefined, conversationPanes: new Map() as never })
})

describe('initBodySyncFromWire', () => {
  it('requests the active conversation body when its pane has no rows loaded', () => {
    seedSkeletonPane()
    const stop = initBodySyncFromWire()

    expect(sent).toHaveLength(1)
    expect(sent[0].frame).toMatchObject({ type: 'studio_body_request', tabId: TAB, instanceId: 'inst-1' })
    stop()
  })

  it('does not re-request while one request is already outstanding', () => {
    seedSkeletonPane()
    const stop = initBodySyncFromWire()
    // A second store notification for the same unhydrated tab must not re-ask.
    useSessionStore.setState({ activeTabId: TAB })

    expect(hostMock.send).toHaveBeenCalledTimes(1)
    stop()
  })

  it('applies a studio_body answer into the mirror pane', () => {
    seedSkeletonPane()
    const stop = initBodySyncFromWire()

    frameHandler!('local', {
      type: 'studio_body',
      tabId: TAB,
      instanceId: 'inst-1',
      rows: [
        { id: 'm1', role: 'user', content: 'hello' },
        { id: 'm2', role: 'assistant', content: 'hi' },
      ],
    })

    const inst = useSessionStore.getState().conversationPanes.get(TAB)!.instances[0] as any
    expect(inst.messages).toHaveLength(2)
    expect(inst.messages[0].content).toBe('hello')
    expect(inst.historyHydrated).toBe(true)
    stop()
  })

  it('never asks for a conversation whose rows are already loaded', () => {
    useSessionStore.setState({
      activeTabId: TAB,
      conversationPanes: new Map([
        [TAB, {
          activeInstanceId: 'inst-1',
          instances: [{ id: 'inst-1', messages: [{ id: 'm1', role: 'user', content: 'x' }], messageCount: 1, historyHydrated: true }],
        }],
      ]) as never,
    })
    const stop = initBodySyncFromWire()

    expect(hostMock.send).not.toHaveBeenCalled()
    stop()
  })
})

describe('applyStudioBody', () => {
  it('drops malformed rows rather than committing them', () => {
    seedSkeletonPane()
    applyStudioBody(TAB, 'inst-1', [{ id: 'm1', role: 'user', content: 'ok' }, { nope: true }])

    const inst = useSessionStore.getState().conversationPanes.get(TAB)!.instances[0] as any
    expect(inst.messages).toHaveLength(1)
  })

  it('returns false when the mirror has no pane for the tab', () => {
    expect(applyStudioBody('missing-tab', undefined, [])).toBe(false)
  })
})

describe('body.load span', () => {
  it('spans the request to the applied page, with the row count', async () => {
    const { rInfo } = await import('../../../rendererLogger')
    vi.mocked(rInfo).mockClear()
    seedSkeletonPane()
    const stop = initBodySyncFromWire()
    expect(vi.mocked(rInfo).mock.calls.filter((c) => c[1] === 'body.load')).toHaveLength(0)
    frameHandler!('local', { type: 'studio_body', tabId: TAB, instanceId: 'inst-1', rows: [{ id: 'm1', role: 'user', content: 'hello' }], hasMore: false })
    const span = vi.mocked(rInfo).mock.calls.find((c) => c[0] === 'span' && c[1] === 'body.load')
    expect(span?.[2]).toMatchObject({ tab_id: TAB, environment_id: 'local', row_count: 1, applied: true, span_kind: 'client', older_page: false })
    stop()
  })
})
