/**
 * useAtvExports — the postcard (PNG) and clip (WebM) export callbacks,
 * extracted from AtvApp to keep it under the file-size cap. Pure composition
 * over the live canvas + agent cache refs; the reducers/footers they use are
 * the tested pure modules in export/.
 */
import { useCallback } from 'react'
import { rError, rInfo } from '../rendererLogger'
import type { AgentCache, AtvActiveState } from './state/agent-cache'
import { postcardFooter } from './export/postcard'
import { clipReducer, CLIP_SECONDS, type ClipState } from './export/clip'

export interface AtvExportDeps {
  canvasRef: React.RefObject<HTMLCanvasElement | null>
  activeRef: React.MutableRefObject<AtvActiveState | null>
  cacheRef: React.MutableRefObject<AgentCache | null>
  seed: string
  clip: ClipState
  setClip: React.Dispatch<React.SetStateAction<ClipState>>
}

export function useAtvExports({ canvasRef, activeRef, cacheRef, seed, clip, setClip }: AtvExportDeps): {
  recordClip: () => void
  exportPostcard: () => Promise<void>
} {
  /** Record a 10s office clip (MediaRecorder over the canvas stream). */
  const recordClip = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas || clip.kind !== 'idle') return
    let recorder: MediaRecorder
    const chunks: Blob[] = []
    try {
      const stream = canvas.captureStream(30)
      recorder = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp9' })
    } catch (err) {
      rError('atv', 'clip recorder unavailable', { error: String(err) })
      return
    }
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data)
    }
    recorder.onstop = async () => {
      setClip((s) => clipReducer(s, { type: 'stop' }))
      const blob = new Blob(chunks, { type: 'video/webm' })
      const ok = await window.ion.atvExportVideo(await blob.arrayBuffer())
      rInfo('atv', 'clip export', { saved: ok, bytes: blob.size })
      setClip((s) => clipReducer(s, { type: ok ? 'saved' : 'failed' }))
    }
    recorder.start()
    setClip((s) => clipReducer(s, { type: 'start', atMs: performance.now() }))
    setTimeout(() => {
      if (recorder.state !== 'inactive') recorder.stop()
    }, CLIP_SECONDS * 1000)
  }, [canvasRef, clip.kind, setClip])

  /** Postcard export: compose the live canvas + stats footer into a PNG. */
  const exportPostcard = useCallback(async () => {
    const canvas = canvasRef.current
    const active = activeRef.current
    if (!canvas) return
    const footerH = 32
    const out = document.createElement('canvas')
    out.width = canvas.width
    out.height = canvas.height + footerH
    const ctx = out.getContext('2d')
    if (!ctx) return
    ctx.imageSmoothingEnabled = false
    ctx.drawImage(canvas, 0, 0)
    ctx.fillStyle = '#14161c'
    ctx.fillRect(0, canvas.height, out.width, footerH)
    ctx.fillStyle = '#8a8f9e'
    ctx.font = '12px Menlo, Monaco, monospace'
    const stats = active ? cacheRef.current?.statsFor(active.tabId) : null
    const footer = postcardFooter({
      agentCount: active?.agents.length ?? 0,
      perAgent: stats?.perAgent ?? new Map(),
      conversationCostUsd: (active?.statusFields as { conversationCostUsd?: number } | null)?.conversationCostUsd ?? 0,
      seed,
    })
    ctx.fillText(footer, 10, canvas.height + 20)
    const blob = await new Promise<Blob | null>((resolve) => out.toBlob(resolve, 'image/png'))
    if (!blob) return
    const ok = await window.ion.atvExportImage(await blob.arrayBuffer())
    rInfo('atv', 'postcard export', { saved: ok, footer })
  }, [canvasRef, activeRef, cacheRef, seed])

  return { recordClip, exportPostcard }
}
