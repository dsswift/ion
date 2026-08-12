/**
 * Per-frame coalescing invariants for the inbound engine stream.
 *
 * The queue exists to collapse a frame's worth of IPC messages into one render
 * pass. Its correctness rests entirely on two properties, both pinned here:
 * arrival order is preserved across all three channels, and text is only ever
 * merged with the message immediately before it.
 */

import { describe, it, expect } from 'vitest'
import {
  type QueuedItem, enqueueEvent, enqueueStatus, enqueueError, dropQueuedTextFor, countMergedChunks,
} from './engine-event-frame-queue'

const chunk = (text: string) => ({ type: 'text_chunk', text }) as any

describe('engine event frame queue', () => {
  it('merges consecutive text chunks for the same tab', () => {
    const q: QueuedItem[] = []
    enqueueEvent(q, 'tab1', chunk('Hel'))
    enqueueEvent(q, 'tab1', chunk('lo '))
    enqueueEvent(q, 'tab1', chunk('world'))

    expect(q).toHaveLength(1)
    expect((q[0] as any).event.text).toBe('Hello world')
  })

  it('does not merge text across an intervening event', () => {
    const q: QueuedItem[] = []
    enqueueEvent(q, 'tab1', chunk('before'))
    enqueueEvent(q, 'tab1', { type: 'tool_start', name: 'Bash' } as any)
    enqueueEvent(q, 'tab1', chunk('after'))

    // Merging these would render the second chunk on the wrong side of the
    // tool call.
    expect(q).toHaveLength(3)
    expect((q[0] as any).event.text).toBe('before')
    expect((q[2] as any).event.text).toBe('after')
  })

  it('does not merge text belonging to different tabs', () => {
    const q: QueuedItem[] = []
    enqueueEvent(q, 'tab1', chunk('one'))
    enqueueEvent(q, 'tab2', chunk('two'))

    expect(q).toHaveLength(2)
    expect((q[0] as any).tabId).toBe('tab1')
    expect((q[1] as any).tabId).toBe('tab2')
  })

  it('preserves arrival order across events, status changes and errors', () => {
    const q: QueuedItem[] = []
    enqueueEvent(q, 'tab1', chunk('text'))
    enqueueStatus(q, 'tab1', 'running', 'idle')
    enqueueError(q, 'tab1', { message: 'boom' } as any)
    enqueueEvent(q, 'tab1', { type: 'message_end' } as any)

    expect(q.map((i) => i.kind)).toEqual(['event', 'status', 'error', 'event'])
  })

  it('drops queued text for a tab on stream reset, leaving other tabs alone', () => {
    let q: QueuedItem[] = []
    enqueueEvent(q, 'tab1', chunk('discard me'))
    enqueueEvent(q, 'tab2', chunk('keep me'))
    enqueueStatus(q, 'tab1', 'running', 'idle')

    q = dropQueuedTextFor(q, 'tab1')

    expect(q).toHaveLength(2)
    expect(q.some((i) => i.kind === 'event' && i.tabId === 'tab1')).toBe(false)
    expect(q.some((i) => i.kind === 'event' && i.tabId === 'tab2')).toBe(true)
    expect(q.some((i) => i.kind === 'status')).toBe(true)
  })

  it('reports how many chunks the merge collapsed', () => {
    const q: QueuedItem[] = []
    enqueueEvent(q, 'tab1', chunk('a'))
    enqueueEvent(q, 'tab1', chunk('b'))
    enqueueEvent(q, 'tab1', chunk('c'))

    // Three chunks received, one entry emitted.
    expect(countMergedChunks(3, q)).toBe(2)
  })
})
