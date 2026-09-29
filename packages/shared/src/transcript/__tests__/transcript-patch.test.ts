import { describe, expect, it } from 'vitest'
import type { TranscriptRow } from '../transcript-row'
import { applyTranscriptChange, diffTranscript, transcriptStreamId } from '../transcript-patch'

const r = (id: string, over: Partial<TranscriptRow> = {}): TranscriptRow => ({ id, role: 'assistant', content: id, timestamp: 1, ...over })

/** Every diff must reproduce `next` when applied to `prev`. */
function roundTrips(prev: TranscriptRow[], next: TranscriptRow[]): ReturnType<typeof diffTranscript> {
  const change = diffTranscript(prev, next)
  if (change && change.kind !== 'reset') expect(applyTranscriptChange(prev, change)).toEqual(next)
  return change
}

describe('diffTranscript', () => {
  it('reports nothing for equal lists', () => {
    expect(diffTranscript([r('a'), r('b')], [r('a'), r('b')])).toBeNull()
  })

  it('sends only the new suffix when one row grows', () => {
    const change = roundTrips([r('a'), r('b', { content: 'hel' })], [r('a'), r('b', { content: 'hello' })])
    expect(change).toEqual({ kind: 'append', index: 1, id: 'b', field: 'content', text: 'lo' })
  })

  it('appends streamed tool input the same way', () => {
    const change = roundTrips([r('t', { toolInput: '{"a"' })], [r('t', { toolInput: '{"a":1}' })])
    expect(change).toMatchObject({ kind: 'append', field: 'toolInput', text: ':1}' })
  })

  it('splices when a growing row also changed another field', () => {
    const change = roundTrips([r('b', { content: 'x', thinkingActive: true })], [r('b', { content: 'xy', thinkingActive: false })])
    expect(change?.kind).toBe('splice')
  })

  it('splices a new row onto the end', () => {
    expect(roundTrips([r('a')], [r('a'), r('b')])).toEqual({ kind: 'splice', at: 1, deleteCount: 0, rows: [r('b')] })
  })

  it('splices a re-keyed row in the middle of the tail', () => {
    const change = roundTrips([r('u'), r('local-1'), r('t')], [r('u'), r('e1a2', { content: 'local-1' }), r('t')])
    expect(change).toMatchObject({ kind: 'splice', at: 1, deleteCount: 1 })
  })

  it('splices a relocation and a truncation', () => {
    roundTrips([r('a'), r('h'), r('b')], [r('a'), r('b'), r('h')])
    expect(roundTrips([r('a'), r('b'), r('c')], [r('a')])).toEqual({ kind: 'splice', at: 1, deleteCount: 2, rows: [] })
  })

  it('handles a full replacement', () => {
    roundTrips([r('a'), r('b')], [r('x'), r('y'), r('z')])
  })

  it('resets when the change is larger than the budget', () => {
    expect(diffTranscript([], [r('big', { content: 'x'.repeat(200) })], 100)).toEqual({ kind: 'reset', reason: 'too_large' })
  })
})

describe('applyTranscriptChange', () => {
  it('refuses an append whose row does not match', () => {
    expect(applyTranscriptChange([r('a')], { kind: 'append', index: 0, id: 'other', field: 'content', text: 'x' })).toBeNull()
  })

  it('refuses a splice past the end', () => {
    expect(applyTranscriptChange([r('a')], { kind: 'splice', at: 1, deleteCount: 1, rows: [] })).toBeNull()
  })

  it('never applies a reset', () => {
    expect(applyTranscriptChange([r('a')], { kind: 'reset', reason: 'too_large' })).toBeNull()
  })
})

describe('transcriptStreamId', () => {
  it('keys tab and dispatch streams distinctly', () => {
    expect(transcriptStreamId({ kind: 'tab', tabId: 't', instanceId: 'main' })).toBe('tab:t:main')
    expect(transcriptStreamId({ kind: 'dispatch', tabId: 't', conversationId: 'c', dispatchId: 'd' })).toBe('dispatch:c:d')
    // Two dispatches of one conversation are two streams: each lays its own
    // in-flight activity over the shared file.
    expect(transcriptStreamId({ kind: 'dispatch', tabId: 't', conversationId: 'c', dispatchId: 'd2' })).not.toBe('dispatch:c:d')
  })
})
