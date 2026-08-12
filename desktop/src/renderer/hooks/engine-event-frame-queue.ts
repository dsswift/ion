// engine-event-frame-queue.ts — per-frame coalescing for the inbound engine
// stream.
//
// Every inbound IPC message arrives in its own macrotask, so React's automatic
// batching cannot merge them: each one drives its own store write and its own
// render pass. While several agents stream at once that is hundreds of render
// passes per second, and each pass costs more the more tabs are open — which
// is how a busy fan-out froze the UI.
//
// The queue holds one frame's worth of inbound work and replays it in arrival
// order inside a single animation frame, so the frame produces one render
// instead of one per message.
//
// Two properties matter more than the coalescing itself:
//
//   1. ORDER IS TOTAL. Normalized events, tab-status transitions, and errors
//      share one queue, because they are separate IPC channels describing the
//      same conversation. Draining them independently would let a status
//      transition apply ahead of the event that caused it.
//   2. MERGING IS ADJACENT-ONLY. Consecutive text chunks for the same tab
//      collapse into one entry; a chunk is never merged across an intervening
//      event, even for the same tab. Text that jumped over a tool result would
//      render in the wrong place.

import type { NormalizedEvent, EnrichedError } from '../../shared/types'

export type QueuedItem =
  | { kind: 'event'; tabId: string; event: NormalizedEvent }
  | { kind: 'status'; tabId: string; status: string; previous: string }
  | { kind: 'error'; tabId: string; error: EnrichedError }

/**
 * Appends an event, merging it into the tail when it is a text chunk
 * continuing the same tab's text. Returns the queue for call-site chaining.
 */
export function enqueueEvent(queue: QueuedItem[], tabId: string, event: NormalizedEvent): QueuedItem[] {
  if (event.type === 'text_chunk') {
    const tail = queue[queue.length - 1]
    if (tail && tail.kind === 'event' && tail.tabId === tabId && tail.event.type === 'text_chunk') {
      queue[queue.length - 1] = {
        kind: 'event',
        tabId,
        event: { ...tail.event, text: (tail.event.text ?? '') + (event.text ?? '') } as NormalizedEvent,
      }
      return queue
    }
  }
  queue.push({ kind: 'event', tabId, event })
  return queue
}

export function enqueueStatus(
  queue: QueuedItem[], tabId: string, status: string, previous: string,
): QueuedItem[] {
  queue.push({ kind: 'status', tabId, status, previous })
  return queue
}

export function enqueueError(queue: QueuedItem[], tabId: string, error: EnrichedError): QueuedItem[] {
  queue.push({ kind: 'error', tabId, error })
  return queue
}

/**
 * Drops queued text for a tab whose stream the engine is retrying. The reset
 * itself stays queued: it clears the store's rendered text, and text buffered
 * behind it must not survive to be appended afterwards.
 */
export function dropQueuedTextFor(queue: QueuedItem[], tabId: string): QueuedItem[] {
  return queue.filter((item) => !(
    item.kind === 'event' && item.tabId === tabId && item.event.type === 'text_chunk'
  ))
}

/** Number of text chunks merged away — reported for observability. */
export function countMergedChunks(received: number, queued: QueuedItem[]): number {
  const emitted = queued.reduce((n, item) => (
    item.kind === 'event' && item.event.type === 'text_chunk' ? n + 1 : n
  ), 0)
  return Math.max(0, received - emitted)
}
