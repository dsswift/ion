/**
 * `desktop_set_draft`: a phone's unsent composer text reaching the one store
 * that owns the draft. Without this command iOS drafts stayed in UserDefaults
 * on the device, so the same conversation showed different half-written
 * prompts depending on which screen you happened to be looking at.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  setDraftInput: vi.fn(),
  tabs: [{ id: 'tab-known' }] as Array<{ id: string }>,
}))

vi.mock('../../../store/sessionStore', () => ({
  useSessionStore: {
    getState: () => ({
      tabs: mocks.tabs,
      setDraftInput: (...a: unknown[]) => mocks.setDraftInput(...a),
    }),
  },
}))
vi.mock('../../../logger', () => ({ log: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }))
vi.mock('../../../state', () => ({ state: {}, sessionPlane: {}, engineBridge: {} }))
vi.mock('../../../engine/prompt-pipeline', () => ({ processIncomingPrompt: vi.fn() }))
vi.mock('../../../user-turn-echo', () => ({ echoUserTurn: vi.fn() }))
vi.mock('../engine', () => ({ getVoiceSystemPrompt: vi.fn() }))
vi.mock('../../../engine/engine-control-plane-interrupt', () => ({
  performUnifiedInterrupt: vi.fn(), performDispatchAbort: vi.fn(),
}))
vi.mock('../../prompt-delivery', () => ({ registerRemotePromptDelivery: vi.fn() }))
vi.mock('../../../protocol/presence', () => ({ setDriving: vi.fn() }))
vi.mock('../../paired-device-lookup', () => ({ getPairedDeviceById: vi.fn() }))
vi.mock('../../../resolve-engine-model', () => ({ resolveEngineModel: vi.fn() }))
vi.mock('../../../thin-view/remote-out', () => ({ sendRemoteEvent: vi.fn() }))

import { handleSetDraft } from '../tabs-prompt'

describe('handleSetDraft', () => {
  beforeEach(() => {
    mocks.setDraftInput.mockReset()
    mocks.tabs = [{ id: 'tab-known' }]
  })

  it('writes the remote draft onto the conversation', () => {
    handleSetDraft({ type: 'desktop_set_draft', tabId: 'tab-known', text: 'typed on the phone' })

    expect(mocks.setDraftInput).toHaveBeenCalledWith('tab-known', 'typed on the phone')
  })

  it('carries an empty draft through, because clearing is a real edit', () => {
    handleSetDraft({ type: 'desktop_set_draft', tabId: 'tab-known', text: '' })

    expect(mocks.setDraftInput).toHaveBeenCalledWith('tab-known', '')
  })

  it('refuses a tab the store does not have', () => {
    handleSetDraft({ type: 'desktop_set_draft', tabId: 'tab-gone', text: 'orphan' })

    expect(mocks.setDraftInput).not.toHaveBeenCalled()
  })

  it('refuses a malformed tab id rather than minting a conversation key', () => {
    handleSetDraft({ type: 'desktop_set_draft', tabId: '../../etc/passwd', text: 'x' })

    expect(mocks.setDraftInput).not.toHaveBeenCalled()
  })
})
