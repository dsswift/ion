/**
 * `withSpan` is the one way a server operation is timed: it writes the span
 * line, parents a nested span without a threaded parameter, carries the
 * principal as `user`, and fails the span on a throw or rejection.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const logger = vi.hoisted(() => ({ log: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn(), trace: vi.fn(), info: vi.fn() }))
vi.mock('../../logger', () => logger)

import { annotateSpan, currentEventTrace, currentSpan, currentTrace, currentTraceparent, failSpan, runWithTrace, startServerSpan, withSpan } from '../op-span'
import { runAsPrincipal } from '../../identity/request-principal'
import { capturedSpans, theSpan } from './span-capture'

const TRACE = '4bf92f3577b34da6a3ce929d0e0e4736'
const PARENT = '00f067aa0ba902b7'

beforeEach(() => {
  for (const fn of Object.values(logger)) fn.mockClear()
})

describe('withSpan', () => {
  it('times a synchronous operation and writes one INFO span line with its name, kind, and duration', () => {
    let t = 1_000
    const now = (): number => t
    const value = withSpan('tabs_index.build', { kind: 'internal', attrs: { tab_count: 3 }, now }, () => {
      t += 25
      return 'built'
    })
    expect(value).toBe('built')
    const span = theSpan(logger, 'tabs_index.build')
    expect(span.level).toBe('INFO')
    expect(span.fields).toMatchObject({ span_kind: 'internal', duration_ms: 25, tab_count: 3 })
    expect(span.fields.parent_span_id).toBeUndefined()
  })

  it('ends an asynchronous operation when its promise settles', async () => {
    let t = 0
    const now = (): number => t
    const result = withSpan('body.serve', { now }, async () => {
      await Promise.resolve()
      t = 40
      return 7
    })
    expect(capturedSpans(logger)).toEqual([])
    expect(await result).toBe(7)
    expect(theSpan(logger, 'body.serve').fields.duration_ms).toBe(40)
  })

  it('parents a span started inside another on it, in the same trace, without a parameter', () => {
    withSpan('action.handle', { kind: 'server' }, (outer) => {
      withSpan('engine.request', { kind: 'client' }, (inner) => {
        expect(inner.traceId).toBe(outer.traceId)
        expect(inner.parentSpanId).toBe(outer.spanId)
        expect(currentSpan()?.spanId).toBe(inner.spanId)
      })
      expect(currentSpan()?.spanId).toBe(outer.spanId)
    })
    const [inner, outer] = capturedSpans(logger)
    expect(inner.name).toBe('engine.request')
    expect(outer.name).toBe('action.handle')
    expect(inner.fields.parent_span_id).toBe(outer.fields.span_id)
    expect(inner.fields.trace_id).toBe(outer.fields.trace_id)
    expect(currentSpan()).toBeUndefined()
  })

  it('joins an explicit parent traceparent, and starts a new trace when asked for a root', () => {
    withSpan('action.handle', { parent: `00-${TRACE}-${PARENT}-01` }, (span) => {
      expect(span.joined).toBe(true)
      expect(span.traceId).toBe(TRACE)
      withSpan('git.exec', { root: true }, (root) => {
        expect(root.traceId).not.toBe(TRACE)
        expect(root.parentSpanId).toBeUndefined()
      })
    })
    expect(theSpan(logger, 'action.handle').fields.parent_span_id).toBe(PARENT)
    expect(theSpan(logger, 'git.exec').fields.parent_span_id).toBeUndefined()
  })

  it('carries the ambient principal as user on every span', () => {
    runAsPrincipal({ principal: { subject: 'local:josh', displayName: 'Josh' } as never }, () => {
      withSpan('snapshot.build', {}, () => undefined)
    })
    withSpan('snapshot.build', { attrs: { user: 'explicit' } }, () => undefined)
    const [ambient, explicit] = capturedSpans(logger)
    expect(ambient.fields.user).toBe('local:josh')
    expect(explicit.fields.user).toBe('explicit')
  })

  it('fails the span on a throw and on a rejection, writing WARN with the error, and rethrows', async () => {
    expect(() => withSpan('git.exec', {}, () => { throw new Error('exit 128') })).toThrow('exit 128')
    await expect(withSpan('transfer.import', {}, () => Promise.reject(new Error('bad archive')))).rejects.toThrow('bad archive')
    const spans = capturedSpans(logger)
    expect(spans.map((s) => [s.name, s.level, s.fields.error])).toEqual([
      ['git.exec', 'WARN', 'exit 128'],
      ['transfer.import', 'WARN', 'bad archive'],
    ])
  })

  it('merges attributes added while the span runs, from the ambient context or the bound handle, and a late failure', async () => {
    await withSpan('http.request', {}, (_span, ctx) => {
      annotateSpan({ path: '/healthz' })
      return new Promise<void>((resolve) => {
        // A callback outside the operation's async chain still describes this span.
        setTimeout(() => {
          ctx.annotate({ status: 503 })
          ctx.fail('upstream down')
          resolve()
        }, 0)
      })
    })
    const span = theSpan(logger, 'http.request')
    expect(span.fields).toMatchObject({ path: '/healthz', status: 503, error: 'upstream down' })
    expect(span.level).toBe('WARN')
    withSpan('action.handle', {}, () => failSpan('refused'))
    expect(theSpan(logger, 'action.handle').fields.error).toBe('refused')
  })
})

describe('the ambient trace', () => {
  it('runWithTrace carries a trace without a span, as a traceparent for the next hop, and parents a span under it', () => {
    expect(currentTraceparent()).toBeUndefined()
    runWithTrace({ traceId: TRACE, spanId: PARENT }, () => {
      expect(currentSpan()).toBeUndefined()
      expect(currentTrace()).toEqual({ traceId: TRACE, spanId: PARENT })
      expect(currentTraceparent()).toBe(`00-${TRACE}-${PARENT}-01`)
      withSpan('store.broadcast', {}, (span) => {
        expect(span.traceId).toBe(TRACE)
        expect(span.parentSpanId).toBe(PARENT)
      })
    })
    expect(theSpan(logger, 'store.broadcast').fields.parent_span_id).toBe(PARENT)
  })

  it('keeps the carried event trace visible inside the spans nested in it, and nowhere else', () => {
    expect(currentEventTrace()).toBeUndefined()
    withSpan('action.handle', {}, () => expect(currentEventTrace()).toBeUndefined())
    runWithTrace({ traceId: TRACE, spanId: PARENT }, () => {
      withSpan('store.broadcast', {}, () => {
        withSpan('transcript.patch', {}, (span) => {
          expect(currentTrace()?.spanId).toBe(span.spanId)
          expect(currentEventTrace()).toEqual({ traceId: TRACE, spanId: PARENT })
        })
      })
    })
  })

  it('runWithTrace ignores an invalid or absent trace', () => {
    runWithTrace('not-a-traceparent', () => expect(currentTrace()).toBeUndefined())
    runWithTrace(undefined, () => expect(currentTrace()).toBeUndefined())
  })

  it('startServerSpan parents on the ambient span and can start at an earlier instant', () => {
    withSpan('action.handle', {}, (outer) => {
      const span = startServerSpan('server.startup', { startMs: 500, now: () => 900 })
      expect(span.parentSpanId).toBe(outer.spanId)
      span.end()
    })
    expect(theSpan(logger, 'server.startup').fields.duration_ms).toBe(400)
  })
})
