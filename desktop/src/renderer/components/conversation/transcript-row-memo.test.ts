/**
 * Row-memo pins for the transcript.
 *
 * THE BUG THESE EXIST FOR: the chart feature gave every memoized transcript
 * row a `messages` prop holding the WHOLE conversation, and compared it by
 * reference. The store replaces that array on every stream chunk, so the memo
 * never held: every virtual row re-rendered on every chunk, the virtualizer
 * remeasured rows mid-render, and absolutely-positioned rows painted on top of
 * one another. The operator saw duplicated message rows and images landing over
 * unrelated turns.
 *
 * The fix derives chart state ONCE per message change into a per-row index, so
 * a row's memo depends only on its own chart entry — compared by value, since
 * the index object is rebuilt each time.
 *
 * These tests pin the comparator directly. A row-level React render test would
 * not catch the regression: the defect is about how OFTEN a row re-renders, and
 * the visible damage came from the virtualizer's measurement loop.
 */
import { describe, expect, it } from 'vitest'
import { chartRenderEqual, type ChartRowRender, type ChartTimeline } from './chart-revisions'
import { ESTIMATED_ROW_HEIGHT, ESTIMATED_CHART_ROW_HEIGHT } from './transcript-row-heights'

function timeline(overrides: Partial<ChartTimeline> = {}): ChartTimeline {
  return {
    chartId: 'tool-gate-1-1',
    title: 'Series comparison',
    currentMessageId: 'toolu_02',
    revisions: [
      { messageId: 'toolu_01', spec: {} as ChartTimeline['revisions'][0]['spec'], revision: 1 },
      { messageId: 'toolu_02', spec: {} as ChartTimeline['revisions'][0]['spec'], revision: 2 },
    ],
    ...overrides,
  }
}

describe('chartRenderEqual — a rebuilt index must not invalidate a row', () => {
  it('treats two structurally identical current entries as equal', () => {
    // The index is rebuilt on every message change, so fresh objects with the
    // same meaning MUST compare equal or the memo never holds.
    const a: ChartRowRender = { kind: 'current', timeline: timeline() }
    const b: ChartRowRender = { kind: 'current', timeline: timeline() }
    expect(a).not.toBe(b)
    expect(chartRenderEqual(a, b)).toBe(true)
  })

  it('treats two identical moved markers as equal', () => {
    const a: ChartRowRender = { kind: 'moved', chartId: 'c1', title: 'T', targetMessageId: 'toolu_09' }
    const b: ChartRowRender = { kind: 'moved', chartId: 'c1', title: 'T', targetMessageId: 'toolu_09' }
    expect(chartRenderEqual(a, b)).toBe(true)
  })

  it('treats both-absent as equal, so a chartless row never re-renders', () => {
    // Most rows carry no chart at all; they must be completely unaffected.
    expect(chartRenderEqual(undefined, undefined)).toBe(true)
  })
})

describe('chartRenderEqual — real changes still invalidate', () => {
  it('detects a new revision appended', () => {
    const before: ChartRowRender = { kind: 'current', timeline: timeline() }
    const after: ChartRowRender = {
      kind: 'current',
      timeline: timeline({
        currentMessageId: 'toolu_03',
        revisions: [
          ...timeline().revisions,
          { messageId: 'toolu_03', spec: {} as ChartTimeline['revisions'][0]['spec'], revision: 3 },
        ],
      }),
    }
    expect(chartRenderEqual(before, after)).toBe(false)
  })

  it('detects a rename', () => {
    const before: ChartRowRender = { kind: 'current', timeline: timeline() }
    const after: ChartRowRender = { kind: 'current', timeline: timeline({ title: 'Renamed' }) }
    expect(chartRenderEqual(before, after)).toBe(false)
  })

  it('detects a row becoming superseded (current → moved)', () => {
    // This is the transition a later update causes, and the reason a row needs
    // to re-render at all when its own messages did not change.
    const before: ChartRowRender = { kind: 'current', timeline: timeline() }
    const after: ChartRowRender = { kind: 'moved', chartId: 'tool-gate-1-1', title: 'Series comparison', targetMessageId: 'toolu_03' }
    expect(chartRenderEqual(before, after)).toBe(false)
  })

  it('detects a moved marker retargeting to a newer revision', () => {
    const before: ChartRowRender = { kind: 'moved', chartId: 'c1', title: 'T', targetMessageId: 'toolu_02' }
    const after: ChartRowRender = { kind: 'moved', chartId: 'c1', title: 'T', targetMessageId: 'toolu_03' }
    expect(chartRenderEqual(before, after)).toBe(false)
  })

  it('detects a chart appearing on a row that had none', () => {
    const after: ChartRowRender = { kind: 'current', timeline: timeline() }
    expect(chartRenderEqual(undefined, after)).toBe(false)
  })
})

/**
 * Row-height estimation.
 *
 * THE BUG THIS EXISTS FOR: a chart card is roughly 380px against a 72px text
 * estimate. `scrollToIndex` computes its target from estimates, then every
 * chart row above the target measures to its real height and the virtualizer
 * applies a scroll adjustment per delta — walking the viewport away from the
 * offset the jump just set. Clicking an attachments row scrolled and then
 * drifted, so the transcript appeared not to move at all.
 *
 * Estimating chart rows near their real height removes most of that
 * correction. The heights are pinned so the two cannot silently diverge again:
 * the plot alone is 260px (ChartOutputCard's CHART_HEIGHT).
 */
describe('row height estimation', () => {
  it('estimates a chart row far above a text row', () => {
    expect(ESTIMATED_CHART_ROW_HEIGHT).toBeGreaterThan(ESTIMATED_ROW_HEIGHT * 3)
  })

  it('estimates at least the chart plot height', () => {
    // A guess BELOW the plot alone guarantees a large upward correction.
    expect(ESTIMATED_CHART_ROW_HEIGHT).toBeGreaterThanOrEqual(260)
  })
})
