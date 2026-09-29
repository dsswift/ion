/**
 * A snapshot channel (studio:tabs-sync and its siblings) sends a full state
 * each time. When snapshots are produced faster than a client reads them, a
 * connection must keep only the newest unsent one. Queuing every copy is what
 * pushed a server past its 8 MB send cap at boot and dropped both desktops.
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../logger', () => ({ log: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }))

import { Connection } from '../connection'
import type { ConnectionSocket } from '../connection-socket'
import { channelKeepsLatestOnly } from '@ion/shared/studio-wire/channels'
import type { StudioFrame } from '@ion/shared/studio-wire/types'

function heldSocket() {
  const sent: string[] = []
  const callbacks: Array<(err?: Error) => void> = []
  const ws = {
    send: (data: string, cb?: (err?: Error) => void) => { sent.push(data); if (cb) callbacks.push(cb) },
    close: vi.fn(), terminate: vi.fn(), ping: vi.fn(), on: vi.fn(),
  } as unknown as ConnectionSocket
  return { ws, sent, flushNext: () => callbacks.shift()?.() }
}

const tabsSync = (revision: number): StudioFrame => ({ type: 'studio_event', channel: 'studio:tabs-sync', payload: { revision, blob: 'x'.repeat(3_000_000) } } as StudioFrame)

describe('newest-wins snapshot delivery', () => {
  it('marks the whole-store snapshot channels as newest-wins', () => {
    expect(channelKeepsLatestOnly('studio:tabs-sync')).toBe(true)
    expect(channelKeepsLatestOnly('studio:worktree-sync')).toBe(true)
    expect(channelKeepsLatestOnly('studio:conversation-terminals')).toBe(true)
    expect(channelKeepsLatestOnly('ion:normalized-event')).toBe(false)
  })

  it('keeps one snapshot in flight and replaces the waiting one, so a burst stays under the cap', () => {
    const { ws, sent, flushNext } = heldSocket()
    const conn = new Connection(ws, 'local', 8 * 1024 * 1024)
    for (let revision = 1; revision <= 10; revision++) {
      expect(conn.sendLatest('studio:tabs-sync', tabsSync(revision))).toBe(true)
    }
    expect(conn.isClosed).toBe(false)
    expect(sent).toHaveLength(1)

    flushNext()
    expect(sent).toHaveLength(2)
    expect(JSON.parse(sent[1]).payload.revision).toBe(10)

    flushNext()
    expect(sent).toHaveLength(2)
  })

  it('drops the waiting snapshot when the connection closes', () => {
    const { ws, sent, flushNext } = heldSocket()
    const conn = new Connection(ws, 'local')
    conn.sendLatest('studio:tabs-sync', tabsSync(1))
    conn.sendLatest('studio:tabs-sync', tabsSync(2))
    conn.markClosed()
    flushNext()
    expect(sent).toHaveLength(1)
  })
})
