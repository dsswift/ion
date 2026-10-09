/**
 * The renderer's render-side spans: `studio.first_paint` once per window and
 * a child of the launch trace when one is handed over; `store.hydrate` from
 * mirror boot to the first tabs hydration only; `transcript.apply` from the
 * oldest uncommitted delta to the commit, sampled per tab and carrying the
 * deltas it absorbed.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const logged = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn() }))
vi.mock('../rendererLogger', () => ({ rInfo: logged.info, rWarn: logged.warn, rDebug: logged.debug }))

import {
  TRANSCRIPT_SAMPLE_MS, attachTranscriptView, endStoreHydrate, forgetTranscriptTab, markStudioFirstPaint, noteTranscriptCommit, noteTranscriptDelta,
  startSpanAt, startStoreHydrate, _resetRenderSpansForTest,
} from './render-spans'
import { _resetSpanWriterForTest } from './span-writer'
import { formatTraceparent } from '@ion/shared/trace-context'

type Fields = Record<string, unknown>
const spans = (name: string): Fields[] => logged.info.mock.calls.filter((c) => c[1] === name).map((c) => c[2] as Fields)
const PARENT_TRACE = '1'.repeat(32)
const PARENT_SPAN = '2'.repeat(16)

beforeEach(() => { vi.clearAllMocks(); _resetRenderSpansForTest(); _resetSpanWriterForTest() })

describe('studio.first_paint', () => {
  it('writes once, joined to the launch trace when given its traceparent', () => {
    expect(markStudioFirstPaint(formatTraceparent(PARENT_TRACE, PARENT_SPAN))).toBe(true)
    expect(markStudioFirstPaint()).toBe(false)
    expect(spans('studio.first_paint')).toHaveLength(1)
    expect(spans('studio.first_paint')[0]).toMatchObject({ trace_id: PARENT_TRACE, parent_span_id: PARENT_SPAN })
  })

  it('starts a trace of its own without a launch traceparent', () => {
    markStudioFirstPaint(null)
    expect(spans('studio.first_paint')[0]).not.toHaveProperty('parent_span_id')
  })
})

describe('store.hydrate', () => {
  it('spans mirror boot to the first tabs hydration and ignores later ones', () => {
    expect(endStoreHydrate({ environmentId: 'local', tabCount: 1 })).toBe(false)
    startStoreHydrate(formatTraceparent(PARENT_TRACE, PARENT_SPAN))
    startStoreHydrate(null)
    expect(endStoreHydrate({ environmentId: 'local', tabCount: 4 })).toBe(true)
    expect(endStoreHydrate({ environmentId: 'devbox', tabCount: 2 })).toBe(false)
    expect(spans('store.hydrate')).toHaveLength(1)
    expect(spans('store.hydrate')[0]).toMatchObject({ trace_id: PARENT_TRACE, parent_span_id: PARENT_SPAN, environment_id: 'local', tab_count: 4 })
  })
})

describe('transcript.apply', () => {
  beforeEach(() => { attachTranscriptView('tab'); attachTranscriptView('gone') })

  it('measures the oldest uncommitted delta to the commit and counts the deltas absorbed', () => {
    let t = 10_000
    const now = (): number => t
    noteTranscriptDelta('tab', now)
    t += 5
    noteTranscriptDelta('tab', now)
    t += 20
    expect(noteTranscriptCommit('tab', now)).toBe(true)
    const [fields] = spans('transcript.apply')
    expect(fields).toMatchObject({ tab_id: 'tab', deltas: 2, duration_ms: 25 })
  })

  it('samples: one span per tab per window, with the skipped commits folded into the next', () => {
    let t = 50_000
    const now = (): number => t
    noteTranscriptDelta('tab', now)
    expect(noteTranscriptCommit('tab', now)).toBe(true)
    t += 10
    noteTranscriptDelta('tab', now)
    expect(noteTranscriptCommit('tab', now)).toBe(false)
    t += 10
    noteTranscriptDelta('tab', now)
    t += TRANSCRIPT_SAMPLE_MS
    expect(noteTranscriptCommit('tab', now)).toBe(true)
    expect(spans('transcript.apply')).toHaveLength(2)
    expect(spans('transcript.apply')[1]).toMatchObject({ deltas: 2 })
  })

  it('is silent for a commit with no delta, and after a tab is forgotten', () => {
    expect(noteTranscriptCommit('empty')).toBe(false)
    noteTranscriptDelta('gone')
    forgetTranscriptTab('gone')
    expect(noteTranscriptCommit('gone')).toBe(false)
    expect(spans('transcript.apply')).toHaveLength(0)
  })

  it('does not time a tab with no mounted view, so a hidden tab never reads as a slow render', () => {
    let t = 1_000
    const now = (): number => t
    noteTranscriptDelta('hidden', now)
    t += 60_000
    const detach = attachTranscriptView('hidden')
    expect(noteTranscriptCommit('hidden', now)).toBe(false)
    noteTranscriptDelta('hidden', now)
    t += 7
    expect(noteTranscriptCommit('hidden', now)).toBe(true)
    expect(spans('transcript.apply')[0]).toMatchObject({ tab_id: 'hidden', duration_ms: 7 })
    detach()
  })

  it('forgets pending deltas when the last view of a tab detaches, not before', () => {
    const first = attachTranscriptView('split')
    const second = attachTranscriptView('split')
    noteTranscriptDelta('split')
    first()
    first()
    expect(noteTranscriptCommit('split')).toBe(true)
    noteTranscriptDelta('split')
    second()
    expect(noteTranscriptCommit('split')).toBe(false)
    noteTranscriptDelta('split')
    expect(noteTranscriptCommit('split')).toBe(false)
  })
})

describe('startSpanAt', () => {
  it('begins at the given time and ends at the clock', () => {
    startSpanAt('late', 1_000, { attributes: { k: 'v' } }, () => 1_250).end()
    expect(spans('late')[0]).toMatchObject({ duration_ms: 250, k: 'v' })
  })
})
