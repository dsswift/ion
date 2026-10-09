/**
 * The renderer span writer: one `tag=span` line per span (WARN when it
 * failed), the signed-in identity stamped as `user` once known, and a
 * window-local ring of recent spans per name for the Health page.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const logged = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn() }))
vi.mock('../rendererLogger', () => ({ rInfo: logged.info, rWarn: logged.warn }))

import { RECENT_SPANS_PER_NAME, recentRendererSpans, setSpanUser, subscribeRendererSpans, writeRendererSpan, _resetSpanWriterForTest } from './span-writer'
import type { SpanRecord } from '@ion/shared/trace-context'

const record = (name: string, extra: Partial<SpanRecord> = {}): SpanRecord => ({
  name, traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), kind: 'internal', startMs: 1, endMs: 3, durationMs: 2, attributes: {}, ...extra,
})

beforeEach(() => { vi.clearAllMocks(); _resetSpanWriterForTest() })

describe('writeRendererSpan', () => {
  it('writes INFO for a span and WARN for a failed one', () => {
    writeRendererSpan(record('x'))
    writeRendererSpan(record('y', { error: 'boom' }))
    expect(logged.info).toHaveBeenCalledWith('span', 'x', expect.objectContaining({ duration_ms: 2, span_kind: 'internal' }))
    expect(logged.warn).toHaveBeenCalledWith('span', 'y', expect.objectContaining({ error: 'boom' }))
  })

  it('stamps the signed-in identity as user on every later span, without overwriting an explicit one', () => {
    writeRendererSpan(record('before'))
    setSpanUser('user@example.com')
    writeRendererSpan(record('after'))
    writeRendererSpan(record('explicit', { attributes: { user: 'other' } }))
    expect(logged.info.mock.calls[0][2]).not.toHaveProperty('user')
    expect(logged.info.mock.calls[1][2]).toMatchObject({ user: 'user@example.com' })
    expect(logged.info.mock.calls[2][2]).toMatchObject({ user: 'other' })
  })

  it('keeps the newest spans of each name first, bounded per name, and notifies subscribers', () => {
    const seen = vi.fn()
    const off = subscribeRendererSpans(seen)
    for (let i = 0; i < RECENT_SPANS_PER_NAME + 5; i++) writeRendererSpan(record('busy', { spanId: `${i}`.padStart(16, '0') }))
    const recent = recentRendererSpans()
    expect(recent).toHaveLength(RECENT_SPANS_PER_NAME)
    expect(recent[0].spanId).toBe(`${RECENT_SPANS_PER_NAME + 4}`.padStart(16, '0'))
    expect(seen).toHaveBeenCalledTimes(RECENT_SPANS_PER_NAME + 5)
    off()
    writeRendererSpan(record('quiet'))
    expect(seen).toHaveBeenCalledTimes(RECENT_SPANS_PER_NAME + 5)
  })

  it('keeps a one-off span however many of a busy span follow it', () => {
    writeRendererSpan(record('studio.first_paint'))
    writeRendererSpan(record('store.hydrate'))
    for (let i = 0; i < 100; i++) writeRendererSpan(record('transcript.apply'))
    const names = recentRendererSpans().map((r) => r.name)
    expect(names).toContain('studio.first_paint')
    expect(names).toContain('store.hydrate')
    expect(names.slice(0, RECENT_SPANS_PER_NAME)).toEqual(Array(RECENT_SPANS_PER_NAME).fill('transcript.apply'))
  })
})
