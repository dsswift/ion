/**
 * The server owns the session store, so engine signals must land in it, not
 * only in the mirrors' copies. Before this wiring, submit() marked a tab
 * 'connecting', the session plane went running→idle, the store never heard,
 * and every later prompt on that tab was refused as "connecting".
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

const bridge = vi.hoisted(() => ({
  connect: vi.fn(() => Promise.resolve()),
  connected: true,
  request: vi.fn(() => Promise.resolve({ ok: true, data: {} })),
  on: vi.fn(),
  sendCommand: vi.fn(() => Promise.resolve()),
}))
vi.mock('../../state', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../state')>()
  return { ...actual, engineBridge: bridge }
})

import { sessionPlane } from '../../state'
import { useSessionStore } from '../../store/sessionStore'
import { makeLocalTab } from '../../store/session-store-helpers'
import { makeMainPane } from '../../store/conversation-instance'
import { wireSessionPlaneEvents } from '../event-wiring'

let wired = false

function seedTab(): string {
  const tab = { ...makeLocalTab(), status: 'connecting' as const }
  useSessionStore.setState({
    tabs: [tab],
    activeTabId: tab.id,
    conversationPanes: new Map([[tab.id, makeMainPane({})]]),
  } as never)
  return tab.id
}

describe('engine signals reach the owner store', () => {
  beforeEach(() => {
    if (!wired) {
      wireSessionPlaneEvents()
      wired = true
    }
  })

  it('a tab-status-change moves the store tab out of connecting', () => {
    const tabId = seedTab()
    sessionPlane.emit('tab-status-change', tabId, 'running', 'connecting')
    expect(useSessionStore.getState().tabs.find((t) => t.id === tabId)?.status).toBe('running')
    sessionPlane.emit('tab-status-change', tabId, 'idle', 'running')
    expect(useSessionStore.getState().tabs.find((t) => t.id === tabId)?.status).toBe('idle')
  })

  it('a normalized text_chunk appends assistant text to the store pane', () => {
    const tabId = seedTab()
    sessionPlane.emit('event', tabId, { type: 'text_chunk', text: 'Hi Josh.' })
    const pane = useSessionStore.getState().conversationPanes.get(tabId)!
    const messages = pane.instances[0].messages
    expect(messages.at(-1)).toMatchObject({ role: 'assistant', content: 'Hi Josh.' })
  })

  it('an enriched error marks the store tab failed', () => {
    const tabId = seedTab()
    sessionPlane.emit('error', tabId, { message: 'boom', stderrTail: [], exitCode: 1, elapsedMs: 0, toolCallCount: 0 })
    expect(useSessionStore.getState().tabs.find((t) => t.id === tabId)?.status).toBe('failed')
  })
})
