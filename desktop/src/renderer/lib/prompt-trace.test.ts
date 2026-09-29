/**
 * Studio's prompt trace starts at submit: `prompt.send` (kind client) hands its
 * traceparent to the store's `submit` and ends when the server answers, with a
 * refusal recorded as the span's error. The caller still gets submit's own
 * outcome, so the composer's restore-on-refusal is unchanged.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const logged = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn() }))
vi.mock('../rendererLogger', () => ({ rInfo: logged.info, rWarn: logged.warn }))

import { submitWithTrace } from './prompt-trace'
import { parseTraceparent } from '@ion/shared/trace-context'

beforeEach(() => {
  vi.clearAllMocks()
})

describe('submitWithTrace', () => {
  it('sends the client span as the traceparent and writes the span when the server accepts', async () => {
    const submit = vi.fn(async (_tabId: string, _text: string, _opts: { traceparent: string }) => ({ accepted: true as const }))
    const outcome = submitWithTrace(submit, 't1', 'hello', '1780093348767-c1c03e998388')
    expect(await outcome).toEqual({ accepted: true })

    const sent = parseTraceparent(submit.mock.calls[0][2].traceparent)
    expect(sent).not.toBeNull()
    await Promise.resolve()
    expect(logged.info).toHaveBeenCalledWith('span', 'prompt.send', expect.objectContaining({
      trace_id: sent?.traceId, span_id: sent?.spanId, span_kind: 'client', 'peer.service': 'ion-server', tab_id: 't1',
      conversation_id: '1780093348767-c1c03e998388', accepted: true,
    }))
    const fields = logged.info.mock.calls[0][2] as Record<string, unknown>
    expect(fields).not.toHaveProperty('parent_span_id')
    expect(['studio-desktop', 'studio-web']).toContain(fields.surface)
  })

  it('records a refusal as the span error and returns the refusal unchanged', () => {
    const refused = { accepted: false as const, reason: 'connecting' as const, message: 'Not sent.' }
    const outcome = submitWithTrace(() => refused, 't1', 'hello')
    expect(outcome).toBe(refused)
    expect(logged.warn).toHaveBeenCalledWith('span', 'prompt.send', expect.objectContaining({
      accepted: false, reason: 'connecting', error: 'prompt refused: connecting',
    }))
  })

  it('closes the span when the forwarded submit fails, and leaves the rejection to the caller', async () => {
    const outcome = submitWithTrace(async () => { throw new Error('socket closed') }, 't1', 'hello')
    await expect(outcome).rejects.toThrow('socket closed')
    expect(logged.warn).toHaveBeenCalledWith('span', 'prompt.send', expect.objectContaining({ error: 'socket closed' }))
  })
})
