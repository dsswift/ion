import React, { useCallback, useEffect, useRef, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Microphone, SpinnerGap, X, Check } from '@phosphor-icons/react'
import { useColors } from '../theme'
import { useInteractiveState } from '../hooks/useInteractiveState'
import { blobToWavBase64 } from './InputBarVoiceUtils'

export type VoiceState = 'idle' | 'recording' | 'transcribing'

export interface UseVoiceRecordingResult {
  voiceState: VoiceState
  voiceError: string | null
  startRecording: () => Promise<void>
  stopRecording: () => void
  cancelRecording: () => void
  toggleRecording: () => void
}

/**
 * Encapsulates microphone capture, recording state machine, and
 * transcription IPC for the voice-input button. Calls `appendTranscript`
 * with the resulting text so the caller can splice it into its input.
 */
export function useVoiceRecording(appendTranscript: (text: string) => void): UseVoiceRecordingResult {
  const [voiceState, setVoiceState] = useState<VoiceState>('idle')
  const [voiceError, setVoiceError] = useState<string | null>(null)
  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const cancelledRef = useRef(false)

  const stopRecording = useCallback(() => {
    cancelledRef.current = false
    if (mediaRecorderRef.current?.state === 'recording') mediaRecorderRef.current.stop()
  }, [])

  const cancelRecording = useCallback(() => {
    cancelledRef.current = true
    if (mediaRecorderRef.current?.state === 'recording') mediaRecorderRef.current.stop()
  }, [])

  const startRecording = useCallback(async () => {
    setVoiceError(null)
    chunksRef.current = []
    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    } catch {
      setVoiceError('Microphone permission denied.')
      return
    }
    const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : 'audio/webm'
    const recorder = new MediaRecorder(stream, { mimeType })
    recorder.ondataavailable = (e) => { if (e.data.size > 0) chunksRef.current.push(e.data) }
    recorder.onstop = async () => {
      stream.getTracks().forEach((t) => t.stop())
      if (cancelledRef.current) { cancelledRef.current = false; setVoiceState('idle'); return }
      if (chunksRef.current.length === 0) { setVoiceState('idle'); return }
      setVoiceState('transcribing')
      try {
        const blob = new Blob(chunksRef.current, { type: mimeType })
        const wavBase64 = await blobToWavBase64(blob)
        const result = await window.ion.transcribeAudio(wavBase64)
        if (result.error) setVoiceError(result.error)
        else if (result.transcript) appendTranscript(result.transcript)
      } catch (err: any) { setVoiceError(`Voice failed: ${err.message}`) }
      finally { setVoiceState('idle') }
    }
    recorder.onerror = () => { stream.getTracks().forEach((t) => t.stop()); setVoiceError('Recording failed.'); setVoiceState('idle') }
    mediaRecorderRef.current = recorder
    setVoiceState('recording')
    recorder.start()
  }, [appendTranscript])

  const toggleRecording = useCallback(() => {
    if (voiceState === 'recording') stopRecording()
    else if (voiceState === 'idle') void startRecording()
  }, [voiceState, startRecording, stopRecording])

  useEffect(() => {
    return () => {
      if (mediaRecorderRef.current?.state === 'recording') {
        mediaRecorderRef.current.stop()
      }
    }
  }, [])

  return { voiceState, voiceError, startRecording, stopRecording, cancelRecording, toggleRecording }
}

export interface VoiceButtonsProps {
  voiceState: VoiceState
  isConnecting: boolean
  colors: ReturnType<typeof useColors>
  onToggle: () => void
  onCancel: () => void
  onStop: () => void
}

/**
 * Tri-state button cluster: idle (mic), recording (cancel + confirm),
 * transcribing (spinner). Animates between states with framer-motion.
 *
 * Interactive states follow the desktop style guide: the mic button steps
 * through the mic* solid-surface ladder (micBg → micHover → micPressed), the
 * cancel button through the alpha layer ladder (surfaceHover → surfaceActive
 * → surfacePressed), and the confirm button through the accent family.
 * Disabled (connecting) mic dims to 0.45 with inert handlers. Keyboard focus
 * rides `.ion-focusable`; its class transition covers background/color.
 */
export function VoiceButtons({ voiceState, isConnecting, colors, onToggle, onCancel, onStop }: VoiceButtonsProps) {
  // One interactive-state hook per button — hooks stay top-level and
  // unconditional even though only one branch renders at a time.
  const cancelIx = useInteractiveState()
  const confirmIx = useInteractiveState()
  const micIx = useInteractiveState()
  const micInteractive = !isConnecting

  return (
    <AnimatePresence mode="wait">
      {voiceState === 'recording' ? (
        <motion.div
          key="voice-controls"
          initial={{ opacity: 0, scale: 0.8 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.8 }}
          transition={{ duration: 0.12 }}
          className="flex items-center gap-1"
        >
          <button
            onMouseDown={(e) => { e.preventDefault(); cancelIx.handlers.onMouseDown() }}
            onMouseUp={cancelIx.handlers.onMouseUp}
            onMouseEnter={cancelIx.handlers.onMouseEnter}
            onMouseLeave={cancelIx.handlers.onMouseLeave}
            onBlur={cancelIx.handlers.onBlur}
            onClick={onCancel}
            className="ion-focusable w-9 h-9 rounded-full flex items-center justify-center"
            style={{
              background: cancelIx.pressed
                ? colors.surfacePressed
                : cancelIx.hover
                  ? colors.surfaceActive
                  : colors.surfaceHover,
              color: colors.textTertiary,
            }}
            title="Cancel recording"
          >
            <X size={15} weight="bold" />
          </button>
          <button
            onMouseDown={(e) => { e.preventDefault(); confirmIx.handlers.onMouseDown() }}
            onMouseUp={confirmIx.handlers.onMouseUp}
            onMouseEnter={confirmIx.handlers.onMouseEnter}
            onMouseLeave={confirmIx.handlers.onMouseLeave}
            onBlur={confirmIx.handlers.onBlur}
            onClick={onStop}
            className="ion-focusable w-9 h-9 rounded-full flex items-center justify-center"
            style={{
              background: confirmIx.pressed
                ? colors.accentPressed
                : confirmIx.hover
                  ? colors.accentHover
                  : colors.accent,
              color: colors.textOnAccent,
            }}
            title="Confirm recording"
          >
            <Check size={15} weight="bold" />
          </button>
        </motion.div>
      ) : voiceState === 'transcribing' ? (
        <motion.div key="transcribing" initial={{ opacity: 0, scale: 0.8 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.8 }} transition={{ duration: 0.1 }}>
          <button
            disabled
            className="w-9 h-9 rounded-full flex items-center justify-center"
            style={{ background: colors.micBg, color: colors.micColor, cursor: 'default' }}
          >
            <SpinnerGap size={16} className="animate-spin" />
          </button>
        </motion.div>
      ) : (
        <motion.div key="mic" initial={{ opacity: 0, scale: 0.8 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.8 }} transition={{ duration: 0.1 }}>
          <button
            onMouseDown={(e) => {
              e.preventDefault()
              if (micInteractive) micIx.handlers.onMouseDown()
            }}
            onMouseUp={micInteractive ? micIx.handlers.onMouseUp : undefined}
            onMouseEnter={micInteractive ? micIx.handlers.onMouseEnter : undefined}
            onMouseLeave={micIx.handlers.onMouseLeave}
            onBlur={micIx.handlers.onBlur}
            onClick={onToggle}
            disabled={isConnecting}
            className="ion-focusable w-9 h-9 rounded-full flex items-center justify-center"
            style={{
              background: isConnecting
                ? colors.micBg
                : micIx.pressed
                  ? colors.micPressed
                  : micIx.hover
                    ? colors.micHover
                    : colors.micBg,
              color: isConnecting ? colors.micDisabled : colors.micColor,
              opacity: isConnecting ? 0.45 : 1,
              cursor: isConnecting ? 'default' : 'pointer',
            }}
            title="Voice input"
          >
            <Microphone size={16} />
          </button>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
