/**
 * Studio's prompt trace starts at submit: `prompt.send` (kind client) hands
 * its traceparent to the store's `submit` and ends when the server answers,
 * with a refusal recorded as the span's error. `prompt.visible` opens at the
 * same submit as its child and ends when the first token renders, matched
 * by the event's stamped `trace_id` or, unstamped, by tab. The caller still
 * gets submit's own outcome, so the composer's restore-on-refusal is unchanged.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const logged = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn() }))
vi.mock('../rendererLogger', () => ({ rInfo: logged.info, rWarn: logged.warn, rDebug: logged.debug }))
vi.mock('../host/host-instance', () => ({ host: { capabilities: () => ['nativeShell'] } }))

import { submitWithTrace, notePromptFirstToken, _resetActionTraceForTest } from './action-trace'
import { _resetSpanWriterForTest } from './span-writer'
import { parseTraceparent } from '@ion/shared/trace-context'

type Fields = Record<string, unknown>
const spans = (fn: ReturnType<typeof vi.fn>, name: string): Fields[] => fn.mock.calls.filter((c) => c[0] === 'span' && c[1] === name).map((c) => c[2] as Fields)

beforeEach(() => {
  vi.clearAllMocks()
  _resetActionTraceForTest()
  _resetSpanWriterForTest()
})

describe('submitWithTrace', () => {
  it('sends the client span as the traceparent and writes the span when the server accepts', async () => {
    const submit = vi.fn(async (_tabId: string, _text: string, _opts: { traceparent: string }) => ({ accepted: true as const }))
    const outcome = submitWithTrace(submit, 't1', 'hello', '1780093348767-c1c03e998388')
    expect(await outcome).toEqual({ accepted: true })

    const sent = parseTraceparent(submit.mock.calls[0][2].traceparent)
    expect(sent).not.toBeNull()
    await Promise.resolve()
    const [fields] = spans(logged.info, 'prompt.send')
    expect(fields).toMatchObject({
      trace_id: sent?.traceId, span_id: sent?.spanId, span_kind: 'client', 'peer.service': 'ion-server', tab_id: 't1',
      conversation_id: '1780093348767-c1c03e998388', accepted: true, surface: 'studio-desktop',
    })
    expect(fields).not.toHaveProperty('parent_span_id')
  })

  it('records a refusal as the span error, returns the refusal unchanged, and closes prompt.visible', () => {
    const refused = { accepted: false as const, reason: 'connecting' as const, message: 'Not sent.' }
    const outcome = submitWithTrace(() => refused, 't1', 'hello')
    expect(outcome).toBe(refused)
    expect(spans(logged.warn, 'prompt.send')[0]).toMatchObject({ accepted: false, reason: 'connecting', error: 'prompt refused: connecting' })
    expect(spans(logged.warn, 'prompt.visible')[0]).toMatchObject({ reason: 'connecting', error: 'prompt refused: connecting' })
    expect(notePromptFirstToken('t1')).toBe(false)
  })

  it('closes the span when the forwarded submit fails, and leaves the rejection to the caller', async () => {
    const outcome = submitWithTrace(async () => { throw new Error('socket closed') }, 't1', 'hello')
    await expect(outcome).rejects.toThrow('socket closed')
    expect(spans(logged.warn, 'prompt.send')[0]).toMatchObject({ error: 'socket closed' })
    expect(spans(logged.warn, 'prompt.visible')[0]).toMatchObject({ error: 'socket closed' })
  })
})

describe('prompt.visible', () => {
  it('is a child of prompt.send in the same trace and ends on the first token, joined by the stamped trace_id', async () => {
    const submit = vi.fn((_t: string, _x: string, _o: { traceparent: string }) => ({ accepted: true as const }))
    submitWithTrace(submit, 't1', 'hello')
    const sent = parseTraceparent(submit.mock.calls[0][2].traceparent)!

    expect(notePromptFirstToken('t1', sent.traceId)).toBe(true)
    await new Promise((r) => setTimeout(r, 0))
    const [visible] = spans(logged.info, 'prompt.visible')
    expect(visible).toMatchObject({ trace_id: sent.traceId, parent_span_id: sent.spanId, span_kind: 'internal', tab_id: 't1', joined_by: 'trace_id' })
    // A second token is not a first token.
    expect(notePromptFirstToken('t1', sent.traceId)).toBe(false)
  })

  it('falls back to the tab when the event carries no trace_id, and ignores a tab with no prompt waiting', async () => {
    submitWithTrace(() => ({ accepted: true as const }), 't2', 'hello')
    expect(notePromptFirstToken('t9')).toBe(false)
    expect(notePromptFirstToken('t2')).toBe(true)
    await new Promise((r) => setTimeout(r, 0))
    expect(spans(logged.info, 'prompt.visible')[0]).toMatchObject({ tab_id: 't2', joined_by: 'tab_id' })
  })

  it('ends a waiting span as superseded when the same tab submits again first', () => {
    submitWithTrace(() => ({ accepted: true as const }), 't3', 'one')
    submitWithTrace(() => ({ accepted: true as const }), 't3', 'two')
    expect(spans(logged.warn, 'prompt.visible')[0]).toMatchObject({ tab_id: 't3', error: 'superseded by a later prompt on the same tab' })
  })
})
