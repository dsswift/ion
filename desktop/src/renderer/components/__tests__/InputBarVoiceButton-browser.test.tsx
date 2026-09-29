// @vitest-environment jsdom
/**
 * Voice input on a browser Studio client. `transcribeAudio` used to be an
 * Electron-only IPC verb behind a `transcriptionDirect` capability, so a
 * browser host refused to record at all. It is the `transcribe.audio`
 * studio_action now, run on the server host, so recording proceeds on every
 * host and the microphone prompt is the first thing the operator sees.
 */
import { describe, expect, it, vi } from 'vitest'
import React from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { useVoiceRecording, type UseVoiceRecordingResult } from '../InputBarVoiceButton'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const transcribeAudio = vi.hoisted(() => vi.fn(async () => ({ error: null, transcript: 'hello' })))

vi.mock('../../host/host-instance', () => ({
  host: { shell: { transcribeAudio }, capabilities: () => ['terminal', 'git', 'files', 'questions', 'graph'] },
}))

function renderApi(): { ref: { current: UseVoiceRecordingResult }; root: Root; container: HTMLDivElement } {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  const ref: { current: UseVoiceRecordingResult | undefined } = { current: undefined }
  function Harness(): null {
    ref.current = useVoiceRecording(vi.fn())
    return null
  }
  act(() => { root.render(React.createElement(Harness)) })
  return { ref: ref as { current: UseVoiceRecordingResult }, root, container }
}

describe('useVoiceRecording on a browser host', () => {
  it('requests microphone access instead of refusing up front', async () => {
    const getUserMedia = vi.fn(async () => { throw new Error('denied in test') })
    Object.assign(navigator, { mediaDevices: { getUserMedia } })
    const { ref, root, container } = renderApi()

    await act(async () => { await ref.current.startRecording() })

    expect(getUserMedia).toHaveBeenCalledWith({ audio: true })
    // The denial is the mic's, not a capability gate's.
    expect(ref.current.voiceError).not.toBe('Voice input is not available in this client.')
    expect(ref.current.voiceState).toBe('idle')
    act(() => root.unmount())
    container.remove()
  })
})
