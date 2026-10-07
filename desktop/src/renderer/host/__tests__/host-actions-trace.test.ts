/**
 * Every `studio_action` the renderer sends is one client span with a
 * `traceparent` on the frame: `action.send` (attribute `action`) for any
 * action, `prompt.send` kept for `submit`, and no second span for an action
 * whose arguments already carry one (a prompt traced at submit). The span
 * ends on the result, a refusal as its error, and the renderer's round trip
 * is reported to the host for the IPC-hop figure.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const logged = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn() }))
vi.mock('../../rendererLogger', () => ({ rInfo: logged.info, rWarn: logged.warn }))

import { actionSpanName, createHostAction } from '../host-actions'
import type { StudioHost } from '../StudioHost'
import type { StudioFrame } from '@ion/shared/studio-wire/types'
import { parseTraceparent, formatTraceparent } from '@ion/shared/trace-context'

type Fields = Record<string, unknown>
function fakeHost(): { host: StudioHost; sent: StudioFrame[]; answer(id: string, frame: Partial<StudioFrame>): void; timing: ReturnType<typeof vi.fn> } {
  const sent: StudioFrame[] = []
  const listeners = new Set<(env: string, frame: StudioFrame) => void>()
  const timing = vi.fn()
  const host = {
    capabilities: () => ['nativeShell'],
    send: (_env: string, frame: StudioFrame) => { sent.push(frame) },
    onFrame: (cb: (env: string, frame: StudioFrame) => void) => { listeners.add(cb); return () => listeners.delete(cb) },
    noteActionTiming: timing,
  } as unknown as StudioHost
  return { host, sent, timing, answer: (id, frame) => { for (const cb of listeners) cb('local', { type: 'studio_action_result', id, ok: true, value: 1, ...frame } as StudioFrame) } }
}
const spans = (fn: ReturnType<typeof vi.fn>, name: string): Fields[] => fn.mock.calls.filter((c) => c[0] === 'span' && c[1] === name).map((c) => c[2] as Fields)

beforeEach(() => vi.clearAllMocks())

describe('actionSpanName', () => {
  it('keeps prompt.send for submit and names every other action action.send', () => {
    expect(actionSpanName('submit')).toBe('prompt.send')
    expect(actionSpanName('git.status')).toBe('action.send')
  })
})

describe('host.action tracing', () => {
  it('mints an action.send span whose traceparent rides the frame, and ends it on the result', async () => {
    const h = fakeHost()
    const action = createHostAction(h.host)
    const pending = action('local', 'git.status', [{ path: '/repo' }])
    const frame = h.sent[0] as Extract<StudioFrame, { type: 'studio_action' }>
    const parent = parseTraceparent(frame.traceparent)
    expect(parent).not.toBeNull()
    h.answer(frame.id, { ok: true, value: 'fine' } as Partial<StudioFrame>)
    await expect(pending).resolves.toBe('fine')
    expect(spans(logged.info, 'action.send')[0]).toMatchObject({ trace_id: parent!.traceId, span_id: parent!.spanId, action: 'git.status', environment_id: 'local', span_kind: 'client', 'peer.service': 'ion-server', ok: true, surface: 'studio-desktop' })
    expect(h.timing).toHaveBeenCalledWith('local', frame.id, expect.any(Number))
  })

  it('names a submit without a carried traceparent prompt.send', async () => {
    const h = fakeHost()
    const pending = createHostAction(h.host)('local', 'submit', ['t1', 'hello'])
    h.answer((h.sent[0] as { id: string }).id, {})
    await pending
    expect(spans(logged.info, 'prompt.send')).toHaveLength(1)
    expect(spans(logged.info, 'action.send')).toHaveLength(0)
  })

  it('sends under a carried traceparent without minting a second span', async () => {
    const h = fakeHost()
    const carried = formatTraceparent('3'.repeat(32), '4'.repeat(16))
    const pending = createHostAction(h.host)('local', 'submit', ['t1', 'hello', { traceparent: carried }])
    const frame = h.sent[0] as Extract<StudioFrame, { type: 'studio_action' }>
    expect(frame.traceparent).toBe(carried)
    h.answer(frame.id, {})
    await pending
    expect(spans(logged.info, 'prompt.send')).toHaveLength(0)
    expect(spans(logged.info, 'action.send')).toHaveLength(0)
  })

  it('records a refusal as the span error', async () => {
    const h = fakeHost()
    const pending = createHostAction(h.host)('local', 'git.push', [])
    h.answer((h.sent[0] as { id: string }).id, { ok: false, refusal: { code: 'surface_disabled', message: 'off' } } as Partial<StudioFrame>)
    await expect(pending).rejects.toThrow('off')
    expect(spans(logged.warn, 'action.send')[0]).toMatchObject({ action: 'git.push', ok: false, code: 'surface_disabled', error: 'off' })
  })
})
