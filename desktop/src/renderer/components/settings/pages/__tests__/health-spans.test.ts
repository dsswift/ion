// @vitest-environment jsdom
/** The Health page's render-timing list shows only this window's render and hydrate spans. */
import { describe, expect, it, vi } from 'vitest'
vi.mock('../../../../rendererLogger', () => ({ rInfo: vi.fn(), rWarn: vi.fn() }))
import { renderSpans, RENDER_SPAN_NAMES } from '../health-spans'
import { profilingSurfaceOn } from '../ProfilerSection'
import type { SpanRecord } from '@ion/shared/trace-context'
import { ALL_DEVELOPER_SURFACES_ENABLED } from '@ion/shared/developer-surfaces'

const rec = (name: string): SpanRecord => ({ name, traceId: 'a'.repeat(32), spanId: name.padEnd(16, '0'), kind: 'internal', startMs: 0, endMs: 1, durationMs: 1, attributes: {} })

describe('renderSpans', () => {
  it('keeps the render and hydrate spans and drops the rest', () => {
    const kept = renderSpans([rec('transcript.apply'), rec('prompt.send'), rec('store.hydrate'), rec('action.send'), rec('body.load')])
    expect(kept.map((r) => r.name)).toEqual(['transcript.apply', 'store.hydrate', 'body.load'])
    expect([...RENDER_SPAN_NAMES]).toContain('studio.first_paint')
  })
})

describe('profilingSurfaceOn', () => {
  it('follows the profiling developer surface', () => {
    expect(profilingSurfaceOn(ALL_DEVELOPER_SURFACES_ENABLED)).toBe(true)
    expect(profilingSurfaceOn({ ...ALL_DEVELOPER_SURFACES_ENABLED, profiling: false })).toBe(false)
  })
})
