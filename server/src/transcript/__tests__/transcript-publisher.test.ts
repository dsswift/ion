/**
 * The transcript publisher turns store changes into revisioned patches.
 *
 * What these pin: a burst of streamed tokens becomes one patch; revisions
 * advance by exactly one per patch and every patch names the revision it
 * applies to; streams are independent (their own epoch); only subscribers
 * hear a stream; and a snapshot at revision R is followed by a patch whose
 * baseRev is R -- the property a client relies on to know it missed nothing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { applyTranscriptChange, type TranscriptPatchEvent } from '@ion/shared/transcript/transcript-patch'
import { projectTranscript, type TranscriptRow } from '@ion/shared/transcript/transcript-row'
import type { StudioFrame } from '@ion/shared/studio-wire/types'

type Row = { id: string; role: string; content: string; timestamp: number; [k: string]: unknown }

const store = vi.hoisted(() => {
  const listeners = new Set<() => void>()
  const panes = new Map<string, { activeInstanceId: string; instances: Array<{ id: string; messages: unknown[] }> }>()
  return {
    panes,
    listeners,
    api: {
      getState: () => ({ conversationPanes: panes }),
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

import {
  TRANSCRIPT_FLUSH_MS,
  _resetTranscriptPublisherForTest,
  flushTranscript,
  forgetTranscriptSubscriber,
  openTabTranscript,
  openTranscriptStreams,
} from '../transcript-publisher'
import { TRANSCRIPT_LINGER_MS } from '../transcript-channel'
import { recordingConnection } from '../../protocol/__tests__/recording-connection'
import { runWithTrace } from '../../tracing/op-span'

function setRows(tabId: string, rows: Row[]): void {
  store.panes.set(tabId, { activeInstanceId: 'main', instances: [{ id: 'main', messages: rows }] })
  for (const fn of [...store.listeners]) fn()
}

function patches(sent: StudioFrame[]): TranscriptPatchEvent[] {
  return sent
    .filter((f): f is Extract<StudioFrame, { type: 'studio_event' }> => f.type === 'studio_event')
    .map((f) => f.payload as TranscriptPatchEvent)
    .filter((p) => p.type === 'desktop_transcript_patch')
}

const u = (id: string, content = 'q'): Row => ({ id, role: 'user', content, timestamp: 1 })
const a = (id: string, content: string): Row => ({ id, role: 'assistant', content, timestamp: 2 })

beforeEach(() => {
  vi.useFakeTimers()
  _resetTranscriptPublisherForTest()
  store.panes.clear()
})
afterEach(() => {
  _resetTranscriptPublisherForTest()
  vi.useRealTimers()
})

describe('transcript publisher', () => {
  it('coalesces a burst of streamed tokens into one append', () => {
    setRows('t', [u('u1')])
    const { conn, sent } = recordingConnection({ view: 'thin' })
    const snap = openTabTranscript('t', undefined, conn)!
    expect(snap.rev).toBe(0)

    setRows('t', [u('u1'), a('a1', 'H')])
    setRows('t', [u('u1'), a('a1', 'He')])
    setRows('t', [u('u1'), a('a1', 'Hello')])
    vi.advanceTimersByTime(TRANSCRIPT_FLUSH_MS)

    const got = patches(sent)
    expect(got).toHaveLength(1)
    expect(got[0]).toMatchObject({ baseRev: 0, rev: 1, total: 2, streamId: 'tab:t:main' })
    expect(got[0].change).toMatchObject({ kind: 'splice', at: 1, deleteCount: 0 })

    setRows('t', [u('u1'), a('a1', 'Hello there')])
    vi.advanceTimersByTime(TRANSCRIPT_FLUSH_MS)
    expect(patches(sent)[1]).toMatchObject({ baseRev: 1, rev: 2, change: { kind: 'append', index: 1, field: 'content', text: ' there' } })
  })

  it('reproduces the server rows exactly when a client applies every patch', () => {
    setRows('t', [u('u1')])
    const { conn, sent } = recordingConnection({ view: 'thin' })
    let rows: TranscriptRow[] = openTabTranscript('t', undefined, conn)!.rows
    const steps: Row[][] = [
      [u('u1'), a('local-1', 'Let')],
      [u('u1'), a('local-1', 'Let me check.')],
      [u('u1'), a('e1', 'Let me check.'), { id: 't1', role: 'tool', content: '', toolId: 't1', toolStatus: 'running', timestamp: 3 }],
      [u('u1'), a('e1', 'Let me check.'), { id: 't1', role: 'tool', content: 'ok', toolId: 't1', toolStatus: 'completed', timestamp: 3 }, a('e2', 'Done')],
    ]
    for (const step of steps) {
      setRows('t', step)
      vi.advanceTimersByTime(TRANSCRIPT_FLUSH_MS)
    }
    let rev = 0
    for (const p of patches(sent)) {
      expect(p.baseRev).toBe(rev)
      rows = applyTranscriptChange(rows, p.change)!
      rev = p.rev
    }
    expect(rows).toEqual(projectTranscript(steps[steps.length - 1] as never))
  })

  it('gives each stream its own epoch and only tells its subscribers', () => {
    setRows('t1', [u('a')])
    setRows('t2', [u('b')])
    const one = recordingConnection({ view: 'thin' })
    const two = recordingConnection({ view: 'thin' })
    const s1 = openTabTranscript('t1', undefined, one.conn)!
    const s2 = openTabTranscript('t2', undefined, two.conn)!
    expect(s1.epoch).not.toBe(s2.epoch)

    setRows('t1', [u('a'), a('x', 'y')])
    vi.advanceTimersByTime(TRANSCRIPT_FLUSH_MS)
    expect(patches(one.sent)).toHaveLength(1)
    expect(patches(two.sent)).toHaveLength(0)
  })

  it('opens no stream for a read with nobody subscribing', () => {
    setRows('t', [u('a')])
    expect(openTabTranscript('t', undefined, null)).not.toBeNull()
    expect(openTranscriptStreams()).toEqual([])
  })

  it('keeps a stream its last subscriber left, then closes it when nobody resumes it in time', () => {
    setRows('t', [u('a')])
    const { conn } = recordingConnection({ view: 'thin' })
    openTabTranscript('t', undefined, conn)
    forgetTranscriptSubscriber(conn)
    expect(openTranscriptStreams()).toEqual(['tab:t:main'])
    vi.advanceTimersByTime(TRANSCRIPT_LINGER_MS)
    expect(openTranscriptStreams()).toEqual([])
  })

  it('a client that comes back without its revision gets a new epoch and every row', () => {
    setRows('t', [u('a')])
    const { conn } = recordingConnection({ view: 'thin' })
    const first = openTabTranscript('t', undefined, conn)!
    forgetTranscriptSubscriber(conn)
    const again = openTabTranscript('t', undefined, recordingConnection({ view: 'thin' }).conn)!
    expect(again).toMatchObject({ resumed: false, rev: 0 })
    expect(again.epoch).not.toBe(first.epoch)
  })

  it('resumes a client that comes back holding the revision it left with, and patches it from there', () => {
    setRows('t', [u('a')])
    const before = recordingConnection({ view: 'thin' })
    const first = openTabTranscript('t', undefined, before.conn)!
    forgetTranscriptSubscriber(before.conn)
    // The conversation moves on while the client is away.
    setRows('t', [u('a'), a('b', 'while you were gone')])
    vi.advanceTimersByTime(TRANSCRIPT_FLUSH_MS)

    const after = recordingConnection({ view: 'thin' })
    const resumed = openTabTranscript('t', undefined, after.conn, { epoch: first.epoch, rev: first.rev })!
    expect(resumed).toMatchObject({ resumed: true, epoch: first.epoch, rev: first.rev })
    // Nothing is published before the caller has sent its reply.
    expect(patches(after.sent)).toEqual([])
    vi.advanceTimersByTime(TRANSCRIPT_FLUSH_MS)
    const got = patches(after.sent)
    expect(got).toEqual([expect.objectContaining({ baseRev: first.rev, rev: first.rev + 1, total: 2 })])
    expect(applyTranscriptChange(first.rows, got[0].change)).toEqual(projectTranscript(store.panes.get('t')!.instances[0].messages as never))
  })

  it('resumes with no patch when nothing changed while the client was away', () => {
    setRows('t', [u('a')])
    const before = recordingConnection({ view: 'thin' })
    const first = openTabTranscript('t', undefined, before.conn)!
    forgetTranscriptSubscriber(before.conn)
    const after = recordingConnection({ view: 'thin' })
    expect(openTabTranscript('t', undefined, after.conn, { epoch: first.epoch, rev: first.rev })!.resumed).toBe(true)
    vi.advanceTimersByTime(TRANSCRIPT_FLUSH_MS)
    expect(patches(after.sent)).toEqual([])
  })

  it('does not resume a client holding an older revision than the stream published', () => {
    setRows('t', [u('a')])
    const stays = recordingConnection({ view: 'thin' })
    const first = openTabTranscript('t', undefined, stays.conn)!
    setRows('t', [u('a'), a('b', 'missed')])
    vi.advanceTimersByTime(TRANSCRIPT_FLUSH_MS)
    const back = recordingConnection({ view: 'thin' })
    const snap = openTabTranscript('t', undefined, back.conn, { epoch: first.epoch, rev: first.rev })!
    expect(snap).toMatchObject({ resumed: false, rev: 1 })
    expect(snap.rows.map((r) => r.id)).toEqual(['a', 'b'])
  })

  it('keeps the stream of a subscriber whose connection closed, at the revision it last saw', () => {
    setRows('t', [u('a')])
    const { conn } = recordingConnection({ view: 'thin' })
    const first = openTabTranscript('t', undefined, conn)!
    conn.markClosed()
    setRows('t', [u('a'), a('b', 'c')])
    vi.advanceTimersByTime(TRANSCRIPT_FLUSH_MS)
    setRows('t', [u('a'), a('b', 'cd')])
    vi.advanceTimersByTime(TRANSCRIPT_FLUSH_MS)
    const back = recordingConnection({ view: 'thin' })
    // The refused send counted as a revision the client never received.
    expect(openTabTranscript('t', undefined, back.conn, { epoch: first.epoch, rev: first.rev })!.resumed).toBe(false)
  })

  it('a snapshot taken mid-burst includes the burst, and the next patch builds on it', () => {
    setRows('t', [u('a')])
    const first = recordingConnection({ view: 'thin' })
    openTabTranscript('t', undefined, first.conn)
    setRows('t', [u('a'), a('b', 'pending')])
    // A second client joins before the flush window ends.
    const second = recordingConnection({ view: 'thin' })
    const snap = openTabTranscript('t', undefined, second.conn)!
    expect(snap.rows.map((r) => r.id)).toEqual(['a', 'b'])
    expect(snap.rev).toBe(1)
    setRows('t', [u('a'), a('b', 'pending!')])
    vi.advanceTimersByTime(TRANSCRIPT_FLUSH_MS)
    expect(patches(second.sent)).toEqual([expect.objectContaining({ baseRev: 1, rev: 2 })])
  })

  it('flushTranscript publishes at once, without waiting for the window', () => {
    setRows('t', [u('a')])
    const { conn, sent } = recordingConnection({ view: 'thin' })
    openTabTranscript('t', undefined, conn)
    setRows('t', [u('a'), u('b')])
    flushTranscript('t')
    expect(patches(sent)).toHaveLength(1)
  })

  // The store's reducer edits a tool row in place: a new array holding the
  // SAME row object, now with new toolInput. Change detection keyed on the
  // row object never published it.
  it('publishes a row the store edited in place', () => {
    const tool: Row = { id: 't1', role: 'tool', content: '', toolId: 't1', toolInput: '', toolStatus: 'running', timestamp: 1 }
    const rows = [u('a'), tool]
    setRows('t', rows)
    const { conn, sent } = recordingConnection({ view: 'thin' })
    openTabTranscript('t', undefined, conn)
    tool.toolInput = '{"command":"ls"}'
    setRows('t', [...rows])
    vi.advanceTimersByTime(TRANSCRIPT_FLUSH_MS)
    expect(patches(sent)).toEqual([expect.objectContaining({ change: expect.objectContaining({ kind: 'append', field: 'toolInput', text: '{"command":"ls"}' }) })])
  })

  it('does not re-project a stream whose conversation did not change', () => {
    setRows('t1', [u('a')])
    setRows('t2', [u('b')])
    const one = recordingConnection({ view: 'thin' })
    openTabTranscript('t1', undefined, one.conn)
    // Mutating t1's rows without a new array models no real store change, so
    // a change on t2 must not surface it: t1 was not marked dirty.
    ;(store.panes.get('t1')!.instances[0].messages[0] as Row).content = 'unpublished'
    setRows('t2', [u('b'), u('c')])
    vi.advanceTimersByTime(TRANSCRIPT_FLUSH_MS)
    expect(patches(one.sent)).toHaveLength(0)
  })

  it('closes a stream whose conversation instance is gone', () => {
    setRows('t', [u('a')])
    const { conn } = recordingConnection({ view: 'thin' })
    openTabTranscript('t', undefined, conn)
    store.panes.delete('t')
    for (const fn of [...store.listeners]) fn()
    vi.advanceTimersByTime(TRANSCRIPT_FLUSH_MS)
    expect(openTranscriptStreams()).toEqual([])
  })

  describe('the stream-reasoning-to-phone setting', () => {
    const thinking = (id: string, content: string): Row => ({ id, role: 'thinking', content, timestamp: 3, thinkingElapsedSeconds: 4 })
    afterEach(() => { thinkingSetting.enabled = true })

    it('with it off, a thinking row keeps its place and summary but not its text', () => {
      thinkingSetting.enabled = false
      setRows('t', [u('a'), thinking('k1', 'secret reasoning')])
      const { conn } = recordingConnection({ view: 'thin' })
      const snap = openTabTranscript('t', undefined, conn)!
      expect(snap.rows[1]).toMatchObject({ id: 'k1', role: 'thinking', content: '', thinkingElapsedSeconds: 4 })
    })

    it('turning it on re-publishes the text a phone was not sent', () => {
      thinkingSetting.enabled = false
      setRows('t', [u('a'), thinking('k1', 'secret reasoning')])
      const { conn, sent } = recordingConnection({ view: 'thin' })
      let rows = openTabTranscript('t', undefined, conn)!.rows
      thinkingSetting.enabled = true
      for (const fn of [...thinkingSetting.listeners]) fn()
      for (const p of patches(sent)) rows = applyTranscriptChange(rows, p.change)!
      expect(rows[1].content).toBe('secret reasoning')
    })
  })
})

describe('the engine trace on a patch', () => {
  it('stamps the trace of the engine event whose store change made the patch, and none on a change outside one', () => {
    _resetTranscriptPublisherForTest()
    const { conn, sent } = recordingConnection({ view: 'thin' })
    setRows('tab-trace', [{ id: 'u1', role: 'user', content: 'hi', timestamp: 1 }])
    openTabTranscript('tab-trace', undefined, conn)
    runWithTrace({ traceId: '4bf92f3577b34da6a3ce929d0e0e4736', spanId: '00f067aa0ba902b7' }, () => {
      setRows('tab-trace', [{ id: 'u1', role: 'user', content: 'hi', timestamp: 1 }, { id: 'a1', role: 'assistant', content: 'hello', timestamp: 2 }])
    })
    flushTranscript('tab-trace')
    setRows('tab-trace', [{ id: 'u1', role: 'user', content: 'hi', timestamp: 1 }, { id: 'a1', role: 'assistant', content: 'hello there', timestamp: 2 }])
    flushTranscript('tab-trace')
    const patches = sent.filter((f): f is Extract<StudioFrame, { type: 'studio_event' }> => f.type === 'studio_event').map((f) => f.payload as TranscriptPatchEvent).filter((p) => p.type === 'desktop_transcript_patch')
    expect(patches).toHaveLength(2)
    expect(patches[0]).toMatchObject({ trace_id: '4bf92f3577b34da6a3ce929d0e0e4736', span_id: '00f067aa0ba902b7' })
    expect(patches[1]).not.toHaveProperty('trace_id')
    // The frame carries the same ids, so the phone's render span joins the run's trace.
    const frames = sent.filter((f): f is Extract<StudioFrame, { type: 'studio_event' }> => f.type === 'studio_event' && (f.payload as TranscriptPatchEvent).type === 'desktop_transcript_patch')
    expect(frames[0].trace_id).toBe('4bf92f3577b34da6a3ce929d0e0e4736')
    expect(frames[1].trace_id).toBeUndefined()
  })
})
