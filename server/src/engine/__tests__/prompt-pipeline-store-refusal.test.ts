/**
 * A remote-source prompt the store REFUSES (a locked, connecting, or
 * compacting conversation) never reaches the engine, so nothing would ever
 * settle its delivery. The hand-off settles it on the spot with the store's
 * own sentence, so the submitter is answered instead of left waiting.
 *
 * Fails without the refusal branch: the awaited outcome never resolves.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const deps = vi.hoisted(() => ({
  submit: vi.fn<() => { accepted: true } | { accepted: false; reason: string; message: string }>(),
  submitRemotePrompt: vi.fn(),
}))
vi.mock('../../store/sessionStore', () => ({ useSessionStore: { getState: () => ({ submit: deps.submit, submitRemotePrompt: deps.submitRemotePrompt }) } }))
vi.mock('../../user-turn-echo', () => ({ echoUserTurn: vi.fn() }))
vi.mock('../../thin-view/remote-out', () => ({ sendRemoteEvent: vi.fn(), remoteClientsPresent: () => false }))
vi.mock('../../state', () => ({ state: { remoteTransport: null } }))
vi.mock('../../logger', () => ({ log: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }))

import { submitRemotePromptToStore } from '../prompt-pipeline-store'
import { awaitPromptDelivery, takeRemotePromptDelivery } from '../../remote/prompt-delivery'
import type { IncomingPrompt } from '../prompt-pipeline'

const prompt = (reqId: string): IncomingPrompt => ({ tabId: 't1', text: 'hello', reqId, source: 'remote', hasExtensions: true }) as IncomingPrompt

beforeEach(() => { deps.submit.mockReset(); deps.submitRemotePrompt.mockReset() })

describe('submitRemotePromptToStore', () => {
  it('answers the submitter when the store refuses the prompt', async () => {
    deps.submit.mockReturnValue({ accepted: false, reason: 'input-locked', message: 'Not sent: this conversation is locked and accepts no new input. Your text was kept.' })
    const outcome = awaitPromptDelivery('req-1', 't1')
    expect(submitRemotePromptToStore(prompt('req-1'))).toBe(false)
    expect(await outcome).toEqual({ accepted: false, reason: 'Not sent: this conversation is locked and accepts no new input. Your text was kept.' })
  })

  it('leaves the delivery for the engine admission when the store accepts', () => {
    deps.submit.mockReturnValue({ accepted: true })
    void awaitPromptDelivery('req-2', 't1')
    expect(submitRemotePromptToStore(prompt('req-2'))).toBe(true)
    expect(takeRemotePromptDelivery('req-2')).toBeDefined()
  })
})
