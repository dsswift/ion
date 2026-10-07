/**
 * A client's `session.prompt` (the phone) handled outside an action opens the
 * server's own `action.handle` span (`action=submit`) at receipt, as a child
 * of the client's `prompt.send` span, and ends it once the outcome is
 * settled. The span's traceparent rides the prompt through
 * the pipeline and the delivery the store claims, so the engine run is its
 * child; an invalid client traceparent starts a new root and says so.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { IncomingPrompt } from '../../../engine/prompt-pipeline'

const deps = vi.hoisted(() => ({
  processIncomingPrompt: vi.fn<(p: IncomingPrompt) => Promise<void>>(async () => undefined),
  log: vi.fn(),
  warn: vi.fn(),
}))
vi.mock('../../../transcript/transcript-publisher', () => ({ flushTranscript: vi.fn() }))
vi.mock('../../../engine/prompt-pipeline', () => ({ processIncomingPrompt: deps.processIncomingPrompt }))
vi.mock('../../../user-turn-echo', () => ({ echoUserTurn: vi.fn() }))
vi.mock('../../../protocol/presence', () => ({ setDriving: vi.fn() }))
vi.mock('../engine', () => ({ getVoiceSystemPrompt: () => undefined }))
vi.mock('../../../resolve-engine-model', () => ({ resolveEngineModel: () => undefined }))
vi.mock('../../../engine/engine-control-plane-interrupt', () => ({ performUnifiedInterrupt: vi.fn(), performDispatchAbort: vi.fn() }))
vi.mock('../../../thin-view/remote-out', () => ({ sendRemoteEvent: vi.fn() }))
vi.mock('../../../state', () => ({ state: {}, sessionPlane: {}, engineBridge: {} }))
vi.mock('../../../store/sessionStore', () => ({
  useSessionStore: { getState: () => ({ tabs: [{ id: 't1', workingDirectory: '/repo' }], conversationPanes: new Map(), addEngineInstance: () => 'inst-1' }) },
}))
vi.mock('../../../logger', () => ({ log: deps.log, info: deps.log, warn: deps.warn, debug: vi.fn(), error: vi.fn() }))

import { submitClientPrompt } from '../tabs-prompt'
import { settlePromptDelivery, takeRemotePromptDelivery } from '../../prompt-delivery'
import { parseTraceparent } from '@ion/shared/trace-context'

const TRACE = '4bf92f3577b34da6a3ce929d0e0e4736'
const CLIENT_SPAN = '00f067aa0ba902b7'
const caller = { kind: 'caller' as const, clientId: 'phone-1' }

function spanLines(fn: typeof deps.log): Array<Record<string, unknown>> {
  return fn.mock.calls.filter((c) => c[0] === 'span' && c[1] === 'action.handle').map((c) => c[2] as Record<string, unknown>)
}

beforeEach(() => {
  vi.clearAllMocks()
  deps.processIncomingPrompt.mockImplementation(async () => undefined)
})

describe('action.handle for a client prompt outside an action', () => {
  it('joins the client trace, hands its span to the store claim, and ends on the outcome', async () => {
    let claimed: string | undefined
    deps.processIncomingPrompt.mockImplementation(async (p) => {
      const delivery = takeRemotePromptDelivery(p.reqId)!
      claimed = delivery.traceparent
      settlePromptDelivery(delivery, p.reqId, { accepted: true })
    })
    await submitClientPrompt({ tabId: 't1', text: 'hello', clientMsgId: 'msg-1', traceparent: `00-${TRACE}-${CLIENT_SPAN}-01` }, caller)

    const sent = deps.processIncomingPrompt.mock.calls[0][0]
    const server = parseTraceparent(sent.traceparent)
    expect(server?.traceId).toBe(TRACE)
    expect(server?.spanId).not.toBe(CLIENT_SPAN)
    expect(claimed).toBe(sent.traceparent)

    const [span] = spanLines(deps.log)
    expect(span).toMatchObject({
      trace_id: TRACE, span_id: server?.spanId, parent_span_id: CLIENT_SPAN, span_kind: 'server',
      action: 'submit', surface: 'server', prompt_surface: 'session.prompt', request_id: 'msg-1', accepted: true,
    })
    expect(deps.log).toHaveBeenCalledWith('main', 'submit_prompt: outcome', expect.objectContaining({ trace_id: TRACE }))
  })

  it('starts a new root for an invalid client traceparent, logs why, and records a rejection', async () => {
    deps.processIncomingPrompt.mockImplementation(async (p) => {
      settlePromptDelivery(takeRemotePromptDelivery(p.reqId)!, p.reqId, { accepted: false, reason: 'engine down' })
    })
    await submitClientPrompt({ tabId: 't1', text: 'hello', clientMsgId: 'msg-2', traceparent: 'garbage' }, caller)

    const server = parseTraceparent(deps.processIncomingPrompt.mock.calls[0][0].traceparent)
    expect(server?.traceId).not.toBe(TRACE)
    expect(deps.log).toHaveBeenCalledWith('trace', 'prompt trace started a new root', expect.objectContaining({
      trace_id: server?.traceId, reason: 'client traceparent is invalid',
    }))
    const [span] = spanLines(deps.warn)
    expect(span).toMatchObject({ accepted: false, error: 'engine down' })
    expect(span).not.toHaveProperty('parent_span_id')
  })
})
