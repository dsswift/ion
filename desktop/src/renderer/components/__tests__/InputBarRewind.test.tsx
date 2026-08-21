// @vitest-environment jsdom
/**
 * Rewind prefill is a one-shot tab field. The shared composer must consume it
 * into its local textarea, focus that textarea, and leave the instance draft
 * intact so an operator can edit and resend a rewound prompt.
 */
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const h = vi.hoisted(() => {
  const clearPendingInput = vi.fn()
  const setDraftInput = vi.fn()
  const storeState = {
    activeTabId: 'tab-rewind',
    tabsReady: true,
    initProgress: '',
    tabs: [{
      id: 'tab-rewind',
      status: 'idle',
      attachments: [],
      pendingInput: 'Please keep this complex prompt\nwith its second line.',
      workingDirectory: '/workspace',
      bashExecuting: false,
    }],
    conversationPanes: new Map([
      ['tab-rewind', {
        activeInstanceId: 'main',
        instances: [{ id: 'main', draftInput: 'Please keep this complex prompt\nwith its second line.' }],
      }],
    ]),
    submit: vi.fn(),
    startBashCommand: vi.fn(),
    completeBashCommand: vi.fn(),
    addAttachments: vi.fn(),
    removeAttachment: vi.fn(),
    setDraftInput,
    clearPendingInput,
    createTab: vi.fn(async () => 'tab-new'),
  }
  const useSessionStore = Object.assign(
    (selector: (state: typeof storeState) => unknown) => selector(storeState),
    { getState: () => storeState },
  )
  return { clearPendingInput, setDraftInput, storeState, useSessionStore }
})

const colors = {
  textPrimary: 'black',
  textTertiary: 'gray',
  containerBorder: 'silver',
  sendDisabled: 'gray',
  sendHover: 'green',
  accentPressed: 'purple',
  sendBg: 'blue',
  textOnAccent: 'white',
} as never

vi.mock('../../stores/sessionStore', () => ({ useSessionStore: h.useSessionStore }))
vi.mock('../../stores/model-store', () => ({
  useModelStore: (selector: (state: { findModel: () => undefined }) => unknown) => selector({ findModel: () => undefined }),
}))
vi.mock('../../preferences', () => ({
  usePreferencesStore: (selector: (state: { bashCommandEntry: boolean; preferredModel: null }) => unknown) => selector({ bashCommandEntry: false, preferredModel: null }),
}))
vi.mock('../../theme', () => ({ useColors: () => colors }))
vi.mock('../../hooks/useActiveContextCapacity', () => ({
  useActiveContextCapacity: () => ({ capacityLimit: 0, state: 'normal', tokens: 0 }),
}))
vi.mock('../../rendererLogger', () => ({ rDebug: vi.fn(), rError: vi.fn(), rWarn: vi.fn() }))
vi.mock('../../stores/slices/engine-event-slice', () => ({ getRendererExtensionCommands: () => [] }))
vi.mock('../InputBarVoiceButton', () => ({
  useVoiceRecording: () => ({ voiceState: 'idle', voiceError: null, stopRecording: vi.fn(), cancelRecording: vi.fn(), toggleRecording: vi.fn() }),
  VoiceButtons: () => null,
}))
vi.mock('../InputBarSendButton', () => ({ SendButton: () => null }))
vi.mock('../UpdateButton', () => ({ UpdateButton: () => null }))
vi.mock('../InputBarSend', () => ({ dispatchSend: vi.fn(() => ({ accepted: false })) }))
vi.mock('../InputBarBash', () => ({ dispatchBashCommand: vi.fn() }))
vi.mock('../ComposerControls', () => ({ ComposerControls: () => null }))
vi.mock('../AttachmentChips', () => ({ AttachmentChips: () => null }))
vi.mock('../SlashCommandMenu', () => ({
  SlashCommandMenu: () => null,
  getFilteredCommandsWithExtras: () => [],
  slashMenuEnterAction: () => 'submit',
  ExtensionCommandIcon: () => null,
}))
vi.mock('../InputLockNotice', () => ({ InputLockNotice: () => null }))
vi.mock('../ContextCapacityNotice', () => ({ ContextCapacityNotice: () => null }))
vi.mock('../ImageModelNotice', () => ({ ImageModelNotice: () => null }))

import { InputBar } from '../InputBar'

afterEach(() => {
  h.clearPendingInput.mockClear()
  h.setDraftInput.mockClear()
  h.storeState.tabs[0].pendingInput = 'Please keep this complex prompt\nwith its second line.'
  h.storeState.conversationPanes.get('tab-rewind')!.instances[0].draftInput = 'Please keep this complex prompt\nwith its second line.'
})

describe('InputBar rewind prefill', () => {
  it('loads, focuses, and consumes a rewound prompt while preserving its draft', async () => {
    ;(window as unknown as { ion: unknown }).ion = {
      discoverCommands: vi.fn(async () => []),
      onWindowShown: vi.fn(() => () => {}),
    }
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)

    await act(async () => {
      root.render(<InputBar />)
    })

    const textarea = container.querySelector('textarea') as HTMLTextAreaElement
    expect(textarea.value).toBe('Please keep this complex prompt\nwith its second line.')
    expect(document.activeElement).toBe(textarea)
    expect(h.clearPendingInput).toHaveBeenCalledWith('tab-rewind')
    expect(h.storeState.conversationPanes.get('tab-rewind')!.instances[0].draftInput)
      .toBe('Please keep this complex prompt\nwith its second line.')

    await act(async () => root.unmount())
    container.remove()
  })
})
