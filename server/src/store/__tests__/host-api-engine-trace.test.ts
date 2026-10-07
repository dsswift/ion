/**
 * The store's prompt sink, reached with no action in flight, opens the
 * server's own `action.handle` span (`action=submit`): a child of
 * the client's span when the client sent a valid traceparent, a new root
 * (logged with the reason) otherwise. The engine is handed the SERVER span as
 * the run's parent, so client, server, and engine share one trace. A prompt
 * whose submitter already opened the span reuses it instead of nesting a
 * second one.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { IncomingPrompt } from '../../engine/prompt-pipeline'

const deps = vi.hoisted(() => ({
  processIncomingPrompt: vi.fn(async (_p: IncomingPrompt): Promise<void> => undefined),
  takeRemotePromptDelivery: vi.fn((): { tabId: string; resolve: (o: unknown) => void; traceparent?: string } | undefined => undefined),
  log: vi.fn(),
  warn: vi.fn(),
}))
vi.mock('../../state', () => ({
  sessionPlane: { hasTab: () => true, ensureTab: vi.fn(), getTabStatus: () => ({ permissionMode: 'auto' }) },
  engineBridge: {},
  state: {},
  activeAssistantMessages: new Map(),
  lastMessagePreview: new Map(),
  lastForwardedTabStatus: new Map(),
  lastForwardedTabMeta: new Map(),
  extensionCommandRegistry: new Map(),
}))
vi.mock('../../engine/prompt-pipeline', () => ({ processIncomingPrompt: deps.processIncomingPrompt }))
vi.mock('../../automation/runtime', () => ({ getAutomationRuntime: () => ({ trigger: async () => undefined }) }))
vi.mock('../../engine/session-message-automation', () => ({ emitFreshMessageSubmitted: async () => undefined, emitSteerMessageSubmitted: async () => undefined }))
vi.mock('../../remote/prompt-delivery', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../remote/prompt-delivery')>()), takeRemotePromptDelivery: deps.takeRemotePromptDelivery }))
vi.mock('../../logger', () => ({ log: deps.log, info: deps.log, warn: deps.warn, debug: vi.fn(), error: vi.fn() }))

import { prompt } from '../host-api-engine'
import { parseTraceparent } from '@ion/shared/trace-context'
import type { RunOptions } from '@ion/shared/types'

const TRACE = '4bf92f3577b34da6a3ce929d0e0e4736'
const CLIENT_SPAN = '00f067aa0ba902b7'
const CLIENT_TRACEPARENT = `00-${TRACE}-${CLIENT_SPAN}-01`

const options = (overrides: Partial<RunOptions> = {}): RunOptions => ({ prompt: 'hello', projectPath: '/p', ...overrides } as RunOptions)

/** The span lines the logger was handed: tag `span`. */
function spanLines(fn: typeof deps.log): Array<{ msg: string; fields: Record<string, unknown> }> {
  return fn.mock.calls.filter((c) => c[0] === 'span').map((c) => ({ msg: c[1] as string, fields: c[2] as Record<string, unknown> }))
}

beforeEach(() => {
  vi.clearAllMocks()
  deps.takeRemotePromptDelivery.mockReturnValue(undefined)
  deps.processIncomingPrompt.mockImplementation(async (p) => { p.engineOutcome = { ok: true } })
})

describe('action.handle in the store prompt sink', () => {
  it('joins the client trace and hands the engine the server span as parent', async () => {
    await prompt('t1', 'req-1', options({ traceparent: CLIENT_TRACEPARENT }))

    const incoming = deps.processIncomingPrompt.mock.calls[0][0]
    const toEngine = parseTraceparent(incoming.runOptions?.traceparent)
    expect(toEngine?.traceId).toBe(TRACE)
    expect(toEngine?.spanId).not.toBe(CLIENT_SPAN)
    expect(incoming.traceparent).toBe(incoming.runOptions?.traceparent)

    const [span] = spanLines(deps.log)
    expect(span.msg).toBe('action.handle')
    expect(span.fields).toMatchObject({
      trace_id: TRACE, span_id: toEngine?.spanId, parent_span_id: CLIENT_SPAN, span_kind: 'server',
      action: 'submit', surface: 'server', tab_id: 't1', request_id: 'req-1', prompt_surface: 'studio', accepted: true, engine_dispatched: true,
    })
    expect(deps.log).toHaveBeenCalledWith('trace', 'prompt trace joined the client trace', expect.objectContaining({ trace_id: TRACE }))
    // The sink's own lines about the prompt carry the trace.
    expect(deps.log).toHaveBeenCalledWith(expect.any(String), 'prompt', expect.objectContaining({ trace_id: TRACE }))
  })

  it('starts a new root for an invalid client traceparent and says why', async () => {
    await prompt('t1', 'req-2', options({ traceparent: '00-not-a-trace-01' }))

    const toEngine = parseTraceparent(deps.processIncomingPrompt.mock.calls[0][0].runOptions?.traceparent)
    expect(toEngine).not.toBeNull()
    expect(toEngine?.traceId).not.toBe(TRACE)
    expect(deps.log).toHaveBeenCalledWith('trace', 'prompt trace started a new root', expect.objectContaining({
      trace_id: toEngine?.traceId, reason: 'client traceparent is invalid',
    }))
    expect(spanLines(deps.log)[0].fields).not.toHaveProperty('parent_span_id')
  })

  it('starts a new root, and says so, when the client sent none', async () => {
    await prompt('t1', 'req-3', options())
    expect(deps.log).toHaveBeenCalledWith('trace', 'prompt trace started a new root', expect.objectContaining({ reason: 'client sent no traceparent' }))
  })

  it('reuses the span a submitter already opened instead of nesting a second one', async () => {
    const serverSpan = `00-${TRACE}-1111222233334444-01`
    deps.takeRemotePromptDelivery.mockReturnValue({ tabId: 't1', resolve: vi.fn(), traceparent: serverSpan })
    await prompt('t1', 'req-4', options({ traceparent: CLIENT_TRACEPARENT }))

    expect(deps.processIncomingPrompt.mock.calls[0][0].runOptions?.traceparent).toBe(serverSpan)
    expect(spanLines(deps.log)).toHaveLength(0)
  })

  it('ends the span with the engine refusal as its error', async () => {
    deps.processIncomingPrompt.mockImplementation(async (p) => { p.engineOutcome = { ok: false, error: 'session not found' } })
    await prompt('t1', 'req-5', options({ traceparent: CLIENT_TRACEPARENT }))
    const [span] = spanLines(deps.warn)
    expect(span.fields).toMatchObject({ accepted: false, error: 'session not found' })
  })

  it('ends the span with the pipeline error when the pipeline throws', async () => {
    deps.processIncomingPrompt.mockRejectedValue(new Error('engine down'))
    await expect(prompt('t1', 'req-6', options({ traceparent: CLIENT_TRACEPARENT }))).rejects.toThrow('engine down')
    expect(spanLines(deps.warn)[0].fields).toMatchObject({ trace_id: TRACE, error: 'engine down' })
  })
})
