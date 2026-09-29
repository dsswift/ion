/**
 * The pipeline's terminal sends carry the server span's traceparent to the
 * engine and record what the engine answered, so the span that opened the
 * prompt can end with the real outcome. Its log lines about the prompt carry
 * the trace id. A remote prompt handed to the store keeps its traceparent.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const deps = vi.hoisted(() => ({
  submitPrompt: vi.fn(async () => ({ ok: true } as { ok: boolean; error?: string })),
  submit: vi.fn(() => ({ accepted: true as const })),
  log: vi.fn(),
}))
vi.mock('../../state', () => ({ sessionPlane: { submitPrompt: deps.submitPrompt }, state: { remoteTransport: null } }))
vi.mock('../../store/sessionStore', () => ({ useSessionStore: { getState: () => ({ submit: deps.submit, submitRemotePrompt: vi.fn() }) } }))
vi.mock('../../questions/questions-wiring', () => ({ notifyQuestionsPromptDispatched: vi.fn(), registerQuestionsPromptSink: vi.fn() }))
vi.mock('../engine-control-plane-dialog-response', () => ({ registerSettingsGuardAnswered: vi.fn() }))
vi.mock('../../integration/bench-prompt-context', () => ({ benchClientWorkspaceContext: () => undefined }))
vi.mock('../../user-turn-echo', () => ({ echoUserTurn: vi.fn() }))
vi.mock('../../thin-view/remote-out', () => ({ sendRemoteEvent: vi.fn(), remoteClientsPresent: () => false }))
vi.mock('../../logger', () => ({ log: deps.log, info: deps.log, warn: vi.fn(), debug: vi.fn(), error: vi.fn() }))

import { processIncomingPrompt, type IncomingPrompt } from '../prompt-pipeline'
import { submitRemotePromptToStore } from '../prompt-pipeline-store'
import type { RunOptions } from '@ion/shared/types'

const TRACE = '4bf92f3577b34da6a3ce929d0e0e4736'
const SERVER_SPAN = `00-${TRACE}-1111222233334444-01`

beforeEach(() => { vi.clearAllMocks() })

describe('pipeline trace propagation', () => {
  it('sends the server span traceparent to the engine and records the engine answer', async () => {
    deps.submitPrompt.mockResolvedValueOnce({ ok: false, error: 'session not found' })
    const p: IncomingPrompt = {
      tabId: 't1', text: 'hello', reqId: 'r1', source: 'desktop', hasExtensions: false,
      runOptions: { prompt: 'hello', projectPath: '/p' } as RunOptions, traceparent: SERVER_SPAN,
    }
    await processIncomingPrompt(p)
    expect(deps.submitPrompt).toHaveBeenCalledWith('t1', 'r1', expect.objectContaining({ traceparent: SERVER_SPAN }))
    expect(p.engineOutcome).toEqual({ ok: false, error: 'session not found' })
    expect(deps.log).toHaveBeenCalledWith('main', 'pipeline: submit prompt', expect.objectContaining({ trace_id: TRACE }))
    expect(deps.log).toHaveBeenCalledWith('main', 'pipeline: processIncomingPrompt', expect.objectContaining({ trace_id: TRACE }))
  })

  it('a remote prompt handed to the store keeps its traceparent', () => {
    submitRemotePromptToStore({ tabId: 't1', text: 'hi', reqId: 'r2', source: 'remote', hasExtensions: true, traceparent: SERVER_SPAN })
    expect(deps.submit).toHaveBeenCalledWith('t1', 'hi', expect.objectContaining({ traceparent: SERVER_SPAN, requestId: 'r2' }))
  })
})
