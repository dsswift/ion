/**
 * submitClientPrompt — how an early rejection reaches its submitter.
 *
 * A prompt that cannot be admitted must tell its submitter so, correlated by
 * the clientMsgId the submitter sent. The outcome travels as the value
 * `submitClientPrompt` resolves with — the caller of the `session.prompt`
 * Studio action awaits it directly.
 *
 * The early-rejection path covered here is failed engine-instance creation,
 * the one rejection `submitClientPrompt` decides by itself before the
 * pipeline runs. It is driven against the REAL (unmocked) useSessionStore
 * with a tab that does not exist, so `addEngineInstance` genuinely returns
 * null rather than a mock standing in for it.
 *
 * Pre-migration this suite also covered a "no mainWindow" rejection: the
 * desktop main process used to gate the engine branch on `state.mainWindow`
 * being present. That gate is gone — the engine branch reads `useSessionStore`
 * directly in-process and never references `state.mainWindow`.
 */

import { vi, describe, it, expect } from 'vitest'

vi.mock('electron', () => ({
  app: { get isPackaged() { return false } },
  nativeImage: { createFromPath: vi.fn(), createFromBuffer: vi.fn() },
}))

vi.mock('../../../state', () => ({
  state: {},
  sessionPlane: { cancelTab: vi.fn() },
  engineBridge: {},
}))
vi.mock('../../../logger', () => ({ log: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(), trace: vi.fn() }))
vi.mock('../../../prompt-pipeline', () => ({ processIncomingPrompt: vi.fn(async () => {}) }))
vi.mock('../../attachment-encoder', () => ({
  encodeAttachments: vi.fn((text: string) => ({ encoded: [], rewrittenText: text })),
}))
vi.mock('../../../engine-bridge', () => ({ IS_REMOTE: false }))
vi.mock('./engine', () => ({ getVoiceSystemPrompt: vi.fn(() => undefined) }))
vi.mock('../../../engine-control-plane-interrupt', () => ({ performUnifiedInterrupt: vi.fn() }))
vi.mock('../../prompt-delivery', () => ({ registerRemotePromptDelivery: vi.fn() }))

import { submitClientPrompt } from '../tabs-prompt'

const caller = { kind: 'caller', clientId: 'client-1' } as const

describe('early rejection is answered by value, correlated by clientMsgId', () => {
  it('answers rejected when engine instance creation fails', async () => {
    // No instanceId supplied and the tabId doesn't exist in the real
    // (unmocked) useSessionStore, so addEngineInstance returns null and the
    // prompt is rejected — the only early-rejection path in the engine branch.
    const res = await submitClientPrompt(
      { tabId: 'tab-does-not-exist-1', text: 'hello', clientMsgId: 'msg-123', instanceId: '' } as any,
      caller,
    )

    expect(res).toEqual({
      accepted: false,
      reason: 'failed to create engine instance',
      clientMsgId: 'msg-123',
    })
  })

  it('mints a clientMsgId when the submitter sent none, so the outcome is still correlated', async () => {
    const res = await submitClientPrompt(
      { tabId: 'tab-does-not-exist-2', text: 'hello', instanceId: '' } as any,
      caller,
    )

    expect(res.accepted).toBe(false)
    expect(res.clientMsgId).toMatch(/^remote-\d+$/)
  })

  it('preserves clientMsgId correlation between prompt and outcome', async () => {
    const clientMsgId = 'correlation-test-uuid'
    const res = await submitClientPrompt(
      { tabId: 'tab-does-not-exist-3', text: 'test', clientMsgId, instanceId: '' } as any,
      caller,
    )

    expect(res.clientMsgId).toBe(clientMsgId)
  })
})
