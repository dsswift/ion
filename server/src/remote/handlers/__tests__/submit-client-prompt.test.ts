/**
 * submitClientPrompt answers the caller of the `session.prompt` Studio action
 * with the real outcome of its prompt, by value, where a paired device is told
 * by `desktop_prompt_result` event.
 *
 * The outcome is decided in one of three places, and each is pinned here
 * against the real prompt-delivery module:
 *   - the engine admission, which claims the delivery and settles it later;
 *   - the pipeline itself, when it handles the prompt without an admission
 *     (a command, a shell line) and nothing ever claims the delivery;
 *   - this function, when it cannot create the engine instance it was asked for.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const deps = vi.hoisted(() => ({
  processIncomingPrompt: vi.fn<(p: { reqId: string; tabId: string }) => Promise<void>>(async () => undefined),
  echoUserTurn: vi.fn(),
  setDriving: vi.fn(),
  getVoiceSystemPrompt: vi.fn((): string | undefined => undefined),
  addEngineInstance: vi.fn((): string | null => 'inst-new'),
  panes: new Map<string, { activeInstanceId: string | null; instances: Array<{ id: string; label: string; planFilePath?: string }> }>(),
  flushTranscript: vi.fn(),
}))
vi.mock('../../../transcript/transcript-publisher', () => ({ flushTranscript: deps.flushTranscript }))
vi.mock('../../../engine/prompt-pipeline', () => ({ processIncomingPrompt: deps.processIncomingPrompt }))
vi.mock('../../../user-turn-echo', () => ({ echoUserTurn: deps.echoUserTurn }))
vi.mock('../../../protocol/presence', () => ({ setDriving: deps.setDriving }))
vi.mock('../../paired-device-lookup', () => ({ getPairedDeviceById: () => ({ principalSubject: 'oidc:device-owner' }) }))
vi.mock('../engine', () => ({ getVoiceSystemPrompt: deps.getVoiceSystemPrompt }))
vi.mock('../../../resolve-engine-model', () => ({ resolveEngineModel: () => undefined }))
vi.mock('../../../engine/engine-control-plane-interrupt', () => ({ performUnifiedInterrupt: vi.fn(), performDispatchAbort: vi.fn() }))
vi.mock('../../../thin-view/remote-out', () => ({ sendRemoteEvent: vi.fn() }))
vi.mock('../../../state', () => ({ state: {}, sessionPlane: {}, engineBridge: {} }))
vi.mock('../../../store/sessionStore', () => ({
  useSessionStore: { getState: () => ({ tabs: [{ id: 't1', workingDirectory: '/repo' }], conversationPanes: deps.panes, addEngineInstance: deps.addEngineInstance }) },
}))
vi.mock('../../../logger', () => ({ log: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }))

import { submitClientPrompt } from '../tabs-prompt'
import { settlePromptDelivery, takeRemotePromptDelivery } from '../../prompt-delivery'

const caller = { kind: 'caller' as const, clientId: 'phone-1', principalSubject: 'oidc:alice' }

beforeEach(() => {
  for (const fn of [deps.processIncomingPrompt, deps.echoUserTurn, deps.setDriving, deps.addEngineInstance, deps.getVoiceSystemPrompt]) fn.mockClear()
  deps.processIncomingPrompt.mockImplementation(async () => undefined)
  deps.addEngineInstance.mockReturnValue('inst-new')
  deps.flushTranscript.mockReset()
  deps.panes.clear()
})

describe('submitClientPrompt for the caller of an action', () => {
  // A thin client drops its pending bubble when the result arrives. The row
  // the prompt made must already be on its way, or the turn vanishes from the
  // screen until the next transcript patch.
  it('flushes the conversation transcript after the outcome settles and before answering', async () => {
    const settled = { answered: false }
    deps.flushTranscript.mockImplementation(() => { expect(settled.answered).toBe(false) })
    const answered = await submitClientPrompt({ tabId: 't1', text: 'hello', clientMsgId: 'msg-f' }, caller)
    settled.answered = true
    expect(deps.flushTranscript).toHaveBeenCalledWith('t1')
    expect(answered).toEqual({ accepted: true, clientMsgId: 'msg-f' })
  })

  it('answers accepted when the pipeline handles the prompt without an engine admission', async () => {
    expect(await submitClientPrompt({ tabId: 't1', text: '/help', clientMsgId: 'msg-1' }, caller)).toEqual({ accepted: true, clientMsgId: 'msg-1' })
    expect(takeRemotePromptDelivery('msg-1')).toBeUndefined()
  })

  it('waits for the engine admission that claimed the delivery, and answers what it decides', async () => {
    let admit: (() => void) | undefined
    // The store claims the delivery inside the pipeline call and settles it after the pipeline has returned.
    deps.processIncomingPrompt.mockImplementation(async (p) => {
      const claimed = takeRemotePromptDelivery(p.reqId)!
      admit = () => settlePromptDelivery(claimed, p.reqId, { accepted: false, reason: 'engine down' })
    })
    let answered: unknown
    const pending = submitClientPrompt({ tabId: 't1', text: 'hello', clientMsgId: 'msg-2' }, caller).then((v) => { answered = v })
    await new Promise((r) => setTimeout(r, 0))
    expect(answered).toBeUndefined()
    admit!()
    await pending
    expect(answered).toEqual({ accepted: false, reason: 'engine down', clientMsgId: 'msg-2' })
  })

  it('answers rejected with the reason when the pipeline throws before anything claims the delivery', async () => {
    deps.processIncomingPrompt.mockRejectedValueOnce(new Error('attachment unreadable'))
    expect(await submitClientPrompt({ tabId: 't1', text: 'hello', clientMsgId: 'msg-3' }, caller)).toEqual({ accepted: false, reason: 'attachment unreadable', clientMsgId: 'msg-3' })
  })

  it('creates the first engine instance when one is asked for and none exists, and targets it', async () => {
    await submitClientPrompt({ tabId: 't1', text: 'hello', clientMsgId: 'msg-4', instanceId: '' }, caller)
    expect(deps.addEngineInstance).toHaveBeenCalledWith('t1')
    expect(deps.processIncomingPrompt).toHaveBeenCalledWith(expect.objectContaining({ tabId: 't1', reqId: 'msg-4', instanceId: 'inst-new', hasExtensions: true, source: 'remote' }))
  })

  it('answers rejected by value when the instance cannot be created', async () => {
    deps.addEngineInstance.mockReturnValue(null)
    expect(await submitClientPrompt({ tabId: 't1', text: 'hello', clientMsgId: 'msg-5', instanceId: '' }, caller)).toEqual({ accepted: false, reason: 'failed to create engine instance', clientMsgId: 'msg-5' })
    expect(deps.processIncomingPrompt).not.toHaveBeenCalled()
  })

  it('uses the named instance without creating one, and a plain prompt names none', async () => {
    await submitClientPrompt({ tabId: 't1', text: 'hello', instanceId: 'inst-7' }, caller)
    expect(deps.addEngineInstance).not.toHaveBeenCalled()
    expect(deps.processIncomingPrompt).toHaveBeenLastCalledWith(expect.objectContaining({ instanceId: 'inst-7', hasExtensions: true }))
    await submitClientPrompt({ tabId: 't1', text: 'hello' }, caller)
    expect(deps.processIncomingPrompt).toHaveBeenLastCalledWith(expect.objectContaining({ hasExtensions: false }))
  })

  it('attributes driving and voice configuration to the caller, not to a paired device', async () => {
    deps.getVoiceSystemPrompt.mockReturnValue('Be brief.')
    await submitClientPrompt({ tabId: 't1', text: 'hello', instanceId: 'inst-7' }, caller)
    expect(deps.setDriving).toHaveBeenCalledWith('t1', 'oidc:alice')
    expect(deps.getVoiceSystemPrompt).toHaveBeenCalledWith('phone-1')
    expect(deps.processIncomingPrompt).toHaveBeenLastCalledWith(expect.objectContaining({ appendSystemPrompt: 'Be brief.' }))
  })

  it('mints an id when the client sent none, and answers with it', async () => {
    const result = await submitClientPrompt({ tabId: 't1', text: 'hello' }, caller)
    expect(result.clientMsgId).toMatch(/^remote-\d+$/)
    expect(deps.echoUserTurn).toHaveBeenCalledWith(expect.objectContaining({ id: result.clientMsgId }))
  })
})
