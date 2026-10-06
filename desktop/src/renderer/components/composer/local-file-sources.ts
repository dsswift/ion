/**
 * Files from the machine in front of the operator, through the web platform
 * rather than a native dialog, so they work the same in Electron and in a
 * browser tab. What reaches a conversation is decided by `attachment-staging`.
 */
import { rDebug, rInfo } from '../../rendererLogger'

/**
 * Open the platform file picker and resolve to what the operator chose, or
 * `[]` on cancel. The input is never mounted: a detached file input opens
 * its picker the same way, and leaves nothing behind in the document.
 */
export function pickLocalFiles(opts: { accept?: string; multiple?: boolean } = {}): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.multiple = opts.multiple ?? true
    if (opts.accept) input.accept = opts.accept
    input.addEventListener('change', () => {
      const files = [...(input.files ?? [])]
      rInfo('composer', 'local files picked', { count: files.length })
      resolve(files)
    }, { once: true })
    input.addEventListener('cancel', () => {
      rDebug('composer', 'local file pick cancelled')
      resolve([])
    }, { once: true })
    input.click()
  })
}

/**
 * True when this page can ask the browser to share a screen. The API exists
 * only in a secure context (HTTPS or localhost), so a Studio served over
 * plain HTTP from another host has no capture to offer.
 */
export function canCaptureScreen(): boolean {
  return typeof navigator !== 'undefined' && typeof navigator.mediaDevices?.getDisplayMedia === 'function'
}

/**
 * Ask the browser for a screen, window, or tab, take one frame of it as a
 * PNG, and stop sharing. Resolves to null when the operator cancels the
 * browser's picker.
 */
export async function captureScreenFrame(): Promise<File | null> {
  let stream: MediaStream
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false })
  } catch (err) {
    // The browser rejects with NotAllowedError when the operator closes its
    // share picker; that is a cancel, not a failure.
    if (err instanceof DOMException && err.name === 'NotAllowedError') {
      rDebug('composer', 'screen capture cancelled')
      return null
    }
    throw err
  }
  try {
    const video = document.createElement('video')
    video.muted = true
    video.srcObject = stream
    await video.play()
    const canvas = document.createElement('canvas')
    canvas.width = video.videoWidth
    canvas.height = video.videoHeight
    const context = canvas.getContext('2d')
    if (!context) throw new Error('2d canvas context unavailable')
    context.drawImage(video, 0, 0)
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
    if (!blob) throw new Error('screen frame could not be encoded')
    rInfo('composer', 'screen frame captured', { width: canvas.width, height: canvas.height, bytes: blob.size })
    return new File([blob], 'screenshot.png', { type: 'image/png' })
  } finally {
    for (const track of stream.getTracks()) track.stop()
  }
}
